/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { ensure_cards_view } = ChromeUtils.importESModule(
  "resource://testing-common/MailViewHelpers.sys.mjs"
);

const statusText = document.getElementById("statusText");
const tabmail = document.getElementById("tabmail");
const about3Pane = tabmail.currentAbout3Pane;
const { threadTree } = about3Pane;

add_setup(async function () {
  // Create an account for the test.
  const account = MailServices.accounts.createLocalMailAccount();
  account.addIdentity(MailServices.accounts.createIdentity());

  // Create a folder for the account to store test messages.
  const rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  const testFolder = rootFolder
    .createLocalSubfolder("statusFeedback")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);

  // Generate a test message.
  const generator = new MessageGenerator();
  testFolder.addMessage(generator.makeMessage().toMessageString());

  // Use the test folder.
  about3Pane.displayFolder(testFolder.URI);
  await ensure_cards_view(document);

  // Remove test account on cleanup.
  registerCleanupFunction(() => {
    MailServices.accounts.removeAccount(account, false);
  });
});

/**
 * Tests that the correct status message appears when opening a message.
 */
add_task(async function testMessageOpen() {
  const row = threadTree.getRowAtIndex(0);
  const subjectLine = row.querySelector(
    ".thread-card-subject-container .subject"
  );

  // Click on the email.
  const selectPromise = BrowserTestUtils.waitForEvent(threadTree, "select");
  EventUtils.synthesizeMouseAtCenter(
    subjectLine,
    { clickCount: 1 },
    about3Pane
  );
  await selectPromise;

  // Check the value of the status message.
  Assert.equal(
    statusText.value,
    "Loading Message…",
    "correct status message is shown"
  );

  // Check that the status message eventually reset
  await TestUtils.waitForCondition(
    () => statusText.value == "",
    "status message should eventually reset"
  );
});

add_task(async function testManyStatuses() {
  const statusFeedback = window.MsgStatusFeedback;
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    const str = `Hey hey hey #${i}`;
    if (i < 10) {
      // after 10 messages, messages should get dropped
      statuses.push(
        BrowserTestUtils.waitForMutationCondition(
          statusText,
          {
            attributes: true,
            attributeFilter: ["value"],
          },
          () => statusText.value == str
        )
      );
    }
    statusFeedback.showStatusString(str);
  }
  await Promise.all(statuses);
  Assert.ok(true, `The ${statuses.length} first statuses should be shown`);

  // After that, it should clear up.
  await BrowserTestUtils.waitForMutationCondition(
    statusText,
    {
      attributes: true,
      attributeFilter: ["value"],
    },
    () => statusText.value == ""
  );
});
