/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that nsSuiteGlue correctly restores bookmarks from a JSON backup if
 * database is corrupt and one backup is available.
 */

var {XPCOMUtils} = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "bs",
                                   "@mozilla.org/browser/nav-bookmarks-service;1",
                                   "nsINavBookmarksService");
XPCOMUtils.defineLazyServiceGetter(this, "anno",
                                   "@mozilla.org/browser/annotation-service;1",
                                   "nsIAnnotationService");

var bookmarksObserver = {
  onBeginUpdateBatch: function() {},
  onEndUpdateBatch: function() {
    let itemId = bs.getIdForItemAt(bs.toolbarFolder, 0);
    Assert.notEqual(itemId, -1);
    if (anno.itemHasAnnotation(itemId, "Places/SmartBookmark"))
      continue_test();
  },
  onItemAdded: function() {},
  onItemRemoved: function(id, folder, index, itemType) {},
  onItemChanged: function() {},
  onItemVisited: function(id, visitID, time) {},
  onItemMoved: function() {},
  QueryInterface: ChromeUtils.generateQI([Ci.nsINavBookmarkObserver])
};

function run_test() {
  do_test_pending();

  // Create our bookmarks.html copying bookmarks.glue.html to the profile
  // folder.  It should be ignored.
  create_bookmarks_html("bookmarks.glue.html");

  // Create our JSON backup copying bookmarks.glue.json to the profile folder.
  create_JSON_backup("bookmarks.glue.json");

  // Remove current database file.
  let db = gProfD.clone();
  db.append("places.sqlite");
  if (db.exists()) {
    db.remove(false);
    Assert.ok(!db.exists());
  }
  // Create a corrupt database.
  let corruptDB = gTestDir.clone();
  corruptDB.append("corruptDB.sqlite");
  corruptDB.copyTo(gProfD, "places.sqlite");
  Assert.ok(db.exists());

  // Initialize nsSuiteGlue before Places.
  Cc["@mozilla.org/suite/suiteglue;1"].getService(Ci.nsISuiteGlue);

  // Initialize Places through the History Service.
  let hs = Cc["@mozilla.org/browser/nav-history-service;1"].
           getService(Ci.nsINavHistoryService);
  // Check the database was corrupt.
  // nsSuiteGlue uses databaseStatus to manage initialization.
  Assert.equal(hs.databaseStatus, hs.DATABASE_STATUS_CORRUPT);

  // The test will continue once restore has finished and smart bookmarks
  // have been created.
  bs.addObserver(bookmarksObserver);
}

function continue_test() {
  // Check that JSON backup has been restored.
  // Notice restore from JSON notification is fired before smart bookmarks creation.
  let itemId = bs.getIdForItemAt(bs.toolbarFolder, SMART_BOOKMARKS_ON_TOOLBAR);
  Assert.equal(bs.getItemTitle(itemId), "examplejson");

  remove_bookmarks_html();
  remove_all_JSON_backups();

  do_test_finished();
}
