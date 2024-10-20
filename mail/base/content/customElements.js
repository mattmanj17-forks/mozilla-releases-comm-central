/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// This is loaded into chrome windows with the subscript loader. Wrap in
// a block to prevent accidentally leaking globals onto `window`.
{
  // If toolkit customElements weren't already loaded, do it now.
  if (!window.MozXULElement) {
    Services.scriptloader.loadSubScript(
      "chrome://global/content/customElements.js",
      window
    );
  }

  const isDummyDocument =
    document.documentURI == "chrome://extensions/content/dummy.xhtml";
  if (!isDummyDocument) {
    for (const [tag, script] of [
      ["", "chrome://chat/content/conversation-browser.js"],
      ["", "chrome://messenger/content/gloda-autocomplete-input.js"],
      ["", "chrome://chat/content/chat-tooltip.js"],
      ["", "chrome://messenger/content/mailWidgets.js"],
      ["", "chrome://messenger/content/statuspanel.js"],
      ["folder-summary", "chrome://messenger/content/foldersummary.js"],
      [
        "menulist-addrbooks",
        "chrome://messenger/content/addressbook/menulist-addrbooks.js",
      ],
      ["", "chrome://messenger/content/folder-menupopup.js"],
      ["", "chrome://messenger/content/toolbarbutton-menu-button.js"],
    ]) {
      // Immediately load scripts that either define multiple custom elements or
      // are always used in most doucments this is loaded in.
      if (!tag) {
        Services.scriptloader.loadSubScript(script, window);
        continue;
      }
      customElements.setElementCreationCallback(tag, () => {
        Services.scriptloader.loadSubScript(script, window);
      });
    }
  }
}
