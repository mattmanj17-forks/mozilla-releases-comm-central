/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

import { MailUtils } from "resource:///modules/MailUtils.sys.mjs";
import { jsmime } from "resource:///modules/jsmime.sys.mjs";

/**
 * Collection of helper functions for message sending process.
 */
export var MsgUtils = {
  sendLogger: console.createInstance({
    prefix: "mailnews.send",
    maxLogLevel: "Warn",
    maxLogLevelPref: "mailnews.send.loglevel",
  }),

  smtpLogger: console.createInstance({
    prefix: "mailnews.smtp",
    maxLogLevel: "Warn",
    maxLogLevelPref: "mailnews.smtp.loglevel",
  }),

  /**
   * Convert html to text to form a multipart/alternative message. The output
   * depends on preference.
   *
   * @param {string} input - The HTML text to convert.
   * @param {boolean} formatFlowed - A flag to enable OutputFormatFlowed.
   * @returns {string}
   */
  convertToPlainText(input, formatFlowed) {
    let wrapWidth = Services.prefs.getIntPref("mailnews.wraplength", 72);
    if (wrapWidth == 0 || wrapWidth > 990) {
      wrapWidth = 990;
    } else if (wrapWidth < 10) {
      wrapWidth = 10;
    }

    let flags =
      Ci.nsIDocumentEncoder.OutputPersistNBSP |
      Ci.nsIDocumentEncoder.OutputFormatted |
      Ci.nsIDocumentEncoder.OutputDisallowLineBreaking;
    if (formatFlowed) {
      flags |= Ci.nsIDocumentEncoder.OutputFormatFlowed;
    }

    const parserUtils = Cc["@mozilla.org/parserutils;1"].getService(
      Ci.nsIParserUtils
    );
    return parserUtils.convertToPlainText(input, flags, wrapWidth);
  },

  /**
   * Get the list of default custom headers.
   *
   * @param {nsIMsgIdentity} userIdentity - User identity.
   * @returns {{headerName: string, headerValue: string}[]}
   */
  getDefaultCustomHeaders(userIdentity) {
    // mail.identity.<id#>.headers pref is a comma separated value of pref names
    // containing headers to add headers are stored in
    const headerAttributes = userIdentity
      .getUnicharAttribute("headers")
      .split(",");
    const headers = [];
    for (const attr of headerAttributes) {
      // mail.identity.<id#>.header.<header name> grab all the headers
      const attrValue = userIdentity.getUnicharAttribute(`header.${attr}`);
      if (attrValue) {
        const colonIndex = attrValue.indexOf(":");
        headers.push({
          headerName: attrValue.slice(0, colonIndex),
          headerValue: attrValue.slice(colonIndex + 1).trim(),
        });
      }
    }
    return headers;
  },

  /**
   * Get the fcc value.
   *
   * @param {nsIMsgIdentity} userIdentity - The user identity.
   * @param {nsIMsgCompFields} compFields - The compose fields.
   * @param {string} originalMsgURI - The original message uri, can be null.
   * @param {MSG_ComposeType} compType - The compose type.
   * @returns {string}
   */
  getFcc(userIdentity, compFields, originalMsgURI, compType) {
    // Check if the default fcc has been overridden.
    let fcc = "";
    let useDefaultFcc = true;
    if (compFields.fcc) {
      if (compFields.fcc.startsWith("nocopy://")) {
        useDefaultFcc = false;
        fcc = "";
      } else {
        const folder = MailUtils.getExistingFolder(compFields.fcc);
        if (folder) {
          useDefaultFcc = false;
          fcc = compFields.fcc;
        }
      }
    }

    // If the identity pref "fcc" is set to false, then we will not do the default
    // FCC operation but still allow the override.
    if (!userIdentity.doFcc) {
      return fcc;
    }

    // We use default FCC setting if it's not set or was set to an invalid
    // folder.
    if (useDefaultFcc) {
      // Only check whether the user wants the message in the original message
      // folder if the msgcomptype is some kind of a reply.
      if (
        originalMsgURI &&
        [
          Ci.nsIMsgCompType.Reply,
          Ci.nsIMsgCompType.ReplyAll,
          Ci.nsIMsgCompType.ReplyToGroup,
          Ci.nsIMsgCompType.ReplyToSender,
          Ci.nsIMsgCompType.ReplyToSenderAndGroup,
          Ci.nsIMsgCompType.ReplyToList,
          Ci.nsIMsgCompType.ReplyWithTemplate,
        ].includes(compType)
      ) {
        let msgHdr;
        try {
          msgHdr =
            MailServices.messageServiceFromURI(
              originalMsgURI
            ).messageURIToMsgHdr(originalMsgURI);
        } catch (e) {
          console.warn(
            `messageServiceFromURI failed for ${originalMsgURI}`,
            e.stack
          );
        }
        if (msgHdr) {
          const folder = msgHdr.folder;
          if (
            folder &&
            folder.canFileMessages &&
            folder.server &&
            folder.server.getStringValue("type") != "rss" &&
            userIdentity.fccReplyFollowsParent
          ) {
            fcc = folder.URI;
            useDefaultFcc = false;
          }
        }
      }

      if (useDefaultFcc) {
        const uri = this.getMsgFolderURIFromPrefs(
          userIdentity,
          Ci.nsIMsgSend.nsMsgDeliverNow
        );
        fcc = uri == "nocopy://" ? "" : uri;
      }
    }

    return fcc;
  },

  canSaveToFolder(folderUri) {
    const folder = MailUtils.getOrCreateFolder(folderUri);
    if (folder.server) {
      return folder.server.canFileMessagesOnServer;
    }
    return false;
  },

  /**
   * Get the To header value. When we don't have disclosed recipient but only
   * Bcc, use the undisclosedRecipients entry from composeMsgs.properties as the
   * To header value to prevent problem with some servers.
   *
   * @param {nsIMsgCompFields} compFields - The compose fields.
   * @param {nsMsgDeliverMode} deliverMode - The deliver mode.
   * @returns {string}
   */
  getUndisclosedRecipients(compFields, deliverMode) {
    // Newsgroups count as recipients.
    const hasDisclosedRecipient =
      compFields.to || compFields.cc || compFields.newsgroups;
    // If we are saving the message as a draft, don't bother inserting the
    // undisclosed recipients field. We'll take care of that when we really send
    // the message.
    if (
      hasDisclosedRecipient ||
      [
        Ci.nsIMsgSend.nsMsgDeliverBackground,
        Ci.nsIMsgSend.nsMsgSaveAsDraft,
        Ci.nsIMsgSend.nsMsgSaveAsTemplate,
      ].includes(deliverMode) ||
      !Services.prefs.getBoolPref("mail.compose.add_undisclosed_recipients")
    ) {
      return "";
    }
    const composeBundle = Services.strings.createBundle(
      "chrome://messenger/locale/messengercompose/composeMsgs.properties"
    );
    const undisclosedRecipients = composeBundle.GetStringFromName(
      "undisclosedRecipients"
    );
    const recipients = MailServices.headerParser.makeGroupObject(
      undisclosedRecipients,
      []
    );
    return recipients.toString();
  },

  /**
   * Get the Mail-Followup-To header value.
   * See bug #204339 and http://cr.yp.to/proto/replyto.html for details
   *
   * @param {nsIMsgCompFields} compFields - The compose fields.
   * @param {nsIMsgIdentity} userIdentity - The user identity.
   * @returns {string}
   */
  getMailFollowupToHeader(compFields, userIdentity) {
    const mailLists = userIdentity.getUnicharAttribute(
      "subscribed_mailing_lists"
    );
    if (!mailLists || !(compFields.to || compFields.cc)) {
      return "";
    }
    let recipients = compFields.to;
    if (recipients) {
      if (compFields.cc) {
        recipients += `,${compFields.cc}`;
      }
    } else {
      recipients = compFields.cc;
    }
    const recipientsDedup =
      MailServices.headerParser.removeDuplicateAddresses(recipients);
    const recipientsWithoutMailList =
      MailServices.headerParser.removeDuplicateAddresses(
        recipientsDedup,
        mailLists
      );
    if (recipientsDedup != recipientsWithoutMailList) {
      return recipients;
    }
    return "";
  },

  /**
   * Get the Mail-Reply-To header value.
   * See bug #204339 and http://cr.yp.to/proto/replyto.html for details
   *
   * @param {nsIMsgCompFields} compFields - The compose fields.
   * @param {nsIMsgIdentity} userIdentity - The user identity.
   * @returns {string}
   */
  getMailReplyToHeader(compFields, userIdentity) {
    const mailLists = userIdentity.getUnicharAttribute(
      "replyto_mangling_mailing_lists"
    );
    if (
      !mailLists ||
      mailLists[0] == "*" ||
      !(compFields.to || compFields.cc)
    ) {
      return "";
    }
    let recipients = compFields.to;
    if (recipients) {
      if (compFields.cc) {
        recipients += `,${compFields.cc}`;
      }
    } else {
      recipients = compFields.cc;
    }
    const recipientsDedup =
      MailServices.headerParser.removeDuplicateAddresses(recipients);
    const recipientsWithoutMailList =
      MailServices.headerParser.removeDuplicateAddresses(
        recipientsDedup,
        mailLists
      );
    if (recipientsDedup != recipientsWithoutMailList) {
      return compFields.replyTo || compFields.from;
    }
    return "";
  },

  /**
   * Get the X-Mozilla-Draft-Info header value.
   *
   * @param {nsIMsgCompFields} compFields - The compose fields.
   * @returns {string}
   */
  getXMozillaDraftInfo(compFields) {
    const getCompField = (property, key) => {
      const value = compFields[property] ? 1 : 0;
      return `${key}=${value}; `;
    };
    let draftInfo = "internal/draft; ";
    draftInfo += getCompField("attachVCard", "vcard");

    let receiptValue = 0;
    if (compFields.returnReceipt) {
      // slight change compared to 4.x; we used to use receipt= to tell
      // whether the draft/template has request for either MDN or DNS or both
      // return receipt; since the DNS is out of the picture we now use the
      // header type + 1 to tell whether user has requested the return receipt
      receiptValue = compFields.receiptHeaderType + 1;
    }
    draftInfo += `receipt=${receiptValue}; `;

    draftInfo += getCompField("DSN", "DSN");
    draftInfo += "uuencode=0; ";
    draftInfo += getCompField("attachmentReminder", "attachmentreminder");
    draftInfo += `deliveryformat=${compFields.deliveryFormat}`;

    return draftInfo;
  },

  /**
   * Get the X-Mozilla-Cloud-Part header value.
   *
   * @param {nsMsgDeliverMode} deliverMode - The deliver mode.
   * @param {nsIMsgAttachment} attachment - The cloud attachment.
   * @returns {string}
   */
  getXMozillaCloudPart(deliverMode, attachment) {
    let value = "";
    if (attachment.sendViaCloud && attachment.contentLocation) {
      value += `cloudFile; url=${attachment.contentLocation}`;

      if (
        (deliverMode == Ci.nsIMsgSend.nsMsgSaveAsDraft ||
          deliverMode == Ci.nsIMsgSend.nsMsgSaveAsTemplate) &&
        attachment.cloudFileAccountKey &&
        attachment.cloudPartHeaderData
      ) {
        value += `; provider=${attachment.cloudFileAccountKey}`;
        value += `; ${this.rfc2231ParamFolding(
          "data",
          attachment.cloudPartHeaderData
        )}`;
      }
    }
    return value;
  },

  /**
   * Get the X-Mozilla-Status header value. The header value will be used to set
   * some nsMsgMessageFlags. Including the Read flag for message in a local
   * folder.
   *
   * @param {nsMsgDeliverMode} deliverMode - The deliver mode.
   * @returns {string}
   */
  getXMozillaStatus(deliverMode) {
    if (
      ![
        Ci.nsIMsgSend.nsMsgQueueForLater,
        Ci.nsIMsgSend.nsMsgSaveAsDraft,
        Ci.nsIMsgSend.nsMsgSaveAsTemplate,
        Ci.nsIMsgSend.nsMsgDeliverNow,
        Ci.nsIMsgSend.nsMsgSendUnsent,
        Ci.nsIMsgSend.nsMsgDeliverBackground,
      ].includes(deliverMode)
    ) {
      return "";
    }
    let flags = 0;
    if (deliverMode == Ci.nsIMsgSend.nsMsgQueueForLater) {
      flags |= Ci.nsMsgMessageFlags.Queued;
    } else if (
      deliverMode != Ci.nsIMsgSend.nsMsgSaveAsDraft &&
      deliverMode != Ci.nsIMsgSend.nsMsgDeliverBackground
    ) {
      flags |= Ci.nsMsgMessageFlags.Read;
    }
    return flags.toString(16).padStart(4, "0");
  },

  /**
   * Get the X-Mozilla-Status2 header value. The header value will be used to
   * set some nsMsgMessageFlags.
   *
   * @param {nsMsgDeliverMode} deliverMode - The deliver mode.
   * @returns {string}
   */
  getXMozillaStatus2(deliverMode) {
    if (
      ![
        Ci.nsIMsgSend.nsMsgQueueForLater,
        Ci.nsIMsgSend.nsMsgSaveAsDraft,
        Ci.nsIMsgSend.nsMsgSaveAsTemplate,
        Ci.nsIMsgSend.nsMsgDeliverNow,
        Ci.nsIMsgSend.nsMsgSendUnsent,
        Ci.nsIMsgSend.nsMsgDeliverBackground,
      ].includes(deliverMode)
    ) {
      return "";
    }
    let flags = 0;
    if (deliverMode == Ci.nsIMsgSend.nsMsgSaveAsTemplate) {
      flags |= Ci.nsMsgMessageFlags.Template;
    } else if (
      deliverMode == Ci.nsIMsgSend.nsMsgDeliverNow ||
      deliverMode == Ci.nsIMsgSend.nsMsgSendUnsent
    ) {
      flags &= ~Ci.nsMsgMessageFlags.MDNReportNeeded;
      flags |= Ci.nsMsgMessageFlags.MDNReportSent;
    }
    return flags.toString(16).padStart(8, "0");
  },

  /**
   * Get the Disposition-Notification-To header value.
   *
   * @param {nsIMsgCompFields} compFields - The compose fields.
   * @param {nsMsgDeliverMode} deliverMode - The deliver mode.
   * @returns {{dnt: string, rrt: string}}
   */
  getDispositionNotificationTo(compFields, deliverMode) {
    if (
      compFields.returnReceipt &&
      deliverMode != Ci.nsIMsgSend.nsMsgSaveAsDraft &&
      deliverMode != Ci.nsIMsgSend.nsMsgSaveAsTemplate &&
      compFields.receiptHeaderType != Ci.nsIMsgMdnGenerator.eRrtType
    ) {
      return compFields.from;
    }
    return "";
  },

  /**
   * Get the Return-Receipt-To header value.
   *
   * @param {nsIMsgCompFields} compFields - The compose fields.
   * @param {nsMsgDeliverMode} deliverMode - The deliver mode.
   * @returns {{dnt: string, rrt: string}}
   */
  getReturnReceiptTo(compFields, deliverMode) {
    if (
      compFields.returnReceipt &&
      deliverMode != Ci.nsIMsgSend.nsMsgSaveAsDraft &&
      deliverMode != Ci.nsIMsgSend.nsMsgSaveAsTemplate &&
      compFields.receiptHeaderType != Ci.nsIMsgMdnGenerator.eDntType
    ) {
      return compFields.from;
    }
    return "";
  },

  /**
   * Get the value of X-Priority header.
   *
   * @param {string} rawPriority - Raw X-Priority content.
   * @returns {string}
   */
  getXPriority(rawPriority) {
    rawPriority = rawPriority.toLowerCase();
    let priorityValue = Ci.nsMsgPriority.Default;
    let priorityValueString = "0";
    let priorityName = "None";
    if (rawPriority.startsWith("1") || rawPriority.startsWith("highest")) {
      priorityValue = Ci.nsMsgPriority.highest;
      priorityValueString = "1";
      priorityName = "Highest";
    } else if (
      rawPriority.startsWith("2") ||
      // "high" must be tested after "highest".
      rawPriority.startsWith("high") ||
      rawPriority.startsWith("urgent")
    ) {
      priorityValue = Ci.nsMsgPriority.high;
      priorityValueString = "2";
      priorityName = "High";
    } else if (
      rawPriority.startsWith("3") ||
      rawPriority.startsWith("normal")
    ) {
      priorityValue = Ci.nsMsgPriority.normal;
      priorityValueString = "3";
      priorityName = "Normal";
    } else if (
      rawPriority.startsWith("5") ||
      rawPriority.startsWith("lowest")
    ) {
      priorityValue = Ci.nsMsgPriority.lowest;
      priorityValueString = "5";
      priorityName = "Lowest";
    } else if (
      rawPriority.startsWith("4") ||
      // "low" must be tested after "lowest".
      rawPriority.startsWith("low")
    ) {
      priorityValue = Ci.nsMsgPriority.low;
      priorityValueString = "4";
      priorityName = "Low";
    }
    if (priorityValue == Ci.nsMsgPriority.Default) {
      return "";
    }
    return `${priorityValueString} (${priorityName})`;
  },

  /**
   * Get the References header value.
   *
   * @param {string} references - Raw References header content.
   * @returns {string}
   */
  getReferences(references) {
    if (references.length <= 986) {
      return "";
    }
    // The References header should be kept under 998 characters: if it's too
    // long, trim out the earliest references to make it smaller.
    let newReferences = "";
    const firstRef = references.indexOf("<");
    const secondRef = references.indexOf("<", firstRef + 1);
    if (secondRef > 0) {
      newReferences = references.slice(0, secondRef);
      const bracket = references.indexOf(
        "<",
        references.length + newReferences.length - 986
      );
      if (bracket > 0) {
        newReferences += references.slice(bracket);
      }
    }
    return newReferences;
  },

  /**
   * Get the In-Reply-To header value.
   *
   * @param {string} references - Raw References header content.
   * @returns {string}
   */
  getInReplyTo(references) {
    // The In-Reply-To header is the last entry in the references header...
    const bracket = references.lastIndexOf("<");
    if (bracket >= 0) {
      return references.slice(bracket);
    }
    return "";
  },

  /**
   * Get the Content-Location header value.
   *
   * @param {string} baseUrl - The base url of an HTML attachment.
   * @returns {string}
   */
  getContentLocation(baseUrl) {
    const lowerBaseUrl = baseUrl.toLowerCase();
    if (
      !baseUrl.includes(":") ||
      lowerBaseUrl.startsWith("news:") ||
      lowerBaseUrl.startsWith("snews:") ||
      lowerBaseUrl.startsWith("imap:") ||
      lowerBaseUrl.startsWith("file:") ||
      lowerBaseUrl.startsWith("mailbox:")
    ) {
      return "";
    }
    const transformMap = {
      " ": "%20",
      "\t": "%09",
      "\n": "%0A",
      "\r": "%0D",
    };
    let value = "";
    for (const char of baseUrl) {
      value += transformMap[char] || char;
    }
    return value;
  },

  /**
   * Given a string, convert it to 'qtext' (quoted text) for RFC822 header
   * purposes.
   */
  makeFilenameQtext(srcText, stripCRLFs) {
    const size = srcText.length;
    let ret = "";
    for (let i = 0; i < size; i++) {
      const char = srcText.charAt(i);
      if (
        char == "\\" ||
        char == '"' ||
        (!stripCRLFs &&
          char == "\r" &&
          (srcText[i + 1] != "\n" ||
            (srcText[i + 1] == "\n" && i + 2 < size && srcText[i + 2] != " ")))
      ) {
        ret += "\\";
      }

      if (
        stripCRLFs &&
        char == "\r" &&
        srcText[i + 1] == "\n" &&
        i + 2 < size &&
        srcText[i + 2] == " "
      ) {
        i += 3;
      } else {
        ret += char;
      }
    }
    return ret;
  },

  /**
   * Encode parameter value according to RFC 2047.
   *
   * @param {string} value - The parameter value.
   * @returns {string}
   */
  rfc2047EncodeParam(value) {
    const converter = Cc["@mozilla.org/messenger/mimeconverter;1"].getService(
      Ci.nsIMimeConverter
    );

    const encoded = converter.encodeMimePartIIStr_UTF8(
      value,
      false,
      0,
      Ci.nsIMimeConverter.MIME_ENCODED_WORD_SIZE
    );

    return this.makeFilenameQtext(encoded, false);
  },

  /**
   * Encode parameter value according to RFC 2231.
   *
   * @param {string} paramName - The parameter name.
   * @param {string} paramValue - The parameter value.
   * @returns {string}
   */
  rfc2231ParamFolding(paramName, paramValue) {
    // this is to guarantee the folded line will never be greater
    // than 78 = 75 + CRLFLWSP
    const PR_MAX_FOLDING_LEN = 75;

    let needsEscape = false;
    const encoder = new TextEncoder();
    let dupParamValue = jsmime.mimeutils.typedArrayToString(
      encoder.encode(paramValue)
    );

    if (/[\x80-\xff]/.test(dupParamValue)) {
      needsEscape = true;
      dupParamValue = Services.io.escapeString(
        dupParamValue,
        Ci.nsINetUtil.ESCAPE_ALL
      );
    } else {
      dupParamValue = this.makeFilenameQtext(dupParamValue, true);
    }

    let paramNameLen = paramName.length;
    let paramValueLen = dupParamValue.length;
    paramNameLen += 5; // *=__'__'___ or *[0]*=__'__'__ or *[1]*=___ or *[0]="___"
    let foldedParam = "";

    if (paramValueLen + paramNameLen + "UTF-8".length < PR_MAX_FOLDING_LEN) {
      foldedParam = paramName;
      if (needsEscape) {
        foldedParam += "*=UTF-8''";
      } else {
        foldedParam += '="';
      }
      foldedParam += dupParamValue;
      if (!needsEscape) {
        foldedParam += '"';
      }
    } else {
      let curLineLen = 0;
      let counter = 0;
      let start = 0;
      let end = null;

      while (paramValueLen > 0) {
        curLineLen = 0;
        if (counter == 0) {
          foldedParam = paramName;
        } else {
          foldedParam += `;\r\n ${paramName}`;
        }
        foldedParam += `*${counter}`;
        curLineLen += `*${counter}`.length;
        if (needsEscape) {
          foldedParam += "*=";
          if (counter == 0) {
            foldedParam += "UTF-8''";
            curLineLen += "UTF-8".length;
          }
        } else {
          foldedParam += '="';
        }
        counter++;
        curLineLen += paramNameLen;
        if (paramValueLen <= PR_MAX_FOLDING_LEN - curLineLen) {
          end = start + paramValueLen;
        } else {
          end = start + (PR_MAX_FOLDING_LEN - curLineLen);
        }

        if (end && needsEscape) {
          // Check to see if we are in the middle of escaped char.
          // We use ESCAPE_ALL, so every third character is a '%'.
          if (end - 1 > start && dupParamValue[end - 1] == "%") {
            end -= 1;
          } else if (end - 2 > start && dupParamValue[end - 2] == "%") {
            end -= 2;
          }
          // *end is now a '%'.
          // Check if the following UTF-8 octet is a continuation.
          while (end - 3 > start && "89AB".includes(dupParamValue[end + 1])) {
            end -= 3;
          }
        }
        foldedParam += dupParamValue.slice(start, end);
        if (!needsEscape) {
          foldedParam += '"';
        }
        paramValueLen -= end - start;
        start = end;
      }
    }

    return foldedParam;
  },

  /**
   * Get the target message folder to copy to.
   *
   * @param {nsIMsgIdentity} userIdentity - The user identity.
   * @param {nsMsgDeliverMode} deliverMode - The deliver mode.
   * @returns {string} The folder URI.
   */
  getMsgFolderURIFromPrefs(userIdentity, deliverMode) {
    if (
      deliverMode == Ci.nsIMsgSend.nsMsgQueueForLater ||
      deliverMode == Ci.nsIMsgSend.nsMsgDeliverBackground
    ) {
      const uri = Services.prefs.getCharPref("mail.default_sendlater_uri");
      // check if uri is unescaped, and if so, escape it and reset the pef.
      if (!uri) {
        return "anyfolder://";
      }
      if (uri.includes(" ")) {
        uri.replaceAll(" ", "%20");
        Services.prefs.setCharPref("mail.default_sendlater_uri", uri);
      }
      return uri;
    }
    if (deliverMode == Ci.nsIMsgSend.nsMsgSaveAsDraft) {
      return userIdentity.getOrCreateDraftsFolder().URI;
    }
    if (deliverMode == Ci.nsIMsgSend.nsMsgSaveAsTemplate) {
      return userIdentity.getOrCreateTemplatesFolder().URI;
    }
    if (userIdentity.doFcc) {
      return userIdentity.getOrCreateFccFolder().URI;
    }
    return "";
  },

  /**
   * Get the error string name of an exit code. The name will corresponds to an
   * entry in composeMsgs.properties.
   *
   * @param {nsresult} exitCode - Exit code of sending mail process.
   * @returns {string}
   */
  getErrorStringName(exitCode) {
    const codeNameMap = {
      [Cr.NS_ERROR_FILE_NOT_FOUND]: "errorAttachingFile",
      [Cr.NS_ERROR_UNKNOWN_HOST]: "smtpSendFailedUnknownServer",
      [Cr.NS_ERROR_UNKNOWN_PROXY_HOST]: "smtpSendFailedUnknownServer",
      [Cr.NS_ERROR_CONNECTION_REFUSED]: "smtpSendRequestRefused",
      [Cr.NS_ERROR_PROXY_CONNECTION_REFUSED]: "smtpSendRequestRefused",
      [Cr.NS_ERROR_NET_INTERRUPT]: "smtpSendInterrupted",
      [Cr.NS_ERROR_NET_TIMEOUT]: "smtpSendTimeout",
      [Cr.NS_ERROR_NET_RESET]: "smtpSendTimeout",
    };
    return codeNameMap[exitCode] || "sendFailed";
  },

  /**
   * Format the error message that will be shown to the user.
   *
   * @param {nsIMsgIdentity} userIdentity - User identity.
   * @param {nsIStringBundle} composeBundle - Localized string bundle.
   * @param {string} errorName - The error name derived from an exit code.
   * @returns {string}
   */
  formatStringWithSMTPHostName(userIdentity, composeBundle, errorName) {
    const smtpServer =
      MailServices.outgoingServer.getServerByIdentity(userIdentity);
    const smtpHostname = smtpServer.serverURI.host;
    return composeBundle.formatStringFromName(errorName, [smtpHostname]);
  },

  /**
   * Generate random alphanumeric string.
   *
   * @param {number} size - The length of generated string.
   * @returns {string}
   */
  randomString(size) {
    const length = Math.round((size * 3) / 4);
    return btoa(
      String.fromCharCode(
        ...[...Array(length)].map(() => Math.floor(Math.random() * 256))
      )
    )
      .slice(0, size)
      .replaceAll(/[+/=]/g, "0");
  },

  /**
   * Generate a content id to be used by embedded images.
   *
   * @param {nsIMsgIdentity} userIdentity - User identity.
   * @param {number} partNum - The number of embedded MimePart.
   * @returns {string}
   */
  makeContentId(userIdentity, partNum) {
    const domain = userIdentity.email.split("@")[1];
    return `part${partNum}.${this.randomString(8)}.${this.randomString(
      8
    )}@${domain}`;
  },

  /**
   * Pick a file name from the file URL.
   *
   * @param {string} url - The file URL.
   * @returns {string}
   */
  pickFileNameFromUrl(url) {
    if (/^(news|snews|imap|mailbox):/i.test(url)) {
      // No sensible file name in it,
      return "";
    }
    if (/^data:/i.test(url)) {
      const matches = /filename=(.*);/.exec(url);
      if (matches && matches[1]) {
        return decodeURIComponent(matches[1]);
      }
      const mimeType = url.slice(5, url.indexOf(";"));
      let extname = "";
      try {
        extname = Cc["@mozilla.org/mime;1"]
          .getService(Ci.nsIMIMEService)
          .getPrimaryExtension(mimeType, null);
        if (!extname) {
          return "";
        }
      } catch (e) {
        return "";
      }
      return `${this.randomString(16)}.${extname}`;
    }
    // Take the part after the last / or \.
    let lastSlash = url.lastIndexOf("\\");
    if (lastSlash == -1) {
      lastSlash = url.lastIndexOf("/");
    }
    // Strip any search or anchor.
    return url
      .slice(lastSlash + 1)
      .split("?")[0]
      .split("#")[0];
  },
};
