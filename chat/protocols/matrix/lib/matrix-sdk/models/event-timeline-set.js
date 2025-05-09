"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.EventTimelineSet = exports.DuplicateStrategy = void 0;
var _eventTimeline = require("./event-timeline.js");
var _logger = require("../logger.js");
var _room = require("./room.js");
var _typedEventEmitter = require("./typed-event-emitter.js");
var _relationsContainer = require("./relations-container.js");
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == typeof i ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != typeof t || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != typeof i) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); } /*
Copyright 2016 - 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
const DEBUG = true;

/* istanbul ignore next */
let debuglog;
if (DEBUG) {
  // using bind means that we get to keep useful line numbers in the console
  debuglog = _logger.logger.log.bind(_logger.logger);
} else {
  /* istanbul ignore next */
  debuglog = function () {};
}
let DuplicateStrategy = exports.DuplicateStrategy = /*#__PURE__*/function (DuplicateStrategy) {
  DuplicateStrategy["Ignore"] = "ignore";
  DuplicateStrategy["Replace"] = "replace";
  return DuplicateStrategy;
}({});
class EventTimelineSet extends _typedEventEmitter.TypedEventEmitter {
  /**
   * Construct a set of EventTimeline objects, typically on behalf of a given
   * room.  A room may have multiple EventTimelineSets for different levels
   * of filtering.  The global notification list is also an EventTimelineSet, but
   * lacks a room.
   *
   * <p>This is an ordered sequence of timelines, which may or may not
   * be continuous. Each timeline lists a series of events, as well as tracking
   * the room state at the start and the end of the timeline (if appropriate).
   * It also tracks forward and backward pagination tokens, as well as containing
   * links to the next timeline in the sequence.
   *
   * <p>There is one special timeline - the 'live' timeline, which represents the
   * timeline to which events are being added in real-time as they are received
   * from the /sync API. Note that you should not retain references to this
   * timeline - even if it is the current timeline right now, it may not remain
   * so if the server gives us a timeline gap in /sync.
   *
   * <p>In order that we can find events from their ids later, we also maintain a
   * map from event_id to timeline and index.
   *
   * @param room - Room for this timelineSet. May be null for non-room cases, such as the
   * notification timeline.
   * @param opts - Options inherited from Room.
   * @param client - the Matrix client which owns this EventTimelineSet,
   * can be omitted if room is specified.
   * @param thread - the thread to which this timeline set relates.
   * @param threadListType - the type of thread list represented, if any
   * (e.g., All threads or My threads)
   */
  constructor(room, opts = {}, client, thread, threadListType = null) {
    super();
    this.room = room;
    this.thread = thread;
    this.threadListType = threadListType;
    _defineProperty(this, "relations", void 0);
    _defineProperty(this, "timelineSupport", void 0);
    _defineProperty(this, "displayPendingEvents", void 0);
    _defineProperty(this, "liveTimeline", void 0);
    _defineProperty(this, "timelines", void 0);
    _defineProperty(this, "_eventIdToTimeline", new Map());
    _defineProperty(this, "filter", void 0);
    this.timelineSupport = Boolean(opts.timelineSupport);
    this.liveTimeline = new _eventTimeline.EventTimeline(this);
    this.displayPendingEvents = opts.pendingEvents !== false;

    // just a list - *not* ordered.
    this.timelines = [this.liveTimeline];
    this._eventIdToTimeline = new Map();
    this.filter = opts.filter;
    this.relations = this.room?.relations ?? new _relationsContainer.RelationsContainer(room?.client ?? client);
  }

  /**
   * Get all the timelines in this set
   * @returns the timelines in this set
   */
  getTimelines() {
    return this.timelines;
  }

  /**
   * Get the filter object this timeline set is filtered on, if any
   * @returns the optional filter for this timelineSet
   */
  getFilter() {
    return this.filter;
  }

  /**
   * Set the filter object this timeline set is filtered on
   * (passed to the server when paginating via /messages).
   * @param filter - the filter for this timelineSet
   */
  setFilter(filter) {
    this.filter = filter;
  }

  /**
   * Get the list of pending sent events for this timelineSet's room, filtered
   * by the timelineSet's filter if appropriate.
   *
   * @returns A list of the sent events
   * waiting for remote echo.
   *
   * @throws If `opts.pendingEventOrdering` was not 'detached'
   */
  getPendingEvents() {
    if (!this.room || !this.displayPendingEvents) {
      return [];
    }
    return this.room.getPendingEvents();
  }
  /**
   * Get the live timeline for this room.
   *
   * @returns live timeline
   */
  getLiveTimeline() {
    return this.liveTimeline;
  }

  /**
   * Set the live timeline for this room.
   *
   * @returns live timeline
   */
  setLiveTimeline(timeline) {
    this.liveTimeline = timeline;
  }

  /**
   * Return the timeline (if any) this event is in.
   * @param eventId - the eventId being sought
   * @returns timeline
   */
  eventIdToTimeline(eventId) {
    return this._eventIdToTimeline.get(eventId);
  }

  /**
   * Track a new event as if it were in the same timeline as an old event,
   * replacing it.
   * @param oldEventId -  event ID of the original event
   * @param newEventId -  event ID of the replacement event
   */
  replaceEventId(oldEventId, newEventId) {
    const existingTimeline = this._eventIdToTimeline.get(oldEventId);
    if (existingTimeline) {
      this._eventIdToTimeline.delete(oldEventId);
      this._eventIdToTimeline.set(newEventId, existingTimeline);
    }
  }

  /**
   * Reset the live timeline, and start a new one.
   *
   * <p>This is used when /sync returns a 'limited' timeline.
   *
   * @param backPaginationToken -   token for back-paginating the new timeline
   * @param forwardPaginationToken - token for forward-paginating the old live timeline,
   * if absent or null, all timelines are reset.
   *
   * @remarks
   * Fires {@link RoomEvent.TimelineReset}
   */
  resetLiveTimeline(backPaginationToken, forwardPaginationToken) {
    // Each EventTimeline has RoomState objects tracking the state at the start
    // and end of that timeline. The copies at the end of the live timeline are
    // special because they will have listeners attached to monitor changes to
    // the current room state, so we move this RoomState from the end of the
    // current live timeline to the end of the new one and, if necessary,
    // replace it with a newly created one. We also make a copy for the start
    // of the new timeline.

    // if timeline support is disabled, forget about the old timelines
    const resetAllTimelines = !this.timelineSupport || !forwardPaginationToken;
    const oldTimeline = this.liveTimeline;
    const newTimeline = resetAllTimelines ? oldTimeline.forkLive(_eventTimeline.EventTimeline.FORWARDS) : oldTimeline.fork(_eventTimeline.EventTimeline.FORWARDS);
    if (resetAllTimelines) {
      this.timelines = [newTimeline];
      this._eventIdToTimeline = new Map();
    } else {
      this.timelines.push(newTimeline);
    }
    if (forwardPaginationToken) {
      // Now set the forward pagination token on the old live timeline
      // so it can be forward-paginated.
      oldTimeline.setPaginationToken(forwardPaginationToken, _eventTimeline.EventTimeline.FORWARDS);
    }

    // make sure we set the pagination token before firing timelineReset,
    // otherwise clients which start back-paginating will fail, and then get
    // stuck without realising that they *can* back-paginate.
    newTimeline.setPaginationToken(backPaginationToken ?? null, _eventTimeline.EventTimeline.BACKWARDS);

    // Now we can swap the live timeline to the new one.
    this.liveTimeline = newTimeline;
    this.emit(_room.RoomEvent.TimelineReset, this.room, this, resetAllTimelines);
  }

  /**
   * Get the timeline which contains the given event, if any
   *
   * @param eventId -  event ID to look for
   * @returns timeline containing
   * the given event, or null if unknown
   */
  getTimelineForEvent(eventId) {
    if (eventId === null || eventId === undefined) {
      return null;
    }
    const res = this._eventIdToTimeline.get(eventId);
    return res === undefined ? null : res;
  }

  /**
   * Get an event which is stored in our timelines
   *
   * @param eventId -  event ID to look for
   * @returns the given event, or undefined if unknown
   */
  findEventById(eventId) {
    const tl = this.getTimelineForEvent(eventId);
    if (!tl) {
      return undefined;
    }
    return tl.getEvents().find(function (ev) {
      return ev.getId() == eventId;
    });
  }

  /**
   * Add a new timeline to this timeline list
   *
   * @returns newly-created timeline
   */
  addTimeline() {
    if (!this.timelineSupport) {
      throw new Error("timeline support is disabled. Set the 'timelineSupport'" + " parameter to true when creating MatrixClient to enable" + " it.");
    }
    const timeline = new _eventTimeline.EventTimeline(this);
    this.timelines.push(timeline);
    return timeline;
  }

  /**
   * Add events to a timeline
   *
   * <p>Will fire "Room.timeline" for each event added.
   *
   * @param events - A list of events to add.
   *
   * @param toStartOfTimeline -   True to add these events to the start
   * (oldest) instead of the end (newest) of the timeline. If true, the oldest
   * event will be the <b>last</b> element of 'events'.
   *
   * @param timeline -   timeline to
   *    add events to.
   *
   * @param paginationToken -   token for the next batch of events
   *
   * @remarks
   * Fires {@link RoomEvent.Timeline}
   *
   */
  addEventsToTimeline(events, toStartOfTimeline, timeline, paginationToken) {
    if (!timeline) {
      throw new Error("'timeline' not specified for EventTimelineSet.addEventsToTimeline");
    }
    if (!toStartOfTimeline && timeline == this.liveTimeline) {
      throw new Error("EventTimelineSet.addEventsToTimeline cannot be used for adding events to " + "the live timeline - use Room.addLiveEvents instead");
    }
    if (this.filter) {
      events = this.filter.filterRoomTimeline(events);
      if (!events.length) {
        return;
      }
    }
    const direction = toStartOfTimeline ? _eventTimeline.EventTimeline.BACKWARDS : _eventTimeline.EventTimeline.FORWARDS;
    const inverseDirection = toStartOfTimeline ? _eventTimeline.EventTimeline.FORWARDS : _eventTimeline.EventTimeline.BACKWARDS;

    // Adding events to timelines can be quite complicated. The following
    // illustrates some of the corner-cases.
    //
    // Let's say we start by knowing about four timelines. timeline3 and
    // timeline4 are neighbours:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M]          [P]          [S] <------> [T]
    //
    // Now we paginate timeline1, and get the following events from the server:
    // [M, N, P, R, S, T, U].
    //
    // 1. First, we ignore event M, since we already know about it.
    //
    // 2. Next, we append N to timeline 1.
    //
    // 3. Next, we don't add event P, since we already know about it,
    //    but we do link together the timelines. We now have:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P]          [S] <------> [T]
    //
    // 4. Now we add event R to timeline2:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P, R]       [S] <------> [T]
    //
    //    Note that we have switched the timeline we are working on from
    //    timeline1 to timeline2.
    //
    // 5. We ignore event S, but again join the timelines:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P, R] <---> [S] <------> [T]
    //
    // 6. We ignore event T, and the timelines are already joined, so there
    //    is nothing to do.
    //
    // 7. Finally, we add event U to timeline4:
    //
    //    timeline1    timeline2    timeline3    timeline4
    //      [M, N] <---> [P, R] <---> [S] <------> [T, U]
    //
    // The important thing to note in the above is what happened when we
    // already knew about a given event:
    //
    //   - if it was appropriate, we joined up the timelines (steps 3, 5).
    //   - in any case, we started adding further events to the timeline which
    //       contained the event we knew about (steps 3, 5, 6).
    //
    //
    // So much for adding events to the timeline. But what do we want to do
    // with the pagination token?
    //
    // In the case above, we will be given a pagination token which tells us how to
    // get events beyond 'U' - in this case, it makes sense to store this
    // against timeline4. But what if timeline4 already had 'U' and beyond? in
    // that case, our best bet is to throw away the pagination token we were
    // given and stick with whatever token timeline4 had previously. In short,
    // we want to only store the pagination token if the last event we receive
    // is one we didn't previously know about.
    //
    // We make an exception for this if it turns out that we already knew about
    // *all* of the events, and we weren't able to join up any timelines. When
    // that happens, it means our existing pagination token is faulty, since it
    // is only telling us what we already know. Rather than repeatedly
    // paginating with the same token, we might as well use the new pagination
    // token in the hope that we eventually work our way out of the mess.

    let didUpdate = false;
    let lastEventWasNew = false;
    for (const event of events) {
      const eventId = event.getId();
      const existingTimeline = this._eventIdToTimeline.get(eventId);
      if (!existingTimeline) {
        // we don't know about this event yet. Just add it to the timeline.
        this.addEventToTimeline(event, timeline, {
          toStartOfTimeline
        });
        lastEventWasNew = true;
        didUpdate = true;
        continue;
      }
      lastEventWasNew = false;
      if (existingTimeline == timeline) {
        debuglog("Event " + eventId + " already in timeline " + timeline);
        continue;
      }
      const neighbour = timeline.getNeighbouringTimeline(direction);
      if (neighbour) {
        // this timeline already has a neighbour in the relevant direction;
        // let's assume the timelines are already correctly linked up, and
        // skip over to it.
        //
        // there's probably some edge-case here where we end up with an
        // event which is in a timeline a way down the chain, and there is
        // a break in the chain somewhere. But I can't really imagine how
        // that would happen, so I'm going to ignore it for now.
        //
        if (existingTimeline == neighbour) {
          debuglog("Event " + eventId + " in neighbouring timeline - " + "switching to " + existingTimeline);
        } else {
          debuglog("Event " + eventId + " already in a different " + "timeline " + existingTimeline);
        }
        timeline = existingTimeline;
        continue;
      }

      // time to join the timelines.
      _logger.logger.info("Already have timeline for " + eventId + " - joining timeline " + timeline + " to " + existingTimeline);

      // Variables to keep the line length limited below.
      const existingIsLive = existingTimeline === this.liveTimeline;
      const timelineIsLive = timeline === this.liveTimeline;
      const backwardsIsLive = direction === _eventTimeline.EventTimeline.BACKWARDS && existingIsLive;
      const forwardsIsLive = direction === _eventTimeline.EventTimeline.FORWARDS && timelineIsLive;
      if (backwardsIsLive || forwardsIsLive) {
        // The live timeline should never be spliced into a non-live position.
        // We use independent logging to better discover the problem at a glance.
        if (backwardsIsLive) {
          _logger.logger.warn("Refusing to set a preceding existingTimeLine on our " + "timeline as the existingTimeLine is live (" + existingTimeline + ")");
        }
        if (forwardsIsLive) {
          _logger.logger.warn("Refusing to set our preceding timeline on a existingTimeLine " + "as our timeline is live (" + timeline + ")");
        }
        continue; // abort splicing - try next event
      }
      timeline.setNeighbouringTimeline(existingTimeline, direction);
      existingTimeline.setNeighbouringTimeline(timeline, inverseDirection);
      timeline = existingTimeline;
      didUpdate = true;
    }

    // see above - if the last event was new to us, or if we didn't find any
    // new information, we update the pagination token for whatever
    // timeline we ended up on.
    if (lastEventWasNew || !didUpdate) {
      if (direction === _eventTimeline.EventTimeline.FORWARDS && timeline === this.liveTimeline) {
        _logger.logger.warn({
          lastEventWasNew,
          didUpdate
        }); // for debugging
        _logger.logger.warn(`Refusing to set forwards pagination token of live timeline ` + `${timeline} to ${paginationToken}`);
        return;
      }
      timeline.setPaginationToken(paginationToken ?? null, direction);
    }
  }

  /**
   * Add an event to the end of this live timeline.
   *
   * @param event - Event to be added
   * @param options - addLiveEvent options
   */
  addLiveEvent(event, {
    duplicateStrategy,
    fromCache,
    roomState,
    timelineWasEmpty
  } = {}) {
    if (this.filter) {
      const events = this.filter.filterRoomTimeline([event]);
      if (!events.length) {
        return;
      }
    }
    const timeline = this._eventIdToTimeline.get(event.getId());
    if (timeline) {
      if (duplicateStrategy === DuplicateStrategy.Replace) {
        debuglog("EventTimelineSet.addLiveEvent: replacing duplicate event " + event.getId());
        const tlEvents = timeline.getEvents();
        for (let j = 0; j < tlEvents.length; j++) {
          if (tlEvents[j].getId() === event.getId()) {
            // still need to set the right metadata on this event
            if (!roomState) {
              roomState = timeline.getState(_eventTimeline.EventTimeline.FORWARDS);
            }
            _eventTimeline.EventTimeline.setEventMetadata(event, roomState, false);
            tlEvents[j] = event;

            // XXX: we need to fire an event when this happens.
            break;
          }
        }
      } else {
        debuglog("EventTimelineSet.addLiveEvent: ignoring duplicate event " + event.getId());
      }
      return;
    }
    this.addEventToTimeline(event, this.liveTimeline, {
      toStartOfTimeline: false,
      fromCache,
      roomState,
      timelineWasEmpty
    });
  }

  /**
   * Add event to the given timeline, and emit Room.timeline. Assumes
   * we have already checked we don't know about this event.
   *
   * Will fire "Room.timeline" for each event added.
   *
   * @param event - the event to add
   * @param timeline - the timeline onto which to add it
   * @param options - addEventToTimeline options
   *
   * @remarks
   * Fires {@link RoomEvent.Timeline}
   */

  /**
   * @deprecated In favor of the overload with `IAddEventToTimelineOptions`
   */

  addEventToTimeline(event, timeline, toStartOfTimelineOrOpts, fromCache = false, roomState) {
    let toStartOfTimeline = !!toStartOfTimelineOrOpts;
    let timelineWasEmpty;
    if (typeof toStartOfTimelineOrOpts === "object") {
      ({
        toStartOfTimeline,
        fromCache = false,
        roomState,
        timelineWasEmpty
      } = toStartOfTimelineOrOpts);
    } else if (toStartOfTimelineOrOpts !== undefined) {
      // Deprecation warning
      // FIXME: Remove after 2023-06-01 (technical debt)
      _logger.logger.warn("Overload deprecated: " + "`EventTimelineSet.addEventToTimeline(event, timeline, toStartOfTimeline, fromCache?, roomState?)` " + "is deprecated in favor of the overload with " + "`EventTimelineSet.addEventToTimeline(event, timeline, IAddEventToTimelineOptions)`");
    }
    if (timeline.getTimelineSet() !== this) {
      throw new Error(`EventTimelineSet.addEventToTimeline: Timeline=${timeline.toString()} does not belong " +
                "in timelineSet(threadId=${this.thread?.id})`);
    }
    const eventId = event.getId();
    this.relations.aggregateParentEvent(event);
    this.relations.aggregateChildEvent(event, this);

    // Make sure events don't get mixed in timelines they shouldn't be in (e.g. a
    // threaded message should not be in the main timeline).
    //
    // We can only run this check for timelines with a `room` because `canContain`
    // requires it
    if (this.room && !this.canContain(event)) {
      let eventDebugString = `event=${eventId}`;
      if (event.threadRootId) {
        eventDebugString += `(belongs to thread=${event.threadRootId})`;
      }
      _logger.logger.warn(`EventTimelineSet.addEventToTimeline: Ignoring ${eventDebugString} that does not belong ` + `in timeline=${timeline.toString()} timelineSet(threadId=${this.thread?.id})`);
      return;
    }
    timeline.addEvent(event, {
      toStartOfTimeline,
      roomState,
      timelineWasEmpty
    });
    this._eventIdToTimeline.set(eventId, timeline);
    const data = {
      timeline: timeline,
      liveEvent: !toStartOfTimeline && timeline == this.liveTimeline && !fromCache
    };
    this.emit(_room.RoomEvent.Timeline, event, this.room, Boolean(toStartOfTimeline), false, data);
  }

  /**
   * Insert event to the given timeline, and emit Room.timeline. Assumes
   * we have already checked we don't know about this event.
   *
   * TEMPORARY: until we have recursive relations, we need this function
   * to exist to allow us to insert events in timeline order, which is our
   * best guess for Sync Order.
   * This is a copy of addEventToTimeline above, modified to insert the event
   * after the event it relates to, and before any event with a later
   * timestamp. This is our best guess at Sync Order.
   *
   * Will fire "Room.timeline" for each event added.
   *
   * @internal
   *
   * @remarks
   * Fires {@link RoomEvent.Timeline}
   */
  insertEventIntoTimeline(event, timeline, roomState) {
    if (timeline.getTimelineSet() !== this) {
      throw new Error(`EventTimelineSet.insertEventIntoTimeline: Timeline=${timeline.toString()} does not belong " +
                "in timelineSet(threadId=${this.thread?.id})`);
    }
    const eventId = event.getId();
    this.relations.aggregateParentEvent(event);
    this.relations.aggregateChildEvent(event, this);

    // Make sure events don't get mixed in timelines they shouldn't be in (e.g. a
    // threaded message should not be in the main timeline).
    //
    // We can only run this check for timelines with a `room` because `canContain`
    // requires it
    if (this.room && !this.canContain(event)) {
      let eventDebugString = `event=${eventId}`;
      if (event.threadRootId) {
        eventDebugString += `(belongs to thread=${event.threadRootId})`;
      }
      _logger.logger.warn(`EventTimelineSet.insertEventIntoTimeline: Ignoring ${eventDebugString} that does not belong ` + `in timeline=${timeline.toString()} timelineSet(threadId=${this.thread?.id})`);
      return;
    }

    // Find the event that this event is related to - the "parent"
    const parentEventId = event.relationEventId;
    if (!parentEventId) {
      // Not related to anything - we just append
      this.addEventToTimeline(event, timeline, {
        toStartOfTimeline: false,
        fromCache: false,
        timelineWasEmpty: false,
        roomState
      });
      return;
    }
    const parentEvent = this.findEventById(parentEventId);
    const timelineEvents = timeline.getEvents();

    // Start searching from the parent event, or if it's not loaded, start
    // at the beginning and insert purely using timestamp order.
    const parentIndex = parentEvent !== undefined ? timelineEvents.indexOf(parentEvent) : 0;
    let insertIndex = parentIndex;
    for (; insertIndex < timelineEvents.length; insertIndex++) {
      const nextEvent = timelineEvents[insertIndex];
      if (nextEvent.getTs() > event.getTs()) {
        // We found an event later than ours, so insert before that.
        break;
      }
    }
    // If we got to the end of the loop, insertIndex points at the end of
    // the list.

    timeline.insertEvent(event, insertIndex, roomState);
    this._eventIdToTimeline.set(eventId, timeline);
    const data = {
      timeline: timeline,
      // The purpose of this method is inserting events in the middle of the
      // timeline, so the events are, by definition, not live (whether or not
      // we're adding them to the live timeline).
      liveEvent: false
    };
    this.emit(_room.RoomEvent.Timeline, event, this.room, false, false, data);
  }

  /**
   * Replaces event with ID oldEventId with one with newEventId, if oldEventId is
   * recognised.  Otherwise, add to the live timeline.  Used to handle remote echos.
   *
   * @param localEvent -     the new event to be added to the timeline
   * @param oldEventId -          the ID of the original event
   * @param newEventId -         the ID of the replacement event
   *
   * @remarks
   * Fires {@link RoomEvent.Timeline}
   */
  handleRemoteEcho(localEvent, oldEventId, newEventId) {
    // XXX: why don't we infer newEventId from localEvent?
    const existingTimeline = this._eventIdToTimeline.get(oldEventId);
    if (existingTimeline) {
      this._eventIdToTimeline.delete(oldEventId);
      this._eventIdToTimeline.set(newEventId, existingTimeline);
    } else if (!this.filter || this.filter.filterRoomTimeline([localEvent]).length) {
      this.addEventToTimeline(localEvent, this.liveTimeline, {
        toStartOfTimeline: false
      });
    }
  }

  /**
   * Removes a single event from this room.
   *
   * @param eventId -  The id of the event to remove
   *
   * @returns the removed event, or null if the event was not found
   * in this room.
   */
  removeEvent(eventId) {
    const timeline = this._eventIdToTimeline.get(eventId);
    if (!timeline) {
      return null;
    }
    const removed = timeline.removeEvent(eventId);
    if (removed) {
      this._eventIdToTimeline.delete(eventId);
      const data = {
        timeline: timeline
      };
      this.emit(_room.RoomEvent.Timeline, removed, this.room, undefined, true, data);
    }
    return removed;
  }

  /**
   * Determine where two events appear in the timeline relative to one another
   *
   * @param eventId1 -   The id of the first event
   * @param eventId2 -   The id of the second event
    * @returns -1 if eventId1 precedes eventId2, and +1 eventId1 succeeds
   * eventId2. 0 if they are the same event; null if we can't tell (either
   * because we don't know about one of the events, or because they are in
   * separate timelines which don't join up).
   */
  compareEventOrdering(eventId1, eventId2) {
    if (eventId1 == eventId2) {
      // optimise this case
      return 0;
    }
    const timeline1 = this._eventIdToTimeline.get(eventId1);
    const timeline2 = this._eventIdToTimeline.get(eventId2);
    if (timeline1 === undefined) {
      return null;
    }
    if (timeline2 === undefined) {
      return null;
    }
    if (timeline1 === timeline2) {
      // both events are in the same timeline - figure out their relative indices
      let idx1 = undefined;
      let idx2 = undefined;
      const events = timeline1.getEvents();
      for (let idx = 0; idx < events.length && (idx1 === undefined || idx2 === undefined); idx++) {
        const evId = events[idx].getId();
        if (evId == eventId1) {
          idx1 = idx;
        }
        if (evId == eventId2) {
          idx2 = idx;
        }
      }
      const difference = idx1 - idx2;

      // Return the sign of difference.
      if (difference < 0) {
        return -1;
      } else if (difference > 0) {
        return 1;
      } else {
        return 0;
      }
    }

    // the events are in different timelines. Iterate through the
    // linkedlist to see which comes first.

    // first work forwards from timeline1
    let tl = timeline1;
    while (tl) {
      if (tl === timeline2) {
        // timeline1 is before timeline2
        return -1;
      }
      tl = tl.getNeighbouringTimeline(_eventTimeline.EventTimeline.FORWARDS);
    }

    // now try backwards from timeline1
    tl = timeline1;
    while (tl) {
      if (tl === timeline2) {
        // timeline2 is before timeline1
        return 1;
      }
      tl = tl.getNeighbouringTimeline(_eventTimeline.EventTimeline.BACKWARDS);
    }

    // the timelines are not contiguous.
    return null;
  }

  /**
   * Determine whether a given event can sanely be added to this event timeline set,
   * for timeline sets relating to a thread, only return true for events in the same
   * thread timeline, for timeline sets not relating to a thread only return true
   * for events which should be shown in the main room timeline.
   * Requires the `room` property to have been set at EventTimelineSet construction time.
   *
   * @param event - the event to check whether it belongs to this timeline set.
   * @throws Error if `room` was not set when constructing this timeline set.
   * @returns whether the event belongs to this timeline set.
   */
  canContain(event) {
    if (!this.room) {
      throw new Error("Cannot call `EventTimelineSet::canContain without a `room` set. " + "Set the room when creating the EventTimelineSet to call this method.");
    }
    const {
      threadId,
      shouldLiveInRoom,
      shouldLiveInThread
    } = this.room.eventShouldLiveIn(event);
    if (this.thread) {
      return this.thread.id === threadId;
    }
    if (!shouldLiveInRoom && !shouldLiveInThread) {
      _logger.logger.warn(`EventTimelineSet:canContain event encountered which cannot be added to any timeline roomId=${this.room?.roomId} eventId=${event.getId()} threadId=${event.threadRootId}`);
    }
    return shouldLiveInRoom;
  }
}
exports.EventTimelineSet = EventTimelineSet;