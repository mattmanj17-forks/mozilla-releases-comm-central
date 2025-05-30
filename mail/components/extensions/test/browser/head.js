/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { MailConsts } = ChromeUtils.importESModule(
  "resource:///modules/MailConsts.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { mailTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MailTestUtils.sys.mjs"
);
var { MailUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);
var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { getCachedAllowedSpaces, setCachedAllowedSpaces } =
  ChromeUtils.importESModule(
    "resource:///modules/ExtensionToolbarButtons.sys.mjs"
  );
var { storeState, getState } = ChromeUtils.importESModule(
  "resource:///modules/CustomizationState.mjs"
);
var { getDefaultItemIdsForSpace, getAvailableItemIdsForSpace } =
  ChromeUtils.importESModule("resource:///modules/CustomizableItems.sys.mjs");

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { makeWidgetId } = ExtensionCommon;

// Persistent Listener test functionality
var { assertPersistentListeners } = ExtensionTestUtils.testAssertions;

var { PromiseTestUtils: MailPromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

// Adjust timeout to take care of code coverage runs and fission runs to be a
// lot slower.
const originalRequestLongerTimeout = requestLongerTimeout;
// eslint-disable-next-line no-global-assign
requestLongerTimeout = factor => {
  const ccovMultiplier = AppConstants.MOZ_CODE_COVERAGE ? 2 : 1;
  const fissionMultiplier = SpecialPowers.useRemoteSubframes ? 2 : 1;
  originalRequestLongerTimeout(ccovMultiplier * fissionMultiplier * factor);
};
requestLongerTimeout(1);

add_setup(async () => {
  await check3PaneState(true, true);
  const tabmail = document.getElementById("tabmail");
  if (tabmail.tabInfo.length > 1) {
    info(`Will close ${tabmail.tabInfo.length - 1} tabs left over from others`);
    for (let i = tabmail.tabInfo.length - 1; i > 0; i--) {
      tabmail.closeTab(i);
    }
    is(tabmail.tabInfo.length, 1, "One tab open from start");
  }
});
registerCleanupFunction(() => {
  const tabmail = document.getElementById("tabmail");
  is(tabmail.tabInfo.length, 1, "Only one tab open at end of test");

  while (tabmail.tabInfo.length > 1) {
    tabmail.closeTab(tabmail.tabInfo[1]);
  }

  // Some tests that open new windows don't return focus to the main window
  // in a way that satisfies mochitest, and the test times out.
  Services.focus.focusedWindow = window;
  // Focus an element in the main window, then blur it again to avoid it
  // hijacking keypresses.
  const mainWindowElement = document.getElementById("button-appmenu");
  mainWindowElement.focus();
  mainWindowElement.blur();

  MailServices.accounts.accounts.forEach(cleanUpAccount);
  check3PaneState(true, true);

  // The unified toolbar must have been cleaned up. If this fails, check if a
  // test loaded an extension with a browser_action without setting "useAddonManager"
  // to either "temporary" or "permanent", which triggers onUninstalled to be
  // called on extension unload.
  const cachedAllowedSpaces = getCachedAllowedSpaces();
  is(
    cachedAllowedSpaces.size,
    0,
    `Stored known extension spaces should be cleared: ${JSON.stringify(
      Object.fromEntries(cachedAllowedSpaces)
    )}`
  );
  setCachedAllowedSpaces(new Map());
  Services.prefs.clearUserPref("mail.pane_config.dynamic");
  Services.prefs.clearUserPref("mail.threadpane.listview");
  Services.prefs.setStringPref("extensions.webextensions.uuids", "{}");
});

/**
 * Generate a CSS image-set declaration for the given extension icons.
 *
 * @param {string} url - Normal density icon URL, already wrapped in a CSS url().
 * @param {string} [url2x] - Optional double DPI icon URL, already wrapped in a
 *   CSS url(). If not provided the normal density value is used.
 * @returns {string} The CSS image-set declaration as would be found in computed
 *   styles.
 */
const makeIconSet = (url, url2x) =>
  `image-set(${url} 1dppx, ${url2x || url} 2dppx)`;

/**
 * Enforce a certain state in the unified toolbar.
 *
 * @param {object} state - A dictionary with arrays of buttons assigned to a space
 */
async function enforceState(state) {
  const stateChangeObserved = TestUtils.topicObserved(
    "unified-toolbar-state-change"
  );
  storeState(state);
  await stateChangeObserved;
}

async function check3PaneState(folderPaneOpen = null, messagePaneOpen = null) {
  const tabmail = document.getElementById("tabmail");
  const tab = tabmail.currentTabInfo;
  if (tab.chromeBrowser.contentDocument.readyState != "complete") {
    await BrowserTestUtils.waitForEvent(
      tab.chromeBrowser.contentWindow,
      "load"
    );
  }

  const { paneLayout } = tabmail.currentAbout3Pane;
  if (folderPaneOpen !== null) {
    Assert.equal(
      paneLayout.folderPaneVisible,
      folderPaneOpen,
      "State of folder pane splitter is correct"
    );
    paneLayout.folderPaneVisible = folderPaneOpen;
  }

  if (messagePaneOpen !== null) {
    Assert.equal(
      paneLayout.messagePaneVisible,
      messagePaneOpen,
      "State of message pane splitter is correct"
    );
    paneLayout.messagePaneVisible = messagePaneOpen;
  }
}

var gIMAPServers = new Map();
class IMAPServer {
  constructor(options = {}) {
    this.extensions = options?.extensions ?? [];
  }

  open() {
    const ImapD = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/Imapd.sys.mjs"
    );
    const { IMAP_RFC3501_handler, ImapDaemon, ImapMessage, mixinExtension } =
      ImapD;
    const { nsMailServer } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/Maild.sys.mjs"
    );

    this.ImapMessage = ImapMessage;
    this.daemon = new ImapDaemon();
    this.server = new nsMailServer(daemon => {
      const handler = new IMAP_RFC3501_handler(daemon);
      for (const ext of this.extensions) {
        mixinExtension(handler, ImapD[`IMAP_${ext}_extension`]);
      }
      return handler;
    }, this.daemon);

    this.server.start();

    registerCleanupFunction(() => this.close());
  }
  close() {
    this.server.stop();
  }
  get port() {
    return this.server.port;
  }

  addMessages(folder, messages) {
    folder.QueryInterface(Ci.nsIMsgImapMailFolder);
    const fakeFolder = this.daemon.getMailbox(folder.prettyPath);
    messages.forEach(message => {
      if (typeof message != "string") {
        message = message.toMessageString();
      }
      const msgURI = Services.io.newURI(
        "data:text/plain;base64," + btoa(message)
      );
      const imapMsg = new this.ImapMessage(
        msgURI.spec,
        fakeFolder.uidnext++,
        []
      );
      fakeFolder.addMessage(imapMsg);
    });

    const listener = new MailPromiseTestUtils.PromiseUrlListener();
    folder.updateFolderWithListener(null, listener);
    return listener.promise;
  }
}

function createAccount(type = "none", options = {}) {
  let account;

  if (type == "local") {
    account = MailServices.accounts.createLocalMailAccount();
  } else {
    account = MailServices.accounts.createAccount();
    account.incomingServer = MailServices.accounts.createIncomingServer(
      `${account.key}user`,
      "localhost",
      type
    );
  }

  if (type == "imap") {
    const server = new IMAPServer(options);
    server.open();
    account.incomingServer.port = server.port;
    account.incomingServer.username = "user";
    account.incomingServer.password = "password";
    const inbox = account.incomingServer.rootFolder.getChildNamed("INBOX");
    inbox.QueryInterface(Ci.nsIMsgImapMailFolder).hierarchyDelimiter = "/";
    gIMAPServers.set(account.incomingServer.key, server);
  }

  info(`Created account ${account.toString()}`);
  return account;
}

function cleanUpAccount(account) {
  // If the current displayed message/folder belongs to the account to be removed,
  // select the root folder, otherwise the removal of this account will trigger
  // a "shouldn't have any listeners left" assertion in nsMsgDatabase.cpp.
  const [folder] = window.GetSelectedMsgFolders();
  if (folder && folder.server && folder.server == account.incomingServer) {
    const tabmail = document.getElementById("tabmail");
    tabmail.currentAbout3Pane.displayFolder(folder.server.rootFolder.URI);
  }

  const serverKey = account.incomingServer.key;
  const serverType = account.incomingServer.type;
  info(
    `Cleaning up ${serverType} account ${account.key} and server ${serverKey}`
  );
  MailServices.accounts.removeAccount(account, true);

  try {
    const server = MailServices.accounts.getIncomingServer(serverKey);
    if (server) {
      info(`Cleaning up leftover ${serverType} server ${serverKey}`);
      MailServices.accounts.removeIncomingServer(server, false);
    }
    // eslint-disable-next-line no-unused-vars
  } catch (e) {}
}

function addIdentity(account, email = "mochitest@localhost") {
  const identity = MailServices.accounts.createIdentity();
  identity.email = email;
  account.addIdentity(identity);
  if (!account.defaultIdentity) {
    account.defaultIdentity = identity;
  }
  info(`Created identity ${identity.toString()}`);
  return identity;
}

async function createSubfolder(parent, name) {
  const promiseAdded = MailPromiseTestUtils.promiseFolderAdded(name);
  parent.createSubfolder(name, null);
  await promiseAdded;
  return parent.getChildNamed(name);
}

async function createMessages(folder, makeMessagesArg) {
  if (typeof makeMessagesArg == "number") {
    makeMessagesArg = { count: makeMessagesArg };
  }
  if (!createMessages.messageGenerator) {
    createMessages.messageGenerator = new MessageGenerator();
  }

  const messages =
    createMessages.messageGenerator.makeMessages(makeMessagesArg);

  if (folder.server.type == "imap" && gIMAPServers.has(folder.server.key)) {
    return gIMAPServers.get(folder.server.key).addMessages(folder, messages);
  }

  const messageStrings = messages.map(message => message.toMessageString());
  folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  folder.addMessageBatch(messageStrings);

  return new Promise(resolve =>
    mailTestUtils.updateFolderAndNotify(folder, resolve)
  );
}

async function createMessageFromFile(folder, path) {
  let message = await IOUtils.readUTF8(path);

  // A cheap hack to make this acceptable to addMessageBatch. It works for
  // existing uses but may not work for future uses.
  const fromAddress = message.match(/From: .* <(.*@.*)>/)[0];
  message = `From ${fromAddress}\r\n${message}`;

  if (folder.server.type == "imap" && gIMAPServers.has(folder.server.key)) {
    return gIMAPServers.get(folder.server.key).addMessages(folder, [message]);
  }

  folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  folder.addMessageBatch([message]);
  folder.callFilterPlugins(null);

  return new Promise(resolve =>
    mailTestUtils.updateFolderAndNotify(folder, resolve)
  );
}

async function promiseAnimationFrame(win = window) {
  await new Promise(win.requestAnimationFrame);
  // dispatchToMainThread throws if used as the first argument of Promise.
  return new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
}

async function focusWindow(win) {
  if (Services.focus.activeWindow == win) {
    return;
  }

  const promise = new Promise(resolve => {
    win.addEventListener(
      "focus",
      function () {
        resolve();
      },
      { capture: true, once: true }
    );
  });

  win.focus();
  await promise;
}

function getPanelForNode(node) {
  while (node.localName != "panel") {
    node = node.parentNode;
  }
  return node;
}

/**
 * Wait until the browser is fully loaded.
 *
 * @param {Browser} browser - A xul:browser.
 * @param {string|function():boolean} [wantLoad = null] - If a function, takes a URL and
 *   returns true if that's the load we're interested in. If a string, gives the
 *   URL of the load we're interested in. If not present, the first load resolves
 *   the promise.
 *
 * @returns {Promise} When a load event is triggered for the browser or the browser
 *   is already fully loaded.
 */
function awaitBrowserLoaded(browser, wantLoad) {
  let testFn = () => true;
  if (wantLoad) {
    testFn = typeof wantLoad === "function" ? wantLoad : url => url == wantLoad;
  }

  return TestUtils.waitForCondition(
    () =>
      browser.ownerGlobal.document.readyState === "complete" &&
      (browser.webProgress?.isLoadingDocument === false ||
        browser.contentDocument?.readyState === "complete") &&
      browser.currentURI &&
      testFn(browser.currentURI.spec),
    "Browser should be loaded"
  );
}

async function awaitExtensionPanel(extension, win = window, awaitLoad = true) {
  const { originalTarget: browser } = await BrowserTestUtils.waitForEvent(
    win.document,
    "WebExtPopupLoaded",
    true,
    event => event.detail.extension.id === extension.id
  );

  if (awaitLoad) {
    await awaitBrowserLoaded(browser, url => url != "about:blank");
  }
  await BrowserTestUtils.waitForPopupEvent(getPanelForNode(browser), "shown");
  return browser;
}

function getBrowserActionPopup(extension, win = window) {
  return win.top.document.getElementById("webextension-remote-preload-panel");
}

async function closeBrowserAction(extension, win = window) {
  const popup = getBrowserActionPopup(extension, win);
  await closeMenuPopup(popup);
}

async function openNewMailWindow(options = {}) {
  if (!options.newAccountWizard) {
    Services.prefs.setBoolPref(
      "mail.provider.suppress_dialog_on_startup",
      true
    );
  }

  const win = window.openDialog(
    "chrome://messenger/content/messenger.xhtml",
    "_blank",
    "chrome,all,dialog=no"
  );
  await Promise.all([
    BrowserTestUtils.waitForEvent(win, "focus", true),
    BrowserTestUtils.waitForEvent(win, "activate", true),
  ]);

  return win;
}

async function openComposeWindow(account) {
  const params = Cc[
    "@mozilla.org/messengercompose/composeparams;1"
  ].createInstance(Ci.nsIMsgComposeParams);
  const composeFields = Cc[
    "@mozilla.org/messengercompose/composefields;1"
  ].createInstance(Ci.nsIMsgCompFields);

  params.identity = account.defaultIdentity;
  params.composeFields = composeFields;

  const composeWindowPromise = BrowserTestUtils.domWindowOpened(
    undefined,
    async win => {
      await BrowserTestUtils.waitForEvent(win, "load");
      if (
        win.document.documentURI !=
        "chrome://messenger/content/messengercompose/messengercompose.xhtml"
      ) {
        return false;
      }
      await BrowserTestUtils.waitForEvent(win, "compose-editor-ready");
      return true;
    }
  );
  MailServices.compose.OpenComposeWindowWithParams(null, params);
  return composeWindowPromise;
}

async function openMessageInTab(msgHdr) {
  if (!msgHdr.QueryInterface(Ci.nsIMsgDBHdr)) {
    throw new Error("No message passed to openMessageInTab");
  }

  // Ensure the behaviour pref is set to open a new tab. It is the default,
  // but you never know.
  const oldPrefValue = Services.prefs.getIntPref("mail.openMessageBehavior");
  Services.prefs.setIntPref(
    "mail.openMessageBehavior",
    MailConsts.OpenMessageBehavior.NEW_TAB
  );
  MailUtils.displayMessages([msgHdr]);
  Services.prefs.setIntPref("mail.openMessageBehavior", oldPrefValue);

  const win = Services.wm.getMostRecentWindow("mail:3pane");
  const tab = win.document.getElementById("tabmail").currentTabInfo;
  await BrowserTestUtils.waitForEvent(tab.chromeBrowser, "MsgLoaded");
  return tab;
}

async function openMessageInWindow(msgHdr) {
  if (!msgHdr.QueryInterface(Ci.nsIMsgDBHdr)) {
    throw new Error("No message passed to openMessageInWindow");
  }

  const messageWindowPromise = BrowserTestUtils.domWindowOpenedAndLoaded(
    undefined,
    async win =>
      win.document.documentURI ==
      "chrome://messenger/content/messageWindow.xhtml"
  );
  MailUtils.openMessageInNewWindow(msgHdr);

  const messageWindow = await messageWindowPromise;
  await BrowserTestUtils.waitForEvent(messageWindow, "MsgLoaded");
  return messageWindow;
}

async function promiseMessageLoaded(browser, msgHdr) {
  let messageURI = msgHdr.folder.getUriForMsg(msgHdr);
  messageURI = MailServices.messageServiceFromURI(messageURI).getUrlForUri(
    messageURI,
    null
  );

  await awaitBrowserLoaded(browser, uri => uri == messageURI.spec);
}

/**
 * Check the headers of an open compose window against expected values.
 *
 * @param {object} expected - A dictionary of expected headers.
 *    Omit headers that should have no value.
 * @param {string[]} [expected.to]
 * @param {string[]} [expected.cc]
 * @param {string[]} [expected.bcc]
 * @param {string[]} [expected.replyTo]
 * @param {string[]} [expected.followupTo]
 * @param {string[]} [expected.newsgroups]
 * @param {string} [expected.subject]
 */
async function checkComposeHeaders(expected) {
  const composeWindows = [...Services.wm.getEnumerator("msgcompose")];
  is(composeWindows.length, 1);
  const composeDocument = composeWindows[0].document;
  const composeFields = composeWindows[0].gMsgCompose.compFields;

  await new Promise(resolve => composeWindows[0].setTimeout(resolve));

  if ("identityId" in expected) {
    is(composeWindows[0].getCurrentIdentityKey(), expected.identityId);
  }

  if (expected.attachVCard) {
    is(
      expected.attachVCard,
      composeFields.attachVCard,
      "attachVCard in window should be correct"
    );
  }

  const checkField = (fieldName, elementId) => {
    const pills = composeDocument
      .getElementById(elementId)
      .getElementsByTagName("mail-address-pill");

    if (fieldName in expected) {
      is(
        pills.length,
        expected[fieldName].length,
        `${fieldName} has the right number of pills`
      );
      for (let i = 0; i < expected[fieldName].length; i++) {
        is(pills[i].label, expected[fieldName][i]);
      }
    } else {
      is(pills.length, 0, `${fieldName} is empty`);
    }
  };

  checkField("to", "addressRowTo");
  checkField("cc", "addressRowCc");
  checkField("bcc", "addressRowBcc");
  checkField("replyTo", "addressRowReply");
  checkField("followupTo", "addressRowFollowup");
  checkField("newsgroups", "addressRowNewsgroups");

  const subject = composeDocument.getElementById("msgSubject").value;
  if ("subject" in expected) {
    is(subject, expected.subject, "subject is correct");
  } else {
    is(subject, "", "subject is empty");
  }

  // MV2
  if (expected.hasOwnProperty("overrideDefaultFcc")) {
    if (expected.overrideDefaultFcc) {
      if (expected.overrideDefaultFccFolder) {
        const server = MailServices.accounts.getAccount(
          expected.overrideDefaultFccFolder.accountId
        ).incomingServer;
        const rootURI = server.rootFolder.URI;
        is(
          rootURI + expected.overrideDefaultFccFolder.path,
          composeFields.fcc,
          "fcc should be correct"
        );
      } else {
        ok(
          composeFields.fcc.startsWith("nocopy://"),
          "fcc should start with nocopy://"
        );
      }
    } else {
      is("", composeFields.fcc, "fcc should be empty");
    }
  }

  // MV2
  if (expected.hasOwnProperty("additionalFccFolder")) {
    if (expected.additionalFccFolder) {
      const server = MailServices.accounts.getAccount(
        expected.additionalFccFolder.accountId
      ).incomingServer;
      const rootURI = server.rootFolder.URI;
      is(
        rootURI + expected.additionalFccFolder.path,
        composeFields.fcc2,
        "fcc2 should be correct"
      );
    } else {
      ok(
        composeFields.fcc2 == "" || composeFields.fcc2.startsWith("nocopy://"),
        "fcc2 should not contain a folder uri"
      );
    }
  }

  // MV3
  if (expected.hasOwnProperty("overrideDefaultFccFolderId")) {
    if (expected.overrideDefaultFccFolderId) {
      // We should not use getFolder() here, because we are actually testing that
      // function, so let's do it manually.
      const parts = expected.overrideDefaultFccFolderId.split(":/");
      const accountId = parts.shift();
      const path = parts.join(":/");
      const server = MailServices.accounts.getAccount(accountId).incomingServer;
      is(
        `${server.rootFolder.URI}${path}`,
        composeFields.fcc,
        "fcc should be correct"
      );
    } else if (expected.overrideDefaultFccFolderId == "") {
      ok(
        composeFields.fcc.startsWith("nocopy://"),
        "fcc should start with nocopy://"
      );
    } else {
      is("", composeFields.fcc, "fcc should be empty");
    }
  }

  // MV3
  if (expected.hasOwnProperty("additionalFccFolderId")) {
    if (expected.additionalFccFolderId) {
      // We should not use getFolder() here, because we are actually testing that
      // function, so let's do it manually.
      const parts = expected.additionalFccFolderId.split(":/");
      const accountId = parts.shift();
      const path = parts.join(":/");
      const server = MailServices.accounts.getAccount(accountId).incomingServer;
      is(
        `${server.rootFolder.URI}${path}`,
        composeFields.fcc2,
        "fcc2 should be correct"
      );
    } else {
      ok(
        composeFields.fcc2 == "" || composeFields.fcc2.startsWith("nocopy://"),
        "fcc2 should not contain a folder uri"
      );
    }
  }

  if (expected.hasOwnProperty("priority")) {
    is(
      composeFields.priority.toLowerCase(),
      expected.priority == "normal" ? "" : expected.priority,
      "priority in composeFields should be correct"
    );
  }

  if (expected.hasOwnProperty("returnReceipt")) {
    is(
      composeFields.returnReceipt,
      expected.returnReceipt,
      "returnReceipt in composeFields should be correct"
    );
    for (const item of composeDocument.querySelectorAll(`menuitem[command="cmd_toggleReturnReceipt"],
    toolbarbutton[command="cmd_toggleReturnReceipt"]`)) {
      is(
        item.getAttribute("checked") == "true",
        expected.returnReceipt,
        "returnReceipt in window should be correct"
      );
    }
  }

  if (expected.hasOwnProperty("deliveryStatusNotification")) {
    is(
      composeFields.DSN,
      !!expected.deliveryStatusNotification,
      "deliveryStatusNotification in composeFields should be correct"
    );
    is(
      composeDocument.getElementById("dsnMenu").getAttribute("checked") ==
        "true",
      !!expected.deliveryStatusNotification,
      "deliveryStatusNotification in window should be correct"
    );
  }

  if (expected.hasOwnProperty("deliveryFormat")) {
    const deliveryFormats = {
      auto: Ci.nsIMsgCompSendFormat.Auto,
      plaintext: Ci.nsIMsgCompSendFormat.PlainText,
      html: Ci.nsIMsgCompSendFormat.HTML,
      both: Ci.nsIMsgCompSendFormat.Both,
    };
    const formatToId = new Map([
      [Ci.nsIMsgCompSendFormat.PlainText, "format_plain"],
      [Ci.nsIMsgCompSendFormat.HTML, "format_html"],
      [Ci.nsIMsgCompSendFormat.Both, "format_both"],
      [Ci.nsIMsgCompSendFormat.Auto, "format_auto"],
    ]);
    const expectedFormat = deliveryFormats[expected.deliveryFormat || "auto"];
    is(
      expectedFormat,
      composeFields.deliveryFormat,
      "deliveryFormat in composeFields should be correct"
    );
    for (const [format, id] of formatToId.entries()) {
      const menuitem = composeDocument.getElementById(id);
      is(
        format == expectedFormat,
        menuitem.getAttribute("checked") == "true",
        "checked state of the deliveryFormat menu item <${id}> in window should be correct"
      );
    }
  }
}

/**
 * Click on an item in a browser until the expected event is observed.
 *
 * @param {string} selector - A CSS selector to identify the element which should
 *   be clicked on, inside the provided browser, or a stringified arrow function,
 *   which will be executed in the content process, returning the to-be-clicked
 *   element. The stringified arrow function must start with "() => ".
 * @param {object} [event] - The mouse event to be used to open the menu popup.
 *   It is an object which may contain the properties:
 *     `shiftKey`, `ctrlKey`, `altKey`, `metaKey`, `accessKey`, `clickCount`,
 *     `button`, `type`.
 *   For valid `type`s see nsIDOMWindowUtils' `sendMouseEvent`.
 *   If the type is specified, an mouse event of that type is fired. Otherwise,
 *   a mousedown followed by a mouseup is performed.
 * @param {Browser} browser - The browser which has the element to be clicked on.
 *
 * @returns {Promise} A promise that resolves once the click was observed. Rejects
 *   if unsucessfull for more then 3 tries.
 */
async function synthesizeMouseAtCenterAndRetry(selector, event, browser) {
  let success = false;
  const type = event.type || "click";
  for (let retries = 0; !success && retries < 2; retries++) {
    const clickPromise = BrowserTestUtils.waitForContentEvent(
      browser,
      type
    ).then(() => true);
    // Linux: Sometimes the actor used to simulate the mouse event in the content process does not
    // react, even though the content page signals to be fully loaded. There is no status signal
    // we could wait for, the loaded page *should* be ready at this point. To mitigate, we wait
    // for the click event and if we do not see it within a certain time, we click again.

    const failPromise = new Promise(r =>
      browser.ownerGlobal.setTimeout(r, 500)
    ).then(() => false);

    event.centered = true;
    const browsingContext = BrowserTestUtils.getBrowsingContextFrom(browser);

    // Replicating BrowserTestUtils.synthesizeMouseAtCenter(). However, this
    // implementation allows the caller to specify the function as a string,
    // instead of using target.toString() on the specified function.
    let target = null;
    let targetFn = null;
    if (typeof selector == "function") {
      targetFn = selector.toString();
    } else if (selector.startsWith("() => ")) {
      targetFn = selector;
    } else {
      target = selector;
    }

    BrowserTestUtils.sendQuery(browsingContext, "Test:SynthesizeMouse", {
      target,
      targetFn,
      x: 0,
      y: 0,
      event,
    });

    success = await Promise.race([clickPromise, failPromise]);
  }
  Assert.ok(success, `Should have received ${type} event.`);
}

/**
 * Click on an element inside an action popup.
 *
 * @param {Extension} extension - The extension the action popup belongs to.
 * @param {string} selector - A CSS selector to identify the element which should
 *   be clicked on, inside the action popup.
 * @param {Winow} [win] - The window which has the action popup. Defaults to the
 *   current window.
 *
 * @returns {Promise} A promise that resolves once the click was observed. Rejects
 *   if unsucessfull for more then 3 tries.
 */
async function clickElementInActionPopup(extension, selector, win = window) {
  const stack = getBrowserActionPopup(extension, win);
  const browser = stack.querySelector("browser");
  await synthesizeMouseAtCenterAndRetry(selector, {}, browser);
}

/**
 * Open the standard browser context menu popup inside the current tab.
 *
 * @param {string} selector - A CSS selector to identify the element which should
 *   be clicked on, inside the current tab.
 * @param {Window} [win] - The window which has the tab. Defaults to the current
 *   window.
 *
 * @returns {Promise<Element>} The opened menu.
 */
async function openBrowserContextMenuInTab(selector, win = window) {
  const contentAreaContextMenu =
    win.top.document.getElementById("browserContext");
  const tabmail = document.getElementById("tabmail");
  const browser = tabmail.selectedBrowser;
  await openMenuPopupInBrowser(browser, contentAreaContextMenu, selector);
  return contentAreaContextMenu;
}

/**
 * Open the standard browser context menu popup inside an action popup.
 *
 * @param {Extension} extension - The extension the action popup belongs to.
 * @param {string} selector - A CSS selector to identify the element which should
 *   be clicked on, inside the action popup.
 * @param {Winow} [win] - The window which has the action popup. Defaults to the
 *   current window.
 *
 * @returns {Promise<Element>} The opened menu.
 */
async function openBrowserContextMenuInActionPopup(
  extension,
  selector,
  win = window
) {
  const contentAreaContextMenu =
    win.top.document.getElementById("browserContext");
  const stack = getBrowserActionPopup(extension, win);
  const browser = stack.querySelector("browser");
  await openMenuPopupInBrowser(browser, contentAreaContextMenu, selector);
  return contentAreaContextMenu;
}

/**
 * Click on an element identified by a selector, inside a browser and wait for the
 * specified menu popup to be shown.
 *
 * @param {Browser} browser
 * @param {Element} menu - The <menu> that should appear.
 * @param {string} selector - A CSS selector to identify the element which should
 *   be clicked on, inside the browser.
 * @returns {Promise} A promise that resolves once the menu was opened. Rejects
 *   if unsucessfull for more then 3 tries.
 */
async function openMenuPopupInBrowser(browser, menu, selector) {
  await BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  await synthesizeMouseAtCenterAndRetry(
    selector,
    { type: "mousedown", button: 2 },
    browser
  );
  await synthesizeMouseAtCenterAndRetry(
    selector,
    { type: "contextmenu" },
    browser
  );
  await BrowserTestUtils.waitForPopupEvent(menu, "shown");
}

/**
 * click on the specified element and wait for the specified menu popup to appear.
 * For elements in the parent process only.
 *
 * @param {Element} menu - The <menu> that should appear.
 * @param {Element} element - The element to be clicked on.
 * @param {object} [event] - The mouse event to be used to open the menu popup.
 *   It is an object which may contain the properties:
 *     `shiftKey`, `ctrlKey`, `altKey`, `metaKey`, `accessKey`, `clickCount`,
 *     `button`, `type`.
 *   For valid `type`s see nsIDOMWindowUtils' `sendMouseEvent`.
 *   If the type is specified, an mouse event of that type is fired. Otherwise,
 *   a mousedown followed by a mouseup is performed.
 *
 * @returns {Promise} A promise that resolves when the menu appears.
 */
async function openMenuPopup(menu, element, event = {}) {
  await BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  EventUtils.synthesizeMouseAtCenter(element, event, element.ownerGlobal);
  await BrowserTestUtils.waitForPopupEvent(menu, "shown");
}

/**
 * Activate (click) an menu item in a menu popup.
 *
 * @param {Element} element - The menu item element to be clicked on.
 * @param {ActivateMenuItemOptions} [modifiers] - A modifier object.
 * @see /dom/chrome-webidl/XULPopupElement.webidl
 *
 * @returns {Promise} A promise that resolves after the menu popup of the
 *   clicked item is hidden.
 */
async function clickItemInMenuPopup(element, modifiers = {}) {
  if (element) {
    const menu = element.parentNode;
    await BrowserTestUtils.waitForPopupEvent(menu, "shown");
    element.closest("menupopup").activateItem(element, modifiers);
    await BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  } else {
    throw new Error("clickItemInMenuPopup specified non-existing item");
  }
}

/**
 * Open (click) a sub-menu item in a menu popup.
 *
 * @param {Element} element - The sub-menu item element to be clicked on.
 * @returns {Promise<Element>} The opened sub-menu.
 */
async function openSubMenuPopup(element) {
  const submenu = element.menupopup;
  await BrowserTestUtils.waitForPopupEvent(submenu, "hidden");
  element.openMenu(true);
  await BrowserTestUtils.waitForPopupEvent(submenu, "shown");
  return submenu;
}

/**
 * Close a menu popup.
 *
 * @param {Element} menu - The menu popup element to be closed.
 * @returns {Promise} A promise that resolves after the menu popup is hidden.
 */
async function closeMenuPopup(menu) {
  await BrowserTestUtils.waitForPopupEvent(menu, "shown");
  menu.hidePopup();
  await BrowserTestUtils.waitForPopupEvent(menu, "hidden");
}

/**
 * Close the standard browser context menu popup.
 *
 * @returns {Promise} A promise that resolves after the menu popup is hidden.
 */
async function closeBrowserContextMenuPopup() {
  const contentAreaContextMenu = document.getElementById("browserContext");
  await closeMenuPopup(contentAreaContextMenu);
}

async function getUtilsJS() {
  return IOUtils.readUTF8(getTestFilePath("utils.js"));
}

async function checkContent(browser, expected) {
  // eslint-disable-next-line no-shadow
  await SpecialPowers.spawn(browser, [expected], async expected => {
    let body = content.document.body;
    Assert.ok(body, "body");
    const computedStyle = content.getComputedStyle(body);

    if ("backgroundColor" in expected) {
      if (computedStyle.backgroundColor != expected.backgroundColor) {
        // Give it a bit more time if things weren't settled.

        await new Promise(resolve => content.setTimeout(resolve, 500));
      }
      Assert.equal(
        computedStyle.backgroundColor,
        expected.backgroundColor,
        "backgroundColor"
      );
    }
    if ("color" in expected) {
      if (computedStyle.color != expected.color) {
        // Give it a bit more time if things weren't settled.

        await new Promise(resolve => content.setTimeout(resolve, 500));
      }
      Assert.equal(computedStyle.color, expected.color, "color");
    }
    if ("foo" in expected) {
      if (body.getAttribute("foo") != expected.foo) {
        // Give it a bit more time if things weren't settled.

        await new Promise(resolve => content.setTimeout(resolve, 500));
      }
      Assert.equal(body.getAttribute("foo"), expected.foo, "foo");
    }
    if ("textContent" in expected) {
      // In message display, we only really want the message body, but the
      // document body also has headers. For the purposes of these tests,
      // we can just select an descendant node, since what really matters is
      // whether (or not) a script ran, not the exact result.
      body = body.querySelector(".moz-text-flowed") ?? body;
      if (body.textContent != expected.textContent) {
        // Give it a bit more time if things weren't settled.

        await new Promise(resolve => content.setTimeout(resolve, 500));
      }
      Assert.equal(body.textContent, expected.textContent, "textContent");
    }
  });
}

function contentTabOpenPromise(tabmail, url) {
  return new Promise(resolve => {
    const tabMonitor = {
      onTabTitleChanged() {},
      onTabClosing() {},
      onTabPersist() {},
      onTabRestored() {},
      onTabSwitched() {},
      async onTabOpened(aTab) {
        const result = awaitBrowserLoaded(
          aTab.linkedBrowser,
          urlToMatch => urlToMatch == url
        ).then(() => aTab);

        const reporterListener = {
          QueryInterface: ChromeUtils.generateQI([
            "nsIWebProgressListener",
            "nsISupportsWeakReference",
          ]),
          onStateChange() {},
          onProgressChange() {},
          onLocationChange(
            /* in nsIWebProgress*/ aWebProgress,
            /* in nsIRequest*/ aRequest,
            /* in nsIURI*/ aLocation
          ) {
            if (aLocation.spec == url) {
              aTab.browser.removeProgressListener(reporterListener);
              tabmail.unregisterTabMonitor(tabMonitor);
              TestUtils.executeSoon(() => resolve(result));
            }
          },
          onStatusChange() {},
          onSecurityChange() {},
          onContentBlockingEvent() {},
        };
        aTab.browser.addProgressListener(reporterListener);
      },
    };
    tabmail.registerTabMonitor(tabMonitor);
  });
}

/**
 * @typedef ConfigData
 * @property {string} actionType - type of action button in underscore notation
 * @property {string} window - the window to perform the test in
 * @property {string} [testType] - supported tests are "open-with-mouse-click" and
 *   "open-with-menu-command"
 * @property {string} [default_area] - area to be used for the test
 * @property {boolean} [use_default_popup] - select if the default_popup should be
 *  used for the test
 * @property {boolean} [disable_button] - select if the button should be disabled
 * @property {Function} [backend_script] - custom backend script to be used for the
 *  test, will override the default backend_script of the selected test
 * @property {Function} [background_script] - custom background script to be used for the
 *  test, will override the default background_script of the selected test
 * @property {[string]} [permissions] - custom permissions to be used for the test,
 *  must not be specified together with testType
 */

/**
 * Creates an extension with an action button and either runs one of the default
 * tests, or loads a custom background script and a custom backend scripts to run
 * an arbitrary test.
 *
 * @param {ConfigData} configData - test configuration
 */
async function run_popup_test(configData) {
  if (!configData.actionType) {
    throw new Error("Mandatory configData.actionType is missing");
  }
  if (!configData.window) {
    throw new Error("Mandatory configData.window is missing");
  }

  // Get camelCase API names from action type.
  configData.apiName = configData.actionType.replace(/_([a-z])/g, function (g) {
    return g[1].toUpperCase();
  });
  configData.moduleName =
    configData.actionType == "action" ? "browserAction" : configData.apiName;

  let backend_script = configData.backend_script;

  const extensionDetails = {
    files: {
      "popup.html": `<!DOCTYPE html>
        <html>
          <head>
            <title>Popup</title>
            <meta charset="utf-8">
            <script defer="defer" src="popup.js"></script>
          </head>
          <body>
            <p>Hello</p>
          </body>
        </html>`,
      "popup.js": async function () {
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        await browser.runtime.sendMessage("popup opened");
        await new Promise(resolve => window.setTimeout(resolve));
        window.close();
      },
      "utils.js": await getUtilsJS(),
      "helper.js": function () {
        window.actionType = browser.runtime.getManifest().description;
        // Get camelCase API names from action type.
        window.apiName = window.actionType.replace(/_([a-z])/g, function (g) {
          return g[1].toUpperCase();
        });
        window.getPopupOpenedPromise = function () {
          return new Promise(resolve => {
            const handleMessage = async (message, sender, sendResponse) => {
              if (message && message == "popup opened") {
                sendResponse();
                window.setTimeout(resolve);
                browser.runtime.onMessage.removeListener(handleMessage);
              }
            };
            browser.runtime.onMessage.addListener(handleMessage);
          });
        };
      },
    },
    manifest: {
      manifest_version: configData.manifest_version || 2,
      browser_specific_settings: {
        gecko: {
          id: `${configData.actionType}@mochi.test`,
        },
      },
      description: configData.actionType,
      background: { scripts: ["utils.js", "helper.js", "background.js"] },
    },
    useAddonManager: "temporary",
  };

  switch (configData.testType) {
    case "open-with-mouse-click":
      // eslint-disable-next-line no-shadow
      backend_script = async function (extension, configData) {
        const win = configData.window;

        await extension.startup();
        await promiseAnimationFrame(win);
        await new Promise(resolve => win.setTimeout(resolve));
        await extension.awaitMessage("ready");

        const buttonId = `${configData.actionType}_mochi_test-${configData.moduleName}-toolbarbutton`;
        let toolbarId;
        switch (configData.actionType) {
          case "compose_action":
            toolbarId = "composeToolbar2";
            if (configData.default_area == "formattoolbar") {
              toolbarId = "FormatToolbar";
            }
            break;
          case "action":
          case "browser_action":
            if (configData.default_windows?.join(",") === "messageDisplay") {
              toolbarId = "mail-bar3";
            } else {
              toolbarId = "unified-toolbar";
            }
            break;
          case "message_display_action":
            toolbarId = "header-view-toolbar";
            break;
          default:
            throw new Error(
              `Unsupported configData.actionType: ${configData.actionType}`
            );
        }

        let toolbar, button;
        if (toolbarId === "unified-toolbar") {
          toolbar = win.document.querySelector("unified-toolbar");
          button = win.document.querySelector(
            `#unifiedToolbarContent [extension="${configData.actionType}@mochi.test"]`
          );
        } else {
          toolbar = win.document.getElementById(toolbarId);
          button = win.document.getElementById(buttonId);
        }
        ok(button, "Button created");
        ok(toolbar.contains(button), "Button added to toolbar");
        let label;
        if (toolbarId === "unified-toolbar") {
          const state = getState();
          const itemId = `ext-${configData.actionType}@mochi.test`;
          if (state.mail) {
            ok(
              state.mail.includes(itemId),
              "Button should be in unified toolbar mail space"
            );
          }
          ok(
            getDefaultItemIdsForSpace("mail").includes(itemId),
            "Button should be in default set for unified toolbar mail space"
          );
          ok(
            getAvailableItemIdsForSpace("mail").includes(itemId),
            "Button should be available in unified toolbar mail space"
          );

          const icon = button.querySelector(".button-icon");
          is(
            getComputedStyle(icon).content,
            makeIconSet(`url("chrome://messenger/content/extension.svg")`),
            "Default icon"
          );
          label = button.querySelector(".button-label");
          is(label.textContent, "This is a test", "Correct label");
        } else {
          if (toolbar.hasAttribute("customizable")) {
            ok(
              toolbar.currentSet.split(",").includes(buttonId),
              `Button should have been added to currentSet property of toolbar ${toolbarId}`
            );
            ok(
              toolbar.getAttribute("currentset").split(",").includes(buttonId),
              `Button should have been added to currentset attribute of toolbar ${toolbarId}`
            );
          }
          ok(
            Services.xulStore
              .getValue(win.location.href, toolbarId, "currentset")
              .split(",")
              .includes(buttonId),
            `Button should have been added to currentset xulStore of toolbar ${toolbarId}`
          );

          const icon = button.querySelector(".toolbarbutton-icon");
          is(
            getComputedStyle(icon).listStyleImage,
            makeIconSet(`url("chrome://messenger/content/extension.svg")`),
            "Default icon"
          );
          label = button.querySelector(".toolbarbutton-text");
          is(label.value, "This is a test", "Correct label");
        }

        if (
          !configData.use_default_popup &&
          configData?.manifest_version == 3
        ) {
          assertPersistentListeners(
            extension,
            configData.moduleName,
            "onClicked",
            {
              primed: false,
            }
          );
        }
        if (configData.terminateBackground) {
          await extension.terminateBackground({
            disableResetIdleForTest: true,
          });
          if (
            !configData.use_default_popup &&
            configData?.manifest_version == 3
          ) {
            assertPersistentListeners(
              extension,
              configData.moduleName,
              "onClicked",
              {
                primed: true,
              }
            );
          }
        }

        let clickedPromise;
        if (!configData.disable_button) {
          clickedPromise = extension.awaitMessage("actionButtonClicked");
        }
        EventUtils.synthesizeMouseAtCenter(button, { clickCount: 1 }, win);
        if (configData.disable_button) {
          // We're testing that nothing happens. Give it time to potentially happen.

          await new Promise(resolve => win.setTimeout(resolve, 500));
          // In case the background was terminated, it should not restart.
          // If it does, we will get an extra "ready" message and fail.
          // Listeners should still be primed.
          if (
            configData.terminateBackground &&
            configData?.manifest_version == 3
          ) {
            assertPersistentListeners(
              extension,
              configData.moduleName,
              "onClicked",
              {
                primed: true,
              }
            );
          }
        } else {
          const hasFiredBefore = await clickedPromise;
          await promiseAnimationFrame(win);
          await new Promise(resolve => win.setTimeout(resolve));
          if (toolbarId === "unified-toolbar") {
            is(
              win.document.querySelector(
                `#unifiedToolbarContent [extension="${configData.actionType}@mochi.test"]`
              ),
              button
            );
            label = button.querySelector(".button-label");
            is(label.textContent, "New title", "Correct label");
          } else {
            is(win.document.getElementById(buttonId), button);
            label = button.querySelector(".toolbarbutton-text");
            is(label.value, "New title", "Correct label");
          }

          if (configData.terminateBackground) {
            // The onClicked event should have restarted the background script.
            await extension.awaitMessage("ready");
            // Could be undefined, but it must not be true
            is(false, !!hasFiredBefore);
          }
          if (
            !configData.use_default_popup &&
            configData?.manifest_version == 3
          ) {
            assertPersistentListeners(
              extension,
              configData.moduleName,
              "onClicked",
              {
                primed: false,
              }
            );
          }
        }

        // Check the open state of the action button.
        await TestUtils.waitForCondition(
          () => button.getAttribute("open") != "true",
          "Button should not have open state after the popup closed."
        );

        await extension.unload();
        await promiseAnimationFrame(win);
        await new Promise(resolve => win.setTimeout(resolve));

        ok(!win.document.getElementById(buttonId), "Button destroyed");

        if (toolbarId === "unified-toolbar") {
          const state = getState();
          const itemId = `ext-${configData.actionType}@mochi.test`;
          if (state.mail) {
            ok(
              !state.mail.includes(itemId),
              "Button should have been removed from unified toolbar mail space"
            );
          }
          ok(
            !getDefaultItemIdsForSpace("mail").includes(itemId),
            "Button should have been removed from default set for unified toolbar mail space"
          );
          ok(
            !getAvailableItemIdsForSpace("mail").includes(itemId),
            "Button should have no longer be available in unified toolbar mail space"
          );
        } else {
          ok(
            !Services.xulStore
              .getValue(win.top.location.href, toolbarId, "currentset")
              .split(",")
              .includes(buttonId),
            `Button should have been removed from currentset xulStore of toolbar ${toolbarId}`
          );
        }
      };
      if (configData.use_default_popup) {
        // With popup.
        extensionDetails.files["background.js"] = async function () {
          browser.test.log("popup background script ran");
          const popupPromise = window.getPopupOpenedPromise();
          browser.test.sendMessage("ready");
          await popupPromise;
          await browser[window.apiName].setTitle({ title: "New title" });
          browser.test.sendMessage("actionButtonClicked");
        };
      } else if (configData.disable_button) {
        // Without popup and disabled button.
        extensionDetails.files["background.js"] = async function () {
          browser.test.log("nopopup & button disabled background script ran");
          browser[window.apiName].onClicked.addListener(async () => {
            browser.test.fail(
              "Should not have seen the onClicked event for a disabled button"
            );
          });
          browser[window.apiName].disable();
          browser.test.sendMessage("ready");
        };
      } else {
        // Without popup.
        extensionDetails.files["background.js"] = async function () {
          let hasFiredBefore = false;
          browser.test.log("nopopup background script ran");
          browser[window.apiName].onClicked.addListener(async (tab, info) => {
            browser.test.assertEq("object", typeof tab);
            browser.test.assertEq("object", typeof info);
            browser.test.assertEq(0, info.button);
            browser.test.assertTrue(Array.isArray(info.modifiers));
            browser.test.assertEq(0, info.modifiers.length);
            const [currentTab] = await browser.tabs.query({
              active: true,
              currentWindow: true,
            });
            browser.test.assertEq(
              currentTab.id,
              tab.id,
              "Should find the correct tab"
            );
            await browser[window.apiName].setTitle({ title: "New title" });
            await new Promise(resolve => window.setTimeout(resolve));
            browser.test.sendMessage("actionButtonClicked", hasFiredBefore);
            hasFiredBefore = true;
          });
          browser.test.sendMessage("ready");
        };
      }
      break;

    case "open-with-menu-command":
      extensionDetails.manifest.permissions = ["menus"];
      // eslint-disable-next-line no-shadow
      backend_script = async function (extension, configData) {
        const win = configData.window;
        const buttonId = `${configData.actionType}_mochi_test-${configData.moduleName}-toolbarbutton`;
        let menuId = "toolbar-context-menu";
        let isUnifiedToolbar = false;
        if (
          configData.actionType == "compose_action" &&
          configData.default_area == "formattoolbar"
        ) {
          menuId = "format-toolbar-context-menu";
        }
        if (configData.actionType == "message_display_action") {
          menuId = "header-toolbar-context-menu";
        }
        if (
          (configData.actionType == "browser_action" ||
            configData.actionType == "action") &&
          configData.default_windows?.join(",") !== "messageDisplay"
        ) {
          menuId = "unifiedToolbarMenu";
          isUnifiedToolbar = true;
        }
        const getButton = windowContent => {
          if (isUnifiedToolbar) {
            return windowContent.document.querySelector(
              `#unifiedToolbarContent [extension="${configData.actionType}@mochi.test"]`
            );
          }
          return windowContent.document.getElementById(buttonId);
        };

        extension.onMessage("triggerClick", async () => {
          const button = getButton(win);
          const menu = win.document.getElementById(menuId);
          const onShownPromise = extension.awaitMessage("onShown");
          await BrowserTestUtils.waitForPopupEvent(menu, "hidden");
          EventUtils.synthesizeMouseAtCenter(
            button,
            { type: "contextmenu" },
            win
          );
          await BrowserTestUtils.waitForPopupEvent(menu, "shown");
          await onShownPromise;
          await new Promise(resolve => win.setTimeout(resolve));

          const menuitem = win.document.getElementById(
            `${configData.actionType}_mochi_test-menuitem-_testmenu`
          );
          Assert.ok(menuitem);
          await clickItemInMenuPopup(menuitem);
          extension.sendMessage();
        });

        await extension.startup();
        await extension.awaitFinish();

        // Check the open state of the action button.
        const button = getButton(win);
        await TestUtils.waitForCondition(
          () => button.getAttribute("open") != "true",
          "Button should not have open state after the popup closed."
        );

        await extension.unload();
      };
      if (configData.use_default_popup) {
        // With popup.
        extensionDetails.files["background.js"] = async function () {
          browser.test.log("popup background script ran");
          await new Promise(resolve => {
            browser.menus.create(
              {
                id: "testmenu",
                title: `Open ${window.actionType}`,
                contexts: [window.actionType],
                command: `_execute_${window.actionType}`,
              },
              resolve
            );
          });

          await browser.menus.onShown.addListener((...args) => {
            browser.test.sendMessage("onShown", args);
          });

          const popupPromise = window.getPopupOpenedPromise();
          await window.sendMessage("triggerClick");
          await popupPromise;

          browser.test.notifyPass();
        };
      } else if (configData.disable_button) {
        // Without popup and disabled button.
        extensionDetails.files["background.js"] = async function () {
          browser.test.log("nopopup & button disabled background script ran");
          await new Promise(resolve => {
            browser.menus.create(
              {
                id: "testmenu",
                title: `Open ${window.actionType}`,
                contexts: [window.actionType],
                command: `_execute_${window.actionType}`,
              },
              resolve
            );
          });

          await browser.menus.onShown.addListener((...args) => {
            browser.test.sendMessage("onShown", args);
          });

          browser[window.apiName].onClicked.addListener(async () => {
            browser.test.fail(
              "Should not have seen the onClicked event for a disabled button"
            );
          });

          await browser[window.apiName].disable();
          await window.sendMessage("triggerClick");
          browser.test.notifyPass();
        };
      } else {
        // Without popup.
        extensionDetails.files["background.js"] = async function () {
          browser.test.log("nopopup background script ran");
          await new Promise(resolve => {
            browser.menus.create(
              {
                id: "testmenu",
                title: `Open ${window.actionType}`,
                contexts: [window.actionType],
                command: `_execute_${window.actionType}`,
              },
              resolve
            );
          });

          await browser.menus.onShown.addListener((...args) => {
            browser.test.sendMessage("onShown", args);
          });

          const clickPromise = new Promise(resolve => {
            const listener = async (tab, info) => {
              browser[window.apiName].onClicked.removeListener(listener);
              browser.test.assertEq("object", typeof tab);
              browser.test.assertEq("object", typeof info);
              browser.test.assertEq(0, info.button);
              browser.test.assertTrue(Array.isArray(info.modifiers));
              browser.test.assertEq(0, info.modifiers.length);
              browser.test.log(`Tab ID is ${tab.id}`);
              resolve();
            };
            browser[window.apiName].onClicked.addListener(listener);
          });
          await window.sendMessage("triggerClick");
          await clickPromise;

          browser.test.notifyPass();
        };
      }
      break;
  }

  extensionDetails.manifest[configData.actionType] = {
    default_title: "This is a test",
  };
  if (configData.use_default_popup) {
    extensionDetails.manifest[configData.actionType].default_popup =
      "popup.html";
  }
  if (configData.default_area) {
    extensionDetails.manifest[configData.actionType].default_area =
      configData.default_area;
  }
  if (configData.hasOwnProperty("background")) {
    extensionDetails.files["background.js"] = configData.background_script;
  }
  if (configData.hasOwnProperty("permissions")) {
    extensionDetails.manifest.permissions = configData.permissions;
  }
  if (configData.default_windows) {
    extensionDetails.manifest[configData.actionType].default_windows =
      configData.default_windows;
  }

  const extension = ExtensionTestUtils.loadExtension(extensionDetails);
  await backend_script(extension, configData);
}

async function run_action_button_order_test(configs, window, actionType) {
  // Get camelCase API names from action type.
  const apiName = actionType.replace(/_([a-z])/g, function (g) {
    return g[1].toUpperCase();
  });

  function get_id(name) {
    return `${name}_mochi_test-${apiName}-toolbarbutton`;
  }

  function test_buttons(confs, win, toolbars) {
    for (const toolbarId of toolbars) {
      const expected = confs.filter(e => e.toolbar == toolbarId);
      const selector =
        toolbarId === "unified-toolbar"
          ? `#unifiedToolbarContent [extension$="@mochi.test"]`
          : `#${toolbarId} toolbarbutton[id$="${get_id("")}"]`;
      const buttons = win.document.querySelectorAll(selector);
      Assert.equal(
        expected.length,
        buttons.length,
        `Should find the correct number of buttons in ${toolbarId} toolbar`
      );
      for (let i = 0; i < buttons.length; i++) {
        if (toolbarId === "unified-toolbar") {
          Assert.equal(
            `${expected[i].name}@mochi.test`,
            buttons[i].getAttribute("extension"),
            `Should find the correct button at location #${i}`
          );
        } else {
          Assert.equal(
            get_id(expected[i].name),
            buttons[i].id,
            `Should find the correct button at location #${i}`
          );
        }
      }
    }
  }

  // Create extension data.
  const toolbars = new Set();
  for (const config of configs) {
    toolbars.add(config.toolbar);
    config.extensionData = {
      useAddonManager: "permanent",
      manifest: {
        applications: {
          gecko: {
            id: `${config.name}@mochi.test`,
          },
        },
        [actionType]: {
          default_title: config.name,
        },
      },
    };
    if (config.area) {
      config.extensionData.manifest[actionType].default_area = config.area;
    }
    if (config.default_windows) {
      config.extensionData.manifest[actionType].default_windows =
        config.default_windows;
    }
  }

  // Test order of buttons after first install.
  for (const config of configs) {
    config.extension = ExtensionTestUtils.loadExtension(config.extensionData);
    await config.extension.startup();
  }
  test_buttons(configs, window, toolbars);

  // Disable all buttons.
  for (const config of configs) {
    const addon = await AddonManager.getAddonByID(config.extension.id);
    await addon.disable();
  }
  test_buttons([], window, toolbars);

  // Re-enable all buttons in reversed order, displayed order should not change.
  for (const config of [...configs].reverse()) {
    const addon = await AddonManager.getAddonByID(config.extension.id);
    await addon.enable();
  }
  test_buttons(configs, window, toolbars);

  // Re-install all extensions in reversed order, displayed order should not change.
  for (const config of [...configs].reverse()) {
    config.extension2 = ExtensionTestUtils.loadExtension(config.extensionData);
    await config.extension2.startup();
  }
  test_buttons(configs, window, toolbars);

  // Remove all extensions.
  for (const config of [...configs].reverse()) {
    await config.extension.unload();
    await config.extension2.unload();
  }
  test_buttons([], window, toolbars);
}
