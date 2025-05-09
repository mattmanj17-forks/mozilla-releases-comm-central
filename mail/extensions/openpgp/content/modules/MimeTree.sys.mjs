/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  EnigmailArmor: "chrome://openpgp/content/modules/armor.sys.mjs",
  EnigmailConstants: "chrome://openpgp/content/modules/constants.sys.mjs",
  EnigmailData: "chrome://openpgp/content/modules/data.sys.mjs",
  EnigmailDecryption: "chrome://openpgp/content/modules/decryption.sys.mjs",
  EnigmailFixExchangeMsg:
    "chrome://openpgp/content/modules/fixExchangeMsg.sys.mjs",
  EnigmailMime: "chrome://openpgp/content/modules/mime.sys.mjs",
  EnigmailStreams: "chrome://openpgp/content/modules/streams.sys.mjs",
  MailCryptoUtils: "resource:///modules/MailCryptoUtils.sys.mjs",
  MailStringUtils: "resource:///modules/MailStringUtils.sys.mjs",
  jsmime: "resource:///modules/jsmime.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "l10n", () => {
  return new Localization(["messenger/openpgp/openpgp.ftl"], true);
});

var log = console.createInstance({
  prefix: "openpgp",
  maxLogLevel: "Warn",
  maxLogLevelPref: "openpgp.loglevel",
});

/**
 * @typedef {object} MimeTreePart - A mime part generated by jsmime using the
 *   MimeTreeEmitter.
 *
 * @property {string} partNum
 * @property {Map} headers - A Map, containing all headers. Special headers for
 *   contentType and charset.
 * @property {integer} size - Size of this part, including all subparts.
 * @property {string} body - Body
 * @property {string} [name] - The name, if this part is an attachment.
 * @property {boolean} [isAttachment] - The part is an attachment.
 * @property {MimeTreePart[]} subParts - Array of MimeTreePart with sub parts
 */

/**
 * @typedef {object} MimeTreeEmitterOptions
 *
 * @property {boolean} [enableFilterMode=false] - Enabling this mode allows using
 *   the other available configuration flags, deviating from the standard behavior.
 *   This is to ensure that changes to this class do not alter the expected
 *   behavior of the consumer in getMimeTree(), which is heavily used in different
 *   areas of the crypto code.
 * @property {boolean} [checkForAttachments=false] - Determines for each part, if
 *   it is an attachment and sets the"name" and the "isAttachment" property. The
 *   default is to check if the "content-disposition" header includes "attachment",
 *   but the condition can be adjusted by re-implementing the getAttachmentName()
 *   class method. Will be forced to true, if one of checkForEncryption or
 *   excludeAttachmentData is enabled.
 * @property {boolean} [checkForEncryption=false] - Check for encrypted parts,
 *   status can be retrieved via MimeTreeEmitter.hasEncryptedParts.
 * @property {boolean} [excludeAttachmentData=false] - Whether to exclude the
 *   content of parts which are considered to be attachments.
 */

/**
 * A base class for a jsmime emitter, producing MimeTreeParts.
 */
export class MimeTreeEmitter {
  // The MimeTreeDecrypter instance used to decrypt MimeTreeParts.
  #decrypter;

  // Internal flag to keep track if encrypted parts have been found.
  #hasEncryptedParts;

  // Internal flags mapped from options provided in the constructor.
  #enableFilterMode;
  #checkForAttachments;
  #checkForEncryption;
  #excludeAttachmentData;
  #currentlyProcessingEncryptedPartNum;

  /**
   * @param {MimeTreeEmitterOptions} [options]
   */
  constructor(options) {
    this.mimeTree = {
      partNum: "",
      headers: null,
      body: "",
      size: 0,
      parent: null,
      subParts: [],
    };
    this.currentPart = "";
    this.currPartNum = "";
    this.#currentlyProcessingEncryptedPartNum = "";

    // Options and their sane defaults. Make sure that additional config flags are
    // ignored, if the filter mode is disabled. Even though it is already ensured
    // here, that none of the additional flags can be enabled, without activating
    // the filter mode, all usages are guarded by the #enableFilterMode flag. This
    // allows to identify all code parts, which are affected by the filter mode.
    this.#enableFilterMode = options?.enableFilterMode ?? false;
    this.#checkForAttachments = false;
    this.#checkForEncryption = false;
    this.#excludeAttachmentData = false;

    if (this.#enableFilterMode) {
      this.#checkForAttachments = options?.checkForAttachments ?? false;
      this.#checkForEncryption = options?.checkForEncryption ?? false;
      this.#excludeAttachmentData = options?.excludeAttachmentData ?? false;

      if (this.#checkForEncryption) {
        this.#checkForAttachments = true;
        this.#hasEncryptedParts = false;
        this.#decrypter = new MimeTreeDecrypter({ disablePrompts: false });
      }

      if (this.#excludeAttachmentData) {
        this.#checkForAttachments = true;
      }
    }
  }

  /**
   * A function to determine the attachment name of a given MimeTreePart, if any.
   *
   * @param {MimeTreePart} mimeTreePart
   * @returns {string|null} The name of the attachment, or null if the part is not
   *   an attachment.
   */
  getAttachmentName(mimeTreePart) {
    if (isAttachment(mimeTreePart)) {
      return getAttachmentName(mimeTreePart);
    }
    return null;
  }

  /**
   * Returns true if this MimeTree has encrypted parts. Returns undefined, if
   * the checkForEncryption option is not enabled.
   *
   * @returns {boolean|undefined}
   */
  get hasEncryptedParts() {
    return this.#hasEncryptedParts;
  }

  createPartObj(partNum, headers, parent) {
    let ct;

    if (headers.has("content-type")) {
      ct = headers.contentType.type;
      const it = headers.get("content-type").entries();
      for (const i of it) {
        ct += "; " + i[0] + '="' + i[1] + '"';
      }
    }

    return {
      partNum,
      headers,
      fullContentType: ct,
      body: "",
      size: 0,
      parent,
      subParts: [],
    };
  }

  /** JSMime API */
  startMessage() {
    this.currentPart = this.mimeTree;
  }

  endMessage() {}

  startPart(partNum, headers) {
    partNum = "1" + (partNum !== "" ? "." : "") + partNum;
    const newPart = this.createPartObj(partNum, headers, this.currentPart);

    this.currentPart.subParts.push(newPart);
    this.currPartNum = partNum;
    this.currentPart = newPart;

    if (this.#enableFilterMode && this.#checkForAttachments) {
      const attachmentName = this.getAttachmentName(newPart);
      if (attachmentName != null) {
        this.currentPart.isAttachment = true;
        this.currentPart.name = attachmentName;
      }
    }

    // Check headers to identify this part as encrypted, if this message has not
    // yet been identified as having encrypted parts.
    if (
      this.#enableFilterMode &&
      this.#checkForEncryption &&
      !this.#hasEncryptedParts &&
      !this.#currentlyProcessingEncryptedPartNum &&
      (this.#decrypter.isSMIME(this.currentPart) ||
        this.#decrypter.hasPgpMimeHeaders(this.currentPart))
    ) {
      this.#hasEncryptedParts = true;
      this.#currentlyProcessingEncryptedPartNum = partNum;
    }
  }

  endPart() {
    if (this.#currentlyProcessingEncryptedPartNum == this.currPartNum) {
      this.#currentlyProcessingEncryptedPartNum = "";
    }

    if (this.#enableFilterMode && this.#checkForEncryption) {
      // If we haven't yet found any OpenPGP/MIME encrypted part, then check for
      // on OpenPGP/INLINE encrypted part.
      if (
        !this.#hasEncryptedParts &&
        this.currentPart.headers.contentType.mediatype == "text"
      ) {
        this.#hasEncryptedParts = this.#decrypter.isEncryptedINLINE(
          this.currentPart
        );
      }

      // If we still haven't found anything that's encrypted, then check for an
      // OpenPGP encrypted attachment.
      if (!this.#hasEncryptedParts && this.currentPart.isAttachment) {
        this.#hasEncryptedParts = this.#decrypter.isPgpEncryptedAttachment(
          this.currentPart
        );
      }

      // Clean up partial attachment data, which had been added just to be able
      // to check for encryption.
      if (this.currentPart.isAttachment && this.#excludeAttachmentData) {
        this.currentPart.body = "";
      }
    }

    const partSize = this.currentPart.size;
    this.currentPart = this.currentPart.parent;
    // Add size to parent.
    this.currentPart.size += partSize;
  }

  deliverPartData(partNum, data) {
    this.currentPart.size += data.length;

    // We must keep enough data to be able to check for an encrypted body, if the
    // encryption check is required. Otherwise ignore the data if it has not been
    // requested.
    const keepData =
      this.#checkForEncryption &&
      !this.#hasEncryptedParts &&
      this.currentPart.body.length < 300;

    if (
      this.#enableFilterMode &&
      this.currentPart.isAttachment &&
      this.#excludeAttachmentData &&
      !keepData
    ) {
      return;
    }

    if (typeof data === "string") {
      this.currentPart.body += data;
    } else {
      this.currentPart.body +=
        lazy.MailStringUtils.uint8ArrayToByteString(data);
    }
  }
}

/**
 * @typedef {object} MimeTreeDecrypterOptions
 *
 * @property {boolean} [disablePrompts=false] - If the user's input is necessary
 *   but prompting is disabled, the operation will abort with a failure.
 */

/**
 * Class to decrypt a MimeTreePart.
 */
export class MimeTreeDecrypter {
  /**
   * @param {MimeTreeDecrypterOptions} [options]
   */
  constructor(options) {
    this.cryptoChanged = false;
    this.decryptFailure = false;
    this.mimeTree = null;
    this.subject = "";
    this.disablePrompts = options?.disablePrompts ?? false;
  }

  /**
   * Decrypts the provided MimeTreePart in-place.
   *
   * @param {MimeTreePart} mimeTreePart
   */
  async decrypt(mimeTreePart) {
    this.mimeTree = mimeTreePart;
    this.cryptoChanged = false;
    this.decryptFailure = false;

    // Note: MimeTreeDecrypter.decryptMimeTree() is replacing the body of the
    //       encrypted parts with the decrypted content, but does not parse it.
    //       It is no longer a fully parsed MimeTree.
    await this.decryptMimeTree(mimeTreePart);
  }

  /**
   * Walk through the MIME message structure and decrypt the body if there is
   * something to decrypt
   *
   * @param {MimeTreePart} mimeTreePart
   */
  async decryptMimeTree(mimeTreePart) {
    if (this.isBrokenByExchange(mimeTreePart)) {
      this.fixExchangeMessage(mimeTreePart);
    }

    if (this.isSMIME(mimeTreePart)) {
      this.decryptSMIME(mimeTreePart);
    } else if (this.isPgpMime(mimeTreePart)) {
      await this.decryptPGPMIME(mimeTreePart);
    } else if (isAttachment(mimeTreePart)) {
      await this.pgpDecryptAttachment(mimeTreePart);
    } else {
      await this.decryptINLINE(mimeTreePart);
    }

    for (const i in mimeTreePart.subParts) {
      await this.decryptMimeTree(mimeTreePart.subParts[i]);
    }
  }

  /***
   *
   * Detect if MimeTreePart is PGP/MIME message that got modified by MS-Exchange:
   *
   * - multipart/mixed Container with
   *   - application/pgp-encrypted Attachment with name "PGPMIME Version Identification"
   *   - application/octet-stream Attachment with name "encrypted.asc" having the encrypted content in base64
   * - see:
   *   - https://doesnotexist-openpgp-integration.thunderbird/forum/viewtopic.php?f=4&t=425
   *   - https://sourceforge.net/p/enigmail/forum/support/thread/4add2b69/
   *
   * @returns {boolean}
   */
  isBrokenByExchange(mimeTreePart) {
    try {
      if (
        mimeTreePart.subParts &&
        mimeTreePart.subParts.length === 3 &&
        mimeTreePart.fullContentType
          .toLowerCase()
          .includes("multipart/mixed") &&
        mimeTreePart.subParts[0].subParts.length === 0 &&
        mimeTreePart.subParts[0].fullContentType.search(
          /multipart\/encrypted/i
        ) < 0 &&
        mimeTreePart.subParts[0].fullContentType
          .toLowerCase()
          .includes("text/plain") &&
        mimeTreePart.subParts[1].fullContentType
          .toLowerCase()
          .includes("application/pgp-encrypted") &&
        mimeTreePart.subParts[1].fullContentType
          .toLowerCase()
          .search(/multipart\/encrypted/i) < 0 &&
        mimeTreePart.subParts[1].fullContentType
          .toLowerCase()
          .search(/PGPMIME Versions? Identification/i) >= 0 &&
        mimeTreePart.subParts[2].fullContentType
          .toLowerCase()
          .includes("application/octet-stream") &&
        mimeTreePart.subParts[2].fullContentType
          .toLowerCase()
          .includes("encrypted.asc")
      ) {
        log.debug("Found message broken by MS-Exchange");
        return true;
      }
    } catch (ex) {}

    return false;
  }

  /**
   * @param {MimeTreePart} mimeTreePart
   */
  decryptSMIME(mimeTreePart) {
    const encrypted = lazy.MailCryptoUtils.binaryStringToTypedArray(
      mimeTreePart.body
    );

    const cmsDecoderJS = Cc["@mozilla.org/nsCMSDecoderJS;1"].createInstance(
      Ci.nsICMSDecoderJS
    );
    const decrypted = cmsDecoderJS.decrypt(encrypted);

    if (decrypted.length === 0) {
      // fail if no data found
      this.decryptFailure = true;
      return;
    }

    let data = "";
    for (const c of decrypted) {
      data += String.fromCharCode(c);
    }

    // Search for the separator between headers and message body.
    let bodyIndex = data.search(/\n\s*\r?\n/);
    if (bodyIndex < 0) {
      // not found, body starts at beginning.
      bodyIndex = 0;
    } else {
      // found, body starts after the headers.
      const wsSize = data.match(/\n\s*\r?\n/);
      bodyIndex += wsSize[0].length;
    }

    if (data.substr(bodyIndex).search(/\r?\n$/) === 0) {
      return;
    }

    const m = Cc["@mozilla.org/messenger/mimeheaders;1"].createInstance(
      Ci.nsIMimeHeaders
    );
    // headers are found from the beginning up to the start of the body
    m.initialize(data.substr(0, bodyIndex));

    for (const hdrName of [
      "content-type",
      "content-transfer-encoding",
      "content-disposition",
      "content-description",
    ]) {
      mimeTreePart.headers._rawHeaders.delete(hdrName);
      const val = m.extractHeader(hdrName, false);
      if (val) {
        mimeTreePart.headers._rawHeaders.set(hdrName, val);
      }
    }

    mimeTreePart.subParts = [];
    mimeTreePart.body = data.substr(bodyIndex);

    this.cryptoChanged = true;
  }

  /**
   * @param {MimeTreePart} mimeTreePart
   * @returns {boolean}
   */
  isSMIME(mimeTreePart) {
    if (!mimeTreePart.headers.has("content-type")) {
      return false;
    }

    return (
      mimeTreePart.headers.get("content-type").type.toLowerCase() ===
        "application/pkcs7-mime" &&
      mimeTreePart.headers
        .get("content-type")
        .get("smime-type")
        .toLowerCase() === "enveloped-data" &&
      mimeTreePart.subParts.length === 0
    );
  }

  isPgpMime(mimeTreePart) {
    return (
      this.hasPgpMimeHeaders(mimeTreePart) && mimeTreePart.subParts.length === 2
    );
  }

  /**
   * @param {MimeTreePart} mimeTreePart
   * @returns {boolean}
   */
  hasPgpMimeHeaders(mimeTreePart) {
    try {
      if (mimeTreePart.headers.has("content-type")) {
        if (
          mimeTreePart.headers.get("content-type").type.toLowerCase() ===
            "multipart/encrypted" &&
          mimeTreePart.headers
            .get("content-type")
            .get("protocol")
            .toLowerCase() === "application/pgp-encrypted"
        ) {
          return true;
        }
      }
    } catch (x) {}
    return false;
  }

  /**
   * @param {MimeTreePart} mimeTreePart
   */
  async decryptPGPMIME(mimeTreePart) {
    if (!mimeTreePart.subParts[1]) {
      throw new Error(
        `${mimeTreePart.partNum} is not a correct PGP/MIME message`
      );
    }

    const uiFlags =
      lazy.EnigmailConstants.UI_INTERACTIVE |
      lazy.EnigmailConstants.UI_UNVERIFIED_ENC_OK |
      lazy.EnigmailConstants.UI_IGNORE_MDC_ERROR;
    const exitCodeObj = {};
    const statusFlagsObj = {};
    const userIdObj = {};
    const sigDetailsObj = {};
    const errorMsgObj = {};
    const keyIdObj = {};
    const blockSeparationObj = {
      value: "",
    };
    const encToDetailsObj = {};
    var signatureObj = {};
    signatureObj.value = "";

    const data = await lazy.EnigmailDecryption.decryptMessage(
      null,
      uiFlags,
      mimeTreePart.subParts[1].body,
      null, // date
      signatureObj,
      exitCodeObj,
      statusFlagsObj,
      keyIdObj,
      userIdObj,
      sigDetailsObj,
      errorMsgObj,
      blockSeparationObj,
      encToDetailsObj
    );

    if (!data || data.length === 0) {
      if (statusFlagsObj.value & lazy.EnigmailConstants.DISPLAY_MESSAGE) {
        if (!this.disablePrompts) {
          Services.prompt.alert(null, null, errorMsgObj.value);
        } else {
          log.warn(errorMsgObj.value);
        }
        throw new Error("Decryption impossible");
      }
    }

    if (data.length === 0) {
      // fail if no data found
      this.decryptFailure = true;
      return;
    }

    let bodyIndex = data.search(/\n\s*\r?\n/);
    if (bodyIndex < 0) {
      bodyIndex = 0;
    } else {
      const wsSize = data.match(/\n\s*\r?\n/);
      bodyIndex += wsSize[0].length;
    }

    if (data.substr(bodyIndex).search(/\r?\n$/) === 0) {
      return;
    }

    const m = Cc["@mozilla.org/messenger/mimeheaders;1"].createInstance(
      Ci.nsIMimeHeaders
    );
    m.initialize(data.substr(0, bodyIndex));
    let ct = m.extractHeader("content-type", false) || "";
    const part = mimeTreePart.partNum;

    if (part.length > 0 && part.search(/[^01.]/) < 0) {
      if (ct.search(/protected-headers/i) >= 0) {
        if (m.hasHeader("subject")) {
          let subject = m.extractHeader("subject", false) || "";
          subject = subject.replace(/^(Re: )+/, "Re: ");
          this.mimeTree.headers._rawHeaders.set("subject", [subject]);
        }
      } else if (this.mimeTree.headers.get("subject") === "p≡p") {
        let subject = getPepSubject(data);
        if (subject) {
          subject = subject.replace(/^(Re: )+/, "Re: ");
          this.mimeTree.headers._rawHeaders.set("subject", [subject]);
        }
      } else if (
        !(statusFlagsObj.value & lazy.EnigmailConstants.GOOD_SIGNATURE) &&
        /^multipart\/signed/i.test(ct)
      ) {
        // RFC 3156, Section 6.1 message
        const innerMsg = getMimeTree(data, false);
        if (innerMsg.subParts.length > 0) {
          ct = innerMsg.subParts[0].fullContentType;
          const hdrMap = innerMsg.subParts[0].headers._rawHeaders;
          if (ct.search(/protected-headers/i) >= 0 && hdrMap.has("subject")) {
            let subject = innerMsg.subParts[0].headers._rawHeaders
              .get("subject")
              .join("");
            subject = subject.replace(/^(Re: )+/, "Re: ");
            this.mimeTree.headers._rawHeaders.set("subject", [subject]);
          }
        }
      }
    }

    let boundary = getBoundary(mimeTreePart);
    if (!boundary) {
      boundary = lazy.EnigmailMime.createBoundary();
    }

    // append relevant headers
    mimeTreePart.headers.get("content-type").type = "multipart/mixed";
    mimeTreePart.headers._rawHeaders.set("content-type", [
      'multipart/mixed; boundary="' + boundary + '"',
    ]);
    mimeTreePart.subParts = [
      {
        body: data,
        decryptedPgpMime: true,
        partNum: mimeTreePart.partNum + ".1",
        headers: {
          _rawHeaders: new Map(),
          get() {
            return null;
          },
          has() {
            return false;
          },
        },
        subParts: [],
      },
    ];

    this.cryptoChanged = true;
  }

  /**
   * Check if this attachment appears to be encrypted.
   *
   * @param {MimeTreePart} mimeTreePart
   * @returns {boolean}
   */
  isPgpEncryptedAttachment(mimeTreePart) {
    const attachmentHead = mimeTreePart.body.substr(0, 30);
    if (attachmentHead.search(/-----BEGIN PGP \w{5,10} KEY BLOCK-----/) >= 0) {
      // Skip PGP key files.
      return false;
    }
    if (attachmentHead.search(/-----BEGIN PGP /) >= 0) {
      return true;
    }
    return false;
  }

  /**
   * @param {MimeTreePart} mimeTreePart
   */
  async pgpDecryptAttachment(mimeTreePart) {
    const attachmentHead = mimeTreePart.body.substr(0, 30);
    if (attachmentHead.search(/-----BEGIN PGP \w{5,10} KEY BLOCK-----/) >= 0) {
      // attachment appears to be a PGP key file, skip
      return;
    }

    const uiFlags =
      lazy.EnigmailConstants.UI_INTERACTIVE |
      lazy.EnigmailConstants.UI_UNVERIFIED_ENC_OK |
      lazy.EnigmailConstants.UI_IGNORE_MDC_ERROR;
    const exitCodeObj = {};
    const statusFlagsObj = {};
    const userIdObj = {};
    const sigDetailsObj = {};
    const errorMsgObj = {};
    const keyIdObj = {};
    const blockSeparationObj = {
      value: "",
    };
    const encToDetailsObj = {};
    var signatureObj = {};
    signatureObj.value = "";

    let attachmentName = getAttachmentName(mimeTreePart);
    attachmentName = attachmentName
      ? attachmentName.replace(/\.(pgp|asc|gpg)$/, "")
      : "";

    const data = await lazy.EnigmailDecryption.decryptMessage(
      null,
      uiFlags,
      mimeTreePart.body,
      null, // date
      signatureObj,
      exitCodeObj,
      statusFlagsObj,
      keyIdObj,
      userIdObj,
      sigDetailsObj,
      errorMsgObj,
      blockSeparationObj,
      encToDetailsObj
    );

    if (data || statusFlagsObj.value & lazy.EnigmailConstants.DECRYPTION_OKAY) {
      // Decryption ok.
      this.cryptoChanged = true;
    } else if (statusFlagsObj.value & lazy.EnigmailConstants.MISSING_MDC) {
      log.warn("Decryption failed. Missing MDC protection.");
      this.decryptFailure = true;
    } else if (
      statusFlagsObj.value & lazy.EnigmailConstants.DECRYPTION_FAILED
    ) {
      log.warn("Decryption failed.");
      this.decryptFailure = true;
      // Enigmail prompts the user here, but we just keep going.
    } else if (
      statusFlagsObj.value & lazy.EnigmailConstants.DECRYPTION_INCOMPLETE
    ) {
      log.warn("Decryption failed. Message not complete.");
      this.decryptFailure = true;
      return;
    } else {
      // there is nothing to be decrypted
      return;
    }

    if (statusFlagsObj.encryptedFileName) {
      attachmentName = statusFlagsObj.encryptedFileName;
    }

    mimeTreePart.body = data;
    mimeTreePart.headers._rawHeaders.set(
      "content-disposition",
      `attachment; filename="${attachmentName}"`
    );
    mimeTreePart.headers._rawHeaders.set("content-transfer-encoding", [
      "base64",
    ]);
    const origCt = mimeTreePart.headers.get("content-type");
    let ct = origCt.type;

    for (const i of origCt.entries()) {
      if (i[0].toLowerCase() === "name") {
        i[1] = i[1].replace(/\.(pgp|asc|gpg)$/, "");
      }
      ct += `; ${i[0]}="${i[1]}"`;
    }

    mimeTreePart.headers._rawHeaders.set("content-type", [ct]);
  }

  /**
   * @param {MimeTreePart} mimeTreePart
   */
  isEncryptedINLINE(mimeTreePart) {
    if ("decryptedPgpMime" in mimeTreePart && mimeTreePart.decryptedPgpMime) {
      return false;
    }

    if ("body" in mimeTreePart && mimeTreePart.body.length > 0) {
      const ct = getContentType(mimeTreePart);

      let body = mimeTreePart.body;
      if (ct === "text/html") {
        body = stripHTMLFromArmoredBlocks(body);
      }
      const blocks = lazy.EnigmailArmor.locateArmoredBlocks(body);
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].blocktype == "MESSAGE") {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * @param {MimeTreePart} mimeTreePart
   */
  async decryptINLINE(mimeTreePart) {
    if ("decryptedPgpMime" in mimeTreePart && mimeTreePart.decryptedPgpMime) {
      return 0;
    }

    if ("body" in mimeTreePart && mimeTreePart.body.length > 0) {
      const ct = getContentType(mimeTreePart);

      if (ct === "text/html") {
        mimeTreePart.body = stripHTMLFromArmoredBlocks(mimeTreePart.body);
      }

      var exitCodeObj = {};
      var statusFlagsObj = {};
      var userIdObj = {};
      var sigDetailsObj = {};
      var errorMsgObj = {};
      var keyIdObj = {};
      var blockSeparationObj = {
        value: "",
      };
      var encToDetailsObj = {};
      var signatureObj = {};
      signatureObj.value = "";

      const uiFlags =
        lazy.EnigmailConstants.UI_INTERACTIVE |
        lazy.EnigmailConstants.UI_UNVERIFIED_ENC_OK |
        lazy.EnigmailConstants.UI_IGNORE_MDC_ERROR;

      var plaintexts = [];
      var blocks = lazy.EnigmailArmor.locateArmoredBlocks(mimeTreePart.body);
      var tmp = [];

      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].blocktype == "MESSAGE") {
          tmp.push(blocks[i]);
        }
      }

      blocks = tmp;

      if (blocks.length < 1) {
        return 0;
      }

      let charset = "utf-8";

      for (let i = 0; i < blocks.length; i++) {
        let plaintext = null;
        do {
          const ciphertext = mimeTreePart.body.substring(
            blocks[i].begin,
            blocks[i].end + 1
          );

          if (ciphertext.length === 0) {
            break;
          }

          const hdr = ciphertext.search(/(\r\r|\n\n|\r\n\r\n)/);
          if (hdr > 0) {
            const chset = ciphertext.substr(0, hdr).match(/^(charset:)(.*)$/im);
            if (chset && chset.length == 3) {
              charset = chset[2].trim();
            }
          }
          plaintext = await lazy.EnigmailDecryption.decryptMessage(
            null,
            uiFlags,
            ciphertext,
            null, // date
            signatureObj,
            exitCodeObj,
            statusFlagsObj,
            keyIdObj,
            userIdObj,
            sigDetailsObj,
            errorMsgObj,
            blockSeparationObj,
            encToDetailsObj
          );
          if (!plaintext || plaintext.length === 0) {
            if (statusFlagsObj.value & lazy.EnigmailConstants.DISPLAY_MESSAGE) {
              if (!this.disablePrompts) {
                Services.prompt.alert(null, null, errorMsgObj.value);
              } else {
                log.warn(errorMsgObj.value);
              }
              this.cryptoChanged = false;
              this.decryptFailure = true;
              return -1;
            }

            if (
              statusFlagsObj.value &
              (lazy.EnigmailConstants.DECRYPTION_FAILED |
                lazy.EnigmailConstants.MISSING_MDC)
            ) {
              log.debug("Not MDC protection. Decrypting inline anyway.");
            }
            if (
              statusFlagsObj.value & lazy.EnigmailConstants.DECRYPTION_FAILED
            ) {
              // since we cannot find out if the user wants to cancel
              // we should ask
              const msg = await lazy.l10n.formatValue(
                "converter-decrypt-body-failed",
                {
                  subject: this.subject,
                }
              );

              if (
                this.disablePrompts ||
                Services.prompt.confirmEx(
                  null,
                  null,
                  msg,
                  Services.prompt.STD_OK_CANCEL_BUTTONS,
                  lazy.l10n.formatValueSync("dlg-button-retry"),
                  lazy.l10n.formatValueSync("dlg-button-skip"),
                  null,
                  null,
                  {}
                )
              ) {
                // Either user pressed skip/cancel, or prompts are forbidden.
                this.cryptoChanged = false;
                this.decryptFailure = true;
                log.warn(msg);
                return -1;
              }
            } else if (
              statusFlagsObj.value &
              lazy.EnigmailConstants.DECRYPTION_INCOMPLETE
            ) {
              this.cryptoChanged = false;
              this.decryptFailure = true;
              return -1;
            } else {
              plaintext = " ";
            }
          }

          if (ct === "text/html") {
            plaintext = plaintext.replace(/\n/gi, "<br/>\n");
          }

          let subject = "";
          if (this.mimeTree.headers.has("subject")) {
            subject = this.mimeTree.headers.get("subject");
          }

          if (
            i == 0 &&
            subject === "pEp" &&
            mimeTreePart.partNum.length > 0 &&
            mimeTreePart.partNum.search(/[^01.]/) < 0
          ) {
            const m = lazy.EnigmailMime.extractSubjectFromBody(plaintext);
            if (m) {
              plaintext = m.messageBody;
              this.mimeTree.headers._rawHeaders.set("subject", [m.subject]);
            }
          }

          if (plaintext) {
            plaintexts.push(plaintext);
          }
        } while (!plaintext || plaintext === "");
      }

      var decryptedMessage =
        mimeTreePart.body.substring(0, blocks[0].begin) + plaintexts[0];
      for (let i = 1; i < blocks.length; i++) {
        decryptedMessage +=
          mimeTreePart.body.substring(
            blocks[i - 1].end + 1,
            blocks[i].begin + 1
          ) + plaintexts[i];
      }

      decryptedMessage += mimeTreePart.body.substring(
        blocks[blocks.length - 1].end + 1
      );

      // enable base64 encoding if non-ASCII character(s) found
      const j = decryptedMessage.search(/[^\x01-\x7F]/); // eslint-disable-line no-control-regex
      if (j >= 0) {
        mimeTreePart.headers._rawHeaders.set("content-transfer-encoding", [
          "base64",
        ]);
      } else {
        mimeTreePart.headers._rawHeaders.set("content-transfer-encoding", [
          "8bit",
        ]);
      }
      mimeTreePart.body = decryptedMessage;

      const origCharset = getCharset(mimeTreePart, "content-type");
      if (origCharset) {
        mimeTreePart.headers._rawHeaders.set(
          "content-type",
          getHeaderValue(mimeTreePart, "content-type").replace(
            origCharset,
            charset
          )
        );
      } else {
        mimeTreePart.headers._rawHeaders.set(
          "content-type",
          getHeaderValue(mimeTreePart, "content-type") + "; charset=" + charset
        );
      }

      this.cryptoChanged = true;
      return 1;
    }
    return 0;
  }

  /**
   * @param {MimeTreePart} mimeTreePart
   */
  fixExchangeMessage(mimeTreePart) {
    const msg = mimeTreeToString(mimeTreePart, true);
    const fixedMsg = lazy.EnigmailFixExchangeMsg.getRepairedMessage(msg);
    const replacement = getMimeTree(fixedMsg, true);
    for (const i in replacement) {
      mimeTreePart[i] = replacement[i];
    }
  }
}

function stripHTMLFromArmoredBlocks(text) {
  var index = 0;
  var begin = text.indexOf("-----BEGIN PGP");
  var end = text.indexOf("-----END PGP");

  while (begin > -1 && end > -1) {
    let sub = text.substring(begin, end);

    sub = sub.replace(/(<([^>]+)>)/gi, "");
    sub = sub.replace(/&[A-z]+;/gi, "");

    text = text.substring(0, begin) + sub + text.substring(end);

    index = end + 10;
    begin = text.indexOf("-----BEGIN PGP", index);
    end = text.indexOf("-----END PGP", index);
  }

  return text;
}

function getHeaderValue(mimeStruct, header) {
  try {
    if (mimeStruct.headers.has(header)) {
      const hdrVal = mimeStruct.headers.get(header);
      if (typeof hdrVal == "string") {
        return hdrVal;
      }
      return mimeStruct.headers[header].join(" ");
    }
    return "";
  } catch (e) {
    log.debug("Could not get header value for header=" + header, e);
    return "";
  }
}

function getContentType(mimeTreePart) {
  try {
    if (
      mimeTreePart &&
      "headers" in mimeTreePart &&
      mimeTreePart.headers.has("content-type")
    ) {
      return mimeTreePart.headers.get("content-type").type.toLowerCase();
    }
  } catch (e) {
    log.debug("Get content type failed.", e);
  }
  return null;
}

// return the content of the boundary parameter
function getBoundary(mimeTreePart) {
  try {
    if (
      mimeTreePart &&
      "headers" in mimeTreePart &&
      mimeTreePart.headers.has("content-type")
    ) {
      return mimeTreePart.headers.get("content-type").get("boundary");
    }
  } catch (e) {
    log.debug("Get boundary failed.", e);
  }
  return null;
}

function getCharset(mimeTreePart) {
  try {
    if (
      mimeTreePart &&
      "headers" in mimeTreePart &&
      mimeTreePart.headers.has("content-type")
    ) {
      const c = mimeTreePart.headers.get("content-type").get("charset");
      if (c) {
        return c.toLowerCase();
      }
    }
  } catch (e) {
    log.debug("Get charset failed.", e);
  }
  return null;
}

function getTransferEncoding(mimeTreePart) {
  try {
    if (
      mimeTreePart &&
      "headers" in mimeTreePart &&
      mimeTreePart.headers._rawHeaders.has("content-transfer-encoding")
    ) {
      const c = mimeTreePart.headers._rawHeaders.get(
        "content-transfer-encoding"
      )[0];
      if (c) {
        return c.toLowerCase();
      }
    }
  } catch (e) {
    log.debug("Get transfer encoding failed.", e);
  }
  return "8Bit";
}

function isAttachment(mimeTreePart) {
  try {
    if (mimeTreePart && "headers" in mimeTreePart) {
      if (mimeTreePart.fullContentType.search(/^multipart\//i) === 0) {
        return false;
      }
      if (mimeTreePart.fullContentType.search(/^text\//i) < 0) {
        return true;
      }

      if (mimeTreePart.headers.has("content-disposition")) {
        const c = mimeTreePart.headers.get("content-disposition")[0];
        if (c) {
          if (c.search(/^attachment/i) === 0) {
            return true;
          }
        }
      }
    }
  } catch (x) {}
  return false;
}

/**
 * If the given MimeTreePart is an attachment, return its filename.
 *
 * @param {MimeTreePart} mimeTreePart
 * @returns {?string} the filename or null
 */
function getAttachmentName(mimeTreePart) {
  if (
    "headers" in mimeTreePart &&
    mimeTreePart.headers.has("content-disposition")
  ) {
    const c = mimeTreePart.headers.get("content-disposition")[0];
    if (/^attachment/i.test(c)) {
      return lazy.EnigmailMime.getParameter(c, "filename");
    }
  }
  return null;
}

function getPepSubject(mimeString) {
  let subject = null;
  const emitter = {
    ct: "",
    firstPlainText: false,
    startPart(partNum, headers) {
      try {
        this.ct = String(headers.getRawHeader("content-type")).toLowerCase();
        if (!subject && !this.firstPlainText) {
          const s = headers.getRawHeader("subject");
          if (s) {
            subject = String(s);
            this.firstPlainText = true;
          }
        }
      } catch (ex) {
        this.ct = "";
      }
    },

    endPart() {},

    deliverPartData(partNum, data) {
      if (!this.firstPlainText && this.ct.search(/^text\/plain/) === 0) {
        // check data
        this.firstPlainText = true;

        const o = lazy.EnigmailMime.extractSubjectFromBody(data);
        if (o) {
          subject = o.subject;
        }
      }
    },
  };

  try {
    const p = new lazy.jsmime.MimeParser(emitter, {
      strformat: "unicode",
      bodyformat: "decode",
    });
    p.deliverData(mimeString);
  } catch (ex) {}

  return subject;
}

/**
 * Function to reassemble the message from a MimeTreePart.
 *
 * @param {mimeTreePart} mimeTreePart
 * @param {boolean} includeHeaders
 * @returns {string}
 */
export function mimeTreeToString(mimeTreePart, includeHeaders) {
  let msg = "";
  const rawHdr = mimeTreePart.headers._rawHeaders;

  if (includeHeaders && rawHdr.size > 0) {
    for (const hdr of rawHdr.keys()) {
      const formatted = lazy.EnigmailMime.formatMimeHeader(
        hdr,
        rawHdr.get(hdr)
      );
      msg += formatted;
      if (!formatted.endsWith("\r\n")) {
        msg += "\r\n";
      }
    }

    msg += "\r\n";
  }

  if (mimeTreePart.body.length > 0) {
    let encoding = getTransferEncoding(mimeTreePart);
    if (!encoding) {
      encoding = "8bit";
    }

    if (encoding === "base64") {
      msg += lazy.EnigmailData.encodeBase64(mimeTreePart.body);
    } else {
      const charset = getCharset(mimeTreePart, "content-type");
      if (charset) {
        msg += lazy.EnigmailData.convertFromUnicode(mimeTreePart.body, charset);
      } else {
        msg += mimeTreePart.body;
      }
    }
  }

  if (mimeTreePart.subParts.length > 0) {
    const boundary = lazy.EnigmailMime.getBoundary(
      rawHdr.get("content-type").join("")
    );

    for (const i in mimeTreePart.subParts) {
      msg += `--${boundary}\r\n`;
      msg += mimeTreeToString(mimeTreePart.subParts[i], true);
      if (msg.search(/[\r\n]$/) < 0) {
        msg += "\r\n";
      }
      msg += "\r\n";
    }

    msg += `--${boundary}--\r\n`;
  }
  return msg;
}

/**
 * @callback MimeTreeFromUrlCallback
 *
 * Function is called when parsing is complete.
 * @param {MimeTreePart} aimeTreePart
 */

/**
 * Parse a MIME message and return a tree structure of MimeTreePart
 *
 * @param {string} url - the URL to load and parse
 * @param {boolean} getBody - if true, delivers the body of each MimeTreePart
 * @param {MimeTreeFromUrlCallback} callbackFunc - the callback function that is
 *   called asynchronously when parsing is complete.
 */
export function getMimeTreeFromUrl(url, getBody = false, callbackFunc) {
  function onData(data) {
    const tree = getMimeTree(data, getBody);
    callbackFunc(tree);
  }

  const chan = lazy.EnigmailStreams.createChannel(url);
  const bufferListener = lazy.EnigmailStreams.newStringStreamListener(onData);
  chan.asyncOpen(bufferListener, null);
}

/**
 * Return the contents of a message.
 *
 * @param {string} url - the URL to load and parse
 * @param {MimeTreeFromUrlCallback} callbackFunc - the callback function that is
 *   called asynchronously when parsing is complete.
 */
export function getMessageFromUrl(url, callbackFunc) {
  function onData(data) {
    callbackFunc(data);
  }
  const chan = lazy.EnigmailStreams.createChannel(url);
  const bufferListener = lazy.EnigmailStreams.newStringStreamListener(onData);
  chan.asyncOpen(bufferListener, null);
}

/**
 * Parse a MIME message and return a tree structure of MimeTreePart.
 *
 * @param {string} mimeStr - string of a MIME message
 * @param {boolean} getBody - returned MimeTreePart includes body
 *
 * @returns {MimeTreePart}
 */
export function getMimeTree(mimeStr, getBody = false) {
  const jsmimeEmitter = new MimeTreeEmitter({
    enableFilterMode: false,
  });

  const opt = {
    strformat: "unicode",
    bodyformat: getBody ? "decode" : "none",
    stripcontinuations: false,
  };

  try {
    const p = new lazy.jsmime.MimeParser(jsmimeEmitter, opt);
    p.deliverData(mimeStr);
    return jsmimeEmitter.mimeTree.subParts[0];
  } catch (ex) {
    return null;
  }
}
