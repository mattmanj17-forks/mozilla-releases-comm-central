/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
// vim:set ts=2 sw=2 sts=2 et ft=javascript:

import { jsmime } from "resource:///modules/jsmime.sys.mjs";

/** @implements {MimeEmitter} */
var ExtractHeadersEmitter = {
  startPart(partNum, headers) {
    if (partNum == "") {
      this.headers = headers;
    }
  },
};

/** @implements {MimeEmitter} */
var ExtractHeadersAndBodyEmitter = {
  body: "",
  startPart: ExtractHeadersEmitter.startPart,
  deliverPartData(partNum, data) {
    if (partNum == "") {
      this.body += data;
    }
  },
};

// Sets appropriate default options for chrome-privileged environments
function setDefaultParserOptions(opts) {
  if (!("onerror" in opts)) {
    opts.onerror = Cu.reportError;
  }
}

export var MimeParser = {
  /***
   * Determine an arbitrary "parameter" part of a mail header.
   *
   * @param {string} headerStr - The string containing all parts of the header.
   * @param {string} parameter - The parameter we are looking for.
   *
   * 'multipart/signed; protocol="xyz"', 'protocol' --> returns "xyz"
   *
   * @return {string} String containing the value of the parameter; or "".
   */
  getParameter(headerStr, parameter) {
    parameter = parameter.toLowerCase();
    headerStr = headerStr.replace(/[\r\n]+[ \t]+/g, "");

    const hdrMap = jsmime.headerparser.parseParameterHeader(
      ";" + headerStr,
      true,
      true
    );

    for (const [key, value] of hdrMap.entries()) {
      if (parameter == key.toLowerCase()) {
        return value;
      }
    }

    return "";
  },

  /**
   * Triggers an asynchronous parse of the given input.
   *
   * The input is an input stream; the stream will be read until EOF and then
   * closed upon completion. Both blocking and nonblocking streams are
   * supported by this implementation, but it is still guaranteed that the first
   * callback will not happen before this method returns.
   *
   * @param {nsIInputStream} input - An input stream of text to parse.
   * @param {MimeEmitter} emitter - The emitter to receive callbacks on.
   * @param {MimeParserOptions} opts - A set of options for the parser.
   */
  parseAsync(input, emitter, opts) {
    // Normalize the input into an input stream.
    if (!(input instanceof Ci.nsIInputStream)) {
      throw new Error("input is not a recognizable type!");
    }

    // We need a pump for the listener
    var pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(
      Ci.nsIInputStreamPump
    );
    pump.init(input, 0, 0, true);

    // Make a stream listener with the given emitter and use it to read from
    // the pump.
    var parserListener = MimeParser.makeStreamListenerParser(emitter, opts);
    pump.asyncRead(parserListener);
  },

  /**
   * Triggers an synchronous parse of the given input.
   *
   * The input is a string that is immediately parsed, calling all functions on
   * the emitter before this function returns.
   *
   * @param {string} input - A string of text to parse.
   * @param {MimeEmitter} emitter - The emitter to receive callbacks on.
   * @param {MimeParserOptions} opts - A set of options for the parser.
   */
  parseSync(input, emitter, opts) {
    // We only support string parsing if we are trying to do this parse
    // synchronously.
    if (typeof input != "string") {
      throw new Error("input is not a recognizable type!");
    }
    setDefaultParserOptions(opts);
    var parser = new jsmime.MimeParser(emitter, opts);
    parser.deliverData(input);
    parser.deliverEOF();
  },

  /**
   * Returns a stream listener that feeds data into a parser.
   *
   * In addition to the functions on the emitter that the parser may use, the
   * generated stream listener will also make calls to onStartRequest and
   * onStopRequest on the emitter (if they exist).
   *
   * @param {MimeEmitter} emitter - The emitter to receive callbacks on.
   * @param {MimeParserOptions} opts - A set of options for the parser.
   */
  makeStreamListenerParser(emitter, opts) {
    var StreamListener = {
      onStartRequest(aRequest) {
        try {
          if ("onStartRequest" in emitter) {
            emitter.onStartRequest(aRequest);
          }
        } finally {
          this._parser.resetParser();
        }
      },
      onStopRequest(aRequest, aStatus) {
        this._parser.deliverEOF();
        if ("onStopRequest" in emitter) {
          emitter.onStopRequest(aRequest, aStatus);
        }
      },
      onDataAvailable(aRequest, aStream, aOffset, aCount) {
        var scriptIn = Cc[
          "@mozilla.org/scriptableinputstream;1"
        ].createInstance(Ci.nsIScriptableInputStream);
        scriptIn.init(aStream);
        // Use readBytes instead of read to handle embedded NULs properly.
        this._parser.deliverData(scriptIn.readBytes(aCount));
      },
      QueryInterface: ChromeUtils.generateQI([
        "nsIStreamListener",
        "nsIRequestObserver",
      ]),
    };
    setDefaultParserOptions(opts);
    StreamListener._parser = new jsmime.MimeParser(emitter, opts);
    return StreamListener;
  },

  /**
   * Returns a new raw MIME parser.
   *
   * Prefer one of the other methods where possible, since the input here must
   * be driven manually.
   *
   * @param {MimeEmitter} emitter - The emitter to receive callbacks on.
   * @param {MimeParserOptions} opts - A set of options for the parser.
   */
  makeParser(emitter, opts) {
    setDefaultParserOptions(opts);
    return new jsmime.MimeParser(emitter, opts);
  },

  /**
   * Returns a dictionary of headers for the given input.
   *
   * The input is any type of input that would be accepted by parseSync. What
   * is returned is a JS object that represents the headers of the entire
   * envelope as would be received by startPart when partNum is the empty
   * string.
   *
   * @param {string} input - A string of text to parse.
   */
  extractHeaders(input) {
    var emitter = Object.create(ExtractHeadersEmitter);
    MimeParser.parseSync(input, emitter, { pruneat: "", bodyformat: "none" });
    return emitter.headers;
  },

  /**
   * Returns the headers and body for the given input message.
   *
   * The return value is an array whose first element is the dictionary of
   * headers (as would be returned by extractHeaders) and whose second element
   * is a binary string of the entire body of the message.
   *
   * @param {string} input - A string of text to parse.
   */
  extractHeadersAndBody(input) {
    var emitter = Object.create(ExtractHeadersAndBodyEmitter);
    MimeParser.parseSync(input, emitter, { pruneat: "", bodyformat: "raw" });
    return [emitter.headers, emitter.body];
  },

  // Parameters for parseHeaderField

  /**
   * Parse the header as if it were unstructured.
   *
   * This results in the same string if no other options are specified. If other
   * options are specified, this causes the string to be modified appropriately.
   */
  HEADER_UNSTRUCTURED: 0x00,
  /**
   * Parse the header as if it were in the form text; attr=val; attr=val.
   *
   * Such headers include Content-Type, Content-Disposition, and most other
   * headers used by MIME as opposed to messages.
   */
  HEADER_PARAMETER: 0x02,
  /**
   * Parse the header as if it were a sequence of mailboxes.
   */
  HEADER_ADDRESS: 0x03,

  /**
   * This decodes parameter values according to RFC 2231.
   *
   * This flag means nothing if HEADER_PARAMETER is not specified.
   */
  HEADER_OPTION_DECODE_2231: 0x10,
  /**
   * This decodes the inline encoded-words that are in RFC 2047.
   */
  HEADER_OPTION_DECODE_2047: 0x20,
  /**
   * This converts the header from a raw string to proper Unicode.
   */
  HEADER_OPTION_ALLOW_RAW: 0x40,

  // Convenience for all three of the above.
  HEADER_OPTION_ALL_I18N: 0x70,

  /**
   * Parse a header field according to the specification given by flags.
   *
   * Permissible flags begin with one of the HEADER_* flags, which may be or'd
   * with any of the HEADER_OPTION_* flags to modify the result appropriately.
   *
   * If the option HEADER_OPTION_ALLOW_RAW is passed, the charset parameter, if
   * present, is the charset to fallback to if the header is not decodable as
   * UTF-8 text. If HEADER_OPTION_ALLOW_RAW is passed but the charset parameter
   * is not provided, then no fallback decoding will be done. If
   * HEADER_OPTION_ALLOW_RAW is not passed, then no attempt will be made to
   * convert charsets.
   *
   * @param {string} text - The value of a MIME or message header to parse.
   * @param {integer} flags - A set of flags that controls interpretation of the header.
   * @param {string} charset - A default charset to assume if no information may be found.
   */
  parseHeaderField(text, flags, charset) {
    // If we have a raw string, convert it to Unicode first
    if (flags & MimeParser.HEADER_OPTION_ALLOW_RAW) {
      text = jsmime.headerparser.convert8BitHeader(text, charset);
    }

    // The low 4 bits indicate the type of the header we are parsing. All of the
    // higher-order bits are flags.
    switch (flags & 0x0f) {
      case MimeParser.HEADER_UNSTRUCTURED:
        if (flags & MimeParser.HEADER_OPTION_DECODE_2047) {
          text = jsmime.headerparser.decodeRFC2047Words(text);
        }
        return text;
      case MimeParser.HEADER_PARAMETER:
        return jsmime.headerparser.parseParameterHeader(
          text,
          (flags & MimeParser.HEADER_OPTION_DECODE_2047) != 0,
          (flags & MimeParser.HEADER_OPTION_DECODE_2231) != 0
        );
      case MimeParser.HEADER_ADDRESS:
        return jsmime.headerparser.parseAddressingHeader(
          text,
          (flags & MimeParser.HEADER_OPTION_DECODE_2047) != 0
        );
      default:
        throw new Error("Illegal type of header field");
    }
  },
};
