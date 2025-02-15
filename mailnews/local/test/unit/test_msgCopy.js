/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Test of setting keywords with copyFileMessage

var bugmail11 = do_get_file("../../../data/bugmail11");

// main test

// tag used with test messages
var tag1 = "istag";

function run_test() {
  do_test_pending();
  copyFileMessageInLocalFolder(bugmail11, 0, tag1, null, test_keywords);
}

function test_keywords(aMessageHeaderKeys) {
  const headerKeys = aMessageHeaderKeys;
  Assert.notEqual(headerKeys, null);
  const copiedMessage = localAccountUtils.inboxFolder.GetMessageHeader(
    headerKeys[0]
  );
  Assert.equal(copiedMessage.getStringProperty("keywords"), tag1);
  do_test_finished();
}
