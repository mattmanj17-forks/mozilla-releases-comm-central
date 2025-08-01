/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Given a MimeMessage and the corresponding folder, return the GlodaContent object.
 *
 * @param {MimeMessage} aMimeMsg - The MimeMessage instance.
 * @param {nsIMsgFolder} folder - The folder the message is in.
 * @returns {any[]} an array containing the GlodaContent instance, and the meta
 *   dictionary that the Gloda content providers may have filled with useful data.
 */
export function mimeMsgToContentAndMeta(aMimeMsg, folder) {
  const content = new GlodaContent();
  const meta = { subject: aMimeMsg.get("subject") };
  const bodyLines = aMimeMsg.coerceBodyToPlaintext(folder).split(/\r?\n/);

  for (const whittler of whittlerRegistry.getWhittlers()) {
    whittler.contentWhittle(meta, bodyLines, content);
  }

  return [content, meta];
}

/**
 * Given a MimeMessage, return the whittled content string, suitable for summarizing
 * a message.
 *
 * @param {MimeMessage} aMimeMsg - The MimeMessage instance.
 * @param {nsIMsgFolder} folder - The folder the message is in.
 * @param {integer} [length] - Optional number of characters to trim the whittled
 *   content. If the actual length of the message is greater than |length|,
 *   then the return value is the first (length-1) characters with an ellipsis
 *   appended.
 * @returns {any[]} an array containing the text of the snippet, and the meta dictionary
 *   that the Gloda content providers may have filled with useful data.
 */
export function mimeMsgToContentSnippetAndMeta(aMimeMsg, folder, length) {
  const [content, meta] = mimeMsgToContentAndMeta(aMimeMsg, folder);

  let text = content.getContentSnippet(length + 1);
  if (length && text.length > length) {
    text = text.substring(0, length - 1) + "\u2026"; // ellipsis
  }
  return [text, meta];
}

/**
 * A registry of gloda providers that have contentWhittle() functions.
 * used by mimeMsgToContentSnippet, but populated by the Gloda object as it's
 * processing providers.
 */
function WhittlerRegistry() {
  this._whittlers = [];
}

WhittlerRegistry.prototype = {
  /**
   * Add a provider as a content whittler.
   *
   * @param {object} provider - The object instance providing a 'process' method.
   */
  registerWhittler(provider) {
    this._whittlers.push(provider);
  },
  /**
   * Get the list of content whittlers, sorted from the most specific to
   * the most generic.
   *
   * @returns {object[]} providers.
   */
  getWhittlers() {
    // Use the concat() trick to avoid mutating the internal object and
    // leaking an internal representation.
    return this._whittlers.concat().reverse();
  },
};

export const whittlerRegistry = new WhittlerRegistry();

export function GlodaContent() {
  this._contentPriority = null;
  this._producing = false;
  this._hunks = [];
}

GlodaContent.prototype = {
  kPriorityBase: 0,
  kPriorityPerfect: 100,

  kHunkMeta: 1,
  kHunkQuoted: 2,
  kHunkContent: 3,

  _resetContent() {
    this._keysAndValues = [];
    this._keysAndDeltaValues = [];
    this._hunks = [];
    this._curHunk = null;
  },

  /* ===== Consumer API ===== */
  hasContent() {
    return this._contentPriority != null;
  },

  /**
   * Return content suitable for snippet display.  This means that no quoting
   *  or meta-data should be returned.
   *
   * @param {integer} aMaxLength - The maximum snippet length desired.
   */
  getContentSnippet(aMaxLength) {
    let content = this.getContentString();
    if (aMaxLength) {
      content = content.substring(0, aMaxLength);
    }
    return content;
  },

  getContentString(aIndexingPurposes) {
    let data = "";
    for (const hunk of this._hunks) {
      if (hunk.hunkType == this.kHunkContent) {
        if (data) {
          data += "\n" + hunk.data;
        } else {
          data = hunk.data;
        }
      }
    }

    if (aIndexingPurposes) {
      // append the values for indexing.  we assume the keywords are cruft.
      // this may be crazy, but things that aren't a science aren't an exact
      // science.
      for (const kv of this._keysAndValues) {
        data += "\n" + kv[1];
      }
      for (const kon of this._keysAndValues) {
        data += "\n" + kon[1] + "\n" + kon[2];
      }
    }

    return data;
  },

  /* ===== Producer API ===== */
  /**
   * Called by a producer with the priority they believe their interpretation
   *  of the content comes in at.
   *
   * @returns {boolean} true if we believe the producer's interpretation will be
   *   interesting and they should go ahead and generate events.  We return
   *   false if we don't think they are interesting, in which case they should
   *   probably not issue calls to us, although we don't care.  (We will
   *   ignore their calls if we return false, this allows the simplification
   *   of code that needs to run anyways.)
   */
  volunteerContent(aPriority) {
    if (this._contentPriority === null || this._contentPriority < aPriority) {
      this._contentPriority = aPriority;
      this._resetContent();
      this._producing = true;
      return true;
    }
    this._producing = false;
    return false;
  },

  keyValue(aKey, aValue) {
    if (!this._producing) {
      return;
    }

    this._keysAndValues.push([aKey, aValue]);
  },
  keyValueDelta(aKey, aOldValue, aNewValue) {
    if (!this._producing) {
      return;
    }

    this._keysAndDeltaValues.push([aKey, aOldValue, aNewValue]);
  },

  /**
   * Meta lines are lines that have to do with the content but are not the
   *  content and can generally be related to an attribute that has been derived
   *  and stored on the item.
   * For example, a bugzilla bug may note that an attachment was created; this
   *  is not content and wouldn't be desired in a snippet, but is still
   *  potentially interesting meta-data.
   *
   * @param {string|string[]} aLineOrLines - The line or list of lines that
   *   are meta-data.
   * @param {string} aAttr - The attribute this meta-data is associated with.
   * @param {integer} aIndex - If the attribute is non-singular, indicate
   *   the specific index of the item in the attribute's bound list that the
   *   meta-data sis associated with.
   */
  meta(aLineOrLines, aAttr, aIndex) {
    if (!this._producing) {
      return;
    }

    let data;
    if (typeof aLineOrLines == "string") {
      data = aLineOrLines;
    } else {
      data = aLineOrLines.join("\n");
    }

    this._curHunk = {
      hunkType: this.kHunkMeta,
      attr: aAttr,
      index: aIndex,
      data,
    };
    this._hunks.push(this._curHunk);
  },
  /**
   * Quoted lines reference previous messages or what not.
   *
   * @param {string|string[]} aLineOrLines - The line or list of lines that are quoted.
   * @param {integer} aDepth - The depth of the quoting.
   * @param {object} aOrigin - The item that originated the original content, if known.
   *   For example, perhaps a GlodaMessage?
   * @param {string} aTarget - A reference to the location in the original content, if
   *   known. For example, the index of a line in a message or something?
   */
  quoted(aLineOrLines, aDepth, aOrigin, aTarget) {
    if (!this._producing) {
      return;
    }

    let data;
    if (typeof aLineOrLines == "string") {
      data = aLineOrLines;
    } else {
      data = aLineOrLines.join("\n");
    }

    if (
      !this._curHunk ||
      this._curHunk.hunkType != this.kHunkQuoted ||
      this._curHunk.depth != aDepth ||
      this._curHunk.origin != aOrigin ||
      this._curHunk.target != aTarget
    ) {
      this._curHunk = {
        hunkType: this.kHunkQuoted,
        data,
        depth: aDepth,
        origin: aOrigin,
        target: aTarget,
      };
      this._hunks.push(this._curHunk);
    } else {
      this._curHunk.data += "\n" + data;
    }
  },

  /** @param {string|string[]} aLineOrLines */
  content(aLineOrLines) {
    if (!this._producing) {
      return;
    }

    let data;
    if (typeof aLineOrLines == "string") {
      data = aLineOrLines;
    } else {
      data = aLineOrLines.join("\n");
    }

    if (!this._curHunk || this._curHunk.hunkType != this.kHunkContent) {
      this._curHunk = { hunkType: this.kHunkContent, data };
      this._hunks.push(this._curHunk);
    } else {
      this._curHunk.data += "\n" + data;
    }
  },
};
