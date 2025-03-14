/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Put the MailViewConstants in an object so we can export them to
 *  msgViewPickerOverlay in one blob without contaminating everyone's address
 *  space who might want to import us.
 */
export var MailViewConstants = {
  // tag views have kViewTagMarker + their key as value
  kViewItemAll: 0,
  kViewItemUnread: 1,
  kViewItemTags: 2, // former labels used values 2-6
  kViewItemNotDeleted: 3,
  // not a real view! a sentinel value to pop up a dialog
  kViewItemVirtual: 7,
  // not a real view! a sentinel value to pop up a dialog
  kViewItemCustomize: 8,
  kViewItemFirstCustom: 9,

  kViewCurrent: "current-view",
  kViewCurrentTag: "current-view-tag",
  kViewTagMarker: ":",
};

/**
 * MailViews are view 'filters' implemented using search terms.  DBViewWrapper
 *  uses the SearchSpec class to combine the search terms of the mailview with
 *  those of the virtual folder (if applicable) and the quicksearch (if
 *  applicable).
 */
export var MailViewManager = {
  _views: {},
  _customMailViews: Cc["@mozilla.org/messenger/mailviewlist;1"].getService(
    Ci.nsIMsgMailViewList
  ),

  /**
   * Define one of the built-in mail-views.  If you want to define your own
   *  view, you need to define a custom view using nsIMsgMailViewList.
   *
   * We define our own little view definition abstraction because some day this
   *  functionality may want to be generalized to be usable by gloda as well.
   *
   * @param {object} aViewDef - The view definition.
   * @param {string} aViewDef.name - Name for the view, for debugging
   *   purposes only. This should not be localized!
   * @param {integer} aViewDef.index - The index to assign to the view.
   * @param {Function} aViewDef.makeTerms - A function to invoke that returns
   *   a list of search terms.
   */
  defineView(aViewDef) {
    this._views[aViewDef.index] = aViewDef;
  },

  /**
   * Wrap a custom view into our cute little view abstraction.  We do not cache
   *  these because views should not change often enough for it to matter from
   *  a performance perspective, but they will change enough to make stale
   *  caches a potential issue.
   */
  _wrapCustomView(aCustomViewIndex) {
    const mailView = this._customMailViews.getMailViewAt(aCustomViewIndex);
    return {
      name: mailView.prettyName, // since the user created it it's localized
      index: aCustomViewIndex,
      makeTerms() {
        return mailView.searchTerms;
      },
    };
  },

  _findCustomViewByName(aName) {
    const count = this._customMailViews.mailViewCount;
    for (let i = 0; i < count; i++) {
      const mailView = this._customMailViews.getMailViewAt(i);
      if (mailView.mailViewName == aName) {
        return this._wrapCustomView(i);
      }
    }
    throw new Error("No custom view with name: " + aName);
  },

  /**
   * Return the view definition associated with the given view index.
   *
   * @param {integer|string} aViewIndex - If the value is an integer it
   *    references the built-in view with the view index from MailViewConstants,
   *    or if the index is >= MailViewConstants.kViewItemFirstCustom, it is a
   *    reference to a custom view definition.  If the value is a string, it is
   *    the name of a custom view.
   *    The string case is mainly intended for testing purposes.
   */
  getMailViewByIndex(aViewIndex) {
    if (typeof aViewIndex == "string") {
      return this._findCustomViewByName(aViewIndex);
    }
    if (aViewIndex < MailViewConstants.kViewItemFirstCustom) {
      return this._views[aViewIndex];
    }
    return this._wrapCustomView(
      aViewIndex - MailViewConstants.kViewItemFirstCustom
    );
  },
};

MailViewManager.defineView({
  name: "all mail", // debugging assistance only! not localized!
  index: MailViewConstants.kViewItemAll,
  makeTerms() {
    return null;
  },
});

MailViewManager.defineView({
  name: "new mail / unread", // debugging assistance only! not localized!
  index: MailViewConstants.kViewItemUnread,
  makeTerms(aSession) {
    const term = aSession.createTerm();
    const value = term.value;

    value.status = Ci.nsMsgMessageFlags.Read;
    value.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
    term.value = value;
    term.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
    term.op = Ci.nsMsgSearchOp.Isnt;
    term.booleanAnd = true;

    return [term];
  },
});

MailViewManager.defineView({
  name: "tags", // debugging assistance only! not localized!
  index: MailViewConstants.kViewItemTags,
  makeTerms(aSession, aKeyword) {
    const term = aSession.createTerm();
    const value = term.value;

    value.str = aKeyword;
    value.attrib = Ci.nsMsgSearchAttrib.Keywords;
    term.value = value;
    term.attrib = Ci.nsMsgSearchAttrib.Keywords;
    term.op = Ci.nsMsgSearchOp.Contains;
    term.booleanAnd = true;

    return [term];
  },
});

MailViewManager.defineView({
  name: "not deleted", // debugging assistance only! not localized!
  index: MailViewConstants.kViewItemNotDeleted,
  makeTerms(aSession) {
    const term = aSession.createTerm();
    const value = term.value;

    value.status = Ci.nsMsgMessageFlags.IMAPDeleted;
    value.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
    term.value = value;
    term.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
    term.op = Ci.nsMsgSearchOp.Isnt;
    term.booleanAnd = true;

    return [term];
  },
});
