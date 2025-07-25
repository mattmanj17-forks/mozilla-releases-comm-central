/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var folder;

var {
  create_body_part,
  create_deleted_attachment,
  create_detached_attachment,
  create_enclosure_attachment,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/AttachmentHelpers.sys.mjs"
);
var {
  be_in_folder,
  close_popup,
  create_folder,
  get_about_message,
  open_message_from_file,
  select_click_row,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
);
const { add_message_to_folder, create_message } = ChromeUtils.importESModule(
  "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
);

var aboutMessage = get_about_message();

var textAttachment =
  "Can't make the frug contest, Helen; stomach's upset. I'll fix you, " +
  "Ubik! Ubik drops you back in the thick of things fast. Taken as " +
  "directed, Ubik speeds relief to head and stomach. Remember: Ubik is " +
  "only seconds away. Avoid prolonged use.";

// create some messages that have various types of attachments
var messages = [
  {
    name: "regular_attachment",
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    menuStates: [{ open: true, save: true, detach: true, delete_: true }],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "detached_attachment",
    bodyPart: null,
    menuStates: [{ open: true, save: true, detach: false, delete_: false }],
    allMenuStates: { open: true, save: true, detach: false, delete_: false },
  },
  {
    name: "detached_attachment_with_missing_file",
    bodyPart: null,
    menuStates: [{ open: false, save: false, detach: false, delete_: false }],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "deleted_attachment",
    bodyPart: null,
    menuStates: [{ open: false, save: false, detach: false, delete_: false }],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "multiple_attachments",
    attachments: [
      { body: textAttachment, filename: "ubik.txt", format: "" },
      { body: textAttachment, filename: "ubik2.txt", format: "" },
    ],
    menuStates: [
      { open: true, save: true, detach: true, delete_: true },
      { open: true, save: true, detach: true, delete_: true },
    ],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "multiple_attachments_one_detached",
    bodyPart: null,
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    menuStates: [
      { open: true, save: true, detach: false, delete_: false },
      { open: true, save: true, detach: true, delete_: true },
    ],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "multiple_attachments_one_detached_with_missing_file",
    bodyPart: null,
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: true, save: true, detach: true, delete_: true },
    ],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "multiple_attachments_one_deleted",
    bodyPart: null,
    attachments: [{ body: textAttachment, filename: "ubik.txt", format: "" }],
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: true, save: true, detach: true, delete_: true },
    ],
    allMenuStates: { open: true, save: true, detach: true, delete_: true },
  },
  {
    name: "multiple_attachments_all_detached",
    bodyPart: null,
    menuStates: [
      { open: true, save: true, detach: false, delete_: false },
      { open: true, save: true, detach: false, delete_: false },
    ],
    allMenuStates: { open: true, save: true, detach: false, delete_: false },
  },
  {
    name: "multiple_attachments_all_detached_with_missing_files",
    bodyPart: null,
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
    ],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "multiple_attachments_all_deleted",
    bodyPart: null,
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
    ],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "link_enclosure_valid",
    bodyPart: null,
    menuStates: [{ open: true, save: true, detach: false, delete_: false }],
    allMenuStates: { open: true, save: true, detach: false, delete_: false },
  },
  {
    name: "link_enclosure_invalid",
    bodyPart: null,
    menuStates: [{ open: false, save: false, detach: false, delete_: false }],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "link_multiple_enclosures",
    bodyPart: null,
    menuStates: [
      { open: true, save: true, detach: false, delete_: false },
      { open: true, save: true, detach: false, delete_: false },
    ],
    allMenuStates: { open: true, save: true, detach: false, delete_: false },
  },
  {
    name: "link_multiple_enclosures_one_invalid",
    bodyPart: null,
    menuStates: [
      { open: true, save: true, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
    ],
    allMenuStates: { open: true, save: true, detach: false, delete_: false },
  },
  {
    name: "link_multiple_enclosures_all_invalid",
    bodyPart: null,
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
    ],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
  {
    name: "link_multiple_enclosures_all_links_invalid",
    bodyPart: null,
    menuStates: [
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
      { open: false, save: false, detach: false, delete_: false },
    ],
    allMenuStates: { open: false, save: false, detach: false, delete_: false },
  },
];

add_setup(async function () {
  // set up our detached/deleted attachments
  var detachedFile = new FileUtils.File(getTestFilePath(`data/attachment.txt`));
  var detached = create_body_part("Here is a file", [
    create_detached_attachment(detachedFile, "text/plain"),
  ]);
  var multiple_detached = create_body_part("Here are some files", [
    create_detached_attachment(detachedFile, "text/plain"),
    create_detached_attachment(detachedFile, "text/plain"),
  ]);

  var missingFile = new FileUtils.File(getTestFilePath(`data/nonexistent.txt`));
  var missing = create_body_part(
    "Here is a file (but you deleted the external file, you silly oaf!)",
    [create_detached_attachment(missingFile, "text/plain")]
  );
  var multiple_missing = create_body_part(
    "Here are some files (but you deleted the external files, you silly oaf!)",
    [
      create_detached_attachment(missingFile, "text/plain"),
      create_detached_attachment(missingFile, "text/plain"),
    ]
  );

  var deleted = create_body_part("Here is a file that you deleted", [
    create_deleted_attachment("deleted.txt", "text/plain"),
  ]);
  var multiple_deleted = create_body_part(
    "Here are some files that you deleted",
    [
      create_deleted_attachment("deleted.txt", "text/plain"),
      create_deleted_attachment("deleted.txt", "text/plain"),
    ]
  );

  var enclosure_valid_url = create_body_part("My blog has the best enclosure", [
    create_enclosure_attachment(
      "purr.mp3",
      "audio/mpeg",
      "https://example.com",
      12345678
    ),
  ]);
  var enclosure_invalid_url = create_body_part(
    "My blog has the best enclosure with a dead link",
    [
      create_enclosure_attachment(
        "meow.mp3",
        "audio/mpeg",
        "https://example.com/invalid"
      ),
    ]
  );
  var multiple_enclosures = create_body_part(
    "My blog has the best 2 cat sound enclosures",
    [
      create_enclosure_attachment(
        "purr.mp3",
        "audio/mpeg",
        "https://example.com",
        1234567
      ),
      create_enclosure_attachment(
        "meow.mp3",
        "audio/mpeg",
        "https://example.com",
        987654321
      ),
    ]
  );
  var multiple_enclosures_one_link_invalid = create_body_part(
    "My blog has the best 2 cat sound enclosures but one is invalid",
    [
      create_enclosure_attachment(
        "purr.mp3",
        "audio/mpeg",
        "https://example.com",
        1234567
      ),
      create_enclosure_attachment(
        "meow.mp3",
        "audio/mpeg",
        "https://example.com/invalid"
      ),
    ]
  );
  var multiple_enclosures_all_links_invalid = create_body_part(
    "My blog has 2 enclosures with 2 bad links",
    [
      create_enclosure_attachment(
        "purr.mp3",
        "audio/mpeg",
        "https://example.com/invalid"
      ),
      create_enclosure_attachment(
        "meow.mp3",
        "audio/mpeg",
        "https://example.com/invalid"
      ),
    ]
  );
  var link_multiple_enclosures_all_links_invalid = create_body_part(
    "Bad file links",
    [
      create_enclosure_attachment(
        "meow1.mp3",
        "audio/mpeg",
        "file:///\\1.2.3.4/asd"
      ),
      create_enclosure_attachment(
        "meow2.mp3",
        "audio/mpeg",
        "file://///1.2.3.4/asd"
      ),
      create_enclosure_attachment(
        "meow3.mp3",
        "audio/mpeg",
        "file:///%5c%5c1.2.3.4/asd"
      ),
      create_enclosure_attachment(
        "meow4.mp3",
        "audio/mpeg",
        "file:///%5c%5cattacker.tld%5cmeow"
      ),
      create_enclosure_attachment(
        "meow5.mp3",
        "audio/mpeg",
        "chrome://messenger/content/messenger.xhtml"
      ),
      create_enclosure_attachment(
        "meow6.mp3",
        "audio/mpeg",
        "smtp://example.com?foobar"
      ),
    ]
  );

  folder = await create_folder("AttachmentMenusA");
  for (let i = 0; i < messages.length; i++) {
    // First, add any missing info to the message object.
    switch (messages[i].name) {
      case "detached_attachment":
      case "multiple_attachments_one_detached":
        messages[i].bodyPart = detached;
        break;
      case "multiple_attachments_all_detached":
        messages[i].bodyPart = multiple_detached;
        break;
      case "detached_attachment_with_missing_file":
      case "multiple_attachments_one_detached_with_missing_file":
        messages[i].bodyPart = missing;
        break;
      case "multiple_attachments_all_detached_with_missing_files":
        messages[i].bodyPart = multiple_missing;
        break;
      case "deleted_attachment":
      case "multiple_attachments_one_deleted":
        messages[i].bodyPart = deleted;
        break;
      case "multiple_attachments_all_deleted":
        messages[i].bodyPart = multiple_deleted;
        break;
      case "link_enclosure_valid":
        messages[i].bodyPart = enclosure_valid_url;
        messages[i].feedMessage = true;
        break;
      case "link_enclosure_invalid":
        messages[i].bodyPart = enclosure_invalid_url;
        messages[i].feedMessage = true;
        break;
      case "link_multiple_enclosures":
        messages[i].bodyPart = multiple_enclosures;
        messages[i].feedMessage = true;
        break;
      case "link_multiple_enclosures_one_invalid":
        messages[i].bodyPart = multiple_enclosures_one_link_invalid;
        messages[i].feedMessage = true;
        break;
      case "link_multiple_enclosures_all_invalid":
        messages[i].bodyPart = multiple_enclosures_all_links_invalid;
        break;
      case "link_multiple_enclosures_all_links_invalid":
        messages[i].bodyPart = link_multiple_enclosures_all_links_invalid;
        break;
    }

    await add_message_to_folder([folder], create_message(messages[i]));
    if (messages[i].feedMessage) {
      // Feeds allow special behaviors. Add flag if we're testing such a case.
      // In particular, http attachments (enclosures) are allowed.
      const msg = [...folder.messages].at(-1);
      msg.orFlags(Ci.nsMsgMessageFlags.FeedMsg);
    }
  }
});

/**
 * Ensure that the specified element is visible/hidden
 *
 * @param {string} id - The id of the element to check.
 * @param {boolean} visible - true if the element should be visible.
 */
function assert_shown(id, visible) {
  Assert.notEqual(
    aboutMessage.document.getElementById(id).hidden,
    visible,
    `"${id}" should be ${visible ? "visible" : "hidden"}`
  );
}

/**
 * Ensure that the specified element is enabled/disabled
 *
 * @param {string} id the id of the element to check
 * @param {boolean} enabled true if the element should be enabled.
 */
function assert_enabled(id, enabled) {
  Assert.notEqual(
    aboutMessage.document.getElementById(id).disabled,
    enabled,
    `"${id}" should be ${enabled ? "enabled" : "disabled"}`
  );
}

/**
 * Check that the menu states in the "save" toolbar button are correct.
 *
 * @param {object} expected - A dictionary containing the expected states.
 */
async function check_toolbar_menu_states_single(expected) {
  assert_shown("attachmentSaveAllSingle", true);
  assert_shown("attachmentSaveAllMultiple", false);

  if (expected.save === false) {
    assert_enabled("attachmentSaveAllSingle", false);
  } else {
    assert_enabled("attachmentSaveAllSingle", true);
    const dm = aboutMessage.document.querySelector(
      "#attachmentSaveAllSingle .toolbarbutton-menubutton-dropmarker"
    );
    EventUtils.synthesizeMouseAtCenter(dm, { clickCount: 1 }, aboutMessage);
    await BrowserTestUtils.waitForPopupEvent(
      aboutMessage.document.getElementById("attachmentSaveAllSingleMenu"),
      "shown"
    );

    try {
      assert_enabled("button-openAttachment", expected.open);
      assert_enabled("button-saveAttachment", expected.save);
      assert_enabled("button-detachAttachment", expected.detach);
      assert_enabled("button-deleteAttachment", expected.delete_);
    } finally {
      await close_popup(
        aboutMessage,
        aboutMessage.document.getElementById("attachmentSaveAllSingleMenu")
      );
    }
  }
}

/**
 * Check that the menu states in the "save all" toolbar button are correct.
 *
 * @param {object} expected - A dictionary containing the expected states.
 */
async function check_toolbar_menu_states_multiple(expected) {
  assert_shown("attachmentSaveAllSingle", false);
  assert_shown("attachmentSaveAllMultiple", true);

  if (expected.save === false) {
    assert_enabled("attachmentSaveAllMultiple", false);
  } else {
    assert_enabled("attachmentSaveAllMultiple", true);
    const dm = aboutMessage.document.querySelector(
      "#attachmentSaveAllMultiple .toolbarbutton-menubutton-dropmarker"
    );
    EventUtils.synthesizeMouseAtCenter(dm, { clickCount: 1 }, aboutMessage);
    await BrowserTestUtils.waitForPopupEvent(
      aboutMessage.document.getElementById("attachmentSaveAllMultipleMenu"),
      "shown"
    );

    try {
      assert_enabled("button-openAllAttachments", expected.open);
      assert_enabled("button-saveAllAttachments", expected.save);
      assert_enabled("button-detachAllAttachments", expected.detach);
      assert_enabled("button-deleteAllAttachments", expected.delete_);
    } finally {
      await close_popup(
        window,
        aboutMessage.document.getElementById("attachmentSaveAllMultipleMenu")
      );
    }
  }
}

/**
 * Check that the menu states in the single item context menu are correct
 *
 * @param {integer} index - Index of the attachment in the attachmentList.
 * @param {object} expected - A dictionary containing the expected states.
 */
async function check_menu_states_single(index, expected) {
  const attachmentList = aboutMessage.document.getElementById("attachmentList");
  const node = attachmentList.getItemAtIndex(index);
  Assert.ok(!!node, `Attachment at index ${index} should exist`);

  const contextMenu = aboutMessage.document.getElementById(
    "attachmentItemContext"
  );
  const shownPromise = BrowserTestUtils.waitForEvent(contextMenu, "popupshown");
  attachmentList.selectItem(node);
  EventUtils.synthesizeMouseAtCenter(
    node,
    { type: "contextmenu" },
    aboutMessage
  );
  await shownPromise;

  try {
    assert_shown("context-openAttachment", true);
    assert_shown("context-saveAttachment", true);
    assert_shown("context-menu-separator", true);
    assert_shown("context-detachAttachment", true);
    assert_shown("context-deleteAttachment", true);

    assert_enabled("context-openAttachment", expected.open);
    assert_enabled("context-saveAttachment", expected.save);
    assert_enabled("context-detachAttachment", expected.detach);
    assert_enabled("context-deleteAttachment", expected.delete_);
  } finally {
    const hiddenPromise = BrowserTestUtils.waitForEvent(
      contextMenu,
      "popuphidden"
    );
    contextMenu.hidePopup();
    await hiddenPromise;
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

/**
 * Check that the menu states in the all items context menu are correct
 *
 * @param {object} expected - A dictionary containing the expected states.
 */
async function check_menu_states_all(expected) {
  // Using a rightClick here is unsafe, because we need to hit the empty area
  // beside the attachment items and that seems to be different per platform.
  // Using DOM methods to open the popup works fine.
  const contextMenu = aboutMessage.document.getElementById(
    "attachmentListContext"
  );
  const shownPromise = BrowserTestUtils.waitForEvent(contextMenu, "popupshown");
  aboutMessage.document
    .getElementById("attachmentListContext")
    .openPopup(aboutMessage.document.getElementById("attachmentList"));
  await shownPromise;

  try {
    assert_shown("context-openAllAttachments", true);
    assert_shown("context-saveAllAttachments", true);
    assert_shown("context-menu-separator-all", true);
    assert_shown("context-detachAllAttachments", true);
    assert_shown("context-deleteAllAttachments", true);

    assert_enabled("context-openAllAttachments", expected.open);
    assert_enabled("context-saveAllAttachments", expected.save);
    assert_enabled("context-detachAllAttachments", expected.detach);
    assert_enabled("context-deleteAllAttachments", expected.delete_);
  } finally {
    await close_popup(
      aboutMessage,
      aboutMessage.document.getElementById("attachmentListContext")
    );
  }
}

async function help_test_attachment_menus(index) {
  await be_in_folder(folder);
  await select_click_row(index);
  const expectedStates = messages[index].menuStates;

  aboutMessage.toggleAttachmentList(true);

  for (const attachment of aboutMessage.currentAttachments) {
    // Ensure all attachments are resolved; other than external they already
    // should be.
    await attachment.isEmpty();
  }

  if (expectedStates.length == 1) {
    await check_toolbar_menu_states_single(messages[index].allMenuStates);
  } else {
    await check_toolbar_menu_states_multiple(messages[index].allMenuStates);
  }

  await check_menu_states_all(messages[index].allMenuStates);
  for (let i = 0; i < expectedStates.length; i++) {
    await check_menu_states_single(i, expectedStates[i]);
  }
}

// Generate a test for each message in |messages|.
for (let i = 0; i < messages.length; i++) {
  add_task(function () {
    return help_test_attachment_menus(i);
  });
}

/**
 * Tests that the detach and delete attachment menu items are disabled for .eml
 * files.
 */
add_task(async function test_attachment_menus_eml_file() {
  const file = new FileUtils.File(
    getTestFilePath("data/multiple_attachments.eml")
  );
  const msgc = await open_message_from_file(file);
  aboutMessage = get_about_message(msgc);

  aboutMessage.toggleAttachmentList(true);
  const menuStates = { open: true, save: true, detach: false, delete_: false };
  await check_toolbar_menu_states_multiple(menuStates);
  await check_menu_states_all(menuStates);
  await check_menu_states_single(0, menuStates);
  await check_menu_states_single(1, menuStates);

  await BrowserTestUtils.closeWindow(msgc);
});

add_task(() => {
  Assert.report(
    false,
    undefined,
    undefined,
    "Test ran to completion successfully"
  );
});

registerCleanupFunction(() => {
  // Remove created folders.
  folder.deleteSelf(null);
});
