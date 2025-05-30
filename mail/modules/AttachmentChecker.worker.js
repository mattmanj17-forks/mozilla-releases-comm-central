/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Check whether the character is a CJK character or not.
 *
 * @returns {boolean} true if it is a CJK character.
 */
function IsCJK(code) {
  if (code >= 0x2000 && code <= 0x9fff) {
    // Hiragana, Katakana and Kanaji
    return true;
  } else if (code >= 0xac00 && code <= 0xd7ff) {
    // Hangul
    return true;
  } else if (code >= 0xf900 && code <= 0xffff) {
    // Hiragana, Katakana and Kanaji
    return true;
  }
  return false;
}

/**
 * Get the (possibly-empty) list of attachment keywords in this message.
 *
 * @param {string} mailData - The mail data to check.
 * @param {string} keywordsInCsv - Comma separated keywords to look for.
 * @returns {string[]} the list of attachment keywords in this message.
 */
function getAttachmentKeywords(mailData, keywordsInCsv) {
  // The empty string would get split to an array of size 1.  Avoid that...
  const keywordsArray = keywordsInCsv ? keywordsInCsv.split(",") : [];

  function escapeRegxpSpecials(inputString) {
    const specials = [
      ".",
      "\\",
      "^",
      "$",
      "*",
      "+",
      "?",
      "|",
      "(",
      ")",
      "[",
      "]",
      "{",
      "}",
    ];
    const re = new RegExp("(\\" + specials.join("|\\") + ")", "g");
    inputString = inputString.replace(re, "\\$1");
    return inputString.replace(" ", "\\s+");
  }

  // NOT_W is the character class that isn't in the Unicode classes "Ll",
  // "Lu" and "Lt".  It should work like \W, if \W knew about Unicode.
  const NOT_W =
    "[^\\u0041-\\u005a\\u0061-\\u007a\\u00aa\\u00b5\\u00ba\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u01ba\\u01bc-\\u01bf\\u01c4-\\u02ad\\u0386\\u0388-\\u0481\\u048c-\\u0556\\u0561-\\u0587\\u10a0-\\u10c5\\u1e00-\\u1fbc\\u1fbe\\u1fc2-\\u1fcc\\u1fd0-\\u1fdb\\u1fe0-\\u1fec\\u1ff2-\\u1ffc\\u207f\\u2102\\u2107\\u210a-\\u2113\\u2115\\u2119-\\u211d\\u2124\\u2126\\u2128\\u212a-\\u212d\\u212f-\\u2131\\u2133\\u2134\\u2139\\ufb00-\\ufb17\\uff21-\\uff3a\\uff41-\\uff5a]";

  const keywordsFound = [];
  for (let i = 0; i < keywordsArray.length; i++) {
    const kw = escapeRegxpSpecials(keywordsArray[i]);
    // If the keyword starts (ends) with a CJK character, we don't care
    // what the previous (next) character is, because the words aren't
    // space delimited.
    if (keywordsArray[i].charAt(0) == ".") {
      // like .pdf
      // For this case we want to match the whole document name.
      const start = "(([^\\s]*)\\b)";
      const end = IsCJK(kw.charCodeAt(kw.length - 1)) ? "" : "(\\s|$)";
      const re = new RegExp(start + kw + end, "ig");
      const matching = mailData.match(re);
      if (matching) {
        for (let j = 0; j < matching.length; j++) {
          // Ignore the match if it was in a URL.
          if (!/^(https?|ftp):\/\//i.test(matching[j])) {
            // We can have several *different* matches for one dot-keyword.
            // E.g. foo.pdf and bar.pdf would both match for .pdf.
            const m = matching[j].trim();
            if (!keywordsFound.includes(m)) {
              keywordsFound.push(m);
            }
          }
        }
      }
    } else {
      const start = IsCJK(kw.charCodeAt(0)) ? "" : "((^|\\s)\\S*)";
      const end = IsCJK(kw.charCodeAt(kw.length - 1))
        ? ""
        : "(" + NOT_W + "|$)";
      const re = new RegExp(start + kw + end, "ig");
      let matching;
      while ((matching = re.exec(mailData)) !== null) {
        // Ignore the match if it was in a URL.
        if (!/^(https?|ftp):\/\//i.test(matching[0].trim())) {
          keywordsFound.push(keywordsArray[i]);
          break;
        }
      }
    }
  }
  return keywordsFound;
}

/**
 * Worker message event handler.
 *
 * @param {Event} event - "message" posted from parent.
 */
self.onmessage = function (event) {
  const keywordsFound = getAttachmentKeywords(event.data[0], event.data[1]);
  self.postMessage(keywordsFound);
};
