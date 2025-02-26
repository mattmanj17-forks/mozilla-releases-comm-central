/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

/**
 * Maintain a list of all active stream listeners so that we can cancel them all
 *  during shutdown.  If we don't cancel them, we risk calls into javascript
 *  from C++ after the various XPConnect contexts have already begun their
 *  teardown process.
 */
var activeStreamListeners = {};

var shutdownCleanupObserver = {
  _initialized: false,
  ensureInitialized() {
    if (this._initialized) {
      return;
    }

    Services.obs.addObserver(this, "quit-application");

    this._initialized = true;
  },

  observe(aSubject, aTopic) {
    if (aTopic == "quit-application") {
      Services.obs.removeObserver(this, "quit-application");

      for (const uri in activeStreamListeners) {
        const streamListener = activeStreamListeners[uri];
        if (streamListener._request) {
          streamListener._request.cancel(Cr.NS_BINDING_ABORTED);
        }
      }
    }
  },
};

function CallbackStreamListener(aMsgHdr, aCallbackThis, aCallback) {
  this._msgHdr = aMsgHdr;
  // Messages opened from file or attachments do not have a folder property, but
  // have their url stored as a string property.
  this._hdrURI = aMsgHdr.folder
    ? aMsgHdr.folder.getUriForMsg(aMsgHdr)
    : aMsgHdr.getStringProperty("dummyMsgUrl");

  this._request = null;
  this._stream = null;
  if (aCallback === undefined) {
    this._callbacksThis = [null];
    this._callbacks = [aCallbackThis];
  } else {
    this._callbacksThis = [aCallbackThis];
    this._callbacks = [aCallback];
  }
  activeStreamListeners[this._hdrURI] = this;
}

/**
 * @implements {nsIRequestObserver}
 * @implements {nsIStreamListener}
 * @implements {nsIUrlListener}
 */
CallbackStreamListener.prototype = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIRequestObserver",
    "nsIStreamListener",
    "nsIUrlListener",
  ]),

  // nsIUrlListener part

  OnStartRunningUrl() {},
  OnStopRunningUrl(aUrl, aExitCode) {
    if (!Components.isSuccessCode(aExitCode)) {
      // Connection errors are not seen by onStopRequest, so we finalize on
      // fails here.
      this._finalize(null);
    }
  },

  // nsIRequestObserver part

  onStartRequest(aRequest) {
    this._request = aRequest;
  },
  onStopRequest(aRequest, aStatusCode) {
    aRequest.QueryInterface(Ci.nsIChannel);
    let message = MsgHdrToMimeMessage.RESULT_RENDEVOUZ[aRequest.URI.spec];
    if (message === undefined) {
      message = null;
    }
    delete MsgHdrToMimeMessage.RESULT_RENDEVOUZ[aRequest.URI.spec];

    if (Components.isSuccessCode(aStatusCode)) {
      // Only finalize on success here. Fails are finalized in OnStopRunningUrl.
      this._finalize(message);
    }
  },

  _finalize(message) {
    delete activeStreamListeners[this._hdrURI];

    for (let i = 0; i < this._callbacksThis.length; i++) {
      try {
        this._callbacks[i].call(this._callbacksThis[i], this._msgHdr, message);
      } catch (e) {
        // Most of the time, exceptions will silently disappear into the endless
        // deeps of XPConnect, and never reach the surface ever again. At least
        // warn the user if he has dump enabled.
        dump(
          "The MsgHdrToMimeMessage callback threw an exception: " + e + "\n"
        );
        // That one will probably never make it to the original caller.
        throw e;
      }
    }

    this._msgHdr = null;
    this._request = null;
    this._stream = null;
    this._callbacksThis = null;
    this._callbacks = null;
  },

  // nsIStreamListener part

  /**
   * Our onDataAvailable should actually never be called. The stream converter
   * is actually eating everything except the start and stop notification.
   */
  onDataAvailable(aRequest) {
    throw new Error(
      `The stream converter should have grabbed the data for ${aRequest?.URI.spec}`
    );
  },
};

/**
 * @param {?MimeContainer} aPart - MIME part to handle.
 * @returns {?MimeContainer} the MIME part, with encrypted parts removed.
 */
function stripEncryptedParts(aPart) {
  if (!aPart) {
    return null;
  }
  if (aPart.parts && aPart.isEncrypted) {
    aPart.parts = []; // Show an empty container.
  } else if (aPart.parts) {
    aPart.parts = aPart.parts.map(stripEncryptedParts);
  }
  return aPart;
}

/**
 * Starts retrieval of a MimeMessage instance for the given message header.
 *  Your callback will be called with the message header you provide and the
 *
 * @param {nsIMsgDBHdr} aMsgHdr - The message header to retrieve the body for
 *   and build a MIME representation of the message.
 * @param {object} [aCallbackThis] The (optional) 'this' to use for your
 *   callback function.
 * @param {Function} aCallback - The callback function to invoke on completion
 *   of message parsing or failure.
 *   The first argument passed will be the nsIMsgDBHdr you passed to this function.
 *   The second argument will be the MimeMessage
 *     instance resulting from the processing on success, and null on failure.
 * @param {boolean} [aAllowDownload=false] - Should we allow the message to be downloaded
 *   for this streaming request?  The default is false, which means that we
 *   require that the message be available offline.  If false is passed and
 *   the message is not available offline, we will propagate an exception
 *   thrown by the underlying code.
 * @param {object} [aOptions] - Optional options.
 * @param {integer} [aOptions.saneBodySize] Limit body sizes to a 'reasonable'
 *   size in order to combat corrupt offline/message stores creating pathological
 *   situations where we have erroneously multi-megabyte messages.  This
 *   also likely reduces the impact of legitimately ridiculously large messages.
 * @param {boolean} [aOptions.examineEncryptedParts] - By default, we won't
 *   reveal the contents of multipart/encrypted parts to the consumers, unless explicitly
 *   requested. In the case of MIME/PGP messages, for instance, the message
 *   will appear as an empty multipart/encrypted container, unless this option
 *   is used.
 */
export function MsgHdrToMimeMessage(
  aMsgHdr,
  aCallbackThis,
  aCallback,
  aAllowDownload,
  aOptions
) {
  shutdownCleanupObserver.ensureInitialized();

  const requireOffline = !aAllowDownload;
  // Messages opened from file or attachments do not have a folder property, but
  // have their url stored as a string property.
  const msgURI = aMsgHdr.folder
    ? aMsgHdr.folder.getUriForMsg(aMsgHdr)
    : aMsgHdr.getStringProperty("dummyMsgUrl");

  const msgService = MailServices.messageServiceFromURI(msgURI);

  MsgHdrToMimeMessage.OPTION_TUNNEL = aOptions;
  // By default, Enigmail only decrypts a message streamed via libmime if it's
  // the one currently on display in the message reader. With this option, we're
  // letting Enigmail know that it should decrypt the message since the client
  // explicitly asked for it.
  const encryptedStr =
    aOptions && aOptions.examineEncryptedParts
      ? "&examineEncryptedParts=true"
      : "";

  // S/MIME, our other encryption backend, is not that smart, and always
  // decrypts data. In order to protect sensitive data (e.g. not index it in
  // Gloda), unless the client asked for encrypted data, we pass to the client
  // callback a stripped-down version of the MIME structure where encrypted
  // parts have been removed.
  const wrapCallback = function (callback, callbackThis) {
    if (aOptions && aOptions.examineEncryptedParts) {
      return callback;
    }
    return (msgHdr, aMimeMsg) =>
      callback.call(callbackThis, msgHdr, stripEncryptedParts(aMimeMsg));
  };

  // Apparently there used to be an old syntax where the callback was the second
  // argument...
  const callback = aCallback ? aCallback : aCallbackThis;
  const callbackThis = aCallback ? aCallbackThis : null;

  // if we're already streaming this msg, just add the callback
  // to the listener.
  const listenerForURI = activeStreamListeners[msgURI];
  if (listenerForURI != undefined) {
    listenerForURI._callbacks.push(wrapCallback(callback, callbackThis));
    listenerForURI._callbacksThis.push(callbackThis);
    return;
  }
  const streamListener = new CallbackStreamListener(
    aMsgHdr,
    callbackThis,
    wrapCallback(callback, callbackThis)
  );

  try {
    msgService.streamMessage(
      msgURI,
      streamListener, // consumer
      null, // nsIMsgWindow
      streamListener, // nsIUrlListener
      true, // have them create the converter
      // additional uri payload, note that "header=" is prepended automatically
      "filter&emitter=js" + encryptedStr,
      requireOffline
    );
  } catch (ex) {
    // If streamMessage throws an exception, we should make sure to clear the
    // activeStreamListener, or any subsequent attempt at sreaming this URI
    // will silently fail
    if (activeStreamListeners[msgURI]) {
      delete activeStreamListeners[msgURI];
    }
    MsgHdrToMimeMessage.OPTION_TUNNEL = null;
    throw ex;
  }

  MsgHdrToMimeMessage.OPTION_TUNNEL = null;
}

/**
 * Let the jsmimeemitter provide us with results.  The poor emitter (if I am
 *  understanding things correctly) is evaluated outside of the C.u.import
 *  world, so if we were to import him, we would not see him, but rather a new
 *  copy of him.  This goes for his globals, etc.  (and is why we live in this
 *  file right here).  Also, it appears that the XPCOM JS wrappers aren't
 *  magically unified so that we can try and pass data as expando properties
 *  on things like the nsIUri instances either.  So we have the jsmimeemitter
 *  import us and poke things into RESULT_RENDEVOUZ.  We put it here on this
 *  function to try and be stealthy and avoid polluting the namespaces (or
 *  encouraging bad behaviour) of our importers.
 *
 * If you can come up with a prettier way to shuttle this data, please do.
 */
MsgHdrToMimeMessage.RESULT_RENDEVOUZ = {};
/**
 * Cram rich options here for the MimeMessageEmitter to grab from.  We
 *  leverage the known control-flow to avoid needing a whole dictionary here.
 *  We set this immediately before constructing the emitter and clear it
 *  afterwards.  Control flow is never yielded during the process and reentrancy
 *  cannot happen via any other means.
 */
MsgHdrToMimeMessage.OPTION_TUNNEL = null;

var HeaderHandlerBase = {
  /**
   * Look-up a header that should be present at most once.
   *
   * @param {string} aHeaderName - The header name to retrieve, case does not
   *   matter.
   * @param {?string} [aDefaultValue=null] The value to return if the header was
   *   not found, null if left unspecified.
   * @returns {?string} the value of the header if present, and the default
   *   value if not(defaults to null). If the header was present multiple times,
   *   the first instance of the header is returned.
   *   Use getAll if you want all of the values for the multiply-defined header.
   */
  get(aHeaderName, aDefaultValue) {
    if (aDefaultValue === undefined) {
      aDefaultValue = null;
    }
    const lowerHeader = aHeaderName.toLowerCase();
    if (lowerHeader in this.headers) {
      // we require that the list cannot be empty if present
      return this.headers[lowerHeader][0];
    }
    return aDefaultValue;
  },
  /**
   * Look-up a header that can be present multiple times.  Use get for headers
   *  that you only expect to be present at most once.
   *
   * @param {string} aHeaderName - The header name to retrieve, case does not matter.
   * @returns {string[]} An array containing the values observed, which may
   *   mean a zero length array.
   */
  getAll(aHeaderName) {
    const lowerHeader = aHeaderName.toLowerCase();
    if (lowerHeader in this.headers) {
      return this.headers[lowerHeader];
    }
    return [];
  },
  /**
   * @param {string} aHeaderName - Header name to test for its presence.
   * @returns {boolean} true if the message has (at least one value for)
   *   the given header name.
   */
  has(aHeaderName) {
    const lowerHeader = aHeaderName.toLowerCase();
    return lowerHeader in this.headers;
  },
  _prettyHeaderString(aIndent) {
    if (aIndent === undefined) {
      aIndent = "";
    }
    let s = "";
    for (const header in this.headers) {
      const values = this.headers[header];
      s += "\n        " + aIndent + header + ": " + values;
    }
    return s;
  },
};

/**
 * @class MimeMessage
 *
 * @property {string} partName - The MIME part, ex "1.2.2.1".
 *   The partName of a (top-level) message is "1", its first child is "1.1",
 *   its second child is "1.2", its first child's first child is "1.1.1", etc.
 * @property {Map<string,string>} headers - Maps lower-cased header field names
 *   to a list of the values seen for the given header.
 *   Use get or getAll as convenience helpers.
 * @property {MimeMessage[]|MimeMessageAttachment[]|MimeContainer[]|MimeUnknown[]} parts - The list
 *   of the MIME part children of this message.  Children
 *   will be either MimeMessage instances, MimeMessageAttachment instances,
 *   MimeContainer instances, or MimeUnknown instances.  The latter two are
 *   the result of limitations in the JavaScript representation generation
 *   at this time, combined with the need to most accurately represent the
 *   MIME structure.
 */
export function MimeMessage() {
  this.partName = null;
  this.headers = {};
  this.parts = [];
  this.isEncrypted = false;
}

MimeMessage.prototype = {
  __proto__: HeaderHandlerBase,
  contentType: "message/rfc822",

  /**
   * @returns {MimeMessageAttachment[]} a list of all attachments contained in
   *   this message and all its sub-messages.
   *   Only MimeMessageAttachment instances will be present in the list
   *   (no sub-messages).
   */
  get allAttachments() {
    let results = []; // messages are not attachments, don't include self
    for (let iChild = 0; iChild < this.parts.length; iChild++) {
      const child = this.parts[iChild];
      results = results.concat(child.allAttachments);
    }
    return results;
  },

  /**
   * @returns {MimeMessageAttachment[]}  a list of all attachments contained in
   *   this message and all its sub-messages, including the sub-messages.
   */
  get allInlineAttachments() {
    // Do not include the top message, but only sub-messages.
    let results = this.partName ? [this] : [];
    for (let iChild = 0; iChild < this.parts.length; iChild++) {
      const child = this.parts[iChild];
      results = results.concat(child.allInlineAttachments);
    }
    return results;
  },

  /**
   * @returns  {MimeMessageAttachment[]} a list of all attachments contained in
   *   this message, with included/forwarded messages treated as real
   *   attachments. Attachments contained in inner messages won't be shown.
   */
  get allUserAttachments() {
    if (this.url) {
      // The jsmimeemitter camouflaged us as a MimeAttachment
      return [this];
    }
    return this.parts
      .map(child => child.allUserAttachments)
      .reduce((a, b) => a.concat(b), []);
  },

  /**
   * @returns {integer} the total size of this message, that is, the size of all subparts
   */
  get size() {
    return this.parts
      .map(child => child.size)
      .reduce((a, b) => a + Math.max(b, 0), 0);
  },

  /**
   * In the case of attached messages, libmime considers them as attachments,
   * and if the body is, say, quoted-printable encoded, then libmime will start
   * counting bytes and notify the js mime emitter about it. The JS mime emitter
   * being a nice guy, it will try to set a size on us. While this is the
   * expected behavior for MimeMsgAttachments, we must make sure we can handle
   * that (failing to write a setter results in exceptions being thrown).
   *
   * @param {integer} _whatever
   */
  set size(_whatever) {
    // noop
  },

  /**
   * @param {nsIMsgFolder} aMsgFolder - A message folder, any message folder.
   *   Because this is a hack.
   * @returns {string} The concatenation of all of the body parts where parts
   *    available as text/plain are pulled as-is, and parts only available
   *    as text/html are converted to plaintext form first.  In other words,
   *    if we see a multipart/alternative with a text/plain, we take the
   *    text/plain.  If we see a text/html without an alternative, we convert
   *    that to text.
   */
  coerceBodyToPlaintext(aMsgFolder) {
    const bodies = [];
    for (const part of this.parts) {
      // an undefined value for something not having the method is fine
      const body =
        part.coerceBodyToPlaintext && part.coerceBodyToPlaintext(aMsgFolder);
      if (body) {
        bodies.push(body);
      }
    }
    if (bodies) {
      return bodies.join("");
    }
    return "";
  },

  /**
   * Convert the message and its hierarchy into a "pretty string".  The message
   *  and each MIME part get their own line.  The string never ends with a
   *  newline.  For a non-multi-part message, only a single line will be
   *  returned.
   * Messages have their subject displayed, attachments have their filename and
   *  content-type (ex: image/jpeg) displayed.  "Filler" classes simply have
   *  their class displayed.
   *
   * @param {boolean} aVerbose - Verbose.
   * @param {boolean} aIndent - Whether to indent or not.
   * @param {boolean} aDumpBody - Whether to dump() body or not.
   */
  prettyString(aVerbose, aIndent, aDumpBody) {
    if (aIndent === undefined) {
      aIndent = "";
    }
    const nextIndent = aIndent + "  ";

    let s =
      "Message " +
        (this.isEncrypted ? "[encrypted] " : "") +
        "(" +
        this.size +
        " bytes): " +
        "subject" in
      this.headers
        ? this.headers.subject
        : "";
    if (aVerbose) {
      s += this._prettyHeaderString(nextIndent);
    }

    for (let iPart = 0; iPart < this.parts.length; iPart++) {
      const part = this.parts[iPart];
      s +=
        "\n" +
        nextIndent +
        (iPart + 1) +
        " " +
        part.prettyString(aVerbose, nextIndent, aDumpBody);
    }

    return s;
  },
};

/**
 * MimeContainer. The parts held by this container can be instances of any
 * of the classes found in this file.
 *
 * @param {string} contentType - The content-type of this container.
 */
export function MimeContainer(contentType) {
  this.partName = null;
  this.contentType = contentType;
  this.headers = {};
  this.parts = [];
  this.isEncrypted = false;
}

MimeContainer.prototype = {
  __proto__: HeaderHandlerBase,
  get allAttachments() {
    let results = [];
    for (let iChild = 0; iChild < this.parts.length; iChild++) {
      const child = this.parts[iChild];
      results = results.concat(child.allAttachments);
    }
    return results;
  },
  get allInlineAttachments() {
    let results = [];
    for (let iChild = 0; iChild < this.parts.length; iChild++) {
      const child = this.parts[iChild];
      results = results.concat(child.allInlineAttachments);
    }
    return results;
  },
  get allUserAttachments() {
    return this.parts
      .map(child => child.allUserAttachments)
      .reduce((a, b) => a.concat(b), []);
  },
  get size() {
    return this.parts
      .map(child => child.size)
      .reduce((a, b) => a + Math.max(b, 0), 0);
  },
  set size(whatever) {
    // nop
  },
  coerceBodyToPlaintext(aMsgFolder) {
    if (this.contentType == "multipart/alternative") {
      let htmlPart;
      // pick the text/plain if we can find one, otherwise remember the HTML one
      for (const part of this.parts) {
        if (part.contentType == "text/plain") {
          return part.body;
        }
        if (part.contentType == "text/html") {
          htmlPart = part;
        } else if (!htmlPart && part.contentType == "text/enriched") {
          // text/enriched gets transformed into HTML, so use it if we don't
          // already have an HTML part.
          htmlPart = part;
        }
      }
      // convert the HTML part if we have one
      if (htmlPart) {
        return aMsgFolder.convertMsgSnippetToPlainText(htmlPart.body);
      }
    }
    // if it's not alternative, recurse/aggregate using MimeMessage logic
    return MimeMessage.prototype.coerceBodyToPlaintext.call(this, aMsgFolder);
  },
  prettyString(aVerbose, aIndent, aDumpBody) {
    const nextIndent = aIndent + "  ";

    let s =
      "Container " +
      (this.isEncrypted ? "[encrypted] " : "") +
      "(" +
      this.size +
      " bytes): " +
      this.contentType;
    if (aVerbose) {
      s += this._prettyHeaderString(nextIndent);
    }

    for (let iPart = 0; iPart < this.parts.length; iPart++) {
      const part = this.parts[iPart];
      s +=
        "\n" +
        nextIndent +
        (iPart + 1) +
        " " +
        part.prettyString(aVerbose, nextIndent, aDumpBody);
    }

    return s;
  },
  toString() {
    return "Container: " + this.contentType;
  },
};

/**
 * @class Represents a body portion that we understand and do not believe to be
 *  a proper attachment.  This means text/plain or text/html and it has no
 *  filename. (A filename suggests an attachment.)
 * @property {string} body - The actual body content.
 *
 * @param {string} contentType - The content type of this body materal;
 *   text/plain or text/html.
 */
export function MimeBody(contentType) {
  this.partName = null;
  this.contentType = contentType;
  this.headers = {};
  this.body = "";
  this.isEncrypted = false;
}

MimeBody.prototype = {
  __proto__: HeaderHandlerBase,
  get allAttachments() {
    return []; // we are a leaf
  },
  get allInlineAttachments() {
    return []; // we are a leaf
  },
  get allUserAttachments() {
    return []; // we are a leaf
  },
  get size() {
    return this.body.length;
  },
  set size(whatever) {
    // nop
  },
  appendBody(aBuf) {
    this.body += aBuf;
  },
  coerceBodyToPlaintext(aMsgFolder) {
    if (this.contentType == "text/plain") {
      return this.body;
    }
    // text/enriched gets transformed into HTML by libmime
    if (
      this.contentType == "text/html" ||
      this.contentType == "text/enriched"
    ) {
      return aMsgFolder.convertMsgSnippetToPlainText(this.body);
    }
    return "";
  },
  prettyString(aVerbose, aIndent, aDumpBody) {
    let s =
      "Body: " +
      (this.isEncrypted ? "[encrypted] " : "") +
      "" +
      this.contentType +
      " (" +
      this.body.length +
      " bytes" +
      (aDumpBody ? ": '" + this.body + "'" : "") +
      ")";
    if (aVerbose) {
      s += this._prettyHeaderString(aIndent + "  ");
    }
    return s;
  },
  toString() {
    return "Body: " + this.contentType + " (" + this.body.length + " bytes)";
  },
};

/**
 * @class MimeUnknown - A MIME Leaf node that doesn't have a filename so we assume it's not
 *  intended to be an attachment proper.  This is probably meant for inline
 *  display or is the result of someone amusing themselves by composing messages
 *  by hand or a bad client.  This class should probably be renamed or we should
 *  introduce a better named class that we try and use in preference to this
 *  class.
 *
 * @param {string} contentType - The content type of this part.
 */
export function MimeUnknown(contentType) {
  this.partName = null;
  this.contentType = contentType;
  this.headers = {};
  // Looks like libmime does not always interpret us as an attachment, which
  //  means we'll have to have a default size. Returning undefined would cause
  //  the recursive size computations to fail.
  this._size = 0;
  this.isEncrypted = false;
  // We want to make sure MimeUnknown has a part property: S/MIME encrypted
  // messages have a topmost MimeUnknown part, with the encrypted bit set to 1,
  // and we need to ensure all other encrypted parts are children of this
  // topmost part.
  this.parts = [];
}

MimeUnknown.prototype = {
  __proto__: HeaderHandlerBase,
  get allAttachments() {
    return this.parts
      .map(child => child.allAttachments)
      .reduce((a, b) => a.concat(b), []);
  },
  get allInlineAttachments() {
    return this.parts
      .map(child => child.allInlineAttachments)
      .reduce((a, b) => a.concat(b), []);
  },
  get allUserAttachments() {
    return this.parts
      .map(child => child.allUserAttachments)
      .reduce((a, b) => a.concat(b), []);
  },
  get size() {
    return (
      this._size +
      this.parts
        .map(child => child.size)
        .reduce((a, b) => a + Math.max(b, 0), 0)
    );
  },
  set size(aSize) {
    this._size = aSize;
  },
  prettyString(aVerbose, aIndent, aDumpBody) {
    const nextIndent = aIndent + "  ";

    let s =
      "Unknown: " +
      (this.isEncrypted ? "[encrypted] " : "") +
      "" +
      this.contentType +
      " (" +
      this.size +
      " bytes)";
    if (aVerbose) {
      s += this._prettyHeaderString(aIndent + "  ");
    }

    for (let iPart = 0; iPart < this.parts.length; iPart++) {
      const part = this.parts[iPart];
      s +=
        "\n" +
        nextIndent +
        (iPart + 1) +
        " " +
        (part ? part.prettyString(aVerbose, nextIndent, aDumpBody) : "NULL");
    }
    return s;
  },
  toString() {
    return "Unknown: " + this.contentType;
  },
};

/**
 * @class MimeMessageAttachment - An attachment proper.
 *   We think it's an attachment because it has a filename that libmime was able
 *   to figure out.
 *
 * @property {string} partName - @see{MimeMessage.partName}
 * @property {string} name - The filename of this attachment.
 * @property {string} contentType - The MIME content type of this part.
 * @property {string} url - The URL to stream if you want the contents of this part.
 * @property {boolean} isExternal - Is the attachment stored someplace else than in the message?
 * @property {integer} size - The size of the attachment if available, -1 otherwise (size is set
 *  after initialization by jsmimeemitter.js)
 *
 * @param {string} aPartName
 * @param {string} aName
 * @param {string} aContentType
 * @param {string} aUrl
 * @param {boolean} aIsExternal
 */
export function MimeMessageAttachment(
  aPartName,
  aName,
  aContentType,
  aUrl,
  aIsExternal
) {
  this.partName = aPartName;
  this.name = aName;
  this.contentType = aContentType;
  this.url = aUrl;
  this.isExternal = aIsExternal;
  this.headers = {};
  this.isEncrypted = false;
  // parts is copied over from the part instance that preceded us
  // headers is copied over from the part instance that preceded us
  // isEncrypted is copied over from the part instance that preceded us
}

MimeMessageAttachment.prototype = {
  __proto__: HeaderHandlerBase,
  get allAttachments() {
    return [this]; // we are a leaf, so just us.
  },
  get allInlineAttachments() {
    return [this]; // we are a leaf, so just us.
  },
  get allUserAttachments() {
    return [this];
  },
  prettyString(aVerbose, aIndent) {
    let s =
      "Attachment " +
      (this.isEncrypted ? "[encrypted] " : "") +
      "(" +
      this.size +
      " bytes): " +
      this.name +
      ", " +
      this.contentType;
    if (aVerbose) {
      s += this._prettyHeaderString(aIndent + "  ");
    }
    return s;
  },
  toString() {
    return this.prettyString(false, "");
  },
};
