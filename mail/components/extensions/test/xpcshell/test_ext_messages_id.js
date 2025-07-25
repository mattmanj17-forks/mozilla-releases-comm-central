/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
var { AttachmentInfo } = ChromeUtils.importESModule(
  "resource:///modules/AttachmentInfo.sys.mjs"
);

let gSubFolders;

add_task(
  {
    skip_if: () => IS_NNTP,
  },
  async function setup() {
    const account = await createAccount();
    const rootFolder = account.incomingServer.rootFolder;
    gSubFolders = {
      test1: await createSubfolder(rootFolder, "test1"),
      test2: await createSubfolder(rootFolder, "test2"),
      test3: await createSubfolder(rootFolder, "test3"),
      attachment: await createSubfolder(rootFolder, "attachment"),
    };
    await createMessages(gSubFolders.test1, 5);
    const textAttachment = {
      body: "textAttachment",
      filename: "test.txt",
      contentType: "text/plain",
    };
    await createMessages(gSubFolders.attachment, {
      count: 1,
      subject: "Msg with text attachment",
      attachments: [textAttachment],
    });
  }
);

// In this test we'll move and copy some messages around between
// folders. Every operation should result in the message's id property
// changing to a never-seen-before value.
add_task(
  {
    skip_if: () => IS_NNTP,
  },
  async function test_identifiers() {
    const extension = ExtensionTestUtils.loadExtension({
      files: {
        "background.js": async () => {
          const [{ folders }] = await browser.accounts.list();
          const testFolder1 = folders.find(f => f.name == "test1");
          const testFolder2 = folders.find(f => f.name == "test2");
          const testFolder3 = folders.find(f => f.name == "test3");

          class OneTimeListener {
            constructor(type) {
              this.task = Promise.withResolvers();
              this.listener = (...args) => {
                browser.messages[type].removeListener(this.listener);
                this.task.resolve([...args]);
              };
              browser.messages[type].addListener(this.listener);
            }
            seen() {
              return this.task.promise;
            }
          }

          let { messages } = await browser.messages.list(testFolder1.id);
          browser.test.assertEq(
            5,
            messages.length,
            "message count in testFolder1"
          );
          browser.test.assertEq(1, messages[0].id);
          browser.test.assertEq(2, messages[1].id);
          browser.test.assertEq(3, messages[2].id);
          browser.test.assertEq(4, messages[3].id);
          browser.test.assertEq(5, messages[4].id);

          const subjects = messages.map(m => m.subject);

          // Move two messages. We could do this in one operation, but to be
          // sure of the order, do it in separate operations.
          const onMovedPart1 = new OneTimeListener("onMoved");
          await browser.messages.move([1], testFolder2.id);
          await onMovedPart1.seen();
          const onMovedPart2 = new OneTimeListener("onMoved");
          await browser.messages.move([3], testFolder2.id);
          await onMovedPart2.seen();

          ({ messages } = await browser.messages.list(testFolder1.id));
          browser.test.assertEq(
            3,
            messages.length,
            "message count in testFolder1"
          );
          browser.test.assertEq(2, messages[0].id);
          browser.test.assertEq(4, messages[1].id);
          browser.test.assertEq(5, messages[2].id);
          browser.test.assertEq(subjects[1], messages[0].subject);
          browser.test.assertEq(subjects[3], messages[1].subject);
          browser.test.assertEq(subjects[4], messages[2].subject);

          // It should not be possible to update the moved message.
          await browser.test.assertRejects(
            browser.messages.update(3, { flagged: true }),
            /Message not found: 3/,
            "Should not be able to update a no longer existing message"
          );

          // It should not be possible to get the moved message.
          await browser.test.assertRejects(
            browser.messages.get(1),
            /Message not found: 1/,
            "Should not be able to get a no longer existing message"
          );

          // It should not be possible to get the moved message.
          await browser.test.assertRejects(
            browser.messages.get(3),
            /Message not found: 3/,
            "Should not be able to get a no longer existing message"
          );

          ({ messages } = await browser.messages.list(testFolder2.id));
          browser.test.assertEq(
            2,
            messages.length,
            "message count in testFolder2"
          );
          browser.test.assertEq(6, messages[0].id, "new id created");
          browser.test.assertEq(7, messages[1].id, "new id created");
          browser.test.assertEq(subjects[0], messages[0].subject);
          browser.test.assertEq(subjects[2], messages[1].subject);

          // Copy one message.

          const onCopied = new OneTimeListener("onCopied");
          await browser.messages.copy([6], testFolder3.id);
          await onCopied.seen();

          ({ messages } = await browser.messages.list(testFolder2.id));
          browser.test.assertEq(
            2,
            messages.length,
            "message count in testFolder2"
          );
          browser.test.assertEq(6, messages[0].id);
          browser.test.assertEq(7, messages[1].id);
          browser.test.assertEq(subjects[0], messages[0].subject);
          browser.test.assertEq(subjects[2], messages[1].subject);

          ({ messages } = await browser.messages.list(testFolder3.id));
          browser.test.assertEq(
            1,
            messages.length,
            "message count in testFolder3"
          );
          browser.test.assertEq(8, messages[0].id, "new id created");
          browser.test.assertEq(subjects[0], messages[0].subject);

          // Move the copied message back to the previous folder. There should
          // now be two copies there, each with their own ID.

          const onMoved = new OneTimeListener("onMoved");
          await browser.messages.move([8], testFolder2.id);
          await onMoved.seen();

          ({ messages } = await browser.messages.list(testFolder2.id));
          browser.test.assertEq(
            3,
            messages.length,
            "message count in testFolder2"
          );
          browser.test.assertEq(6, messages[0].id);
          browser.test.assertEq(7, messages[1].id);
          browser.test.assertEq(
            9,
            messages[2].id,
            "new id created, not a duplicate"
          );
          browser.test.assertEq(subjects[0], messages[0].subject);
          browser.test.assertEq(subjects[2], messages[1].subject);
          browser.test.assertEq(
            subjects[0],
            messages[2].subject,
            "same message as another in this folder"
          );

          // It should not be possible to update the moved message.
          await browser.test.assertRejects(
            browser.messages.update(8, { flagged: true }),
            /Message not found: 8/,
            "Should not be able to update a no longer existing message"
          );

          // It should not be possible to get the moved message.
          await browser.test.assertRejects(
            browser.messages.get(8),
            /Message not found: 8/,
            "Should not be able to get a no longer existing message"
          );

          browser.test.notifyPass("finished");
        },
        "utils.js": await getUtilsJS(),
      },
      manifest: {
        background: { scripts: ["utils.js", "background.js"] },
        permissions: [
          "accountsRead",
          "messagesMove",
          "messagesRead",
          "messagesUpdate",
        ],
      },
    });

    await extension.startup();
    await extension.awaitFinish("finished");
    await extension.unload();
  }
);

// In this test we'll remove an attachment from a message and its id property
// should not change. (Bug 1645595). Test does not work with IMAP test server,
// which has issues with attachments.
add_task(
  {
    skip_if: () => IS_NNTP || IS_IMAP,
  },
  async function test_attachments() {
    const extension = ExtensionTestUtils.loadExtension({
      files: {
        "background.js": async () => {
          browser.test.onMessage.addListener(async () => {
            // This listener gets called once the attachment has been removed.
            // Make sure we still get the message and it no longer has the
            // attachment.
            const modifiedMessage = await browser.messages.getFull(id);
            browser.test.assertEq(
              "Msg with text attachment",
              modifiedMessage.headers.subject[0]
            );
            browser.test.assertEq(
              "text/x-moz-deleted",
              modifiedMessage.parts[0].parts[1].contentType
            );
            browser.test.assertEq(
              "Deleted: test.txt",
              modifiedMessage.parts[0].parts[1].name
            );
            browser.test.notifyPass("finished");
          });

          const [{ folders }] = await browser.accounts.list();
          const testFolder = folders.find(f => f.name == "attachment");
          const { messages } = await browser.messages.list(testFolder.id);
          browser.test.assertEq(1, messages.length);
          const id = messages[0].id;

          const originalMessage = await browser.messages.getFull(id);
          browser.test.assertEq(
            "Msg with text attachment",
            originalMessage.headers.subject[0]
          );
          browser.test.assertEq(
            "text/plain",
            originalMessage.parts[0].parts[1].contentType
          );
          browser.test.assertEq(
            "test.txt",
            originalMessage.parts[0].parts[1].name
          );
          browser.test.sendMessage("removeAttachment", id);
        },
        "utils.js": await getUtilsJS(),
      },
      manifest: {
        background: { scripts: ["utils.js", "background.js"] },
        permissions: ["accountsRead", "messagesRead"],
      },
    });

    extension.onMessage("removeAttachment", async () => {
      const msgHdr = gSubFolders.attachment.messages.getNext();
      const msgUri = msgHdr.folder.getUriForMsg(msgHdr);
      const neckoURL = MailServices.neckoURLForMessageURI(msgUri);
      const attachment = new AttachmentInfo({
        contentType: "text/plain",
        url: `${neckoURL}&part=1.2&filename=test.txt`,
        name: "test.txt",
        uri: msgUri,
        message: msgHdr,
      });
      await AttachmentInfo.deleteAttachments(msgHdr, [attachment], true);
      extension.sendMessage();
    });

    await extension.startup();
    await extension.awaitFinish("finished");
    await extension.unload();
  }
);
