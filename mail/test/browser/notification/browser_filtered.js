/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that duplicate notifications about the same message do not appear.
 */

const { MockAlertsService } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MockAlertsService.sys.mjs"
);

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { ServerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ServerTestUtils.sys.mjs"
);

add_task(async function () {
  const server = await ServerTestUtils.createServer(
    ServerTestUtils.serverDefs.imap.plain
  );
  server.daemon.createMailbox("INBOX/greenFilter", { subscribed: true });
  server.daemon.createMailbox("INBOX/blueFilter", { subscribed: true });
  server.daemon.createMailbox("INBOX/redFilter", { subscribed: true });

  const account = MailServices.accounts.createAccount();
  account.addIdentity(MailServices.accounts.createIdentity());
  account.incomingServer = MailServices.accounts.createIncomingServer(
    "user",
    "test.test",
    "imap"
  );
  account.incomingServer.prettyName = "IMAP Account";
  account.incomingServer.port = 143;
  account.incomingServer.password = "password";
  const rootFolder = account.incomingServer.rootFolder;
  const inbox = rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);

  document.getElementById("tabmail").currentAbout3Pane.displayFolder(inbox);
  await TestUtils.waitForCondition(
    () => inbox.numSubFolders == 3,
    "waiting for all folders to appear"
  );

  function createFilter(sender, folder) {
    const filter = filterList.createFilter(sender);
    filter.enabled = true;

    const searchTerm = filter.createTerm();
    searchTerm.attrib = Ci.nsMsgSearchAttrib.Sender;
    searchTerm.op = Ci.nsMsgSearchOp.Is;

    searchTerm.value = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgSearchValue"]),
      attrib: Ci.nsMsgSearchAttrib.Sender,
      str: sender,
    };

    const action = filter.createAction();
    action.type = Ci.nsMsgFilterAction.MoveToFolder;
    action.targetFolderUri = folder.URI;

    filter.appendTerm(searchTerm);
    filter.appendAction(action);
    filterList.insertFilterAt(0, filter);
  }

  const filterList = account.incomingServer.getFilterList(null);
  for (const colour of ["green", "blue", "red"]) {
    const folder = inbox.getChildNamed(`${colour}Filter`);
    Assert.ok(folder, `folder ${colour}Filter should exist`);
    createFilter(`${colour}@test.invalid`, folder);
  }

  const trash = await TestUtils.waitForCondition(
    () => rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash),
    "waiting for trash folder to exist"
  );
  createFilter("spammer@test.invalid", trash);

  MockAlertsService.init();

  const generator = new MessageGenerator();

  registerCleanupFunction(async function () {
    await TestUtils.waitForCondition(
      () => account.incomingServer.allConnectionsIdle,
      "waiting for IMAP connection to become idle"
    );

    MailServices.accounts.removeAccount(account, false);
    MockAlertsService.cleanup();
  });

  await server.addMessages(
    inbox,
    generator.makeMessages({
      count: 1,
      from: ["spammer", "spammer@test.invalid"],
    })
  );
  window.GetFolderMessages();
  // There should be no notification here. Wait a bit to be sure.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 500));
  Assert.equal(
    trash.getNumNewMessages(false),
    1,
    "trash should have one new message"
  );
  Assert.ok(!MockAlertsService.alert, "there should be no notification");

  for (const colour of ["red", "green", "blue", "green", "red"]) {
    await server.addMessages(
      inbox,
      generator.makeMessages({
        count: 1,
        from: [colour, `${colour}@test.invalid`],
      }),
      false
    );
    window.GetFolderMessages();

    const alert = await TestUtils.waitForCondition(
      () => MockAlertsService.alert,
      `waiting for a notification about folder ${colour}Filter`
    );
    Assert.stringContains(
      alert.text,
      `from "${colour}"`,
      `notification should be about a message from ${colour}@test.invalid`
    );
    Assert.stringContains(
      alert.cookie,
      `INBOX/${colour}Filter`,
      `notification should be about folder ${colour}Filter`
    );

    MockAlertsService.listener.observe(null, "alertfinished", alert.cookie);
    MockAlertsService.reset();
  }

  await server.addMessages(
    inbox,
    generator.makeMessages({
      count: 1,
      from: ["spammer", "spammer@test.invalid"],
    })
  );
  window.GetFolderMessages();
  // There should be no notification here. Wait a bit to be sure.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 500));
  Assert.equal(
    trash.getNumNewMessages(false),
    1,
    "trash should have one new message"
  );
  Assert.equal(
    trash.getNumUnread(false),
    2,
    "trash should have two unread messages"
  );
  Assert.ok(!MockAlertsService.alert, "there should be no notification");
});
