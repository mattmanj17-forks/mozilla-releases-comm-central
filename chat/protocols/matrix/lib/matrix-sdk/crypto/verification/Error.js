"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.errorFactory = errorFactory;
exports.errorFromEvent = errorFromEvent;
exports.newUserCancelledError = exports.newUnknownMethodError = exports.newUnexpectedMessageError = exports.newTimeoutError = exports.newKeyMismatchError = exports.newInvalidMessageError = void 0;
exports.newVerificationError = newVerificationError;
var _event = require("../../models/event.js");
var _event2 = require("../../@types/event.js");
/*
Copyright 2018 - 2021 The Matrix.org Foundation C.I.C.

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

/**
 * Error messages.
 */

function newVerificationError(code, reason, extraData) {
  const content = Object.assign({}, {
    code,
    reason
  }, extraData);
  return new _event.MatrixEvent({
    type: _event2.EventType.KeyVerificationCancel,
    content
  });
}
function errorFactory(code, reason) {
  return function (extraData) {
    return newVerificationError(code, reason, extraData);
  };
}

/**
 * The verification was cancelled by the user.
 */
const newUserCancelledError = exports.newUserCancelledError = errorFactory("m.user", "Cancelled by user");

/**
 * The verification timed out.
 */
const newTimeoutError = exports.newTimeoutError = errorFactory("m.timeout", "Timed out");

/**
 * An unknown method was selected.
 */
const newUnknownMethodError = exports.newUnknownMethodError = errorFactory("m.unknown_method", "Unknown method");

/**
 * An unexpected message was sent.
 */
const newUnexpectedMessageError = exports.newUnexpectedMessageError = errorFactory("m.unexpected_message", "Unexpected message");

/**
 * The key does not match.
 */
const newKeyMismatchError = exports.newKeyMismatchError = errorFactory("m.key_mismatch", "Key mismatch");

/**
 * An invalid message was sent.
 */
const newInvalidMessageError = exports.newInvalidMessageError = errorFactory("m.invalid_message", "Invalid message");
function errorFromEvent(event) {
  const content = event.getContent();
  if (content) {
    const {
      code,
      reason
    } = content;
    return {
      code,
      reason
    };
  } else {
    return {
      code: "Unknown error",
      reason: "m.unknown"
    };
  }
}