/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

import {
  MailViewConstants,
  MailViewManager,
} from "resource:///modules/MailViewManager.sys.mjs";
import { SearchSpec } from "resource:///modules/SearchSpec.sys.mjs";
import { ThreadPaneColumns } from "chrome://messenger/content/ThreadPaneColumns.mjs";
import { FolderUtils } from "resource:///modules/FolderUtils.sys.mjs";

import { VirtualFolderHelper } from "resource:///modules/VirtualFolderWrapper.sys.mjs";

var MSG_VIEW_FLAG_DUMMY = 0x20000000;

var nsMsgViewIndex_None = 0xffffffff;

function getSortStatusFromView(dbView) {
  const primarySort = [
    dbView.sortType,
    dbView.sortOrder,
    dbView.curCustomColumn,
  ];
  const secondarySort = [
    dbView.secondarySortType,
    dbView.secondarySortOrder,
    dbView.secondaryCustomColumn,
  ];
  // Ignore secondary sort, if it is for the same column, or byNone.
  if (
    secondarySort[0] == Ci.nsMsgViewSortType.byNone ||
    (secondarySort[0] != Ci.nsMsgViewSortType.byCustom &&
      secondarySort[0] == primarySort[0]) ||
    (secondarySort[0] == Ci.nsMsgViewSortType.byCustom &&
      secondarySort[2] == primarySort[2]) ||
    dbView.viewFlags & Ci.nsMsgViewFlagsType.kGroupBySort
  ) {
    return [primarySort];
  }
  return [primarySort, secondarySort];
}

/**
 * Helper singleton for DBViewWrapper that tells instances when something
 *  interesting is happening to the folder(s) they care about.  The rationale
 *  for this is to:
 * - reduce listener overhead (although arguably the events we listen to are
 *     fairly rare)
 * - make testing / verification easier by centralizing and exposing listeners.
 *
 */
var FolderNotificationHelper = {
  /**
   * Maps URIs of pending folder loads to the DBViewWrapper instances that
   *  are waiting on the loads.  The value is a list of instances in case
   *  a quick-clicking user is able to do something unexpected.
   */
  _pendingFolderUriToViewWrapperLists: {},

  /**
   * Map URIs of folders to view wrappers interested in hearing about their
   *  deletion.
   */
  _interestedWrappers: {},

  /**
   * Array of wrappers that are interested in all folders, used for
   * search results wrappers.
   */
  _curiousWrappers: [],

  /**
   * Initialize our listeners.  We currently don't bother cleaning these up
   *  because we are a singleton and if anyone imports us, they probably want
   *  us for as long as their application so shall live.
   */
  _init() {
    // register with the session for our folded loaded notifications
    MailServices.mailSession.AddFolderListener(
      this,
      Ci.nsIFolderListener.event | Ci.nsIFolderListener.intPropertyChanged
    );

    // register with the notification service for deleted folder notifications
    MailServices.mfn.addListener(
      this,
      Ci.nsIMsgFolderNotificationService.folderDeleted |
        // we need to track renames because we key off of URIs. frick.
        Ci.nsIMsgFolderNotificationService.folderRenamed |
        Ci.nsIMsgFolderNotificationService.folderMoveCopyCompleted |
        Ci.nsIMsgFolderNotificationService.folderReindexTriggered
    );
  },

  /**
   * Call updateFolder, and assuming all goes well, request that the provided
   *  FolderDisplayWidget be notified when the folder is loaded.  This method
   *  performs the updateFolder call for you so there is less chance of leaking.
   * In the event the updateFolder call fails, we will propagate the exception.
   */
  updateFolderAndNotifyOnLoad(aFolder, aFolderDisplay, aMsgWindow) {
    // set up our datastructure first in case of wacky event sequences
    const folderURI = aFolder.URI;
    let wrappers = this._pendingFolderUriToViewWrapperLists[folderURI];
    if (wrappers == null) {
      wrappers = this._pendingFolderUriToViewWrapperLists[folderURI] = [];
    }
    wrappers.push(aFolderDisplay);
    try {
      aFolder.updateFolder(aMsgWindow);
    } catch (ex) {
      console.warn(`Update folder ${folderURI} failed.`, ex);
      // uh-oh, that didn't work.  tear down the data structure...
      wrappers.pop();
      if (wrappers.length == 0) {
        delete this._pendingFolderUriToViewWrapperLists[folderURI];
      }
      throw ex;
    }
  },

  /**
   * Request notification of every little thing these folders do.
   *
   * @param {nsIMsgFolder[]} aFolders - The folders.
   * @param {nsIMsgFolder} aNotherFolder - A folder that may or may not be in aFolders.
   * @param {DBViewWrapper} aViewWrapper - The view wrapper that is up to no good.
   */
  stalkFolders(aFolders, aNotherFolder, aViewWrapper) {
    const folders = aFolders ? aFolders.concat() : [];
    if (aNotherFolder && !folders.includes(aNotherFolder)) {
      folders.push(aNotherFolder);
    }
    for (const folder of folders) {
      let wrappers = this._interestedWrappers[folder.URI];
      if (wrappers == null) {
        wrappers = this._interestedWrappers[folder.URI] = [];
      }
      wrappers.push(aViewWrapper);
    }
  },

  /**
   * Request notification of every little thing every folder does.
   *
   * @param {DBViewWrapper} aViewWrapper - The viewWrapper interested in every
   *   notification. This will be a search results view of some sort.
   */
  noteCuriosity(aViewWrapper) {
    this._curiousWrappers.push(aViewWrapper);
  },

  /**
   * Removal helper for use by removeNotifications.
   *
   * @param {object} aTable - The table mapping URIs to list of view wrappers.
   * @param {nsIMsgFolder} aFolder - The folder we care about.
   * @param {DBViewWrapper} aViewWrapper - The view wrapper of interest.
   */
  _removeWrapperFromListener(aTable, aFolder, aViewWrapper) {
    const wrappers = aTable[aFolder.URI];
    if (wrappers) {
      const index = wrappers.indexOf(aViewWrapper);
      if (index >= 0) {
        wrappers.splice(index, 1);
      }
      if (wrappers.length == 0) {
        delete aTable[aFolder.URI];
      }
    }
  },
  /**
   * Remove notification requests on the provided folders by the given view
   *  wrapper.
   *
   * @param {nsIMsgFolder[]} aFolders - Folders.
   * @param {DBViewWrapper} aViewWrapper - Wrapper.
   */
  removeNotifications(aFolders, aViewWrapper) {
    if (!aFolders) {
      this._curiousWrappers.splice(
        this._curiousWrappers.indexOf(aViewWrapper),
        1
      );
      return;
    }
    for (const folder of aFolders) {
      this._removeWrapperFromListener(
        this._interestedWrappers,
        folder,
        aViewWrapper
      );
      this._removeWrapperFromListener(
        this._pendingFolderUriToViewWrapperLists,
        folder,
        aViewWrapper
      );
    }
  },

  /**
   * @returns {boolean} true if there are any listeners still registered.
   *   This is intended to support debugging code. If you are not debug code,
   *   you are a bad person/code.
   */
  haveListeners() {
    if (Object.keys(this._pendingFolderUriToViewWrapperLists).length > 0) {
      return true;
    }
    if (Object.keys(this._interestedWrappers).length > 0) {
      return true;
    }
    return this._curiousWrappers.length != 0;
  },

  /* ***** Notifications ***** */
  _notifyHelper(aFolder, aHandlerName) {
    const wrappers = this._interestedWrappers[aFolder.URI];
    if (wrappers) {
      // clone the list to avoid confusing mutation by listeners
      for (const wrapper of wrappers.concat()) {
        wrapper[aHandlerName](aFolder);
      }
    }
    for (const wrapper of this._curiousWrappers) {
      wrapper[aHandlerName](aFolder);
    }
  },

  /**
   * @param {nsIMsgFolder} aFolder - The folder that the event is for.
   * @param {string} aEvent - The event: "FolderLoaded", "AboutToCompact",
   *   "CompactCompleted", "DeleteOrMoveMsgCompleted", "DeleteOrMoveMsgFailed",
   *   "RenameCompleted" are handled.
   */
  onFolderEvent(aFolder, aEvent) {
    if (aEvent == "FolderLoaded") {
      const folderURI = aFolder.URI;
      const widgets = this._pendingFolderUriToViewWrapperLists[folderURI];
      if (widgets) {
        for (const widget of widgets) {
          // we are friends, this is an explicit relationship.
          // (we don't use a generic callback mechanism because the 'this' stuff
          //  gets ugly and no one else should be hooking in at this level.)
          try {
            widget._folderLoaded(aFolder);
          } catch (ex) {
            console.error(`_folderLoaded for ${folderURI} failed.`, ex);
          }
        }
        delete this._pendingFolderUriToViewWrapperLists[folderURI];
      }
    } else if (aEvent == "AboutToCompact") {
      this._notifyHelper(aFolder, "_aboutToCompactFolder");
    } else if (aEvent == "CompactCompleted") {
      this._notifyHelper(aFolder, "_compactedFolder");
    } else if (aEvent == "DeleteOrMoveMsgCompleted") {
      this._notifyHelper(aFolder, "_deleteCompleted");
    } else if (aEvent == "DeleteOrMoveMsgFailed") {
      this._notifyHelper(aFolder, "_deleteFailed");
    } else if (aEvent == "RenameCompleted") {
      this._notifyHelper(aFolder, "_renameCompleted");
    }
  },

  /**
   * @param {nsIMsgFolder} aFolder - The folder.
   * @param {string} aProperty - The property.
   */
  onFolderIntPropertyChanged(aFolder, aProperty) {
    if (aProperty == "TotalMessages" || aProperty == "TotalUnreadMessages") {
      this._notifyHelper(aFolder, "_messageCountsChanged");
    }
  },

  /**
   * @param {nsIMsgFolder} aOldFolder - The old folder.
   * @param {nsIMsgFolder} aNewFolder - The new folder.
   */
  _folderMoveHelper(aOldFolder, aNewFolder) {
    const oldURI = aOldFolder.URI;
    const newURI = aNewFolder.URI;
    // fix up our listener tables.
    if (oldURI in this._pendingFolderUriToViewWrapperLists) {
      this._pendingFolderUriToViewWrapperLists[newURI] =
        this._pendingFolderUriToViewWrapperLists[oldURI];
      delete this._pendingFolderUriToViewWrapperLists[oldURI];
    }
    if (oldURI in this._interestedWrappers) {
      this._interestedWrappers[newURI] = this._interestedWrappers[oldURI];
      delete this._interestedWrappers[oldURI];
    }

    const wrappers = this._interestedWrappers[newURI];
    if (wrappers) {
      // clone the list to avoid confusing mutation by listeners
      for (const wrapper of wrappers.concat()) {
        wrapper._folderMoved(aOldFolder, aNewFolder);
      }
    }
  },

  /**
   * Update our URI mapping tables when renames happen.
   */
  folderRenamed(aOrigFolder, aNewFolder) {
    this._folderMoveHelper(aOrigFolder, aNewFolder);
  },

  folderMoveCopyCompleted(aMove, aSrcFolder, aDestFolder) {
    if (aMove) {
      const aNewFolder = aDestFolder.getChildNamed(aSrcFolder.name);
      this._folderMoveHelper(aSrcFolder, aNewFolder);
    }
  },

  /**
   * @param {nsIMsgFolder} aFolder - The folder.
   */
  folderDeleted(aFolder) {
    const wrappers = this._interestedWrappers[aFolder.URI];
    if (wrappers) {
      // clone the list to avoid confusing mutation by listeners
      for (const wrapper of wrappers.concat()) {
        wrapper._folderDeleted(aFolder);
      }
      // if the folder is deleted, it's not going to ever do anything again
      delete this._interestedWrappers[aFolder.URI];
    }
  },

  /**
   * This notification is received when a folder is about to be reindexed. We
   * use the same mechanism for refreshing the view of the affected wrappers as
   * we do when folders are being compacted.
   *
   * @param {nsIMsgFolder} aFolder - The folder being reindexed.
   */
  folderReindexTriggered(aFolder) {
    if (aFolder.server.type == "imap") {
      return;
    }

    const wrappers = this._interestedWrappers[aFolder.URI];
    if (wrappers) {
      for (const wrapper of wrappers) {
        wrapper._aboutToCompactFolder(aFolder);
      }
      const folderListener = {
        onFolderEvent(aEventFolder, aEvent) {
          if (aEvent == "FolderLoaded" && aEventFolder.URI == aFolder.URI) {
            MailServices.mailSession.RemoveFolderListener(this);
            for (const wrapper of wrappers) {
              wrapper.refresh();
            }
          }
        },
      };
      MailServices.mailSession.AddFolderListener(
        folderListener,
        Ci.nsIFolderListener.event
      );
    }
  },
};
FolderNotificationHelper._init();

/**
 * Defines the DBViewWrapper listener interface.  This class exists exclusively
 *  for documentation purposes and should never be instantiated.
 */
export function IDBViewWrapperListener() {}

IDBViewWrapperListener.prototype = {
  // uh, this is secretly exposed for debug purposes.  DO NOT LOOK AT ME!
  _FNH: FolderNotificationHelper,

  /* ===== Exposure of UI Globals ===== */
  messenger: null,
  msgWindow: null,
  threadPaneCommandUpdater: null,

  /* ===== Guidance ===== */
  /**
   * Indicate whether mail view settings should be used/honored.  A UI oddity
   *  is that we only have mail views be sticky if its combo box UI is visible.
   *  (Without the view combobox, it may not be obvious that the mail is
   *  filtered.)
   */
  get shouldUseMailViews() {
    return false;
  },

  /**
   * Should we defer displaying the messages in this folder until after we have
   *  talked to the server?  This is for our poor man's password protection
   *  via the "mail.password_protect_local_cache" pref.  We add this specific
   *  check rather than internalizing the logic in the wrapper because the
   *  password protection is a shoddy UI-only protection.
   */
  get shouldDeferMessageDisplayUntilAfterServerConnect() {
    return false;
  },

  /* ===== Event Notifications ===== */
  /* === Status Changes === */
  /**
   * We tell you when we start and stop loading the folder.  This is a good
   *  time to mess with the hour-glass cursor machinery if you are inclined to
   *  do so.
   */
  onFolderLoading() {},

  /**
   * We tell you when we start and stop searching.  This is a good time to mess
   *  with progress spinners (meteors) and the like, if you are so inclined.
   */
  onSearching() {},

  /**
   * This event is generated when a new view has been created.  It is intended
   *  to be used to provide the MsgCreateDBView notification so that custom
   *  columns can add themselves to the view.
   * The notification is not generated by the DBViewWrapper itself because this
   *  is fundamentally a UI issue.  Additionally, because the MsgCreateDBView
   *  notification consumers assume gDBView whose exposure is affected by tabs,
   *  the tab logic needs to be involved.
   */
  onCreatedView() {},

  /**
   * This event is generated just before we close/destroy a message view.
   *
   * @param {boolean} _aFolderIsComingBack - Indicates whether we are planning
   *  to create a new view to display the same folder after we destroy this view.
   *  This will be the case unless we are switching to display a new folder or
   *  closing the view wrapper entirely.
   */
  onDestroyingView(_aFolderIsComingBack) {},

  /**
   * Generated when we are loading information about the folder from its
   *  dbFolderInfo.  The dbFolderInfo object is passed in.
   * The DBViewWrapper has already restored its state when this function is
   *  called, but has not yet created the dbView.  A view update is in process,
   *  so the view settings can be changed and will take effect when the update
   *  is closed.
   * |onDisplayingFolder| is the next expected notification following this
   *  notification.
   */
  onLoadingFolder() {},

  /**
   * Generated when the folder is being entered for display.  This is the chance
   *  for the listener to affect any UI-related changes to the folder required.
   *  Currently, this just means setting the header cache size (which needs to
   *  be proportional to the number of lines in the tree view, and is thus a
   *  UI issue.)
   * The dbView has already been created and is valid when this function is
   *  called.
   * |onLoadingFolder| is called before this notification.
   */
  onDisplayingFolder() {},

  /**
   * Generated when we are leaving a folder.
   */
  onLeavingFolder() {},

  /**
   * Things to do once all the messages that should show up in a folder have
   *  shown up.  For a real folder, this happens when the folder is entered.
   *  For a (multi-folder) virtual folder, this happens when the search
   *  completes.
   * You may get onMessagesLoaded called with aAll false immediately after
   * the view is opened. You will definitely get onMessagesLoaded(true)
   * when we've finished getting the headers for the view.
   */
  onMessagesLoaded() {},

  /**
   * The mail view changed.  The mail view widget is likely to care about this.
   */
  onMailViewChanged() {},

  /**
   * The active sort changed, and that is all that changed.  If the sort is
   *  changing because the view is being destroyed and re-created, this event
   *  will not be generated.
   */
  onSortChanged() {},

  /**
   * This event is generated when messages in one of the folders backing the
   *  view have been removed by message moves / deletion.  If there is a search
   *  in effect, it is possible that the removed messages were not visible in
   *  the view in the first place.
   */
  onMessagesRemoved() {},

  /**
   * Like onMessagesRemoved, but something went awry in the move/deletion and
   *  it failed.  Although this is not a very interesting event on its own,
   *  it is useful in cases where the listener was expecting an
   *  onMessagesRemoved and might need to clean some state up.
   */
  onMessageRemovalFailed() {},

  /**
   * The total message count or total unread message counts changed.
   */
  onMessageCountsChanged() {},
};

/**
 * Encapsulates everything related to working with our nsIMsgDBView
 *  implementations.
 *
 * Things we do not do and why we do not do them:
 * - Selection.  This depends on having an nsITreeSelection object and we choose
 *   to avoid entanglement with XUL/layout code.  Selection accordingly must be
 *   handled a layer up in the FolderDisplayWidget.
 */
export function DBViewWrapper(aListener) {
  this.displayedFolder = null;
  this.listener = aListener;

  this._underlyingData = this.kUnderlyingNone;
  this._underlyingFolders = null;
  this._syntheticView = null;

  this._viewUpdateDepth = 0;

  this._mailViewIndex = MailViewConstants.kViewItemAll;
  this._mailViewData = null;

  this._specialView = null;

  this._sort = [];
  // see the _viewFlags getter and setter for info on our use of __viewFlags.
  this.__viewFlags = null;

  /**
   * It's possible to support grouped view thread expand/collapse, and also sort
   * by thread despite the back end (see nsMsgQuickSearchDBView::SortThreads).
   * Also, nsMsgQuickSearchDBView does not respect the kExpandAll flag, fix that.
   */
  this._threadExpandAll = true;

  this.dbView = null;
  this.search = null;

  this._folderLoading = false;
  this._searching = false;
}

DBViewWrapper.prototype = {
  /* = constants explaining the nature of the underlying data = */
  /**
   * We currently don't have any underlying data.
   */
  kUnderlyingNone: 0,
  /**
   * The underlying data source is a single folder.
   */
  kUnderlyingRealFolder: 1,
  /**
   * The underlying data source is a virtual folder that is operating over
   *  multiple underlying folders.
   */
  kUnderlyingMultipleFolder: 2,
  /**
   * Our data source is transient, most likely a gloda search that crammed the
   *  results into us.  This is different from a search view.
   */
  kUnderlyingSynthetic: 3,
  /**
   * We are a search view, which translates into a search that has underlying
   *  folders, just like kUnderlyingMultipleFolder, but we have no
   *  displayedFolder.  We differ from kUnderlyingSynthetic in that we are
   *  not just a bunch of message headers randomly crammed in.
   */
  kUnderlyingSearchView: 4,

  /**
   * Returns the sortType of the column assoziated with the given columnId.
   *
   * @param {string} columnId
   * @returns {nsMsgViewSortType|undefined} the sort type as defined by Ci.nsMsgViewSortType, if any
   */
  getSortType(columnId) {
    const column = ThreadPaneColumns.getDefaultColumns().find(
      c => c.sortKey && c.id == columnId
    );
    if (column) {
      return Ci.nsMsgViewSortType[column.sortKey];
    }
    return undefined;
  },

  /**
   * @returns {boolean} true if the folder being displayed is backed by a
   *   single 'real'folder. This folder can be a saved search on that folder or
   *   just an outright un-filtered display of that folder.
   */
  get isSingleFolder() {
    return this._underlyingData == this.kUnderlyingRealFolder;
  },

  /**
   * @returns {boolean} true if the folder being displayed is a virtual folder
   *   backed by multiple 'real' folders or a search view. This corresponds to a
   *   cross-folder saved search.
   */
  get isMultiFolder() {
    return (
      this._underlyingData == this.kUnderlyingMultipleFolder ||
      this._underlyingData == this.kUnderlyingSearchView
    );
  },

  /**
   * @returns {boolean} true if the folder being displayed is not a real folder
   *   at all, but rather the result of an un-scoped search, such as a gloda search.
   */
  get isSynthetic() {
    return this._underlyingData == this.kUnderlyingSynthetic;
  },

  /**
   * @returns {boolean} true if the folder being displayed is not a real folder
   *   at all, but rather the result of a search.
   */
  get isSearch() {
    return this._underlyingData == this.kUnderlyingSearchView;
  },

  /**
   * Check if the folder in question backs the currently displayed folder.  For
   *  a virtual folder, this is a test of whether the virtual folder includes
   *  messages from the given folder.  For a 'real' single folder, this is
   *  effectively a test against displayedFolder.
   * If you want to see if the displayed folder is a folder, just compare
   *  against the displayedFolder attribute.
   *
   * @returns {boolean} true is the given folder is an underlying folder.
   */
  isUnderlyingFolder(aFolder) {
    return this._underlyingFolders.some(
      underlyingFolder => aFolder == underlyingFolder
    );
  },

  /**
   * Refresh the view by re-creating the view.  You would do this to get rid of
   *  messages that no longer match the view but are kept around for view
   *  stability reasons.  (In other words, in an unread-messages view, you would
   *  go insane if when you clicked on a message it immediately disappeared
   *  because it no longer matched.)
   * This method was adding for testing purposes and does not have a (legacy) UI
   *  reason for existing.  (The 'open' method is intended to behave identically
   *  to the legacy UI if you click on the currently displayed folder.)
   */
  refresh() {
    this._applyViewChanges();
  },

  /**
   * Null out the folder's database to avoid memory bloat if we don't have a
   *  reason to keep the database around.  Currently, we keep all Inboxes
   *  around and null out everyone else.  This is a standard stopgap measure
   *  until we have something more clever going on.
   * In general, there is little potential downside to nulling out the message
   *  database reference when it is in use.  As long as someone is holding onto
   *  a message header from the database, the database will be kept open, and
   *  therefore the database service will still have a reference to the db.
   *  When the folder goes to ask for the database again, the service will have
   *  it, and it will not need to be re-opened.
   *
   * Note: regrettably a unit test cannot verify that we did this; msgDatabase
   *  is a getter that will always try and load the message database!
   */
  _releaseFolderDatabase(aFolder) {
    if (
      !aFolder.isSpecialFolder(Ci.nsMsgFolderFlags.Inbox, false) &&
      aFolder.databaseOpen &&
      aFolder.msgDatabase.databaseSize <
        Services.prefs.getIntPref("mail.db.keep_open_size")
    ) {
      aFolder.msgDatabase = null;
    }
  },

  /**
   * Clone this DBViewWrapper and its underlying nsIMsgDBView.
   *
   * @param {IDBViewWrapperListener} aListener -The listener to use on the new view.
   */
  clone(aListener) {
    const doppel = new DBViewWrapper(aListener);

    // -- copy attributes
    doppel.displayedFolder = this.displayedFolder;
    doppel._underlyingData = this._underlyingData;
    doppel._underlyingFolders = this._underlyingFolders
      ? this._underlyingFolders.concat()
      : null;
    doppel._syntheticView = this._syntheticView;

    // _viewUpdateDepth should stay at its initial value of zero
    doppel._mailViewIndex = this._mailViewIndex;
    doppel._mailViewData = this._mailViewData;

    doppel._specialView = this._specialView;
    // a shallow copy is all that is required for sort; we do not mutate entries
    doppel._sort = this._sort.concat();

    // -- register listeners...
    // note: this does not get us a folder loaded notification.  Our expected
    //  use case for cloning is displaying a single message already visible in
    //  the original view, which implies we don't need to hang about for folder
    //  loaded notification messages.
    FolderNotificationHelper.stalkFolders(
      doppel._underlyingFolders,
      doppel.displayedFolder,
      doppel
    );

    // -- clone the view
    if (this.dbView) {
      doppel.dbView = this.dbView
        .cloneDBView(
          aListener.messenger,
          aListener.msgWindow,
          aListener.threadPaneCommandUpdater
        )
        .QueryInterface(Ci.nsITreeView);
    }
    // -- clone the search
    if (this.search) {
      doppel.search = this.search.clone(doppel);
    }

    if (
      doppel._underlyingData == this.kUnderlyingSearchView ||
      doppel._underlyingData == this.kUnderlyingSynthetic
    ) {
      FolderNotificationHelper.noteCuriosity(doppel);
    }

    return doppel;
  },

  /**
   * Close the current view.  You would only do this if you want to clean up all
   *  the resources associated with this view wrapper.  You would not do this
   *  for UI reasons like the user de-selecting the node in the tree; we should
   *  always be displaying something when used in a UI context!
   *
   * @param {boolean} folderIsDead - If true, tells us not to try and tidy up
   *   on our way out by virtue of the fact that the folder is dead and should
   *   not be messed with.
   */
  close(folderIsDead) {
    if (this.displayedFolder != null) {
      // onLeavingFolder does all the application-level stuff related to leaving
      //  the folder (marking as read, etc.)  We only do this when the folder
      //  is not dead (for obvious reasons).
      if (!folderIsDead) {
        // onLeavingFolder must be called before we potentially null out its
        //  msgDatabase, which we will do in the upcoming underlyingFolders loop
        this.onLeavingFolder(); // application logic
        this.listener.onLeavingFolder(); // display logic
      }
      // (potentially) zero out the display folder if we are dealing with a
      //  virtual folder and so the next loop won't take care of it.
      if (this.isVirtual) {
        FolderNotificationHelper.removeNotifications(
          [this.displayedFolder],
          this
        );
        this._releaseFolderDatabase(this.displayedFolder);
      }

      this.folderLoading = false;
      this.displayedFolder = null;
    }

    FolderNotificationHelper.removeNotifications(this._underlyingFolders, this);
    if (this.isSearch || this.isSynthetic) {
      // Opposite of FolderNotificationHelper.noteCuriosity(this)
      FolderNotificationHelper.removeNotifications(null, this);
    }

    if (this._underlyingFolders) {
      // (potentially) zero out the underlying msgDatabase references
      for (const folder of this._underlyingFolders) {
        this._releaseFolderDatabase(folder);
      }
    }

    // kill off the view and its search association
    if (this.dbView) {
      this.search.dissociateView(this.dbView);
      this.dbView.setTree(null);
      this.dbView.setJSTree(null);
      this.dbView.selection = null;
      this.dbView.close();
      this.listener.onDestroyingView(false);
      this.dbView = null;
    }

    // zero out the view update depth here.  We don't do it on open because it's
    //  theoretically be nice to be able to start a view update before you open
    //  something so you can defer the open.  In practice, that is not yet
    //  tested.
    this._viewUpdateDepth = 0;

    this._underlyingData = this.kUnderlyingNone;
    this._underlyingFolders = null;
    this._syntheticView = null;

    this._mailViewIndex = MailViewConstants.kViewItemAll;
    this._mailViewData = null;

    this._specialView = null;

    this._sort = [];
    this.__viewFlags = null;

    this.search = null;
  },

  /**
   * Open the passed-in nsIMsgFolder folder.  Use openSynthetic for synthetic
   *  view providers.
   */
  open(aFolder) {
    if (aFolder == null) {
      this.close();
      return;
    }

    // If we are in the same folder, there is nothing to do unless we are a
    //  virtual folder.  Virtual folders apparently want to try and get updated.
    if (this.displayedFolder == aFolder) {
      if (!this.isVirtual) {
        return;
      }
      // note: we intentionally (for consistency with old code, not that the
      //  code claimed to have a good reason) fall through here and call
      //  onLeavingFolder via close even though that's debatable in this case.
    }
    this.close();

    this.displayedFolder = aFolder;
    this._enteredFolder = false;

    this.search = new SearchSpec(this);
    this._sort = [];

    if (aFolder.isServer) {
      this._showServer();
      return;
    }

    const typeForTelemetry =
      [
        "Inbox",
        "Drafts",
        "Trash",
        "SentMail",
        "Templates",
        "Junk",
        "Archive",
        "Queue",
        "Virtual",
      ].find(x => aFolder.getFlag(Ci.nsMsgFolderFlags[x])) || "Other";
    Glean.mail.folderOpened[typeForTelemetry].add(1);

    this.beginViewUpdate();
    let msgDatabase;
    try {
      // This will throw an exception if the .msf file is missing,
      // out of date (e.g., the local folder has changed), or corrupted.
      msgDatabase = this.displayedFolder.msgDatabase;
    } catch (e) {}
    if (msgDatabase) {
      this._prepareToLoadView(msgDatabase, aFolder);
    }

    this.folderLoading = true;
    if (!this.isVirtual) {
      FolderNotificationHelper.updateFolderAndNotifyOnLoad(
        this.displayedFolder,
        this,
        this.listener.msgWindow
      );
    }

    // We do this after kicking off the update because this could initiate a
    // search which could fight our explicit updateFolderAndNotifyOnLoad call
    // if the search is already outstanding.
    // If folder loaded directly from the updateFolderAndNotifyOnLoad above
    // no need to enter it once again now.
    if (this.folderLoading && this.shouldShowMessagesForFolderImmediately()) {
      this._enterFolder();
    }
  },

  /**
   * Open a synthetic view provider as backing our view.
   */
  openSynthetic(aSyntheticView) {
    this.close();

    this._underlyingData = this.kUnderlyingSynthetic;
    this._syntheticView = aSyntheticView;

    this.search = new SearchSpec(this);
    this._sort = this._syntheticView.defaultSort.concat();

    this._threadExpandAll = Boolean(
      Services.prefs.getIntPref("mailnews.default_view_flags", 1) &
        Ci.nsMsgViewFlagsType.kExpandAll
    );

    this._applyViewChanges();
    FolderNotificationHelper.noteCuriosity(this);
    this.listener.onDisplayingFolder();
  },

  /**
   * Makes us irrevocavbly be a search view, for use in search windows.
   *  Once you call this, you are not allowed to use us for anything
   *  but a search view!
   * We add a 'searchFolders' property that allows you to control what
   *  folders we are searching over.
   */
  openSearchView() {
    this.close();

    this._underlyingData = this.kUnderlyingSearchView;
    this._underlyingFolders = [];

    const dis = this;
    this.__defineGetter__("searchFolders", function () {
      return dis._underlyingFolders;
    });
    this.__defineSetter__("searchFolders", function (aSearchFolders) {
      dis._underlyingFolders = aSearchFolders;
      dis._applyViewChanges();
    });

    this.search = new SearchSpec(this);
    // the search view uses the order in which messages are added as the
    //  order by default.
    this._sort = [
      [Ci.nsMsgViewSortType.byNone, Ci.nsMsgViewSortOrder.ascending],
    ];
    this.__viewFlags = Ci.nsMsgViewFlagsType.kNone;

    FolderNotificationHelper.noteCuriosity(this);
    this._applyViewChanges();
  },

  get folderLoading() {
    return this._folderLoading;
  },
  set folderLoading(aFolderLoading) {
    if (this._folderLoading == aFolderLoading) {
      return;
    }
    this._folderLoading = aFolderLoading;
    // tell the folder about what is going on so it can remove its db change
    //  listener and restore it, respectively.
    if (aFolderLoading) {
      this.displayedFolder.startFolderLoading();
    } else {
      this.displayedFolder.endFolderLoading();
    }
    this.listener.onFolderLoading(aFolderLoading);
  },

  get searching() {
    return this._searching;
  },
  set searching(aSearching) {
    if (aSearching == this._searching) {
      return;
    }
    this._searching = aSearching;
    this.listener.onSearching(aSearching);
    // notify that all messages are loaded if searching has concluded
    if (!aSearching) {
      this.listener.onMessagesLoaded(true);
    }
  },

  /**
   * Do we want to show the messages immediately, or should we wait for
   *  updateFolder to complete?  The historical heuristic is:
   * - Virtual folders get shown immediately (and updateFolder has no
   *   meaning for them anyways.)
   * - If _underlyingFolders == null, we failed to open the database,
   *   so we need to wait for UpdateFolder to reparse the folder (in the
   *   local folder case).
   * - Wait on updateFolder if our poor man's security via
   *   "mail.password_protect_local_cache" preference is enabled and the
   *   server requires a password to login.  This is accomplished by asking our
   *   listener via shouldDeferMessageDisplayUntilAfterServerConnect.  Note that
   *   there is an obvious hole in this logic because of the virtual folder case
   *   above.
   *
   * Note: this.folderDisplayed is the folder we are talking about.
   *
   * @returns {boolean} true if the folder should be shown immediately
   *   false if we should wait for updateFolder to complete.
   */
  shouldShowMessagesForFolderImmediately() {
    return (
      this.isVirtual ||
      !(
        this._underlyingFolders == null ||
        this.listener.shouldDeferMessageDisplayUntilAfterServerConnect
      )
    );
  },
  /**
   * Extract information about the view from the dbFolderInfo (e.g., sort type,
   * sort order, current view flags, etc), and save in the view wrapper.
   */
  _prepareToLoadView(msgDatabase, aFolder) {
    const dbFolderInfo = msgDatabase.dBFolderInfo;
    // - retrieve persisted sort information
    this._sort = [[dbFolderInfo.sortType, dbFolderInfo.sortOrder]];

    // - retrieve persisted display settings
    this.__viewFlags = dbFolderInfo.viewFlags;
    // - retrieve persisted thread last expanded state.
    this._threadExpandAll = Boolean(
      this.__viewFlags & Ci.nsMsgViewFlagsType.kExpandAll
    );

    // Make sure the threaded bit is set if group-by-sort is set.  The views
    //  encode 3 states in 2-bits, and we want to avoid that odd-man-out
    //  state.
    if (this.__viewFlags & Ci.nsMsgViewFlagsType.kGroupBySort) {
      this.__viewFlags |= Ci.nsMsgViewFlagsType.kThreadedDisplay;
      this._ensureValidSort();
    }

    // See if the last-used view was one of the special views.  If so, put us in
    //  that special view mode.  We intentionally do this after restoring the
    //  view flags because _setSpecialView enforces threading.
    // The nsMsgDBView is the one who persists this information for us.  In this
    //  case the nsMsgThreadedDBView superclass of the special views triggers it
    //  when opened.
    const viewType = dbFolderInfo.viewType;
    if (
      viewType == Ci.nsMsgViewType.eShowThreadsWithUnread ||
      viewType == Ci.nsMsgViewType.eShowWatchedThreadsWithUnread
    ) {
      this._setSpecialView(viewType);
    }

    // - retrieve virtual folder configuration
    if (aFolder.flags & Ci.nsMsgFolderFlags.Virtual) {
      const virtFolder = VirtualFolderHelper.wrapVirtualFolder(aFolder);

      if (virtFolder.searchFolderURIs == "*") {
        // This is a special virtual folder that searches all folders in all
        // accounts (except the unwanted types listed). Get those folders now.
        const unwantedFlags =
          Ci.nsMsgFolderFlags.Trash |
          Ci.nsMsgFolderFlags.Junk |
          Ci.nsMsgFolderFlags.Queue |
          Ci.nsMsgFolderFlags.Virtual;
        this._underlyingFolders = [];
        for (const server of MailServices.accounts.allServers) {
          for (const f of server.rootFolder.descendants) {
            if (!f.isSpecialFolder(unwantedFlags, true)) {
              this._underlyingFolders.push(f);
            }
          }
        }
      } else {
        // Filter out the server roots; they only exist for UI reasons.
        this._underlyingFolders = virtFolder.searchFolders.filter(
          folder => !folder.isServer
        );
      }
      this._underlyingData =
        this._underlyingFolders.length > 1
          ? this.kUnderlyingMultipleFolder
          : this.kUnderlyingRealFolder;

      // figure out if we are using online IMAP searching
      this.search.onlineSearch = virtFolder.onlineSearch;

      // retrieve and chew the search query
      this.search.virtualFolderTerms = virtFolder.searchTerms;
    } else {
      this._underlyingData = this.kUnderlyingRealFolder;
      this._underlyingFolders = [this.displayedFolder];
    }

    FolderNotificationHelper.stalkFolders(
      this._underlyingFolders,
      this.displayedFolder,
      this
    );

    // - retrieve mail view configuration
    if (this.listener.shouldUseMailViews) {
      // if there is a view tag (basically ":tagname"), then it's a
      //  mailview tag.  clearly.
      let mailViewTag = dbFolderInfo.getCharProperty(
        MailViewConstants.kViewCurrentTag
      );
      // "0" and "1" are all and unread views, respectively, from 2.0
      if (mailViewTag && mailViewTag != "0" && mailViewTag != "1") {
        // the tag gets stored with a ":" on the front, presumably done
        //  as a means of name-spacing that was never subsequently leveraged.
        if (mailViewTag.startsWith(":")) {
          mailViewTag = mailViewTag.substr(1);
        }
        // (the true is so we don't persist)
        this.setMailView(MailViewConstants.kViewItemTags, mailViewTag, true);
      } else {
        // otherwise it's just an index. we kinda-sorta migrate from old-school
        //  $label tags, except someone reused one of the indices for
        //  kViewItemNotDeleted, which means that $label2 can no longer be
        //  migrated.
        const mailViewIndex = dbFolderInfo.getUint32Property(
          MailViewConstants.kViewCurrent,
          MailViewConstants.kViewItemAll
        );
        // label migration per above
        if (
          mailViewIndex == MailViewConstants.kViewItemTags ||
          (MailViewConstants.kViewItemTags + 2 <= mailViewIndex &&
            mailViewIndex < MailViewConstants.kViewItemVirtual)
        ) {
          this.setMailView(
            MailViewConstants.kViewItemTags,
            "$label" + (mailViewIndex - 1)
          );
        } else {
          this.setMailView(mailViewIndex);
        }
      }
    }

    this.listener.onLoadingFolder(dbFolderInfo);
  },

  /**
   * Creates a view appropriate to the current settings of the folder display
   *  widget, returning it.  The caller is responsible to assign the result to
   *  this.dbView (or whatever it wants to do with it.)
   */
  _createView() {
    let dbviewContractId = "@mozilla.org/messenger/msgdbview;1?type=";

    // we will have saved these off when closing our view
    let viewFlags =
      this.__viewFlags ??
      Services.prefs.getIntPref("mailnews.default_view_flags", 1);

    if (this.showGroupedBySort && (this.isMultiFolder || this.isSynthetic)) {
      // For performance reasons, cross-folder views should be opened with
      // all groups collapsed.
      viewFlags &= ~Ci.nsMsgViewFlagsType.kExpandAll;
    }

    // real folders are subject to the most interest set of possibilities...
    if (this._underlyingData == this.kUnderlyingRealFolder) {
      // quick-search inherits from threaded which inherits from group, so this
      //  is right to choose it first.
      if (this.search.hasSearchTerms) {
        dbviewContractId += "quicksearch";
      } else if (this.showGroupedBySort) {
        dbviewContractId += "group";
      } else if (this.specialViewThreadsWithUnread) {
        dbviewContractId += "threadswithunread";
      } else if (this.specialViewWatchedThreadsWithUnread) {
        dbviewContractId += "watchedthreadswithunread";
      } else {
        dbviewContractId += "threaded";
      }
    } else if (this._underlyingData == this.kUnderlyingMultipleFolder) {
      // if we're dealing with virtual folders, the answer is always an xfvf
      dbviewContractId += "xfvf";
    } else {
      // kUnderlyingSynthetic or kUnderlyingSearchView
      dbviewContractId += "search";
    }

    // and now zero the saved-off flags.
    this.__viewFlags = null;

    const dbView = Cc[dbviewContractId].createInstance(Ci.nsIMsgDBView);
    dbView.init(
      this.listener.messenger,
      this.listener.msgWindow,
      this.listener.threadPaneCommandUpdater
    );
    const [sortType, sortOrder] = this._sort[0];

    // when the underlying folder is a single real folder (virtual or no), we
    //  tell the view about the underlying folder.
    if (this.isSingleFolder) {
      // If the folder is virtual, m_viewFolder needs to be set before the
      //  folder is opened, otherwise persisted sort info will not be restored
      //  from the right dbFolderInfo. The use case is for a single folder
      //  backed saved search. Currently, sort etc. changes in quick filter are
      //  persisted (gloda list and quick filter in gloda list are not involved).
      if (this.isVirtual) {
        dbView.viewFolder = this.displayedFolder;
      }

      // Open the folder.
      dbView.open(this._underlyingFolders[0], sortType, sortOrder, viewFlags);

      // If there are any search terms, we need to tell the db view about the
      //  the display (/virtual) folder so it can store all the view-specific
      //  data there (things like the active mail view and such that go in
      //  dbFolderInfo.)  This also goes for cases where the quick search is
      //  active; the C++ code explicitly nulls out the view folder for no
      //  good/documented reason, so we need to set it again if we want changes
      //  made with the quick filter applied.  (We don't just change the C++
      //  code because there could be SeaMonkey fallout.)  See bug 502767 for
      //  info about the quick-search part of the problem.
      if (this.search.hasSearchTerms) {
        dbView.viewFolder = this.displayedFolder;
      }
    } else {
      // when we're dealing with a multi-folder virtual folder, we just tell the
      //  db view about the display folder.  (It gets its own XFVF view, so it
      //  knows what to do.)
      // and for a synthetic folder, displayedFolder is null anyways
      dbView.open(this.displayedFolder, sortType, sortOrder, viewFlags);
    }

    // we all know it's a tree view, make sure the interface is available
    //  so no one else has to do this.
    dbView.QueryInterface(Ci.nsITreeView);

    this._sort = getSortStatusFromView(dbView);

    return dbView;
  },

  /**
   * Callback method invoked by FolderNotificationHelper when our folder is
   *  loaded.  Assuming we are still interested in the folder, we enter the
   *  folder via _enterFolder.
   */
  _folderLoaded(aFolder) {
    if (aFolder == this.displayedFolder) {
      this.folderLoading = false;
      // If _underlyingFolders is null, DBViewWrapper_open probably got
      // an exception trying to open the db, but after reparsing the local
      // folder, we should have a db, so set up the view based on info
      // from the db.
      if (this._underlyingFolders == null) {
        this._prepareToLoadView(aFolder.msgDatabase, aFolder);
      }
      this._enterFolder();
    }
  },

  /**
   * Enter this.displayedFolder if we have not yet entered it.
   *
   * Things we do on entering a folder:
   * - clear the folder's biffState!
   * - set the message database's header cache size
   */
  _enterFolder() {
    if (this._enteredFolder) {
      this.listener.onMessagesLoaded(true);
      return;
    }
    this._enteredFolder = true;

    this.displayedFolder.biffState = Ci.nsIMsgFolder.nsMsgBiffState_NoMail;

    // we definitely want a view at this point; force the view.
    this._viewUpdateDepth = 0;
    this._applyViewChanges();

    this.listener.onDisplayingFolder();
  },

  /**
   * Renames, moves to the trash, it's all crazy.  We have to update all our
   *  references when this happens.
   */
  _folderMoved(aOldFolder, aNewFolder) {
    if (aOldFolder == this.displayedFolder) {
      this.displayedFolder = aNewFolder;
    }

    if (!this._underlyingFolders) {
      // View is closed already.
      return;
    }

    const i = this._underlyingFolders.findIndex(f => f == aOldFolder);
    if (i >= 0) {
      this._underlyingFolders[i] = aNewFolder;
    }

    // re-populate the view.
    this._applyViewChanges();
  },

  /**
   * FolderNotificationHelper tells us when folders we care about are deleted
   *  (because we asked it to in |open|).  If it was the folder we were
   *  displaying (real or virtual), this closes it.  If we are virtual and
   *  backed by a single folder, this closes us.  If we are backed by multiple
   *  folders, we just update ourselves.  (Currently, cross-folder views are
   *  not clever enough to purge the mooted messages, so we need to do this to
   *  help them out.)
   * We do not update virtual folder definitions as a result of deletion; we are
   *  a display abstraction.  That (hopefully) happens elsewhere.
   */
  _folderDeleted(aFolder) {
    // XXX When we empty the trash, we're actually sending a folder deleted
    // notification around. This check ensures we don't think we've really
    // deleted the trash folder in the DBViewWrapper, and that stops nasty
    // things happening, like forgetting we've got the trash folder selected.
    if (aFolder.isSpecialFolder(Ci.nsMsgFolderFlags.Trash, false)) {
      return;
    }

    if (aFolder == this.displayedFolder) {
      this.close();
      return;
    }

    if (!this._underlyingFolders) {
      // View is closed already.
      return;
    }

    // indexOf doesn't work for this (reliably)
    for (const [i, underlyingFolder] of this._underlyingFolders.entries()) {
      if (aFolder == underlyingFolder) {
        this._underlyingFolders.splice(i, 1);
        break;
      }
    }

    if (this._underlyingFolders.length == 0) {
      this.close();
      return;
    }
    // if we are virtual, this will update the search session which draws its
    //  search scopes from this._underlyingFolders anyways.
    this._applyViewChanges();
  },

  /**
   * Compacting will likely replace the message database, requiring the view
   * to be rebuilt. We want to notify our listener so they have a chance to
   * save the selected messages.
   */
  _aboutToCompactFolder(aFolder) {
    if (aFolder != this.displayedFolder || !this.dbView) {
      return;
    }

    // Save the view's flags that will be restored in
    // _compactedFolder(aFolder).
    this.__viewFlags = this.dbView.viewFlags;
    // We will have to re-create the view, so nuke the view now.
    this.listener.onDestroyingView(true);
    this.search.dissociateView(this.dbView);
    this.dbView.close();
    this.dbView = null;
  },

  /**
   * Compaction is all done. There's likely a new database, so we'll need to
   * re-create the view.
   */
  _compactedFolder(aFolder) {
    if (aFolder != this.displayedFolder) {
      return;
    }

    this.refresh();
  },

  /**
   * DB Views need help to know when their move / deletion operations complete.
   *  This happens in both single-folder and multiple-folder backed searches.
   *  In the latter case, there is potential danger that we tell a view that did
   *  not initiate the move / deletion but has kicked off its own about the
   *  completion and confuse it.  However, that's on the view code.
   */
  _deleteCompleted() {
    if (this.dbView) {
      this.dbView.onDeleteCompleted(true);
    }
    this.listener.onMessagesRemoved();
  },

  /**
   * See _deleteCompleted for an explanation of what is going on.
   */
  _deleteFailed() {
    if (this.dbView) {
      this.dbView.onDeleteCompleted(false);
    }
    this.listener.onMessageRemovalFailed();
  },

  _forceOpen(aFolder) {
    this.displayedFolder = null;
    this.open(aFolder);
  },

  _renameCompleted(aFolder) {
    if (aFolder == this.displayedFolder) {
      this._forceOpen(aFolder);
    }
  },

  /**
   * If the displayed folder had its total message count or total unread message
   *  count change, notify the listener.  (Note: only for the display folder;
   *  not the underlying folders!)
   */
  _messageCountsChanged(aFolder) {
    if (aFolder == this.displayedFolder) {
      this.listener.onMessageCountsChanged();
    }
  },

  /**
   * @returns {integer} the current set of viewFlags. This may be:
   * - A modified set of flags that are pending application because a view
   *    update is in effect and we don't want to modify the view when it's just
   *    going to get destroyed.
   * - The live set of flags from the current dbView.
   * - The 'limbo' set of flags because we currently lack a view but will have
   *    one soon (and then we will apply the flags).
   */
  get _viewFlags() {
    if (this.__viewFlags != null) {
      return this.__viewFlags;
    }
    if (this.dbView) {
      return this.dbView.viewFlags;
    }
    return 0;
  },
  /**
   * Update the view flags to use on the view.  If we are in a view update or
   *  currently don't have a view, we save the view flags for later usage when
   *  the view gets (re)built.  If we have a view, depending on what's
   *  happening we may re-create the view or just set the bits.
   *
   * @param {nsMsgViewFlagsTypeValue} aViewFlags
   */
  set _viewFlags(aViewFlags) {
    if (this._viewUpdateDepth || !this.dbView) {
      this.__viewFlags = aViewFlags;
      return;
    }

    // For viewFlag changes, do not make a random selection if there is not
    // actually anything selected; some views do this (looking at xfvf).
    if (this.dbView.selection && this.dbView.selection.count == 0) {
      this.dbView.selection.currentIndex = -1;
    }

    // Single-folder can _not_ handle a change between grouped and not-grouped,
    // so re-generate the view. Also it can't handle a change involving
    // kUnreadOnly or kShowIgnored (which are not available in virtual
    // folders).
    const changedFlags = this.dbView.viewFlags ^ aViewFlags;
    if (
      !this.isVirtual &&
      changedFlags &
        (Ci.nsMsgViewFlagsType.kGroupBySort |
          Ci.nsMsgViewFlagsType.kUnreadOnly |
          Ci.nsMsgViewFlagsType.kShowIgnored)
    ) {
      this.__viewFlags = aViewFlags;
      this._applyViewChanges();
      return;
    }

    // XFVF views can handle the flag changes, just set the flags.
    // Single-folder virtual folders (quicksearch) can handle viewFlag changes,
    // to/from grouped included, so set it.
    // Single-folder threaded/unthreaded can handle a change to/from
    // unthreaded/threaded, so set it.
    this.dbView.viewFlags = aViewFlags;
    // ugh, and the single folder case needs us to re-apply his sort...
    if (this.isSingleFolder) {
      this.dbView.sort(this.dbView.sortType, this.dbView.sortOrder);
    }
    this.listener.onSortChanged();
  },

  /**
   * Apply accumulated changes to the view.
   */
  _applyViewChanges() {
    if (this._viewUpdateDepth) {
      // In a batch, do nothing.
      return;
    }
    // make the dbView stop being a search listener if it is one
    if (this.dbView) {
      // save the view's flags if it has any and we haven't already overridden
      //  them.
      if (this.__viewFlags == null) {
        this.__viewFlags = this.dbView.viewFlags;
      }
      this.listener.onDestroyingView(true); // we will re-create it!
      this.search.dissociateView(this.dbView);
      this.dbView.close();
      this.dbView = null;
    }

    this.dbView = this._createView();
    // if the synthetic view defines columns, add those for it
    if (this.isSynthetic) {
      for (const customCol of this._syntheticView.customColumns) {
        customCol.bindToView(this.dbView);
        this.dbView.addColumnHandler(customCol.id, customCol);
      }
    }
    this.listener.onCreatedView();

    // this ends up being a no-op if there are no search terms
    this.search.associateView(this.dbView);

    // If we are searching, then the search will generate the all messages
    //  loaded notification.  Although in some cases the search may have
    //  completed by now, that is not a guarantee.  The search logic is
    //  time-slicing, which is why this can vary.  (If it uses up its time
    //  slices, it will re-schedule itself, returning to us before completing.)
    //  Which is why we always defer to the search if one is active.
    // If we are loading the folder, the load completion will also notify us,
    //  so we should not generate all messages loaded right now.
    if (!this.searching && !this.folderLoading) {
      this.listener.onMessagesLoaded(true);
    } else if (this.dbView.numMsgsInView > 0) {
      this.listener.onMessagesLoaded(false);
    }
  },

  get isMailFolder() {
    return Boolean(
      this.displayedFolder &&
        this.displayedFolder.flags & Ci.nsMsgFolderFlags.Mail
    );
  },

  get isNewsFolder() {
    return Boolean(
      this.displayedFolder &&
        this.displayedFolder.flags & Ci.nsMsgFolderFlags.Newsgroup
    );
  },

  get isFeedFolder() {
    return Boolean(
      this.displayedFolder && this.displayedFolder.server.type == "rss"
    );
  },

  /**
   * @returns {boolean} true if the folder is an outgoing folder by virtue of
   *   being a sent mail folder, drafts folder, queue folder, or template folder,
   *   or being a sub-folder of one of those types of folders.
   */
  get isOutgoingFolder() {
    return (
      this.displayedFolder &&
      this.displayedFolder.isSpecialFolder(
        FolderUtils.OUTGOING_FOLDER_FLAGS,
        true
      )
    );
  },
  /**
   * @returns {boolean} true if the folder is not known to be a special outgoing
   *   folder or the descendent of a special outgoing folder.
   */
  get isIncomingFolder() {
    return !this.isOutgoingFolder;
  },

  get isVirtual() {
    return Boolean(
      this.displayedFolder &&
        this.displayedFolder.flags & Ci.nsMsgFolderFlags.Virtual
    );
  },

  /**
   * Prevent view updates from running until a paired |endViewUpdate| call is
   *  made.  This is an advisory method intended to aid us in performing
   *  redundant view re-computations and does not forbid us from building the
   *  view earlier if we have a good reason.
   * Since calling endViewUpdate will compel a view update when the update
   *  depth reaches 0, you should only call this method if you are sure that
   *  you will need the view to be re-built.  If you are doing things like
   *  changing to/from threaded mode that do not cause the view to be rebuilt,
   *  you should just set those attributes directly.
   */
  beginViewUpdate() {
    this._viewUpdateDepth++;
  },

  /**
   * Conclude a paired call to |beginViewUpdate|.  Assuming the view depth has
   *  reached 0 with this call, the view will be re-created with the current
   *  settings.
   */
  endViewUpdate() {
    if (--this._viewUpdateDepth == 0) {
      this._applyViewChanges();
    }
    // Avoid pathological situations.
    if (this._viewUpdateDepth < 0) {
      this._viewUpdateDepth = 0;
    }
  },

  get primarySortColumnId() {
    const sortType = this.primarySortType;
    const defaultSortType = "dateCol";

    // Handle special cases first.
    if (sortType == Ci.nsMsgViewSortType.byNone) {
      // In the case of None, we default to the date column. This appears to be
      // the case in such instances as Global search, so don't complain about
      // it.
      return defaultSortType;
    }

    if (sortType == Ci.nsMsgViewSortType.byCustom) {
      const curCustomColumn = this.dbView.curCustomColumn;
      if (
        ThreadPaneColumns.getCustomColumns().some(c => c.id == curCustomColumn)
      ) {
        return curCustomColumn;
      }
      dump(
        `primarySortColumnId: custom sort type but no handler for column: ${curCustomColumn} \n`
      );
      return defaultSortType;
    }

    const column = ThreadPaneColumns.getDefaultColumns().find(
      c => !c.custom && Ci.nsMsgViewSortType[c.sortKey] == sortType
    );
    if (column) {
      return column.id;
    }

    dump(`primarySortColumnId: unsupported sort type: ${sortType} \n`);
    return defaultSortType;
  },

  /**
   * @returns {nsMsgViewSortType} the primary sort type.
   */
  get primarySortType() {
    return this._sort[0][0];
  },

  /**
   * @returns {nsMsgViewSortOrder} the primary sort order.
   */
  get primarySortOrder() {
    return this._sort[0][1];
  },

  /**
   * @returns {boolean} true if the dominant sort is ascending.
   */
  get isSortedAscending() {
    return (
      this._sort.length &&
      this.primarySortOrder == Ci.nsMsgViewSortOrder.ascending
    );
  },
  /**
   * @returns {boolean} true if the dominant sort is descending.
   */
  get isSortedDescending() {
    return (
      this._sort.length &&
      this.primarySortOrder == Ci.nsMsgViewSortOrder.descending
    );
  },
  /**
   * Indicate if we are sorting by time or something correlated with time.
   *
   * @returns {boolean} true if the dominant sort is by time.
   */
  get sortImpliesTemporalOrdering() {
    if (!this._sort.length) {
      return false;
    }
    const sortType = this.primarySortType;
    return (
      sortType == Ci.nsMsgViewSortType.byDate ||
      sortType == Ci.nsMsgViewSortType.byReceived ||
      sortType == Ci.nsMsgViewSortType.byId ||
      sortType == Ci.nsMsgViewSortType.byThread
    );
  },

  sortAscending() {
    if (!this.isSortedAscending) {
      this.sort(this.primarySortColumnId, Ci.nsMsgViewSortOrder.ascending);
    }
  },
  sortDescending() {
    if (!this.isSortedDescending) {
      this.sort(this.primarySortColumnId, Ci.nsMsgViewSortOrder.descending);
    }
  },

  /**
   * Accumulates implied secondary sorts based on multiple calls to this method.
   *  This is intended to be hooked up to be controlled by the UI.
   * Because we are lazy, we actually just poke the view's sort method and save
   *  the apparent secondary sort.  This also allows perfect compliance with the
   *  way this used to be implemented!
   *
   * @param {string} aSortColumnId
   * @param {nsMsgViewSortOrderValue} aSortOrder
   */
  sort(aSortColumnId, aSortOrder) {
    if (this.dbView) {
      // For sort changes, do not make a random selection if there is not
      // actually anything selected; some views do this (looking at xfvf).
      if (this.dbView.selection && this.dbView.selection.count == 0) {
        this.dbView.selection.currentIndex = -1;
      }

      // So, the thing we just set obviously will be there.
      this._sort = [
        [this.getSortType(aSortColumnId), aSortOrder, aSortColumnId],
      ];
      // Make sure it is valid...
      this._ensureValidSort();
      const [sortType, sortOrder, sortColumnId] = this._sort[0];
      this.dbView.curCustomColumn =
        sortType == Ci.nsMsgViewSortType.byCustom ? sortColumnId : "";
      this.dbView.sort(sortType, sortOrder);
      this._sort = getSortStatusFromView(this.dbView);

      // Only tell our listener if we're not in a view update batch.
      if (this._viewUpdateDepth == 0) {
        this.listener.onSortChanged();
      }
    }
  },

  /**
   * Make sure the current sort is valid under our other constraints, make it
   *  safe if it is not.  Most specifically, some sorts are illegal when
   *  grouping by sort, and we reset the sort to date in those cases.
   *
   * @param {?integer} [aViewFlags] - Optional set of view flags to consider
   *   instead of the potentially live view flags.
   */
  _ensureValidSort(aViewFlags) {
    if (
      (aViewFlags != null ? aViewFlags : this._viewFlags) &
      Ci.nsMsgViewFlagsType.kGroupBySort
    ) {
      // There is no secondary sort in Grouped-By, as the groups themselves are
      // always sorted by date. So we validate only the primary sort.
      const sortType = this._sort[0][0];
      if (
        sortType == Ci.nsMsgViewSortType.byThread ||
        sortType == Ci.nsMsgViewSortType.byId ||
        sortType == Ci.nsMsgViewSortType.byNone ||
        sortType == Ci.nsMsgViewSortType.bySize ||
        sortType == Ci.nsMsgViewSortType.byUnread ||
        sortType == Ci.nsMsgViewSortType.byJunkStatus ||
        (sortType == Ci.nsMsgViewSortType.byLocation && this.isSingleFolder)
      ) {
        this._sort = [[Ci.nsMsgViewSortType.byDate, this.primarySortOrder]];
      }
    }
  },

  /**
   * @returns {boolean} true if we are grouped-by-sort, false if not.  If we are
   *     not grouped-by-sort, then we are either threaded or unthreaded; check
   *     the showThreaded property to find out which of those it is.
   */
  get showGroupedBySort() {
    return Boolean(this._viewFlags & Ci.nsMsgViewFlagsType.kGroupBySort);
  },
  /**
   * Enable grouped-by-sort which is mutually exclusive with threaded display
   *  (as controlled/exposed by showThreaded).  Grouped-by-sort is not legal
   *  for sorts by thread/id/size/none and enabling this will cause us to change
   *  our sort to by date in those cases.
   */
  set showGroupedBySort(aShowGroupBySort) {
    if (this.showGroupedBySort != aShowGroupBySort) {
      if (aShowGroupBySort) {
        // Do not apply the flag change until we have made the sort safe.
        const viewFlags =
          this._viewFlags |
          Ci.nsMsgViewFlagsType.kGroupBySort |
          Ci.nsMsgViewFlagsType.kThreadedDisplay;
        this._ensureValidSort(viewFlags);
        this._viewFlags = viewFlags;
      } else {
        // maybe we shouldn't do anything in this case?
        this._viewFlags &= ~(
          Ci.nsMsgViewFlagsType.kGroupBySort |
          Ci.nsMsgViewFlagsType.kThreadedDisplay
        );
      }
    }
  },

  /**
   * Are we showing ignored/killed threads?
   */
  get showIgnored() {
    return Boolean(this._viewFlags & Ci.nsMsgViewFlagsType.kShowIgnored);
  },
  /**
   * Set whether we are showing ignored/killed threads.
   */
  set showIgnored(aShowIgnored) {
    if (this.showIgnored == aShowIgnored) {
      return;
    }

    if (aShowIgnored) {
      this._viewFlags |= Ci.nsMsgViewFlagsType.kShowIgnored;
    } else {
      this._viewFlags &= ~Ci.nsMsgViewFlagsType.kShowIgnored;
    }
  },

  /**
   * @returns {boolean} true if we are in threaded mode (as opposed to unthreaded
   *     or grouped-by-sort).
   */
  get showThreaded() {
    return Boolean(
      this._viewFlags & Ci.nsMsgViewFlagsType.kThreadedDisplay &&
        !(this._viewFlags & Ci.nsMsgViewFlagsType.kGroupBySort)
    );
  },
  /**
   * Set us to threaded display mode when set to true.  If we are already in
   *  threaded display mode, we do nothing.  If you want to set us to unthreaded
   *  mode, set |showUnthreaded| to true.  (Because we have three modes of
   *  operation: unthreaded, threaded, and grouped-by-sort, we are a tri-state
   *  and setting us to false is ambiguous.  We should probably be using a
   *  single attribute with three constants...)
   */
  set showThreaded(aShowThreaded) {
    if (this.showThreaded != aShowThreaded) {
      let viewFlags = this._viewFlags;
      if (aShowThreaded) {
        viewFlags |= Ci.nsMsgViewFlagsType.kThreadedDisplay;
      } else {
        // Maybe we shouldn't do anything in this case?
        viewFlags &= ~Ci.nsMsgViewFlagsType.kThreadedDisplay;
      }
      // lose the group bit...
      viewFlags &= ~Ci.nsMsgViewFlagsType.kGroupBySort;
      this._viewFlags = viewFlags;
    }
  },

  /**
   * @returns {boolean} true if we are in unthreaded mode (which means not
   *     threaded and not grouped-by-sort).
   */
  get showUnthreaded() {
    return Boolean(
      !(
        this._viewFlags &
        (Ci.nsMsgViewFlagsType.kGroupBySort |
          Ci.nsMsgViewFlagsType.kThreadedDisplay)
      )
    );
  },
  /**
   * Set to true to put us in unthreaded mode (which means not threaded and
   *  not grouped-by-sort).
   */
  set showUnthreaded(aShowUnthreaded) {
    if (this.showUnthreaded != aShowUnthreaded) {
      if (aShowUnthreaded) {
        this._viewFlags &= ~(
          Ci.nsMsgViewFlagsType.kGroupBySort |
          Ci.nsMsgViewFlagsType.kThreadedDisplay
        );
      } else {
        // Maybe we shouldn't do anything in this case?
        this._viewFlags =
          (this._viewFlags & ~Ci.nsMsgViewFlagsType.kGroupBySort) |
          Ci.nsMsgViewFlagsType.kThreadedDisplay;
      }
    }
  },

  /**
   * @returns {boolean} true if we are showing only unread messages.
   */
  get showUnreadOnly() {
    return Boolean(this._viewFlags & Ci.nsMsgViewFlagsType.kUnreadOnly);
  },
  /**
   * Enable/disable showing only unread messages using the view's flag-based
   *  mechanism.  This functionality can also be approximated using a mail
   *  view (or other search) for unread messages.  There also exist special
   *  views for showing messages with unread threads which is different and
   *  has serious limitations because of its nature.
   * Setting anything to this value clears any active special view because the
   *  actual UI use case (the "View... Threads..." menu) uses this setter
   *  intentionally as a mutually exclusive UI choice from the special views.
   */
  set showUnreadOnly(aShowUnreadOnly) {
    if (this._specialView || this.showUnreadOnly != aShowUnreadOnly) {
      const viewRebuildRequired = this._specialView != null;
      this._specialView = null;
      if (viewRebuildRequired) {
        this.beginViewUpdate();
      }

      if (aShowUnreadOnly) {
        this._viewFlags |= Ci.nsMsgViewFlagsType.kUnreadOnly;
      } else {
        this._viewFlags &= ~Ci.nsMsgViewFlagsType.kUnreadOnly;
      }

      if (viewRebuildRequired) {
        this.endViewUpdate();
      }
    }
  },

  /**
   * Read-only attribute indicating if a 'special view' is in use.  There are
   *  two special views in existence, both of which are concerned about
   *  showing you threads that have any unread messages in them.  They are views
   *  rather than search predicates because the search mechanism is not capable
   *  of expressing such a thing.  (Or at least it didn't use to be?  We might
   *  be able to whip something up these days...)
   */
  get specialView() {
    return this._specialView != null;
  },
  /**
   * Private helper for use by the specialView* setters that handles the common
   *  logic.  We don't want this method to be public because we want it to be
   *  feasible for the view hierarchy and its enumerations to go away without
   *  code outside this class having to care so much.
   */
  _setSpecialView(aViewEnum) {
    // special views simply cannot work for virtual folders.  explode.
    if (this.isVirtual) {
      throw new Error("Virtual folders cannot use special views!");
    }
    this.beginViewUpdate();
    // all special views imply a threaded view
    this.showThreaded = true;
    this.showUnreadOnly = false;
    this._specialView = aViewEnum;
    // We clear the search for paranoia/correctness reasons.  However, the UI
    //  layer is currently responsible for making sure these are already zeroed
    //  out.
    this.search.clear();
    this.endViewUpdate();
  },
  /**
   * @returns {boolean} true if the special view that shows threads with unread
   *   messages in them is active.
   */
  get specialViewThreadsWithUnread() {
    return this._specialView == Ci.nsMsgViewType.eShowThreadsWithUnread;
  },
  /**
   * If true is assigned, attempts to enable the special view that shows threads
   *  with unread messages in them.  This will not work on virtual folders
   *  because of the inheritance hierarchy.
   * Any mechanism that requires search terms (quick search, mailviews) will be
   *  reset/disabled when enabling this view.
   */
  set specialViewThreadsWithUnread(aSpecial) {
    this._setSpecialView(Ci.nsMsgViewType.eShowThreadsWithUnread);
  },
  /**
   * @returns {boolean} true if the special view that shows watched threads with
   *   unread messages in them is active.
   */
  get specialViewWatchedThreadsWithUnread() {
    return this._specialView == Ci.nsMsgViewType.eShowWatchedThreadsWithUnread;
  },
  /**
   * If true is assigned, attempts to enable the special view that shows watched
   *  threads with unread messages in them.  This will not work on virtual
   *  folders because of the inheritance hierarchy.
   * Any mechanism that requires search terms (quick search, mailviews) will be
   *  reset/disabled when enabling this view.
   */
  set specialViewWatchedThreadsWithUnread(aSpecial) {
    this._setSpecialView(Ci.nsMsgViewType.eShowWatchedThreadsWithUnread);
  },

  get mailViewIndex() {
    return this._mailViewIndex;
  },

  get mailViewData() {
    return this._mailViewData;
  },

  /**
   * Set the current mail view to the given mail view index with the provided
   *  data (normally only used for the 'tag' mail views.)  We persist the state
   *  change
   *
   * @param {integer|string} aMailViewIndex - The view to use, one of the
   *   kViewItem* constants from msgViewPickerOverlay.js OR the name of a
   *   custom view.  (It's really up to MailViewManager.getMailViewByIndex...)
   * @param {srting} aData - Some piece of data appropriate to the mail view,
   *    currently this is only used for the tag name for kViewItemTags (sans the ":").
   * @param {boolean} aDoNotPersist If true, we don't save this change to the
   *   db folderinfo. This is intended for internal use only.
   */
  setMailView(aMailViewIndex, aData, aDoNotPersist) {
    const mailViewDef = MailViewManager.getMailViewByIndex(aMailViewIndex);

    this._mailViewIndex = aMailViewIndex;
    this._mailViewData = aData;

    // - update the search terms
    // (this triggers a view update if we are not in a batch)
    this.search.viewTerms = mailViewDef.makeTerms(this.search.session, aData);

    // - persist the view to the folder.
    if (!aDoNotPersist && this.displayedFolder) {
      const msgDatabase = this.displayedFolder.msgDatabase;
      if (msgDatabase) {
        const dbFolderInfo = msgDatabase.dBFolderInfo;
        dbFolderInfo.setUint32Property(
          MailViewConstants.kViewCurrent,
          this._mailViewIndex
        );
        // _mailViewData attempts to be sane and be the tag name, as opposed to
        //  magic-value ":"-prefixed value historically stored on disk.  Because
        //  we want to be forwards and backwards compatible, we put this back on
        //  when we persist it.  It's not like the property is really generic
        //  anyways.
        dbFolderInfo.setCharProperty(
          MailViewConstants.kViewCurrentTag,
          this._mailViewData ? ":" + this._mailViewData : ""
        );
      }
    }

    this.listener.onMailViewChanged();
  },

  /**
   * @returns {boolean} true if the row at the given index contains a collapsed thread,
   *   false if the row is a collapsed group or anything else.
   */
  isCollapsedThreadAtIndex(aViewIndex) {
    if (aViewIndex == nsMsgViewIndex_None) {
      return false;
    }
    const flags = this.dbView.getFlagsAt(aViewIndex);
    return (
      flags & Ci.nsMsgMessageFlags.Elided &&
      !(flags & MSG_VIEW_FLAG_DUMMY) &&
      this.dbView.isContainer(aViewIndex)
    );
  },

  /**
   * Check if the row at the given index is the header (dummy row) of an
   * expanded group, or if the row is anything else..
   *
   * @param {integer} aViewIndex - The index of a selected row.
   * @returns {boolean}
   */
  isExpandedGroupedByHeaderAtIndex(aViewIndex) {
    if (aViewIndex == nsMsgViewIndex_None) {
      return false;
    }
    const flags = this.dbView.getFlagsAt(aViewIndex);
    return (
      !(flags & Ci.nsMsgMessageFlags.Elided) &&
      flags & MSG_VIEW_FLAG_DUMMY &&
      this.dbView.isContainer(aViewIndex)
    );
  },

  /**
   * Check if the row at the given index is the header (dummy row) of a group.
   *
   * @param {integer} aViewIndex - The index of a selected row.
   * @returns {boolean} true if the row at the given index is a grouped view
   *   dummy header row, false if anything else.
   */
  isGroupedByHeaderAtIndex(aViewIndex) {
    if (!this.dbView || aViewIndex < 0 || aViewIndex >= this.dbView.rowCount) {
      return false;
    }
    return Boolean(this.dbView.getFlagsAt(aViewIndex) & MSG_VIEW_FLAG_DUMMY);
  },

  /**
   * Perform application-level behaviors related to leaving a folder that have
   *  nothing to do with our abstraction.
   *
   * Things we do on leaving a folder:
   * - Mark the folder's messages as no longer new
   * - Mark all messages read in the folder _if so configured_.
   */
  onLeavingFolder() {
    // Suppress useless InvalidateRange calls to the tree by the dbView.
    if (this.dbView) {
      this.dbView.suppressChangeNotifications = true;
    }
    this.displayedFolder.clearNewMessages();
    this.displayedFolder.hasNewMessages = false;
    try {
      // For legacy reasons, we support marking all messages as read when we
      //  leave a folder based on the server type.  It's this listener's job
      //  to do the legwork to figure out if this is desired.
      //
      // Mark all messages of aFolder as read:
      // We can't use the command controller, because it is already tuned in to
      // the new folder, so we just mimic its behaviour wrt
      // goDoCommand('cmd_markAllRead').
      if (
        this.dbView &&
        this.listener.shouldMarkMessagesReadOnLeavingFolder(
          this.displayedFolder
        )
      ) {
        this.dbView.doCommand(Ci.nsMsgViewCommandType.markAllRead);
      }
    } catch (e) {}
  },

  /**
   * Returns the view index for this message header in this view.
   *
   * - If this is a single folder view, we first check whether the folder is the
   *   right one. If it is, we call the db view's findIndexOfMsgHdr. We do the
   *   first check because findIndexOfMsgHdr only checks for whether the message
   *   key matches, which might lead to false positives.
   *
   * - If this isn't, we trust findIndexOfMsgHdr to do the right thing.
   *
   * @param {nsIMsgDBHdr} aMsgHdr - The message header for which the view index
   *   should be returned.
   * @param {boolean} [aForceFind=false] If the message is not in the view and
   *   this is true, we will drop any applied view filters to look for the
   *   message. The dropping of view filters is persistent, so use with care.
   *   Defaults to false.
   *
   * @returns {integer} the view index for this header, or nsMsgViewIndex_None
   *   if it isn't found.
   *
   * @public
   */
  getViewIndexForMsgHdr(aMsgHdr, aForceFind) {
    if (this.dbView) {
      if (this.isSingleFolder && aMsgHdr.folder != this.dbView.msgFolder) {
        return nsMsgViewIndex_None;
      }

      let viewIndex = this.dbView.findIndexOfMsgHdr(aMsgHdr, true);

      if (aForceFind && viewIndex == nsMsgViewIndex_None) {
        // Consider dropping view filters.
        // - If we're not displaying all messages, switch to All
        if (
          viewIndex == nsMsgViewIndex_None &&
          this.mailViewIndex != MailViewConstants.kViewItemAll
        ) {
          this.setMailView(MailViewConstants.kViewItemAll, null);
          viewIndex = this.dbView.findIndexOfMsgHdr(aMsgHdr, true);
        }

        // - Don't just show unread only
        if (viewIndex == nsMsgViewIndex_None) {
          this.showUnreadOnly = false;
          viewIndex = this.dbView.findIndexOfMsgHdr(aMsgHdr, true);
        }
      }

      // We've done all we can.
      return viewIndex;
    }

    // No db view, so we can't do anything
    return nsMsgViewIndex_None;
  },

  /**
   * Convenience function to retrieve the first nsIMsgDBHdr in any of the
   *  folders backing this view with the given message-id header.  This
   *  is for the benefit of FolderDisplayWidget's selection logic.
   * When thinking about using this, please keep in mind that, currently, this
   *  is O(n) for the total number of messages across all the backing folders.
   *  Since the folder database should already be in memory, this should
   *  ideally not involve any disk I/O.
   * Additionally, duplicate message-ids can and will happen, but since we
   *  are using the message database's getMsgHdrForMessageID method to be fast,
   *  our semantics are limited to telling you about only the first one we find.
   *
   * @param {string} aMessageId - The message-id of the message you want.
   * @returns {?nsIMsgDBHdr} the first nsIMsgDBHdr found in any of the
   *   underlying folders with the given message header, null if none are found.
   *   The fact that we return something does not guarantee that it is actually
   *   visible in the view.  (The search may be filtering it out.)
   */
  getMsgHdrForMessageID(aMessageId) {
    if (this._syntheticView) {
      return this._syntheticView.getMsgHdrForMessageID(aMessageId);
    }
    if (!this._underlyingFolders) {
      return null;
    }
    for (const folder of this._underlyingFolders) {
      const msgHdr = folder.msgDatabase.getMsgHdrForMessageID(aMessageId);
      if (msgHdr) {
        return msgHdr;
      }
    }
    return null;
  },
};
