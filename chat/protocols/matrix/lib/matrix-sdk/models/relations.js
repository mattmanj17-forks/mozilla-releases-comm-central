"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RelationsEvent = exports.Relations = void 0;
var _event = require("./event.js");
var _logger = require("../logger.js");
var _event2 = require("../@types/event.js");
var _typedEventEmitter = require("./typed-event-emitter.js");
var _room = require("./room.js");
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == typeof i ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != typeof t || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != typeof i) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); } /*
Copyright 2019, 2021, 2023 The Matrix.org Foundation C.I.C.

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
let RelationsEvent = exports.RelationsEvent = /*#__PURE__*/function (RelationsEvent) {
  RelationsEvent["Add"] = "Relations.add";
  RelationsEvent["Remove"] = "Relations.remove";
  RelationsEvent["Redaction"] = "Relations.redaction";
  return RelationsEvent;
}({});
const matchesEventType = (eventType, targetEventType, altTargetEventTypes = []) => [targetEventType, ...altTargetEventTypes].includes(eventType);

/**
 * A container for relation events that supports easy access to common ways of
 * aggregating such events. Each instance holds events that of a single relation
 * type and event type. All of the events also relate to the same original event.
 *
 * The typical way to get one of these containers is via
 * EventTimelineSet#getRelationsForEvent.
 */
class Relations extends _typedEventEmitter.TypedEventEmitter {
  /**
   * @param relationType - The type of relation involved, such as "m.annotation", "m.reference", "m.replace", etc.
   * @param eventType - The relation event's type, such as "m.reaction", etc.
   * @param client - The client which created this instance. For backwards compatibility also accepts a Room.
   * @param altEventTypes - alt event types for relation events, for example to support unstable prefixed event types
   */
  constructor(relationType, eventType, client, altEventTypes) {
    super();
    this.relationType = relationType;
    this.eventType = eventType;
    this.altEventTypes = altEventTypes;
    _defineProperty(this, "relationEventIds", new Set());
    _defineProperty(this, "relations", new Set());
    _defineProperty(this, "annotationsByKey", {});
    _defineProperty(this, "annotationsBySender", {});
    _defineProperty(this, "sortedAnnotationsByKey", []);
    _defineProperty(this, "targetEvent", null);
    _defineProperty(this, "creationEmitted", false);
    _defineProperty(this, "client", void 0);
    /**
     * Listens for event status changes to remove cancelled events.
     *
     * @param event - The event whose status has changed
     * @param status - The new status
     */
    _defineProperty(this, "onEventStatus", (event, status) => {
      if (!event.isSending()) {
        // Sending is done, so we don't need to listen anymore
        event.removeListener(_event.MatrixEventEvent.Status, this.onEventStatus);
        return;
      }
      if (status !== _event.EventStatus.CANCELLED) {
        return;
      }
      // Event was cancelled, remove from the collection
      event.removeListener(_event.MatrixEventEvent.Status, this.onEventStatus);
      this.removeEvent(event);
    });
    /**
     * For relations that have been redacted, we want to remove them from
     * aggregation data sets and emit an update event.
     *
     * To do so, we listen for `Event.beforeRedaction`, which happens:
     *   - after the server accepted the redaction and remote echoed back to us
     *   - before the original event has been marked redacted in the client
     *
     * @param redactedEvent - The original relation event that is about to be redacted.
     */
    _defineProperty(this, "onBeforeRedaction", async redactedEvent => {
      if (!this.relations.has(redactedEvent)) {
        return;
      }
      this.relations.delete(redactedEvent);
      if (this.relationType === _event2.RelationType.Annotation) {
        // Remove the redacted annotation from aggregation by key
        this.removeAnnotationFromAggregation(redactedEvent);
      } else if (this.relationType === _event2.RelationType.Replace && this.targetEvent && !this.targetEvent.isState()) {
        const lastReplacement = await this.getLastReplacement();
        this.targetEvent.makeReplaced(lastReplacement);
      }
      redactedEvent.removeListener(_event.MatrixEventEvent.BeforeRedaction, this.onBeforeRedaction);
      this.emit(RelationsEvent.Redaction, redactedEvent);
    });
    this.client = client instanceof _room.Room ? client.client : client;
  }

  /**
   * Add relation events to this collection.
   *
   * @param event - The new relation event to be added.
   */
  async addEvent(event) {
    if (this.relationEventIds.has(event.getId())) {
      return;
    }
    const relation = event.getRelation();
    if (!relation) {
      _logger.logger.error("Event must have relation info");
      return;
    }
    const relationType = relation.rel_type;
    const eventType = event.getType();
    if (this.relationType !== relationType || !matchesEventType(eventType, this.eventType, this.altEventTypes)) {
      _logger.logger.error("Event relation info doesn't match this container");
      return;
    }

    // If the event is in the process of being sent, listen for cancellation
    // so we can remove the event from the collection.
    if (event.isSending()) {
      event.on(_event.MatrixEventEvent.Status, this.onEventStatus);
    }
    this.relations.add(event);
    this.relationEventIds.add(event.getId());
    if (this.relationType === _event2.RelationType.Annotation) {
      this.addAnnotationToAggregation(event);
    } else if (this.relationType === _event2.RelationType.Replace && this.targetEvent && !this.targetEvent.isState()) {
      const lastReplacement = await this.getLastReplacement();
      this.targetEvent.makeReplaced(lastReplacement);
    }
    event.on(_event.MatrixEventEvent.BeforeRedaction, this.onBeforeRedaction);
    this.emit(RelationsEvent.Add, event);
    this.maybeEmitCreated();
  }

  /**
   * Remove relation event from this collection.
   *
   * @param event - The relation event to remove.
   */
  async removeEvent(event) {
    if (!this.relations.has(event)) {
      return;
    }
    this.relations.delete(event);
    if (this.relationType === _event2.RelationType.Annotation) {
      this.removeAnnotationFromAggregation(event);
    } else if (this.relationType === _event2.RelationType.Replace && this.targetEvent && !this.targetEvent.isState()) {
      const lastReplacement = await this.getLastReplacement();
      this.targetEvent.makeReplaced(lastReplacement);
    }
    this.emit(RelationsEvent.Remove, event);
  }
  /**
   * Get all relation events in this collection.
   *
   * These are currently in the order of insertion to this collection, which
   * won't match timeline order in the case of scrollback.
   * TODO: Tweak `addEvent` to insert correctly for scrollback.
   *
   * Relation events in insertion order.
   */
  getRelations() {
    return [...this.relations];
  }
  addAnnotationToAggregation(event) {
    const {
      key
    } = event.getRelation() ?? {};
    if (!key) return;
    let eventsForKey = this.annotationsByKey[key];
    if (!eventsForKey) {
      eventsForKey = this.annotationsByKey[key] = new Set();
      this.sortedAnnotationsByKey.push([key, eventsForKey]);
    }
    // Add the new event to the set for this key
    eventsForKey.add(event);
    // Re-sort the [key, events] pairs in descending order of event count
    this.sortedAnnotationsByKey.sort((a, b) => {
      const aEvents = a[1];
      const bEvents = b[1];
      return bEvents.size - aEvents.size;
    });
    const sender = event.getSender();
    let eventsFromSender = this.annotationsBySender[sender];
    if (!eventsFromSender) {
      eventsFromSender = this.annotationsBySender[sender] = new Set();
    }
    // Add the new event to the set for this sender
    eventsFromSender.add(event);
  }
  removeAnnotationFromAggregation(event) {
    const {
      key
    } = event.getRelation() ?? {};
    if (!key) return;
    const eventsForKey = this.annotationsByKey[key];
    if (eventsForKey) {
      eventsForKey.delete(event);

      // Re-sort the [key, events] pairs in descending order of event count
      this.sortedAnnotationsByKey.sort((a, b) => {
        const aEvents = a[1];
        const bEvents = b[1];
        return bEvents.size - aEvents.size;
      });
    }
    const sender = event.getSender();
    const eventsFromSender = this.annotationsBySender[sender];
    if (eventsFromSender) {
      eventsFromSender.delete(event);
    }
  }
  /**
   * Get all events in this collection grouped by key and sorted by descending
   * event count in each group.
   *
   * This is currently only supported for the annotation relation type.
   *
   * An array of [key, events] pairs sorted by descending event count.
   * The events are stored in a Set (which preserves insertion order).
   */
  getSortedAnnotationsByKey() {
    if (this.relationType !== _event2.RelationType.Annotation) {
      // Other relation types are not grouped currently.
      return null;
    }
    return this.sortedAnnotationsByKey;
  }

  /**
   * Get all events in this collection grouped by sender.
   *
   * This is currently only supported for the annotation relation type.
   *
   * An object with each relation sender as a key and the matching Set of
   * events for that sender as a value.
   */
  getAnnotationsBySender() {
    if (this.relationType !== _event2.RelationType.Annotation) {
      // Other relation types are not grouped currently.
      return null;
    }
    return this.annotationsBySender;
  }

  /**
   * Returns the most recent (and allowed) m.replace relation, if any.
   *
   * This is currently only supported for the m.replace relation type,
   * once the target event is known, see `addEvent`.
   */
  async getLastReplacement() {
    if (this.relationType !== _event2.RelationType.Replace) {
      // Aggregating on last only makes sense for this relation type
      return null;
    }
    if (!this.targetEvent) {
      // Don't know which replacements to accept yet.
      // This method shouldn't be called before the original
      // event is known anyway.
      return null;
    }

    // the all-knowning server tells us that the event at some point had
    // this timestamp for its replacement, so any following replacement should definitely not be less
    const replaceRelation = this.targetEvent.getServerAggregatedRelation(_event2.RelationType.Replace);
    const minTs = replaceRelation?.origin_server_ts;
    const lastReplacement = this.getRelations().reduce((last, event) => {
      if (event.getSender() !== this.targetEvent.getSender()) {
        return last;
      }
      if (minTs && minTs > event.getTs()) {
        return last;
      }
      if (last && last.getTs() > event.getTs()) {
        return last;
      }
      return event;
    }, null);
    if (lastReplacement?.shouldAttemptDecryption() && this.client.isCryptoEnabled()) {
      await lastReplacement.attemptDecryption(this.client.crypto);
    } else if (lastReplacement?.isBeingDecrypted()) {
      await lastReplacement.getDecryptionPromise();
    }
    return lastReplacement;
  }

  /*
   * @param targetEvent - the event the relations are related to.
   */
  async setTargetEvent(event) {
    if (this.targetEvent) {
      return;
    }
    this.targetEvent = event;
    if (this.relationType === _event2.RelationType.Replace && !this.targetEvent.isState()) {
      const replacement = await this.getLastReplacement();
      // this is the initial update, so only call it if we already have something
      // to not emit Event.replaced needlessly
      if (replacement) {
        this.targetEvent.makeReplaced(replacement);
      }
    }
    this.maybeEmitCreated();
  }
  maybeEmitCreated() {
    if (this.creationEmitted) {
      return;
    }
    // Only emit we're "created" once we have a target event instance _and_
    // at least one related event.
    if (!this.targetEvent || !this.relations.size) {
      return;
    }
    this.creationEmitted = true;
    this.targetEvent.emit(_event.MatrixEventEvent.RelationsCreated, this.relationType, this.eventType);
  }
}
exports.Relations = Relations;