/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * nsIMsgFolder.subFolders tests
 * These tests intend to test pluggableStore.discoverSubFolders
 * and nsIMsgFolder.hasSubFolders.
 */

// Currently we have two mailbox storage formats.
var gPluggableStores = [
  "@mozilla.org/msgstore/berkeleystore;1",
  "@mozilla.org/msgstore/maildirstore;1",
];

/**
 * Check whether the expected folder structure
 * exists in the root folder "mailFolder".
 *
 * @param {nsIMsgFolder[]} expected - An array of folders and subfolders
 *   we expect.
 * @param {nsIMsgFolder[]} actual - Actual subfolders enumerator.
 */
function check_sub_folders(expected, actual) {
  for (const actualFolder of actual) {
    let index;
    for (index = 0; index < expected.length; index++) {
      if (expected[index].name == actualFolder.name) {
        break;
      }
    }
    // If index goes out of bounds, probably we didn't find the name.
    Assert.less(index, expected.length);

    const pluggableStore = actualFolder.msgStore;
    pluggableStore.discoverSubFolders(actualFolder, true);
    Assert.equal(!!expected[index].subFolders, actualFolder.hasSubFolders);
    if (actualFolder.hasSubFolders) {
      Assert.equal(
        expected[index].subFolders.length,
        actualFolder.numSubFolders
      );
      check_sub_folders(expected[index].subFolders, actualFolder.subFolders);
    }
  }
}

/**
 * Test default mailbox without creating any subfolders.
 */
function test_default_mailbox(expected, type) {
  const mailbox = setup_mailbox(type, create_temporary_directory());

  check_sub_folders(expected, mailbox.subFolders);
}

/**
 * A helper method to add the folders in aFolderArray
 * to the aParentFolder as subfolders.
 *
 * @param {nsIMsgFolder[]} aFolderArray - Array of folders and subfolders.
 * @param {nsIMsgFolder} aParentFolder - Folder to which the folders and
 *   subfolders from aFolderArray are to be added.
 */
function add_sub_folders(aFolderArray, aParentFolder) {
  for (const msgFolder of aFolderArray) {
    if (!aParentFolder.containsChildNamed(msgFolder.name)) {
      aParentFolder.createSubfolder(msgFolder.name, null);
    }
    if (msgFolder.subFolders) {
      add_sub_folders(
        msgFolder.subFolders,
        aParentFolder.getChildNamed(msgFolder.name)
      );
    }
  }
}

/**
 * Create a server with folders and subfolders from the
 * "expected" structure, then create a new server with
 * the same filePath, and test that we can discover these
 * folders based on that filePath.
 */
function test_mailbox(expected, type) {
  const mailboxRootFolder = setup_mailbox(type, create_temporary_directory());
  add_sub_folders(expected, mailboxRootFolder);

  const actualFolder = setup_mailbox(type, mailboxRootFolder.filePath);
  check_sub_folders(expected, actualFolder.subFolders);
}

function run_all_tests() {
  test_default_mailbox(
    [{ name: "Trash" }, { name: "Unsent Messages" }],
    "none"
  );
  test_default_mailbox([{ name: "Inbox" }, { name: "Trash" }], "pop3");

  // Assuming that the order of the folders returned from the actual folder
  // discovery is independent and un-important for this test.
  test_mailbox(
    [
      {
        name: "Inbox",
        subFolders: [
          {
            name: "sub4",
          },
        ],
      },
      {
        name: "Trash",
      },
    ],
    "pop3"
  );

  test_mailbox(
    [
      {
        name: "Inbox",
        subFolders: [
          {
            name: "inbox-sub1",
            subFolders: [
              {
                name: "inbox-sub-sub1",
              },
              {
                name: "inbox-sub-sub2",
              },
            ],
          },
          {
            name: "inbox-sub2",
          },
        ],
      },
      {
        name: "Trash",
      },
      {
        name: "Outbox",
        subFolders: [
          {
            name: "outbox-sub1",
          },
        ],
      },
    ],
    "pop3"
  );
}

function run_test() {
  for (const store in gPluggableStores) {
    Services.prefs.setCharPref(
      "mail.serverDefaultStoreContractID",
      gPluggableStores[store]
    );
    run_all_tests();
  }
}
