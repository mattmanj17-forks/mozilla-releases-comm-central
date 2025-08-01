/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that trying to connect to a non-existent server displays an alert.
 */

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { MockAlertsService } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MockAlertsService.sys.mjs"
);
const { ServerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ServerTestUtils.sys.mjs"
);

const generator = new MessageGenerator();
let localAccount, imapAccount, pop3Account, ewsAccount, nntpAccount;

const allServers = [];

const about3Pane = document.getElementById("tabmail").currentAbout3Pane;
const getMessagesButton = about3Pane.document.getElementById(
  "folderPaneGetMessages"
);
const getMessagesContext = about3Pane.document.getElementById(
  "folderPaneGetMessagesContext"
);
let toolbarButton, toolbarContext;
const fileMenu = document.getElementById("menu_File");
const fileMenuGetMessages = document.getElementById("menu_getAllNewMsg");
const fileMenuGetMessagesPopup = fileMenuGetMessages.menupopup;

add_setup(async function () {
  localAccount = MailServices.accounts.createLocalMailAccount();

  imapAccount = MailServices.accounts.createAccount();
  imapAccount.addIdentity(MailServices.accounts.createIdentity());
  imapAccount.incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "imap"
  );
  imapAccount.incomingServer.prettyName = "IMAP Account";
  imapAccount.incomingServer.port = 10000;
  imapAccount.incomingServer.password = "password";
  allServers.push(imapAccount.incomingServer);

  pop3Account = MailServices.accounts.createAccount();
  pop3Account.addIdentity(MailServices.accounts.createIdentity());
  pop3Account.incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "pop3"
  );
  pop3Account.incomingServer.prettyName = "POP3 Account";
  pop3Account.incomingServer.port = 10000;
  pop3Account.incomingServer.password = "password";
  allServers.push(pop3Account.incomingServer);

  ewsAccount = MailServices.accounts.createAccount();
  ewsAccount.addIdentity(MailServices.accounts.createIdentity());
  ewsAccount.incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "ews"
  );
  ewsAccount.incomingServer.setStringValue(
    "ews_url",
    "http://localhost:10000/EWS/Exchange.asmx"
  );
  ewsAccount.incomingServer.prettyName = "EWS Account";
  allServers.push(ewsAccount.incomingServer);

  nntpAccount = MailServices.accounts.createAccount();
  nntpAccount.incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "nntp"
  );
  nntpAccount.incomingServer.prettyName = "NNTP Account";
  nntpAccount.incomingServer.port = 10000;
  nntpAccount.incomingServer.rootFolder.createSubfolder(
    "getmessages.newsgroup",
    null
  );
  allServers.push(nntpAccount.incomingServer);

  about3Pane.displayFolder(localAccount.incomingServer.rootFolder);

  MockAlertsService.init();

  registerCleanupFunction(async function () {
    MailServices.accounts.removeAccount(localAccount, false);
    MailServices.accounts.removeAccount(imapAccount, false);
    MailServices.accounts.removeAccount(pop3Account, false);
    MailServices.accounts.removeAccount(ewsAccount, false);
    MailServices.accounts.removeAccount(nntpAccount, false);
    MockAlertsService.cleanup();
  });
});

add_task(async function testConnectionRefused() {
  for (const server of allServers) {
    info(`getting messages for ${server.type}`);
    EventUtils.synthesizeMouseAtCenter(
      getMessagesButton,
      { type: "contextmenu" },
      about3Pane
    );
    await BrowserTestUtils.waitForPopupEvent(getMessagesContext, "shown");
    getMessagesContext.activateItem(
      getMessagesContext.querySelector(`[data-server-key="${server.key}"]`)
    );
    await BrowserTestUtils.waitForPopupEvent(getMessagesContext, "hidden");

    const alert = await TestUtils.waitForCondition(
      () => MockAlertsService.alert,
      "waiting for connection alert to show"
    );

    Assert.equal(
      alert.imageURL,
      AppConstants.platform == "macosx"
        ? ""
        : "chrome://branding/content/icon48.png"
    );
    Assert.stringContains(
      alert.text,
      "localhost",
      "the alert text should include the hostname of the server"
    );
    Assert.stringContains(
      alert.text,
      "the connection was refused",
      "the alert text should state the problem"
    );

    // There could be multiple alerts for the same problem. These are swallowed
    // while the first alert is open, but we should wait a while for them.
    await promiseServerIdle(server);
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => setTimeout(resolve, 1000));

    MockAlertsService.listener.observe(null, "alertfinished", alert.cookie);
    MockAlertsService.reset();
  }

  await promiseServerIdle(imapAccount.incomingServer);
  await promiseServerIdle(pop3Account.incomingServer);
  await promiseServerIdle(nntpAccount.incomingServer);
});
