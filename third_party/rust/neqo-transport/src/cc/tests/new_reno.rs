// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

// Congestion control

use std::time::Duration;

use test_fixture::now;

use super::{IP_ADDR, MTU, RTT};
use crate::{
    cc::{new_reno::NewReno, ClassicCongestionControl, CongestionControl as _},
    packet,
    pmtud::Pmtud,
    recovery::{self, sent},
    rtt::RttEstimate,
};

const PTO: Duration = RTT;

fn cwnd_is_default(cc: &ClassicCongestionControl<NewReno>) {
    assert_eq!(cc.cwnd(), cc.cwnd_initial());
    assert_eq!(cc.ssthresh(), usize::MAX);
}

fn cwnd_is_halved(cc: &ClassicCongestionControl<NewReno>) {
    assert_eq!(cc.cwnd(), cc.cwnd_initial() / 2);
    assert_eq!(cc.ssthresh(), cc.cwnd_initial() / 2);
}

#[test]
fn issue_876() {
    let mut cc = ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU));
    let now = now();
    let before = now.checked_sub(Duration::from_millis(100)).unwrap();
    let after = now + Duration::from_millis(150);

    let sent_packets = &[
        sent::Packet::new(
            packet::Type::Short,
            1,
            before,
            true,
            recovery::Tokens::new(),
            cc.max_datagram_size() - 1,
        ),
        sent::Packet::new(
            packet::Type::Short,
            2,
            before,
            true,
            recovery::Tokens::new(),
            cc.max_datagram_size() - 2,
        ),
        sent::Packet::new(
            packet::Type::Short,
            3,
            before,
            true,
            recovery::Tokens::new(),
            cc.max_datagram_size(),
        ),
        sent::Packet::new(
            packet::Type::Short,
            4,
            before,
            true,
            recovery::Tokens::new(),
            cc.max_datagram_size(),
        ),
        sent::Packet::new(
            packet::Type::Short,
            5,
            before,
            true,
            recovery::Tokens::new(),
            cc.max_datagram_size(),
        ),
        sent::Packet::new(
            packet::Type::Short,
            6,
            before,
            true,
            recovery::Tokens::new(),
            cc.max_datagram_size(),
        ),
        sent::Packet::new(
            packet::Type::Short,
            7,
            after,
            true,
            recovery::Tokens::new(),
            cc.max_datagram_size() - 3,
        ),
    ];

    // Send some more packets so that the cc is not app-limited.
    for p in &sent_packets[..6] {
        cc.on_packet_sent(p, now);
    }
    assert_eq!(cc.acked_bytes(), 0);
    cwnd_is_default(&cc);
    assert_eq!(cc.bytes_in_flight(), 6 * cc.max_datagram_size() - 3);

    cc.on_packets_lost(Some(now), None, PTO, &sent_packets[0..1], now);

    // We are now in recovery
    assert!(cc.recovery_packet());
    assert_eq!(cc.acked_bytes(), 0);
    cwnd_is_halved(&cc);
    assert_eq!(cc.bytes_in_flight(), 5 * cc.max_datagram_size() - 2);

    // Send a packet after recovery starts
    cc.on_packet_sent(&sent_packets[6], now);
    assert!(!cc.recovery_packet());
    cwnd_is_halved(&cc);
    assert_eq!(cc.acked_bytes(), 0);
    assert_eq!(cc.bytes_in_flight(), 6 * cc.max_datagram_size() - 5);

    // and ack it. cwnd increases slightly
    cc.on_packets_acked(&sent_packets[6..], &RttEstimate::default(), now);
    assert_eq!(cc.acked_bytes(), sent_packets[6].len());
    cwnd_is_halved(&cc);
    assert_eq!(cc.bytes_in_flight(), 5 * cc.max_datagram_size() - 2);

    // Packet from before is lost. Should not hurt cwnd.
    cc.on_packets_lost(Some(now), None, PTO, &sent_packets[1..2], now);
    assert!(!cc.recovery_packet());
    assert_eq!(cc.acked_bytes(), sent_packets[6].len());
    cwnd_is_halved(&cc);
    assert_eq!(cc.bytes_in_flight(), 4 * cc.max_datagram_size());
}

#[test]
// https://github.com/mozilla/neqo/pull/1465
fn issue_1465() {
    let mut cc = ClassicCongestionControl::new(NewReno::default(), Pmtud::new(IP_ADDR, MTU));
    let mut pn = 0;
    let mut now = now();
    let max_datagram_size = cc.max_datagram_size();
    let mut next_packet = |now| {
        let p = sent::Packet::new(
            packet::Type::Short,
            pn,
            now,
            true,
            recovery::Tokens::new(),
            max_datagram_size,
        );
        pn += 1;
        p
    };
    let mut send_next = |cc: &mut ClassicCongestionControl<NewReno>, now| {
        let p = next_packet(now);
        cc.on_packet_sent(&p, now);
        p
    };

    let p1 = send_next(&mut cc, now);
    let p2 = send_next(&mut cc, now);
    let p3 = send_next(&mut cc, now);

    assert_eq!(cc.acked_bytes(), 0);
    cwnd_is_default(&cc);
    assert_eq!(cc.bytes_in_flight(), 3 * cc.max_datagram_size());

    // advance one rtt to detect lost packet there this simplifies the timers, because
    // on_packet_loss would only be called after RTO, but that is not relevant to the problem
    now += RTT;
    cc.on_packets_lost(Some(now), None, PTO, &[p1], now);

    // We are now in recovery
    assert!(cc.recovery_packet());
    assert_eq!(cc.acked_bytes(), 0);
    cwnd_is_halved(&cc);
    assert_eq!(cc.bytes_in_flight(), 2 * cc.max_datagram_size());

    // Don't reduce the cwnd again on second packet loss
    cc.on_packets_lost(Some(now), None, PTO, &[p3], now);
    assert_eq!(cc.acked_bytes(), 0);
    cwnd_is_halved(&cc); // still the same as after first packet loss
    assert_eq!(cc.bytes_in_flight(), cc.max_datagram_size());

    // the acked packets before on_packet_sent were the cause of
    // https://github.com/mozilla/neqo/pull/1465
    cc.on_packets_acked(&[p2], &RttEstimate::default(), now);

    assert_eq!(cc.bytes_in_flight(), 0);

    // send out recovery packet and get it acked to get out of recovery state
    let p4 = send_next(&mut cc, now);
    cc.on_packet_sent(&p4, now);
    now += RTT;
    cc.on_packets_acked(&[p4], &RttEstimate::default(), now);

    // do the same as in the first rtt but now the bug appears
    let p5 = send_next(&mut cc, now);
    let p6 = send_next(&mut cc, now);
    now += RTT;

    let cur_cwnd = cc.cwnd();
    cc.on_packets_lost(Some(now), None, PTO, &[p5], now);

    // go back into recovery
    assert!(cc.recovery_packet());
    assert_eq!(cc.cwnd(), cur_cwnd / 2);
    assert_eq!(cc.acked_bytes(), 0);
    assert_eq!(cc.bytes_in_flight(), 2 * cc.max_datagram_size());

    // this shouldn't introduce further cwnd reduction, but it did before https://github.com/mozilla/neqo/pull/1465
    cc.on_packets_lost(Some(now), None, PTO, &[p6], now);
    assert_eq!(cc.cwnd(), cur_cwnd / 2);
}
