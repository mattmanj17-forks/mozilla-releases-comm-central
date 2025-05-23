"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.SHOW_QR_CODE_METHOD = exports.SCAN_QR_CODE_METHOD = exports.ReciprocateQRCode = exports.QrCodeEvent = exports.QRCodeData = void 0;
var _Base = require("./Base.js");
var _Error = require("./Error.js");
var _base = require("../../base64.js");
var _logger = require("../../logger.js");
var _verification = require("../../crypto-api/verification.js");
var _types = require("../../types.js");
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == typeof i ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != typeof t || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != typeof i) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); } /*
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
*/ /**
 * QR code key verification.
 */
const SHOW_QR_CODE_METHOD = exports.SHOW_QR_CODE_METHOD = _types.VerificationMethod.ShowQrCode;
const SCAN_QR_CODE_METHOD = exports.SCAN_QR_CODE_METHOD = _types.VerificationMethod.ScanQrCode;

/** @deprecated use VerifierEvent */

/** @deprecated use VerifierEvent */
const QrCodeEvent = exports.QrCodeEvent = _verification.VerifierEvent;

/** @deprecated Avoid referencing this class directly; instead use {@link Crypto.Verifier}. */
class ReciprocateQRCode extends _Base.VerificationBase {
  constructor(...args) {
    super(...args);
    _defineProperty(this, "reciprocateQREvent", void 0);
    _defineProperty(this, "doVerification", async () => {
      if (!this.startEvent) {
        // TODO: Support scanning QR codes
        throw new Error("It is not currently possible to start verification" + "with this method yet.");
      }
      const {
        qrCodeData
      } = this.request;
      // 1. check the secret
      if (this.startEvent.getContent()["secret"] !== qrCodeData?.encodedSharedSecret) {
        throw (0, _Error.newKeyMismatchError)();
      }

      // 2. ask if other user shows shield as well
      await new Promise((resolve, reject) => {
        this.reciprocateQREvent = {
          confirm: resolve,
          cancel: () => reject((0, _Error.newUserCancelledError)())
        };
        this.emit(QrCodeEvent.ShowReciprocateQr, this.reciprocateQREvent);
      });

      // 3. determine key to sign / mark as trusted
      const keys = {};
      switch (qrCodeData?.mode) {
        case Mode.VerifyOtherUser:
          {
            // add master key to keys to be signed, only if we're not doing self-verification
            const masterKey = qrCodeData.otherUserMasterKey;
            keys[`ed25519:${masterKey}`] = masterKey;
            break;
          }
        case Mode.VerifySelfTrusted:
          {
            const deviceId = this.request.targetDevice.deviceId;
            keys[`ed25519:${deviceId}`] = qrCodeData.otherDeviceKey;
            break;
          }
        case Mode.VerifySelfUntrusted:
          {
            const masterKey = qrCodeData.myMasterKey;
            keys[`ed25519:${masterKey}`] = masterKey;
            break;
          }
      }

      // 4. sign the key (or mark own MSK as verified in case of MODE_VERIFY_SELF_TRUSTED)
      await this.verifyKeys(this.userId, keys, (keyId, device, keyInfo) => {
        // make sure the device has the expected keys
        const targetKey = keys[keyId];
        if (!targetKey) throw (0, _Error.newKeyMismatchError)();
        if (keyInfo !== targetKey) {
          _logger.logger.error("key ID from key info does not match");
          throw (0, _Error.newKeyMismatchError)();
        }
        for (const deviceKeyId in device.keys) {
          if (!deviceKeyId.startsWith("ed25519")) continue;
          const deviceTargetKey = keys[deviceKeyId];
          if (!deviceTargetKey) throw (0, _Error.newKeyMismatchError)();
          if (device.keys[deviceKeyId] !== deviceTargetKey) {
            _logger.logger.error("master key does not match");
            throw (0, _Error.newKeyMismatchError)();
          }
        }
      });
    });
  }
  static factory(channel, baseApis, userId, deviceId, startEvent, request) {
    return new ReciprocateQRCode(channel, baseApis, userId, deviceId, startEvent, request);
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  static get NAME() {
    return "m.reciprocate.v1";
  }
  getReciprocateQrCodeCallbacks() {
    return this.reciprocateQREvent ?? null;
  }
}
exports.ReciprocateQRCode = ReciprocateQRCode;
const CODE_VERSION = 0x02; // the version of binary QR codes we support
const BINARY_PREFIX = "MATRIX"; // ASCII, used to prefix the binary format
var Mode = /*#__PURE__*/function (Mode) {
  Mode[Mode["VerifyOtherUser"] = 0] = "VerifyOtherUser";
  Mode[Mode["VerifySelfTrusted"] = 1] = "VerifySelfTrusted";
  Mode[Mode["VerifySelfUntrusted"] = 2] = "VerifySelfUntrusted";
  return Mode;
}(Mode || {}); // We do not trust the master key
class QRCodeData {
  constructor(mode, sharedSecret,
  // only set when mode is MODE_VERIFY_OTHER_USER, master key of other party at time of generating QR code
  otherUserMasterKey,
  // only set when mode is MODE_VERIFY_SELF_TRUSTED, device key of other party at time of generating QR code
  otherDeviceKey,
  // only set when mode is MODE_VERIFY_SELF_UNTRUSTED, own master key at time of generating QR code
  myMasterKey, buffer) {
    this.mode = mode;
    this.sharedSecret = sharedSecret;
    this.otherUserMasterKey = otherUserMasterKey;
    this.otherDeviceKey = otherDeviceKey;
    this.myMasterKey = myMasterKey;
    this.buffer = buffer;
  }
  static async create(request, client) {
    const sharedSecret = QRCodeData.generateSharedSecret();
    const mode = QRCodeData.determineMode(request, client);
    let otherUserMasterKey = null;
    let otherDeviceKey = null;
    let myMasterKey = null;
    if (mode === Mode.VerifyOtherUser) {
      const otherUserCrossSigningInfo = client.getStoredCrossSigningForUser(request.otherUserId);
      otherUserMasterKey = otherUserCrossSigningInfo.getId("master");
    } else if (mode === Mode.VerifySelfTrusted) {
      otherDeviceKey = await QRCodeData.getOtherDeviceKey(request, client);
    } else if (mode === Mode.VerifySelfUntrusted) {
      const myUserId = client.getUserId();
      const myCrossSigningInfo = client.getStoredCrossSigningForUser(myUserId);
      myMasterKey = myCrossSigningInfo.getId("master");
    }
    const qrData = QRCodeData.generateQrData(request, client, mode, sharedSecret, otherUserMasterKey, otherDeviceKey, myMasterKey);
    const buffer = QRCodeData.generateBuffer(qrData);
    return new QRCodeData(mode, sharedSecret, otherUserMasterKey, otherDeviceKey, myMasterKey, buffer);
  }

  /**
   * The unpadded base64 encoded shared secret.
   */
  get encodedSharedSecret() {
    return this.sharedSecret;
  }
  getBuffer() {
    return this.buffer;
  }
  static generateSharedSecret() {
    const secretBytes = new Uint8Array(11);
    globalThis.crypto.getRandomValues(secretBytes);
    return (0, _base.encodeUnpaddedBase64)(secretBytes);
  }
  static async getOtherDeviceKey(request, client) {
    const myUserId = client.getUserId();
    const otherDevice = request.targetDevice;
    const device = otherDevice.deviceId ? client.getStoredDevice(myUserId, otherDevice.deviceId) : undefined;
    if (!device) {
      throw new Error("could not find device " + otherDevice?.deviceId);
    }
    return device.getFingerprint();
  }
  static determineMode(request, client) {
    const myUserId = client.getUserId();
    const otherUserId = request.otherUserId;
    let mode = Mode.VerifyOtherUser;
    if (myUserId === otherUserId) {
      // Mode changes depending on whether or not we trust the master cross signing key
      const myTrust = client.checkUserTrust(myUserId);
      if (myTrust.isCrossSigningVerified()) {
        mode = Mode.VerifySelfTrusted;
      } else {
        mode = Mode.VerifySelfUntrusted;
      }
    }
    return mode;
  }
  static generateQrData(request, client, mode, encodedSharedSecret, otherUserMasterKey, otherDeviceKey, myMasterKey) {
    const myUserId = client.getUserId();
    const transactionId = request.channel.transactionId;
    const qrData = {
      prefix: BINARY_PREFIX,
      version: CODE_VERSION,
      mode,
      transactionId,
      firstKeyB64: "",
      // worked out shortly
      secondKeyB64: "",
      // worked out shortly
      secretB64: encodedSharedSecret
    };
    const myCrossSigningInfo = client.getStoredCrossSigningForUser(myUserId);
    if (mode === Mode.VerifyOtherUser) {
      // First key is our master cross signing key
      qrData.firstKeyB64 = myCrossSigningInfo.getId("master");
      // Second key is the other user's master cross signing key
      qrData.secondKeyB64 = otherUserMasterKey;
    } else if (mode === Mode.VerifySelfTrusted) {
      // First key is our master cross signing key
      qrData.firstKeyB64 = myCrossSigningInfo.getId("master");
      qrData.secondKeyB64 = otherDeviceKey;
    } else if (mode === Mode.VerifySelfUntrusted) {
      // First key is our device's key
      qrData.firstKeyB64 = client.getDeviceEd25519Key();
      // Second key is what we think our master cross signing key is
      qrData.secondKeyB64 = myMasterKey;
    }
    return qrData;
  }
  static generateBuffer(qrData) {
    let buf = Buffer.alloc(0); // we'll concat our way through life

    const appendByte = b => {
      const tmpBuf = Buffer.from([b]);
      buf = Buffer.concat([buf, tmpBuf]);
    };
    const appendInt = i => {
      const tmpBuf = Buffer.alloc(2);
      tmpBuf.writeInt16BE(i, 0);
      buf = Buffer.concat([buf, tmpBuf]);
    };
    const appendStr = (s, enc, withLengthPrefix = true) => {
      const tmpBuf = Buffer.from(s, enc);
      if (withLengthPrefix) appendInt(tmpBuf.byteLength);
      buf = Buffer.concat([buf, tmpBuf]);
    };
    const appendEncBase64 = b64 => {
      const b = (0, _base.decodeBase64)(b64);
      const tmpBuf = Buffer.from(b);
      buf = Buffer.concat([buf, tmpBuf]);
    };

    // Actually build the buffer for the QR code
    appendStr(qrData.prefix, "ascii", false);
    appendByte(qrData.version);
    appendByte(qrData.mode);
    appendStr(qrData.transactionId, "utf-8");
    appendEncBase64(qrData.firstKeyB64);
    appendEncBase64(qrData.secondKeyB64);
    appendEncBase64(qrData.secretB64);
    return buf;
  }
}
exports.QRCodeData = QRCodeData;