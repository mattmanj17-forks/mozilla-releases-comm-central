// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

// Congestion control

use std::{
    cmp::{max, min},
    fmt::{self, Debug, Display},
    time::{Duration, Instant},
};

use ::qlog::events::{quic::CongestionStateUpdated, EventData};
use neqo_common::{const_max, const_min, qdebug, qinfo, qlog::Qlog, qtrace};

use super::CongestionControl;
use crate::{
    packet,
    qlog::{self, QlogMetric},
    recovery::sent,
    rtt::RttEstimate,
    sender::PACING_BURST_SIZE,
    Pmtud,
};

pub const CWND_INITIAL_PKTS: usize = 10;
const PERSISTENT_CONG_THRESH: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// In either slow start or congestion avoidance, not recovery.
    SlowStart,
    /// In congestion avoidance.
    CongestionAvoidance,
    /// In a recovery period, but no packets have been sent yet.  This is a
    /// transient state because we want to exempt the first packet sent after
    /// entering recovery from the congestion window.
    RecoveryStart,
    /// In a recovery period, with the first packet sent at this time.
    Recovery,
    /// Start of persistent congestion, which is transient, like `RecoveryStart`.
    PersistentCongestion,
}

impl State {
    pub const fn in_recovery(self) -> bool {
        matches!(self, Self::RecoveryStart | Self::Recovery)
    }

    pub fn in_slow_start(self) -> bool {
        self == Self::SlowStart
    }

    /// These states are transient, we tell qlog on entry, but not on exit.
    pub const fn transient(self) -> bool {
        matches!(self, Self::RecoveryStart | Self::PersistentCongestion)
    }

    /// Update a transient state to the true state.
    pub fn update(&mut self) {
        *self = match self {
            Self::PersistentCongestion => Self::SlowStart,
            Self::RecoveryStart => Self::Recovery,
            _ => unreachable!(),
        };
    }

    pub const fn to_qlog(self) -> &'static str {
        match self {
            Self::SlowStart | Self::PersistentCongestion => "slow_start",
            Self::CongestionAvoidance => "congestion_avoidance",
            Self::Recovery | Self::RecoveryStart => "recovery",
        }
    }
}

pub trait WindowAdjustment: Display + Debug {
    /// This is called when an ack is received.
    /// The function calculates the amount of acked bytes congestion controller needs
    /// to collect before increasing its cwnd by `MAX_DATAGRAM_SIZE`.
    fn bytes_for_cwnd_increase(
        &mut self,
        curr_cwnd: usize,
        new_acked_bytes: usize,
        min_rtt: Duration,
        max_datagram_size: usize,
        now: Instant,
    ) -> usize;
    /// This function is called when a congestion event has been detected and it
    /// returns new (decreased) values of `curr_cwnd` and `acked_bytes`.
    /// This value can be very small; the calling code is responsible for ensuring that the
    /// congestion window doesn't drop below the minimum of `CWND_MIN`.
    fn reduce_cwnd(
        &mut self,
        curr_cwnd: usize,
        acked_bytes: usize,
        max_datagram_size: usize,
    ) -> (usize, usize);
    /// Cubic needs this signal to reset its epoch.
    fn on_app_limited(&mut self);
    #[cfg(test)]
    fn last_max_cwnd(&self) -> f64;
    #[cfg(test)]
    fn set_last_max_cwnd(&mut self, last_max_cwnd: f64);
}

#[derive(Debug)]
pub struct ClassicCongestionControl<T> {
    cc_algorithm: T,
    state: State,
    congestion_window: usize, // = kInitialWindow
    bytes_in_flight: usize,
    acked_bytes: usize,
    ssthresh: usize,
    recovery_start: Option<packet::Number>,
    /// `first_app_limited` indicates the packet number after which the application might be
    /// underutilizing the congestion window. When underutilizing the congestion window due to not
    /// sending out enough data, we SHOULD NOT increase the congestion window.[1] Packets sent
    /// before this point are deemed to fully utilize the congestion window and count towards
    /// increasing the congestion window.
    ///
    /// [1]: https://datatracker.ietf.org/doc/html/rfc9002#section-7.8
    first_app_limited: packet::Number,
    pmtud: Pmtud,
    qlog: Qlog,
}

impl<T> ClassicCongestionControl<T> {
    pub const fn max_datagram_size(&self) -> usize {
        self.pmtud.plpmtu()
    }
}

impl<T: WindowAdjustment> Display for ClassicCongestionControl<T> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(
            f,
            "{} CongCtrl {}/{} ssthresh {}",
            self.cc_algorithm, self.bytes_in_flight, self.congestion_window, self.ssthresh,
        )?;
        Ok(())
    }
}

impl<T: WindowAdjustment> CongestionControl for ClassicCongestionControl<T> {
    fn set_qlog(&mut self, qlog: Qlog) {
        self.qlog = qlog;
    }

    fn cwnd(&self) -> usize {
        self.congestion_window
    }

    fn bytes_in_flight(&self) -> usize {
        self.bytes_in_flight
    }

    fn cwnd_avail(&self) -> usize {
        // BIF can be higher than cwnd due to PTO packets, which are sent even
        // if avail is 0, but still count towards BIF.
        self.congestion_window.saturating_sub(self.bytes_in_flight)
    }

    fn cwnd_min(&self) -> usize {
        self.max_datagram_size() * 2
    }

    #[cfg(test)]
    fn cwnd_initial(&self) -> usize {
        cwnd_initial(self.pmtud.plpmtu())
    }

    fn pmtud(&self) -> &Pmtud {
        &self.pmtud
    }

    fn pmtud_mut(&mut self) -> &mut Pmtud {
        &mut self.pmtud
    }

    fn on_packets_acked(
        &mut self,
        acked_pkts: &[sent::Packet],
        rtt_est: &RttEstimate,
        now: Instant,
    ) {
        let mut is_app_limited = true;
        let mut new_acked = 0;
        for pkt in acked_pkts {
            qtrace!(
                "packet_acked this={self:p}, pn={}, ps={}, ignored={}, lost={}, rtt_est={rtt_est:?}",
                pkt.pn(),
                pkt.len(),
                i32::from(!pkt.cc_outstanding()),
                i32::from(pkt.lost()),
            );
            if !pkt.cc_outstanding() {
                continue;
            }
            if pkt.pn() < self.first_app_limited {
                is_app_limited = false;
            }
            // BIF is set to 0 on a path change, but in case that was because of a simple rebinding
            // event, we may still get ACKs for packets sent before the rebinding.
            self.bytes_in_flight = self.bytes_in_flight.saturating_sub(pkt.len());

            if !self.after_recovery_start(pkt) {
                // Do not increase congestion window for packets sent before
                // recovery last started.
                continue;
            }

            if self.state.in_recovery() {
                self.set_state(State::CongestionAvoidance, now);
                qlog::metrics_updated(&self.qlog, &[QlogMetric::InRecovery(false)], now);
            }

            new_acked += pkt.len();
        }

        if is_app_limited {
            self.cc_algorithm.on_app_limited();
            qdebug!("on_packets_acked this={self:p}, limited=1, bytes_in_flight={}, cwnd={}, state={:?}, new_acked={new_acked}", self.bytes_in_flight, self.congestion_window, self.state);
            return;
        }

        // Slow start, up to the slow start threshold.
        if self.congestion_window < self.ssthresh {
            self.acked_bytes += new_acked;
            let increase = min(self.ssthresh - self.congestion_window, self.acked_bytes);
            self.congestion_window += increase;
            self.acked_bytes -= increase;
            qdebug!("[{self}] slow start += {increase}");
            if self.congestion_window == self.ssthresh {
                // This doesn't look like it is necessary, but it can happen
                // after persistent congestion.
                self.set_state(State::CongestionAvoidance, now);
            }
        }
        // Congestion avoidance, above the slow start threshold.
        if self.congestion_window >= self.ssthresh {
            // The following function return the amount acked bytes a controller needs
            // to collect to be allowed to increase its cwnd by MAX_DATAGRAM_SIZE.
            let bytes_for_increase = self.cc_algorithm.bytes_for_cwnd_increase(
                self.congestion_window,
                new_acked,
                rtt_est.minimum(),
                self.max_datagram_size(),
                now,
            );
            debug_assert!(bytes_for_increase > 0);
            // If enough credit has been accumulated already, apply them gradually.
            // If we have sudden increase in allowed rate we actually increase cwnd gently.
            if self.acked_bytes >= bytes_for_increase {
                self.acked_bytes = 0;
                self.congestion_window += self.max_datagram_size();
            }
            self.acked_bytes += new_acked;
            if self.acked_bytes >= bytes_for_increase {
                self.acked_bytes -= bytes_for_increase;
                self.congestion_window += self.max_datagram_size(); // or is this the current MTU?
            }
            // The number of bytes we require can go down over time with Cubic.
            // That might result in an excessive rate of increase, so limit the number of unused
            // acknowledged bytes after increasing the congestion window twice.
            self.acked_bytes = min(bytes_for_increase, self.acked_bytes);
        }
        qlog::metrics_updated(
            &self.qlog,
            &[
                QlogMetric::CongestionWindow(self.congestion_window),
                QlogMetric::BytesInFlight(self.bytes_in_flight),
            ],
            now,
        );
        qdebug!("[{self}] on_packets_acked this={self:p}, limited=0, bytes_in_flight={}, cwnd={}, state={:?}, new_acked={new_acked}", self.bytes_in_flight, self.congestion_window, self.state);
    }

    /// Update congestion controller state based on lost packets.
    fn on_packets_lost(
        &mut self,
        first_rtt_sample_time: Option<Instant>,
        prev_largest_acked_sent: Option<Instant>,
        pto: Duration,
        lost_packets: &[sent::Packet],
        now: Instant,
    ) -> bool {
        if lost_packets.is_empty() {
            return false;
        }

        for pkt in lost_packets.iter().filter(|pkt| pkt.cc_in_flight()) {
            qdebug!(
                "packet_lost this={self:p}, pn={}, ps={}",
                pkt.pn(),
                pkt.len()
            );
            // BIF is set to 0 on a path change, but in case that was because of a simple rebinding
            // event, we may still declare packets lost that were sent before the rebinding.
            self.bytes_in_flight = self.bytes_in_flight.saturating_sub(pkt.len());
        }
        qlog::metrics_updated(
            &self.qlog,
            &[QlogMetric::BytesInFlight(self.bytes_in_flight)],
            now,
        );

        let is_pmtud_probe = self.pmtud.is_probe_filter();
        let mut lost_packets = lost_packets
            .iter()
            .filter(|pkt| !is_pmtud_probe(pkt))
            .rev()
            .peekable();

        // Lost PMTUD probes do not elicit a congestion control reaction.
        let Some(last_lost_packet) = lost_packets.peek() else {
            return false;
        };

        let congestion = self.on_congestion_event(last_lost_packet, now);
        let persistent_congestion = self.detect_persistent_congestion(
            first_rtt_sample_time,
            prev_largest_acked_sent,
            pto,
            lost_packets.rev(),
            now,
        );
        qdebug!(
            "on_packets_lost this={self:p}, bytes_in_flight={}, cwnd={}, state={:?}",
            self.bytes_in_flight,
            self.congestion_window,
            self.state
        );
        congestion || persistent_congestion
    }

    /// Report received ECN CE mark(s) to the congestion controller as a
    /// congestion event.
    ///
    /// See <https://datatracker.ietf.org/doc/html/rfc9002#section-b.7>.
    fn on_ecn_ce_received(&mut self, largest_acked_pkt: &sent::Packet, now: Instant) -> bool {
        self.on_congestion_event(largest_acked_pkt, now)
    }

    fn discard(&mut self, pkt: &sent::Packet, now: Instant) {
        if pkt.cc_outstanding() {
            assert!(self.bytes_in_flight >= pkt.len());
            self.bytes_in_flight -= pkt.len();
            qlog::metrics_updated(
                &self.qlog,
                &[QlogMetric::BytesInFlight(self.bytes_in_flight)],
                now,
            );
            qtrace!("[{self}] Ignore pkt with size {}", pkt.len());
        }
    }

    fn discard_in_flight(&mut self, now: Instant) {
        self.bytes_in_flight = 0;
        qlog::metrics_updated(
            &self.qlog,
            &[QlogMetric::BytesInFlight(self.bytes_in_flight)],
            now,
        );
    }

    fn on_packet_sent(&mut self, pkt: &sent::Packet, now: Instant) {
        // Record the recovery time and exit any transient state.
        if self.state.transient() {
            self.recovery_start = Some(pkt.pn());
            self.state.update();
        }

        if !pkt.cc_in_flight() {
            return;
        }
        if !self.app_limited() {
            // Given the current non-app-limited condition, we're fully utilizing the congestion
            // window. Assume that all in-flight packets up to this one are NOT app-limited.
            // However, subsequent packets might be app-limited. Set `first_app_limited` to the
            // next packet number.
            self.first_app_limited = pkt.pn() + 1;
        }

        self.bytes_in_flight += pkt.len();
        qdebug!(
            "packet_sent this={self:p}, pn={}, ps={}",
            pkt.pn(),
            pkt.len()
        );
        qlog::metrics_updated(
            &self.qlog,
            &[QlogMetric::BytesInFlight(self.bytes_in_flight)],
            now,
        );
    }

    /// Whether a packet can be sent immediately as a result of entering recovery.
    fn recovery_packet(&self) -> bool {
        self.state == State::RecoveryStart
    }
}

const fn cwnd_initial(mtu: usize) -> usize {
    const_min(CWND_INITIAL_PKTS * mtu, const_max(2 * mtu, 14_720))
}

impl<T: WindowAdjustment> ClassicCongestionControl<T> {
    pub fn new(cc_algorithm: T, pmtud: Pmtud) -> Self {
        Self {
            cc_algorithm,
            state: State::SlowStart,
            congestion_window: cwnd_initial(pmtud.plpmtu()),
            bytes_in_flight: 0,
            acked_bytes: 0,
            ssthresh: usize::MAX,
            recovery_start: None,
            qlog: Qlog::disabled(),
            first_app_limited: 0,
            pmtud,
        }
    }

    #[cfg(test)]
    #[must_use]
    pub const fn ssthresh(&self) -> usize {
        self.ssthresh
    }

    #[cfg(test)]
    pub fn set_ssthresh(&mut self, v: usize) {
        self.ssthresh = v;
    }

    #[cfg(test)]
    pub fn last_max_cwnd(&self) -> f64 {
        self.cc_algorithm.last_max_cwnd()
    }

    #[cfg(test)]
    pub fn set_last_max_cwnd(&mut self, last_max_cwnd: f64) {
        self.cc_algorithm.set_last_max_cwnd(last_max_cwnd);
    }

    #[cfg(test)]
    pub const fn acked_bytes(&self) -> usize {
        self.acked_bytes
    }

    fn set_state(&mut self, state: State, now: Instant) {
        if self.state != state {
            qdebug!("[{self}] state -> {state:?}");
            let old_state = self.state;
            self.qlog.add_event_data_with_instant(
                || {
                    // No need to tell qlog about exit from transient states.
                    if old_state.transient() {
                        None
                    } else {
                        let ev_data = EventData::CongestionStateUpdated(CongestionStateUpdated {
                            old: Some(old_state.to_qlog().to_owned()),
                            new: state.to_qlog().to_owned(),
                            trigger: None,
                        });
                        Some(ev_data)
                    }
                },
                now,
            );
            self.state = state;
        }
    }

    fn detect_persistent_congestion<'a>(
        &mut self,
        first_rtt_sample_time: Option<Instant>,
        prev_largest_acked_sent: Option<Instant>,
        pto: Duration,
        lost_packets: impl IntoIterator<Item = &'a sent::Packet>,
        now: Instant,
    ) -> bool {
        if first_rtt_sample_time.is_none() {
            return false;
        }

        let pc_period = pto * PERSISTENT_CONG_THRESH;

        let mut last_pn = 1 << 62; // Impossibly large, but not enough to overflow.
        let mut start = None;

        // Look for the first lost packet after the previous largest acknowledged.
        // Ignore packets that weren't ack-eliciting for the start of this range.
        // Also, make sure to ignore any packets sent before we got an RTT estimate
        // as we might not have sent PTO packets soon enough after those.
        let cutoff = max(first_rtt_sample_time, prev_largest_acked_sent);
        for p in lost_packets
            .into_iter()
            .skip_while(|p| Some(p.time_sent()) < cutoff)
        {
            if p.pn() != last_pn + 1 {
                // Not a contiguous range of lost packets, start over.
                start = None;
            }
            last_pn = p.pn();
            if !p.cc_in_flight() {
                // Not interesting, keep looking.
                continue;
            }
            if let Some(t) = start {
                let elapsed = p
                    .time_sent()
                    .checked_duration_since(t)
                    .expect("time is monotonic");
                if elapsed > pc_period {
                    qinfo!("[{self}] persistent congestion");
                    self.congestion_window = self.cwnd_min();
                    self.acked_bytes = 0;
                    self.set_state(State::PersistentCongestion, now);
                    qlog::metrics_updated(
                        &self.qlog,
                        &[QlogMetric::CongestionWindow(self.congestion_window)],
                        now,
                    );
                    return true;
                }
            } else {
                start = Some(p.time_sent());
            }
        }
        false
    }

    #[must_use]
    fn after_recovery_start(&self, packet: &sent::Packet) -> bool {
        // At the start of the recovery period, the state is transient and
        // all packets will have been sent before recovery. When sending out
        // the first packet we transition to the non-transient `Recovery`
        // state and update the variable `self.recovery_start`. Before the
        // first recovery, all packets were sent after the recovery event,
        // allowing to reduce the cwnd on congestion events.
        !self.state.transient() && self.recovery_start.map_or(true, |pn| packet.pn() >= pn)
    }

    /// Handle a congestion event.
    /// Returns true if this was a true congestion event.
    fn on_congestion_event(&mut self, last_packet: &sent::Packet, now: Instant) -> bool {
        // Start a new congestion event if lost or ECN CE marked packet was sent
        // after the start of the previous congestion recovery period.
        if !self.after_recovery_start(last_packet) {
            return false;
        }

        let (cwnd, acked_bytes) = self.cc_algorithm.reduce_cwnd(
            self.congestion_window,
            self.acked_bytes,
            self.max_datagram_size(),
        );
        self.congestion_window = max(cwnd, self.cwnd_min());
        self.acked_bytes = acked_bytes;
        self.ssthresh = self.congestion_window;
        qdebug!(
            "[{self}] Cong event -> recovery; cwnd {}, ssthresh {}",
            self.congestion_window,
            self.ssthresh
        );
        qlog::metrics_updated(
            &self.qlog,
            &[
                QlogMetric::CongestionWindow(self.congestion_window),
                QlogMetric::SsThresh(self.ssthresh),
                QlogMetric::InRecovery(true),
            ],
            now,
        );
        self.set_state(State::RecoveryStart, now);
        true
    }

    fn app_limited(&self) -> bool {
        if self.bytes_in_flight >= self.congestion_window {
            false
        } else if self.state.in_slow_start() {
            // Allow for potential doubling of the congestion window during slow start.
            // That is, the application might not have been able to send enough to respond
            // to increases to the congestion window.
            self.bytes_in_flight < self.congestion_window / 2
        } else {
            // We're not limited if the in-flight data is within a single burst of the
            // congestion window.
            (self.bytes_in_flight + self.max_datagram_size() * PACING_BURST_SIZE)
                < self.congestion_window
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use neqo_common::qinfo;
    use test_fixture::now;

    use super::{ClassicCongestionControl, WindowAdjustment, PERSISTENT_CONG_THRESH};
    use crate::{
        cc::{
            classic_cc::State,
            cubic::{Cubic, CUBIC_BETA_USIZE_DIVIDEND, CUBIC_BETA_USIZE_DIVISOR},
            new_reno::NewReno,
            tests::{IP_ADDR, MTU, RTT},
            CongestionControl, CongestionControlAlgorithm, CWND_INITIAL_PKTS,
        },
        packet,
        recovery::{
            self,
            sent::{self},
        },
        rtt::RttEstimate,
        Pmtud,
    };

    const PTO: Duration = RTT;
    const ZERO: Duration = Duration::from_secs(0);
    const EPSILON: Duration = Duration::from_nanos(1);
    const GAP: Duration = Duration::from_secs(1);
    /// The largest time between packets without causing persistent congestion.
    const SUB_PC: Duration = Duration::from_millis(100 * PERSISTENT_CONG_THRESH as u64);
    /// The minimum time between packets to cause persistent congestion.
    /// Uses an odd expression because `Duration` arithmetic isn't `const`.
    const PC: Duration = Duration::from_nanos(100_000_000 * (PERSISTENT_CONG_THRESH as u64) + 1);

    fn cwnd_is_default(cc: &ClassicCongestionControl<NewReno>) {
        assert_eq!(cc.cwnd(), cc.cwnd_initial());
        assert_eq!(cc.ssthresh(), usize::MAX);
    }

    fn cwnd_is_halved(cc: &ClassicCongestionControl<NewReno>) {
        assert_eq!(cc.cwnd(), cc.cwnd_initial() / 2);
        assert_eq!(cc.ssthresh(), cc.cwnd_initial() / 2);
    }

    fn lost(pn: packet::Number, ack_eliciting: bool, t: Duration) -> sent::Packet {
        sent::Packet::new(
            packet::Type::Short,
            pn,
            now() + t,
            ack_eliciting,
            recovery::Tokens::new(),
            100,
        )
    }

    fn congestion_control(cc: CongestionControlAlgorithm) -> Box<dyn CongestionControl> {
        match cc {
            CongestionControlAlgorithm::NewReno => Box::new(ClassicCongestionControl::new(
                NewReno::default(),
                Pmtud::new(IP_ADDR, MTU),
            )),
            CongestionControlAlgorithm::Cubic => Box::new(ClassicCongestionControl::new(
                Cubic::default(),
                Pmtud::new(IP_ADDR, MTU),
            )),
        }
    }

    fn persistent_congestion_by_algorithm(
        mut cc: Box<dyn CongestionControl>,
        reduced_cwnd: usize,
        lost_packets: &[sent::Packet],
        persistent_expected: bool,
    ) {
        for p in lost_packets {
            cc.on_packet_sent(p, now());
        }

        cc.on_packets_lost(Some(now()), None, PTO, lost_packets, Instant::now());

        let persistent = if cc.cwnd() == reduced_cwnd {
            false
        } else if cc.cwnd() == cc.cwnd_min() {
            true
        } else {
            panic!("unexpected cwnd");
        };
        assert_eq!(persistent, persistent_expected);
    }

    fn persistent_congestion(lost_packets: &[sent::Packet], persistent_expected: bool) {
        let cc = congestion_control(CongestionControlAlgorithm::NewReno);
        let cwnd_initial = cc.cwnd_initial();
        persistent_congestion_by_algorithm(cc, cwnd_initial / 2, lost_packets, persistent_expected);

        let cc = congestion_control(CongestionControlAlgorithm::Cubic);
        let cwnd_initial = cc.cwnd_initial();
        persistent_congestion_by_algorithm(
            cc,
            cwnd_initial * CUBIC_BETA_USIZE_DIVIDEND / CUBIC_BETA_USIZE_DIVISOR,
            lost_packets,
            persistent_expected,
        );
    }

    /// A span of exactly the PC threshold only reduces the window on loss.
    #[test]
    fn persistent_congestion_none() {
        persistent_congestion(&[lost(1, true, ZERO), lost(2, true, SUB_PC)], false);
    }

    /// A span of just more than the PC threshold causes persistent congestion.
    #[test]
    fn persistent_congestion_simple() {
        persistent_congestion(&[lost(1, true, ZERO), lost(2, true, PC)], true);
    }

    /// Both packets need to be ack-eliciting.
    #[test]
    fn persistent_congestion_non_ack_eliciting() {
        persistent_congestion(&[lost(1, false, ZERO), lost(2, true, PC)], false);
        persistent_congestion(&[lost(1, true, ZERO), lost(2, false, PC)], false);
    }

    /// Packets in the middle, of any type, are OK.
    #[test]
    fn persistent_congestion_middle() {
        persistent_congestion(
            &[lost(1, true, ZERO), lost(2, false, RTT), lost(3, true, PC)],
            true,
        );
        persistent_congestion(
            &[lost(1, true, ZERO), lost(2, true, RTT), lost(3, true, PC)],
            true,
        );
    }

    /// Leading non-ack-eliciting packets are skipped.
    #[test]
    fn persistent_congestion_leading_non_ack_eliciting() {
        persistent_congestion(
            &[lost(1, false, ZERO), lost(2, true, RTT), lost(3, true, PC)],
            false,
        );
        persistent_congestion(
            &[
                lost(1, false, ZERO),
                lost(2, true, RTT),
                lost(3, true, RTT + PC),
            ],
            true,
        );
    }

    /// Trailing non-ack-eliciting packets aren't relevant.
    #[test]
    fn persistent_congestion_trailing_non_ack_eliciting() {
        persistent_congestion(
            &[
                lost(1, true, ZERO),
                lost(2, true, PC),
                lost(3, false, PC + EPSILON),
            ],
            true,
        );
        persistent_congestion(
            &[
                lost(1, true, ZERO),
                lost(2, true, SUB_PC),
                lost(3, false, PC),
            ],
            false,
        );
    }

    /// Gaps in the middle, of any type, restart the count.
    #[test]
    fn persistent_congestion_gap_reset() {
        persistent_congestion(&[lost(1, true, ZERO), lost(3, true, PC)], false);
        persistent_congestion(
            &[
                lost(1, true, ZERO),
                lost(2, true, RTT),
                lost(4, true, GAP),
                lost(5, true, GAP + PTO * PERSISTENT_CONG_THRESH),
            ],
            false,
        );
    }

    /// A span either side of a gap will cause persistent congestion.
    #[test]
    fn persistent_congestion_gap_or() {
        persistent_congestion(
            &[
                lost(1, true, ZERO),
                lost(2, true, PC),
                lost(4, true, GAP),
                lost(5, true, GAP + PTO),
            ],
            true,
        );
        persistent_congestion(
            &[
                lost(1, true, ZERO),
                lost(2, true, PTO),
                lost(4, true, GAP),
                lost(5, true, GAP + PC),
            ],
            true,
        );
    }

    /// A gap only restarts after an ack-eliciting packet.
    #[test]
    fn persistent_congestion_gap_non_ack_eliciting() {
        persistent_congestion(
            &[
                lost(1, true, ZERO),
                lost(2, true, PTO),
                lost(4, false, GAP),
                lost(5, true, GAP + PC),
            ],
            false,
        );
        persistent_congestion(
            &[
                lost(1, true, ZERO),
                lost(2, true, PTO),
                lost(4, false, GAP),
                lost(5, true, GAP + RTT),
                lost(6, true, GAP + RTT + SUB_PC),
            ],
            false,
        );
        persistent_congestion(
            &[
                lost(1, true, ZERO),
                lost(2, true, PTO),
                lost(4, false, GAP),
                lost(5, true, GAP + RTT),
                lost(6, true, GAP + RTT + PC),
            ],
            true,
        );
    }

    /// Get a time, in multiples of `PTO`, relative to `now()`.
    fn by_pto(t: u32) -> Instant {
        now() + (PTO * t)
    }

    /// Make packets that will be made lost.
    /// `times` is the time of sending, in multiples of `PTO`, relative to `now()`.
    fn make_lost(times: &[u32]) -> Vec<sent::Packet> {
        times
            .iter()
            .enumerate()
            .map(|(i, &t)| {
                sent::Packet::new(
                    packet::Type::Short,
                    u64::try_from(i).unwrap(),
                    by_pto(t),
                    true,
                    recovery::Tokens::new(),
                    1000,
                )
            })
            .collect::<Vec<_>>()
    }

    /// Call `detect_persistent_congestion` using times relative to now and the fixed PTO time.
    /// `last_ack` and `rtt_time` are times in multiples of `PTO`, relative to `now()`,
    /// for the time of the largest acknowledged and the first RTT sample, respectively.
    fn persistent_congestion_by_pto<T: WindowAdjustment>(
        mut cc: ClassicCongestionControl<T>,
        last_ack: u32,
        rtt_time: u32,
        lost: &[sent::Packet],
    ) -> bool {
        let now = Instant::now();
        assert_eq!(cc.cwnd(), cc.cwnd_initial());

        let last_ack = Some(by_pto(last_ack));
        let rtt_time = Some(by_pto(rtt_time));

        // Persistent congestion is never declared if the RTT time is `None`.
        cc.detect_persistent_congestion(None, None, PTO, lost.iter(), now);
        assert_eq!(cc.cwnd(), cc.cwnd_initial());
        cc.detect_persistent_congestion(None, last_ack, PTO, lost.iter(), now);
        assert_eq!(cc.cwnd(), cc.cwnd_initial());

        cc.detect_persistent_congestion(rtt_time, last_ack, PTO, lost.iter(), now);
        cc.cwnd() == cc.cwnd_min()
    }

    /// No persistent congestion can be had if there are no lost packets.
    #[test]
    fn persistent_congestion_no_lost() {
        let lost = make_lost(&[]);
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            0,
            &lost
        ));
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(Cubic::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            0,
            &lost
        ));
    }

    /// No persistent congestion can be had if there is only one lost packet.
    #[test]
    fn persistent_congestion_one_lost() {
        let lost = make_lost(&[1]);
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            0,
            &lost
        ));
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(Cubic::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            0,
            &lost
        ));
    }

    /// Persistent congestion can't happen based on old packets.
    #[test]
    fn persistent_congestion_past() {
        // Packets sent prior to either the last acknowledged or the first RTT
        // sample are not considered.  So 0 is ignored.
        let lost = make_lost(&[0, PERSISTENT_CONG_THRESH + 1, PERSISTENT_CONG_THRESH + 2]);
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU)),
            1,
            1,
            &lost
        ));
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            1,
            &lost
        ));
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU)),
            1,
            0,
            &lost
        ));
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(Cubic::default(), Pmtud::new(IP_ADDR, MTU)),
            1,
            1,
            &lost
        ));
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(Cubic::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            1,
            &lost
        ));
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(Cubic::default(), Pmtud::new(IP_ADDR, MTU)),
            1,
            0,
            &lost
        ));
    }

    /// Persistent congestion doesn't start unless the packet is ack-eliciting.
    #[test]
    fn persistent_congestion_ack_eliciting() {
        let mut lost = make_lost(&[1, PERSISTENT_CONG_THRESH + 2]);
        lost[0] = sent::Packet::new(
            lost[0].packet_type(),
            lost[0].pn(),
            lost[0].time_sent(),
            false,
            lost[0].tokens().clone(),
            lost[0].len(),
        );
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            0,
            &lost
        ));
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(Cubic::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            0,
            &lost
        ));
    }

    /// Detect persistent congestion.  Note that the first lost packet needs to have a time
    /// greater than the previously acknowledged packet AND the first RTT sample.  And the
    /// difference in times needs to be greater than the persistent congestion threshold.
    #[test]
    fn persistent_congestion_min() {
        let lost = make_lost(&[1, PERSISTENT_CONG_THRESH + 2]);
        assert!(persistent_congestion_by_pto(
            ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            0,
            &lost
        ));
        assert!(persistent_congestion_by_pto(
            ClassicCongestionControl::new(Cubic::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            0,
            &lost
        ));
    }

    /// Make sure that not having a previous largest acknowledged also results
    /// in detecting persistent congestion.  (This is not expected to happen, but
    /// the code permits it).
    #[test]
    fn persistent_congestion_no_prev_ack_newreno() {
        let lost = make_lost(&[1, PERSISTENT_CONG_THRESH + 2]);
        let mut cc = ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU));
        cc.detect_persistent_congestion(Some(by_pto(0)), None, PTO, lost.iter(), Instant::now());
        assert_eq!(cc.cwnd(), cc.cwnd_min());
    }

    #[test]
    fn persistent_congestion_no_prev_ack_cubic() {
        let lost = make_lost(&[1, PERSISTENT_CONG_THRESH + 2]);
        let mut cc = ClassicCongestionControl::new(Cubic::default(), Pmtud::new(IP_ADDR, MTU));
        cc.detect_persistent_congestion(Some(by_pto(0)), None, PTO, lost.iter(), Instant::now());
        assert_eq!(cc.cwnd(), cc.cwnd_min());
    }

    /// The code asserts on ordering errors.
    #[test]
    #[should_panic(expected = "time is monotonic")]
    fn persistent_congestion_unsorted_newreno() {
        let lost = make_lost(&[PERSISTENT_CONG_THRESH + 2, 1]);
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            0,
            &lost
        ));
    }

    /// The code asserts on ordering errors.
    #[test]
    #[should_panic(expected = "time is monotonic")]
    fn persistent_congestion_unsorted_cubic() {
        let lost = make_lost(&[PERSISTENT_CONG_THRESH + 2, 1]);
        assert!(!persistent_congestion_by_pto(
            ClassicCongestionControl::new(Cubic::default(), Pmtud::new(IP_ADDR, MTU)),
            0,
            0,
            &lost
        ));
    }

    #[test]
    fn app_limited_slow_start() {
        const BELOW_APP_LIMIT_PKTS: usize = 5;
        const ABOVE_APP_LIMIT_PKTS: usize = BELOW_APP_LIMIT_PKTS + 1;
        let mut cc = ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU));
        let cwnd = cc.congestion_window;
        let mut now = now();
        let mut next_pn = 0;

        // simulate packet bursts below app_limit
        for packet_burst_size in 1..=BELOW_APP_LIMIT_PKTS {
            // always stay below app_limit during sent.
            let mut pkts = Vec::new();
            for _ in 0..packet_burst_size {
                let p = sent::Packet::new(
                    packet::Type::Short,
                    next_pn,
                    now,
                    true,
                    recovery::Tokens::new(),
                    cc.max_datagram_size(),
                );
                next_pn += 1;
                cc.on_packet_sent(&p, now);
                pkts.push(p);
            }
            assert_eq!(
                cc.bytes_in_flight(),
                packet_burst_size * cc.max_datagram_size()
            );
            now += RTT;
            cc.on_packets_acked(&pkts, &RttEstimate::default(), now);
            assert_eq!(cc.bytes_in_flight(), 0);
            assert_eq!(cc.acked_bytes, 0);
            assert_eq!(cwnd, cc.congestion_window); // CWND doesn't grow because we're app limited
        }

        // Fully utilize the congestion window by sending enough packets to
        // have `bytes_in_flight` above the `app_limited` threshold.
        let mut pkts = Vec::new();
        for _ in 0..ABOVE_APP_LIMIT_PKTS {
            let p = sent::Packet::new(
                packet::Type::Short,
                next_pn,
                now,
                true,
                recovery::Tokens::new(),
                cc.max_datagram_size(),
            );
            next_pn += 1;
            cc.on_packet_sent(&p, now);
            pkts.push(p);
        }
        assert_eq!(
            cc.bytes_in_flight(),
            ABOVE_APP_LIMIT_PKTS * cc.max_datagram_size()
        );
        now += RTT;
        // Check if congestion window gets increased for all packets currently in flight
        for (i, pkt) in pkts.into_iter().enumerate() {
            cc.on_packets_acked(&[pkt], &RttEstimate::default(), now);

            assert_eq!(
                cc.bytes_in_flight(),
                (ABOVE_APP_LIMIT_PKTS - i - 1) * cc.max_datagram_size()
            );
            // increase acked_bytes with each packet
            qinfo!(
                "{} {}",
                cc.congestion_window,
                cwnd + i * cc.max_datagram_size()
            );
            assert_eq!(
                cc.congestion_window,
                cwnd + (i + 1) * cc.max_datagram_size()
            );
            assert_eq!(cc.acked_bytes, 0);
        }
    }

    #[test]
    fn app_limited_congestion_avoidance() {
        const CWND_PKTS_CA: usize = CWND_INITIAL_PKTS / 2;
        const BELOW_APP_LIMIT_PKTS: usize = CWND_PKTS_CA - 2;
        const ABOVE_APP_LIMIT_PKTS: usize = BELOW_APP_LIMIT_PKTS + 1;

        let mut cc = ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU));
        let mut now = now();

        // Change state to congestion avoidance by introducing loss.

        let p_lost = sent::Packet::new(
            packet::Type::Short,
            1,
            now,
            true,
            recovery::Tokens::new(),
            cc.max_datagram_size(),
        );
        cc.on_packet_sent(&p_lost, now);
        cwnd_is_default(&cc);
        now += PTO;
        cc.on_packets_lost(Some(now), None, PTO, &[p_lost], now);
        cwnd_is_halved(&cc);
        let p_not_lost = sent::Packet::new(
            packet::Type::Short,
            2,
            now,
            true,
            recovery::Tokens::new(),
            cc.max_datagram_size(),
        );
        cc.on_packet_sent(&p_not_lost, now);
        now += RTT;
        cc.on_packets_acked(&[p_not_lost], &RttEstimate::default(), now);
        cwnd_is_halved(&cc);
        // cc is app limited therefore cwnd in not increased.
        assert_eq!(cc.acked_bytes, 0);

        // Now we are in the congestion avoidance state.
        assert_eq!(cc.state, State::CongestionAvoidance);
        // simulate packet bursts below app_limit
        let mut next_pn = 3;
        for packet_burst_size in 1..=BELOW_APP_LIMIT_PKTS {
            // always stay below app_limit during sent.
            let mut pkts = Vec::new();
            for _ in 0..packet_burst_size {
                let p = sent::Packet::new(
                    packet::Type::Short,
                    next_pn,
                    now,
                    true,
                    recovery::Tokens::new(),
                    cc.max_datagram_size(),
                );
                next_pn += 1;
                cc.on_packet_sent(&p, now);
                pkts.push(p);
            }
            assert_eq!(
                cc.bytes_in_flight(),
                packet_burst_size * cc.max_datagram_size()
            );
            now += RTT;
            for (i, pkt) in pkts.into_iter().enumerate() {
                cc.on_packets_acked(&[pkt], &RttEstimate::default(), now);

                assert_eq!(
                    cc.bytes_in_flight(),
                    (packet_burst_size - i - 1) * cc.max_datagram_size()
                );
                cwnd_is_halved(&cc); // CWND doesn't grow because we're app limited
                assert_eq!(cc.acked_bytes, 0);
            }
        }

        // Fully utilize the congestion window by sending enough packets to
        // have `bytes_in_flight` above the `app_limited` threshold.
        let mut pkts = Vec::new();
        for _ in 0..ABOVE_APP_LIMIT_PKTS {
            let p = sent::Packet::new(
                packet::Type::Short,
                next_pn,
                now,
                true,
                recovery::Tokens::new(),
                cc.max_datagram_size(),
            );
            next_pn += 1;
            cc.on_packet_sent(&p, now);
            pkts.push(p);
        }
        assert_eq!(
            cc.bytes_in_flight(),
            ABOVE_APP_LIMIT_PKTS * cc.max_datagram_size()
        );
        now += RTT;
        let mut last_acked_bytes = 0;
        // Check if congestion window gets increased for all packets currently in flight
        for (i, pkt) in pkts.into_iter().enumerate() {
            cc.on_packets_acked(&[pkt], &RttEstimate::default(), now);

            assert_eq!(
                cc.bytes_in_flight(),
                (ABOVE_APP_LIMIT_PKTS - i - 1) * cc.max_datagram_size()
            );
            // The cwnd doesn't increase, but the acked_bytes do, which will eventually lead to an
            // increase, once the number of bytes reaches the necessary level
            cwnd_is_halved(&cc);
            // increase acked_bytes with each packet
            assert_ne!(cc.acked_bytes, last_acked_bytes);
            last_acked_bytes = cc.acked_bytes;
        }
    }

    #[test]
    fn ecn_ce() {
        let now = now();
        let mut cc = ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU));
        let p_ce = sent::Packet::new(
            packet::Type::Short,
            1,
            now,
            true,
            recovery::Tokens::new(),
            cc.max_datagram_size(),
        );
        cc.on_packet_sent(&p_ce, now);
        cwnd_is_default(&cc);
        assert_eq!(cc.state, State::SlowStart);

        // Signal congestion (ECN CE) and thus change state to recovery start.
        cc.on_ecn_ce_received(&p_ce, now);
        cwnd_is_halved(&cc);
        assert_eq!(cc.state, State::RecoveryStart);
    }
}
