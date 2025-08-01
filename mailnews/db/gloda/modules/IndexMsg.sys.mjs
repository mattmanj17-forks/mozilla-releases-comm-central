/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file currently contains a fairly general implementation of asynchronous
 *  indexing with a very explicit message indexing implementation.  As gloda
 *  will eventually want to index more than just messages, the message-specific
 *  things should ideally lose their special hold on this file.  This will
 *  benefit readability/size as well.
 */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { GlodaDatastore } from "resource:///modules/gloda/GlodaDatastore.sys.mjs";
import {
  GlodaContact,
  GlodaFolder,
} from "resource:///modules/gloda/GlodaDataModel.sys.mjs";
import { Gloda } from "resource:///modules/gloda/Gloda.sys.mjs";
import { GlodaCollectionManager } from "resource:///modules/gloda/Collection.sys.mjs";
import { GlodaConstants } from "resource:///modules/gloda/GlodaConstants.sys.mjs";
import {
  GlodaIndexer,
  IndexingJob,
} from "resource:///modules/gloda/GlodaIndexer.sys.mjs";
import { MsgHdrToMimeMessage } from "resource:///modules/gloda/MimeMessage.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailUtils: "resource:///modules/MailUtils.sys.mjs",
});

// Cr does not have mailnews error codes!
var NS_MSG_ERROR_FOLDER_SUMMARY_OUT_OF_DATE = 0x80550005;

var GLODA_MESSAGE_ID_PROPERTY = "gloda-id";
/**
 * Message header property to track dirty status; one of
 *  |GlodaIndexer.kMessageClean|, |GlodaIndexer.kMessageDirty|,
 *  |GlodaIndexer.kMessageFilthy|.
 */
var GLODA_DIRTY_PROPERTY = "gloda-dirty";

/**
 * The sentinel GLODA_MESSAGE_ID_PROPERTY value indicating that a message fails
 *  to index and we should not bother trying again, at least not until a new
 *  release is made.
 *
 * This should ideally just flip between 1 and 2, with GLODA_OLD_BAD_MESSAGE_ID
 *  flipping in the other direction.  If we start having more trailing badness,
 *  _indexerGetEnumerator and GLODA_OLD_BAD_MESSAGE_ID will need to be altered.
 *
 * When flipping this, be sure to update glodaTestHelper.js's copy.
 */
var GLODA_BAD_MESSAGE_ID = 2;
/**
 * The gloda id we used to use to mark messages as bad, but now should be
 *  treated as eligible for indexing.  This is only ever used for consideration
 *  when creating msg header enumerators with `_indexerGetEnumerator` which
 *  means we only will re-index such messages in an indexing sweep.  Accordingly
 *  event-driven indexing will still treat such messages as unindexed (and
 *  unindexable) until an indexing sweep picks them up.
 */
var GLODA_OLD_BAD_MESSAGE_ID = 1;
var GLODA_FIRST_VALID_MESSAGE_ID = 32;

var JUNK_SCORE_PROPERTY = "junkscore";
var JUNK_SPAM_SCORE_STR = Ci.nsIJunkMailPlugin.IS_SPAM_SCORE.toString();

/**
 * The processing flags that tell us that a message header has not yet been
 *  reported to us via msgsClassified.  If it has one of these flags, it is
 *  still being processed.
 */
var NOT_YET_REPORTED_PROCESSING_FLAGS =
  Ci.nsMsgProcessingFlags.NotReportedClassified |
  Ci.nsMsgProcessingFlags.ClassifyJunk;

// for list comprehension fun
function* range(begin, end) {
  for (let i = begin; i < end; ++i) {
    yield i;
  }
}

/**
 * We do not set properties on the messages until we perform a DB commit; this
 *  helper class tracks messages that we have indexed but are not yet marked
 *  as such on their header.
 */
var PendingCommitTracker = {
  /**
   * Maps message URIs to their gloda ids.
   *
   * I am not entirely sure why I chose the URI for the key rather than
   *  gloda folder ID + message key.  Most likely it was to simplify debugging
   *  since the gloda folder ID is opaque while the URI is very informative.  It
   *  is also possible I was afraid of IMAP folder renaming triggering a UID
   *  renumbering?
   */
  _indexedMessagesPendingCommitByKey: {},
  /**
   * Map from the pending commit gloda id to a tuple of [the corresponding
   *  message header, dirtyState].
   */
  _indexedMessagesPendingCommitByGlodaId: {},
  /**
   * Do we have a post-commit handler registered with this transaction yet?
   */
  _pendingCommit: false,

  /**
   * The function gets called when the commit actually happens to flush our
   *  message id's.
   *
   * It is very possible that by the time this call happens we have left the
   *  folder and nulled out msgDatabase on the folder.  Since nulling it out
   *  is what causes the commit, if we set the headers here without somehow
   *  forcing a commit, we will lose.  Badly.
   * Accordingly, we make a list of all the folders that the headers belong to
   *  as we iterate, make sure to re-attach their msgDatabase before forgetting
   *  the headers, then make sure to zero the msgDatabase again, triggering a
   *  commit.  If there were a way to directly get the nsIMsgDatabase from the
   *  header we could do that and call commit directly.  We don't track
   *  databases along with the headers since the headers can change because of
   *  moves and that would increase the number of moving parts.
   */
  _commitCallback() {
    const foldersByURI = {};
    let lastFolder = null;

    for (const glodaId in PendingCommitTracker._indexedMessagesPendingCommitByGlodaId) {
      const [msgHdr, dirtyState] =
        PendingCommitTracker._indexedMessagesPendingCommitByGlodaId[glodaId];
      // Mark this message as indexed.
      // It's conceivable the database could have gotten blown away, in which
      //  case the message headers are going to throw exceptions when we try
      //  and touch them.  So we wrap this in a try block that complains about
      //  this unforeseen circumstance.  (noteFolderDatabaseGettingBlownAway
      //  should have been called and avoided this situation in all known
      //  situations.)
      try {
        const curGlodaId = msgHdr.getUint32Property(GLODA_MESSAGE_ID_PROPERTY);
        if (curGlodaId != glodaId) {
          msgHdr.setUint32Property(GLODA_MESSAGE_ID_PROPERTY, glodaId);
        }
        const headerDirty = msgHdr.getUint32Property(GLODA_DIRTY_PROPERTY);
        if (headerDirty != dirtyState) {
          msgHdr.setUint32Property(GLODA_DIRTY_PROPERTY, dirtyState);
        }

        // Make sure this folder is in our foldersByURI map.
        if (lastFolder == msgHdr.folder) {
          continue;
        }
        lastFolder = msgHdr.folder;
        const folderURI = lastFolder.URI;
        if (!(folderURI in foldersByURI)) {
          foldersByURI[folderURI] = lastFolder;
        }
      } catch (ex) {
        GlodaMsgIndexer._log.error(
          "Exception while attempting to mark message with gloda state after" +
            "db commit",
          ex
        );
      }
    }

    // it is vitally important to do this before we forget about the headers!
    for (const uri in foldersByURI) {
      const folder = foldersByURI[uri];
      // This will not cause a parse.  The database is in-memory since we have
      //  a header that belongs to it.  This just causes the folder to
      //  re-acquire a reference from the database manager.
      folder.msgDatabase;
      // And this will cause a commit.  (And must be done since we don't want
      //  to cause a leak.)
      folder.msgDatabase = null;
    }

    PendingCommitTracker._indexedMessagesPendingCommitByGlodaId = {};
    PendingCommitTracker._indexedMessagesPendingCommitByKey = {};

    PendingCommitTracker._pendingCommit = false;
  },

  /**
   * Track a message header that should be marked with the given gloda id when
   *  the database commits.
   */
  track(aMsgHdr, aGlodaId) {
    const pendingKey = aMsgHdr.folder.URI + "#" + aMsgHdr.messageKey;
    this._indexedMessagesPendingCommitByKey[pendingKey] = aGlodaId;
    this._indexedMessagesPendingCommitByGlodaId[aGlodaId] = [
      aMsgHdr,
      GlodaMsgIndexer.kMessageClean,
    ];

    if (!this._pendingCommit) {
      GlodaDatastore.runPostCommit(this._commitCallback);
      this._pendingCommit = true;
    }
  },

  /**
   * Get the current state of a message header given that we cannot rely on just
   *  looking at the header's properties because we defer setting those
   *  until the SQLite commit happens.
   *
   * @returns {number[]} Tuple of [gloda id, dirty status].
   */
  getGlodaState(aMsgHdr) {
    // If it's in the pending commit table, then the message is basically
    //  clean.  Return that info.
    const pendingKey = aMsgHdr.folder.URI + "#" + aMsgHdr.messageKey;
    if (pendingKey in this._indexedMessagesPendingCommitByKey) {
      const glodaId =
        PendingCommitTracker._indexedMessagesPendingCommitByKey[pendingKey];
      return [glodaId, this._indexedMessagesPendingCommitByGlodaId[glodaId][1]];
    }

    // Otherwise the header's concept of state is correct.
    const glodaId = aMsgHdr.getUint32Property(GLODA_MESSAGE_ID_PROPERTY);
    const glodaDirty = aMsgHdr.getUint32Property(GLODA_DIRTY_PROPERTY);
    return [glodaId, glodaDirty];
  },

  /**
   * Update our structure to reflect moved headers.  Moves are currently
   *  treated as weakly interesting and do not require a reindexing
   *  although collections will get notified.  So our job is to to fix-up
   *  the pending commit information if the message has a pending commit.
   */
  noteMove(aOldHdr, aNewHdr) {
    const oldKey = aOldHdr.folder.URI + "#" + aOldHdr.messageKey;
    if (!(oldKey in this._indexedMessagesPendingCommitByKey)) {
      return;
    }

    const glodaId = this._indexedMessagesPendingCommitByKey[oldKey];
    delete this._indexedMessagesPendingCommitByKey[oldKey];

    const newKey = aNewHdr.folder.URI + "#" + aNewHdr.messageKey;
    this._indexedMessagesPendingCommitByKey[newKey] = glodaId;

    // only clobber the header, not the dirty state
    this._indexedMessagesPendingCommitByGlodaId[glodaId][0] = aNewHdr;
  },

  /**
   * A blind move is one where we have the source header but not the destination
   *  header.  This happens for IMAP messages that do not involve offline fake
   *  headers.
   * XXX Since IMAP moves will propagate the gloda-id/gloda-dirty bits for us,
   *  we could detect the other side of the move when it shows up as a
   *  msgsClassified event and restore the mapping information.  Since the
   *  offline fake header case should now cover the bulk of IMAP move
   *  operations, we probably do not need to pursue this.
   *
   * We just re-dispatch to noteDirtyHeader because we can't do anything more
   *  clever.
   */
  noteBlindMove(aOldHdr) {
    this.noteDirtyHeader(aOldHdr);
  },

  /**
   * If a message is dirty we should stop tracking it for post-commit
   *  purposes.  This is not because we don't want to write to its header
   *  when we commit as much as that we want to avoid |getHeaderGlodaState|
   *  reporting that the message is clean.  We could complicate our state
   *  by storing that information, but this is easier and ends up the same
   *  in the end.
   */
  noteDirtyHeader(aMsgHdr) {
    const pendingKey = aMsgHdr.folder.URI + "#" + aMsgHdr.messageKey;
    if (!(pendingKey in this._indexedMessagesPendingCommitByKey)) {
      return;
    }

    // (It is important that we get the gloda id from our own structure!)
    const glodaId = this._indexedMessagesPendingCommitByKey[pendingKey];
    this._indexedMessagesPendingCommitByGlodaId[glodaId][1] =
      GlodaMsgIndexer.kMessageDirty;
  },

  /**
   * Sometimes a folder database gets blown away.  This happens for one of two
   *  expected reasons right now:
   * - Folder compaction.
   * - Explicit reindexing of a folder via the folder properties "rebuild index"
   *    button.
   *
   * When this happens, we are basically out of luck and need to discard
   *  everything about the folder.  The good news is that the folder compaction
   *  pass is clever enough to re-establish the linkages that are being lost
   *  when we drop these things on the floor.  Reindexing of a folder is not
   *  clever enough to deal with this but is an exceptional case of last resort
   *  (the user should not normally be performing a reindex as part of daily
   *  operation), so we accept that messages may be redundantly indexed.
   */
  noteFolderDatabaseGettingBlownAway(aMsgFolder) {
    const uri = aMsgFolder.URI + "#";
    for (const key of Object.keys(this._indexedMessagesPendingCommitByKey)) {
      // this is not as efficient as it could be, but compaction is relatively
      //  rare and the number of pending headers is generally going to be
      //  small.
      if (key.indexOf(uri) == 0) {
        const glodaId = this._indexedMessagesPendingCommitByKey[key];
        delete this._indexedMessagesPendingCommitByKey[key];
        delete this._indexedMessagesPendingCommitByGlodaId[glodaId];
      }
    }
  },
};

/**
 * This callback handles processing the asynchronous query results of
 *  |GlodaMsgIndexer.getMessagesByMessageID|.
 */
function MessagesByMessageIdCallback(
  aMsgIDToIndex,
  aResults,
  aCallback,
  aCallbackThis
) {
  this.msgIDToIndex = aMsgIDToIndex;
  this.results = aResults;
  this.callback = aCallback;
  this.callbackThis = aCallbackThis;
}

MessagesByMessageIdCallback.prototype = {
  _log: console.createInstance({
    prefix: "gloda.index_msg.mbm",
    maxLogLevel: "Warn",
    maxLogLevelPref: "gloda.loglevel",
  }),

  onItemsAdded(aItems) {
    // just outright bail if we are shutdown
    if (GlodaDatastore.datastoreIsShutdown) {
      return;
    }

    this._log.debug("getting results...");
    for (const message of aItems) {
      this.results[this.msgIDToIndex[message.headerMessageID]].push(message);
    }
  },
  onItemsModified() {},
  onItemsRemoved() {},
  onQueryCompleted() {
    // just outright bail if we are shutdown
    if (GlodaDatastore.datastoreIsShutdown) {
      return;
    }

    this._log.debug("query completed, notifying... " + this.results);

    this.callback.call(this.callbackThis, this.results);
  },
};

/**
 * The message indexer!
 *
 * === Message Indexing Strategy
 * To these ends, we implement things like so:
 *
 * Message State Tracking
 * - We store a property on all indexed headers indicating their gloda message
 *   id.  This allows us to tell whether a message is indexed from the header,
 *   without having to consult the SQL database.
 * - When we receive an event that indicates that a message's meta-data has
 *   changed and gloda needs to re-index the message, we set a property on the
 *   header that indicates the message is dirty.  This property can indicate
 *   that the message needs to be re-indexed but the gloda-id is valid (dirty)
 *   or that the message's gloda-id is invalid (filthy) because the gloda
 *   database has been blown away.
 * - We track whether a folder is up-to-date on our GlodaFolder representation
 *   using a concept of dirtiness, just like messages.  Like messages, a folder
 *   can be dirty or filthy.  A dirty folder has at least one dirty message in
 *   it which means we should scan the folder.  A filthy folder means that
 *   every message in the folder should be considered filthy.  Folders start
 *   out filthy when Gloda is first told about them indicating we cannot
 *   trust any of the gloda-id's in the folders.  Filthy folders are downgraded
 *   to dirty folders after we mark all of the headers with gloda-id's filthy.
 *
 * Indexing Message Control
 * - We index the headers of all IMAP messages. We index the bodies of all IMAP
 *   messages that are offline.  We index all local messages.  We plan to avoid
 *   indexing news messages.
 * - We would like a way to express desires about indexing that either don't
 *   confound offline storage with indexing, or actually allow some choice.
 *
 * Indexing Messages
 * - We have two major modes of indexing: sweep and event-driven.  When we
 *   start up we kick off an indexing sweep.  We use event-driven indexing
 *   as we receive events for eligible messages, but if we get too many
 *   events we start dropping them on the floor and just flag that an indexing
 *   sweep is required.
 * - The sweep initiates folder indexing jobs based on the priorities assigned
 *   to folders.  Folder indexing uses a filtered message enumerator to find
 *   messages that need to be indexed, minimizing wasteful exposure of message
 *   headers to XPConnect that we would not end up indexing.
 * - For local folders, we use GetDatabaseWithReparse to ensure that the .msf
 *   file exists.  For IMAP folders, we simply use GetDatabase because we know
 *   the auto-sync logic will make sure that the folder is up-to-date and we
 *   want to avoid creating problems through use of updateFolder.
 *
 * Junk Mail
 * - We do not index junk.  We do not index messages until the junk/non-junk
 *   determination has been made.  If a message gets marked as junk, we act like
 *   it was deleted.
 * - We know when a message is actively queued for junk processing thanks to
 *   folder processing flags.  nsMsgDBFolder::CallFilterPlugins does this
 *   prior to initiating spam processing.  Unfortunately, this method does not
 *   get called until after we receive the notification about the existence of
 *   the header.  How long after can vary on different factors.  The longest
 *   delay is in the IMAP case where there is a filter that requires the
 *   message body to be present; the method does not get called until all the
 *   bodies are downloaded.
 *
 */
export var GlodaMsgIndexer = {
  /**
   * A partial attempt to generalize to support multiple databases.  Each
   *  database would have its own datastore would have its own indexer.  But
   *  we rather inter-mingle our use of this field with the singleton global
   *  GlodaDatastore.
   */
  _datastore: GlodaDatastore,
  _log: console.createInstance({
    prefix: "gloda.index_msg",
    maxLogLevel: "Warn",
    maxLogLevelPref: "gloda.loglevel",
  }),

  _junkService: MailServices.junk,

  name: "index_msg",
  /**
   * Are we enabled, read: are we processing change events?
   */
  _enabled: false,
  get enabled() {
    return this._enabled;
  },

  enable() {
    // initialize our listeners' this pointers
    this._databaseAnnouncerListener.indexer = this;
    this._msgFolderListener.indexer = this;

    // register for:
    // - folder loaded events, so we know when getDatabaseWithReparse has
    //   finished updating the index/what not (if it wasn't immediately
    //   available)
    // - property changes (so we know when a message's read/starred state have
    //   changed.)
    this._folderListener._init(this);
    MailServices.mailSession.AddFolderListener(
      this._folderListener,
      Ci.nsIFolderListener.intPropertyChanged |
        Ci.nsIFolderListener.propertyFlagChanged |
        Ci.nsIFolderListener.event
    );

    MailServices.mfn.addListener(
      this._msgFolderListener,
      // note: intentionally no msgAdded or msgUnincorporatedMoved.
      Ci.nsIMsgFolderNotificationService.msgsClassified |
        Ci.nsIMsgFolderNotificationService.msgsJunkStatusChanged |
        Ci.nsIMsgFolderNotificationService.msgsDeleted |
        Ci.nsIMsgFolderNotificationService.msgsMoveCopyCompleted |
        Ci.nsIMsgFolderNotificationService.msgKeyChanged |
        Ci.nsIMsgFolderNotificationService.folderAdded |
        Ci.nsIMsgFolderNotificationService.folderDeleted |
        Ci.nsIMsgFolderNotificationService.folderMoveCopyCompleted |
        Ci.nsIMsgFolderNotificationService.folderRenamed |
        Ci.nsIMsgFolderNotificationService.folderCompactStart |
        Ci.nsIMsgFolderNotificationService.folderCompactFinish |
        Ci.nsIMsgFolderNotificationService.folderReindexTriggered
    );

    this._enabled = true;

    this._considerSchemaMigration();

    this._log.info("Event-Driven Indexing is now " + this._enabled);
  },
  disable() {
    // remove FolderLoaded notification listener
    MailServices.mailSession.RemoveFolderListener(this._folderListener);

    MailServices.mfn.removeListener(this._msgFolderListener);

    this._indexerLeaveFolder(); // nop if we aren't "in" a folder

    this._enabled = false;

    this._log.info("Event-Driven Indexing is now " + this._enabled);
  },

  /**
   * Indicates that we have pending deletions to process, meaning that there
   *  are gloda message rows flagged for deletion.  If this value is a boolean,
   *  it means the value is known reliably.  If this value is null, it means
   *  that we don't know, likely because we have started up and have not checked
   *  the database.
   */
  pendingDeletions: null,

  /**
   * The message (or folder state) is believed up-to-date.
   */
  kMessageClean: 0,
  /**
   * The message (or folder) is known to not be up-to-date. In the case of
   *  folders, this means that some of the messages in the folder may be dirty.
   *  However, because of the way our indexing works, it is possible there may
   *  actually be no dirty messages in a folder.  (We attempt to process
   *  messages in an event-driven fashion for a finite number of messages, but
   *  because we can quit without completing processing of the queue, we need to
   *  mark the folder dirty, just-in-case.)  (We could do some extra leg-work
   *  and do a better job of marking the folder clean again.)
   */
  kMessageDirty: 1,
  /**
   * We have not indexed the folder at all, but messages in the folder think
   *  they are indexed.  We downgrade the folder to just kMessageDirty after
   *  marking all the messages in the folder as dirty.  We do this so that if we
   *  have to stop indexing the folder we can still build on our progress next
   *  time we enter the folder.
   * We mark all folders filthy when (re-)creating the database because there
   *  may be previous state left over from an earlier database.
   */
  kMessageFilthy: 2,

  /**
   * A message addition job yet to be (completely) processed.  Since message
   *  addition events come to us one-by-one, in order to aggregate them into a
   *  job, we need something like this.  It's up to the indexing loop to
   *  decide when to null this out; it can either do it when it first starts
   *  processing it, or when it has processed the last thing.  It's really a
   *  question of whether we want retrograde motion in the folder progress bar
   *  or the message progress bar.
   */
  _pendingAddJob: null,

  /**
   * The number of messages that we should queue for processing before letting
   *  them fall on the floor and relying on our folder-walking logic to ensure
   *  that the messages are indexed.
   * The reason we allow for queueing messages in an event-driven fashion is
   *  that once we have reached a steady-state, it is preferable to be able to
   *  deal with new messages and modified meta-data in a prompt fashion rather
   *  than having to (potentially) walk every folder in the system just to find
   *  the message that the user changed the tag on.
   */
  _indexMaxEventQueueMessages: 20,

  /**
   * Unit testing hook to get us to emit additional logging that verges on
   *  inane for general usage but is helpful in unit test output to get a lay
   *  of the land and for paranoia reasons.
   */
  _unitTestSuperVerbose: false,

  /** The GlodaFolder corresponding to the folder we are indexing. */
  _indexingGlodaFolder: null,
  /** The nsIMsgFolder we are currently indexing. */
  _indexingFolder: null,
  /** The nsIMsgDatabase we are currently indexing. */
  _indexingDatabase: null,
  /**
   * The iterator we are using to iterate over the headers in
   *  this._indexingDatabase.
   */
  _indexingIterator: null,

  /** folder whose entry we are pending on */
  _pendingFolderEntry: null,

  /**
   * Async common logic that we want to deal with the given folder ID.  Besides
   *  cutting down on duplicate code, this ensures that we are listening on
   *  the folder in case it tries to go away when we are using it.
   *
   * @returns {boolean} true when the folder was successfully entered,
   *   false when we need to pend on notification of updating of the folder
   *   (due to re-parsing or what have you).  In the event of an actual problem,
   *   an exception will escape.
   */
  _indexerEnterFolder(aFolderID) {
    // leave the folder if we haven't explicitly left it.
    if (this._indexingFolder !== null) {
      this._indexerLeaveFolder();
    }

    this._indexingGlodaFolder = GlodaDatastore._mapFolderID(aFolderID);
    this._indexingFolder = this._indexingGlodaFolder.getXPCOMFolder(
      this._indexingGlodaFolder.kActivityIndexing
    );

    if (this._indexingFolder) {
      this._log.debug("Entering folder: " + this._indexingFolder.URI);
    }

    try {
      // The msf may need to be created or otherwise updated for local folders.
      // This may require yielding until such time as the msf has been created.
      try {
        if (this._indexingFolder instanceof Ci.nsIMsgLocalMailFolder) {
          this._indexingDatabase = this._indexingFolder.getDatabaseWithReparse(
            null,
            null
          );
        }
        // we need do nothing special for IMAP, news, or other
      } catch (e) {
        // getDatabaseWithReparse can return either NS_ERROR_NOT_INITIALIZED or
        //  NS_MSG_ERROR_FOLDER_SUMMARY_OUT_OF_DATE if the net result is that it
        //  is going to send us a notification when the reparse has completed.
        // (note that although internally NS_MSG_ERROR_FOLDER_SUMMARY_MISSING
        //  might get flung around, it won't make it out to us, and will instead
        //  be permuted into an NS_ERROR_NOT_INITIALIZED.)
        if (
          e.result == Cr.NS_ERROR_NOT_INITIALIZED ||
          e.result == NS_MSG_ERROR_FOLDER_SUMMARY_OUT_OF_DATE
        ) {
          // this means that we need to pend on the update; the listener for
          //  FolderLoaded events will call _indexerCompletePendingFolderEntry.
          this._log.debug("Pending on folder load...");
          this._pendingFolderEntry = this._indexingFolder;
          return GlodaConstants.kWorkAsync;
        }
        throw e;
      }
      // we get an nsIMsgDatabase out of this (unsurprisingly) which
      //  explicitly inherits from nsIDBChangeAnnouncer, which has the
      //  addListener call we want.
      if (this._indexingDatabase == null) {
        this._indexingDatabase = this._indexingFolder.msgDatabase;
      }
      this._indexingDatabase.addListener(this._databaseAnnouncerListener);
    } catch (ex) {
      this._log.error(
        "Problem entering folder: " +
          (this._indexingFolder
            ? this._indexingFolder.localizedName
            : "unknown") +
          ", skipping. Error was: " +
          ex.fileName +
          ":" +
          ex.lineNumber +
          ": " +
          ex
      );
      this._indexingGlodaFolder.indexing = false;
      this._indexingFolder = null;
      this._indexingGlodaFolder = null;
      this._indexingDatabase = null;
      this._indexingEnumerator = null;

      // re-throw, we just wanted to make sure this junk is cleaned up and
      //  get localized error logging...
      throw ex;
    }

    return GlodaConstants.kWorkSync;
  },

  /**
   * If the folder was still parsing/updating when we tried to enter, then this
   *  handler will get called by the listener who got the FolderLoaded message.
   * All we need to do is get the database reference, register a listener on
   *  the db, and retrieve an iterator if desired.
   */
  _indexerCompletePendingFolderEntry() {
    this._indexingDatabase = this._indexingFolder.msgDatabase;
    this._indexingDatabase.addListener(this._databaseAnnouncerListener);
    this._log.debug("...Folder Loaded!");

    // the load is no longer pending; we certainly don't want more notifications
    this._pendingFolderEntry = null;
    // indexerEnterFolder returned kWorkAsync, which means we need to notify
    //  the callback driver to get things going again.
    GlodaIndexer.callbackDriver();
  },

  /**
   * Enumerate all messages in the folder.
   */
  kEnumAllMsgs: 0,
  /**
   * Enumerate messages that look like they need to be indexed.
   */
  kEnumMsgsToIndex: 1,
  /**
   * Enumerate messages that are already indexed.
   */
  kEnumIndexedMsgs: 2,

  /**
   * Synchronous helper to get an enumerator for the current folder (as found
   *  in |_indexingFolder|.
   *
   * @param {0|1|2} aEnumKind - One of |kEnumAllMsgs|, |kEnumMsgsToIndex|, or
   *   |kEnumIndexedMsgs|.
   * @param {boolean} [aAllowPreBadIds=false] - Only valid for
   *  |kEnumIndexedMsgs|, tells us that we should treat message with any
   *  gloda-id as dirty, not just messages that have non-bad message ids.
   */
  _indexerGetEnumerator(aEnumKind, aAllowPreBadIds) {
    if (aEnumKind == this.kEnumMsgsToIndex) {
      // We need to create search terms for messages to index. Messages should
      //  be indexed if they're indexable (local or offline and not expunged)
      //  and either: haven't been indexed, are dirty, or are marked with with
      //  a former GLODA_BAD_MESSAGE_ID that is no longer our bad marker.  (Our
      //  bad marker can change on minor schema revs so that we can try and
      //  reindex those messages exactly once and without needing to go through
      //  a pass to mark them as needing one more try.)
      // The basic search expression is:
      //  ((GLODA_MESSAGE_ID_PROPERTY Is 0) ||
      //   (GLODA_MESSAGE_ID_PROPERTY Is GLODA_OLD_BAD_MESSAGE_ID) ||
      //   (GLODA_DIRTY_PROPERTY Isnt 0)) &&
      //  (JUNK_SCORE_PROPERTY Isnt 100)
      // If the folder !isLocal we add the terms:
      //  - if the folder is offline -- && (Status Is nsMsgMessageFlags.Offline)
      //  - && (Status Isnt nsMsgMessageFlags.Expunged)

      const searchSession = Cc[
        "@mozilla.org/messenger/searchSession;1"
      ].createInstance(Ci.nsIMsgSearchSession);
      const searchTerms = [];
      const isLocal = this._indexingFolder instanceof Ci.nsIMsgLocalMailFolder;

      searchSession.addScopeTerm(
        Ci.nsMsgSearchScope.offlineMail,
        this._indexingFolder
      );

      // first term: (GLODA_MESSAGE_ID_PROPERTY Is 0
      let searchTerm = searchSession.createTerm();
      searchTerm.booleanAnd = false; // actually don't care here
      searchTerm.beginsGrouping = true;
      searchTerm.attrib = Ci.nsMsgSearchAttrib.Uint32HdrProperty;
      searchTerm.op = Ci.nsMsgSearchOp.Is;
      let value = searchTerm.value;
      value.attrib = searchTerm.attrib;
      value.status = 0;
      searchTerm.value = value;
      searchTerm.hdrProperty = GLODA_MESSAGE_ID_PROPERTY;
      searchTerms.push(searchTerm);

      // second term: || GLODA_MESSAGE_ID_PROPERTY Is GLODA_OLD_BAD_MESSAGE_ID
      searchTerm = searchSession.createTerm();
      searchTerm.booleanAnd = false; // OR
      searchTerm.attrib = Ci.nsMsgSearchAttrib.Uint32HdrProperty;
      searchTerm.op = Ci.nsMsgSearchOp.Is;
      value = searchTerm.value;
      value.attrib = searchTerm.attrib;
      value.status = GLODA_OLD_BAD_MESSAGE_ID;
      searchTerm.value = value;
      searchTerm.hdrProperty = GLODA_MESSAGE_ID_PROPERTY;
      searchTerms.push(searchTerm);

      //  third term: || GLODA_DIRTY_PROPERTY Isnt 0 )
      searchTerm = searchSession.createTerm();
      searchTerm.booleanAnd = false;
      searchTerm.endsGrouping = true;
      searchTerm.attrib = Ci.nsMsgSearchAttrib.Uint32HdrProperty;
      searchTerm.op = Ci.nsMsgSearchOp.Isnt;
      value = searchTerm.value;
      value.attrib = searchTerm.attrib;
      value.status = 0;
      searchTerm.value = value;
      searchTerm.hdrProperty = GLODA_DIRTY_PROPERTY;
      searchTerms.push(searchTerm);

      // JUNK_SCORE_PROPERTY Isnt 100
      // For symmetry with our event-driven stuff, we just directly deal with
      //  the header property.
      searchTerm = searchSession.createTerm();
      searchTerm.booleanAnd = true;
      searchTerm.attrib = Ci.nsMsgSearchAttrib.HdrProperty;
      searchTerm.op = Ci.nsMsgSearchOp.Isnt;
      value = searchTerm.value;
      value.attrib = searchTerm.attrib;
      value.str = JUNK_SPAM_SCORE_STR;
      searchTerm.value = value;
      searchTerm.hdrProperty = JUNK_SCORE_PROPERTY;
      searchTerms.push(searchTerm);

      if (!isLocal) {
        // If the folder is offline, then the message should be too
        if (this._indexingFolder.getFlag(Ci.nsMsgFolderFlags.Offline)) {
          // third term: && Status Is nsMsgMessageFlags.Offline
          searchTerm = searchSession.createTerm();
          searchTerm.booleanAnd = true;
          searchTerm.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
          searchTerm.op = Ci.nsMsgSearchOp.Is;
          value = searchTerm.value;
          value.attrib = searchTerm.attrib;
          value.status = Ci.nsMsgMessageFlags.Offline;
          searchTerm.value = value;
          searchTerms.push(searchTerm);
        }

        // fourth term: && Status Isnt nsMsgMessageFlags.Expunged
        searchTerm = searchSession.createTerm();
        searchTerm.booleanAnd = true;
        searchTerm.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
        searchTerm.op = Ci.nsMsgSearchOp.Isnt;
        value = searchTerm.value;
        value.attrib = searchTerm.attrib;
        value.status = Ci.nsMsgMessageFlags.Expunged;
        searchTerm.value = value;
        searchTerms.push(searchTerm);
      }

      this._indexingEnumerator = this._indexingDatabase.getFilterEnumerator(
        searchTerms,
        true
      );
    } else if (aEnumKind == this.kEnumIndexedMsgs) {
      // Enumerate only messages that are already indexed.  This comes out to:
      //  ((GLODA_MESSAGE_ID_PROPERTY > GLODA_FIRST_VALID_MESSAGE_ID-1) &&
      //   (GLODA_DIRTY_PROPERTY Isnt kMessageFilthy))
      // In English, a message is indexed if (by clause):
      // 1) The message has a gloda-id and that gloda-id is in the valid range
      //    (and not in the bad message marker range).
      // 2) The message has not been marked filthy (which invalidates the
      //    gloda-id.)  We also assume that the folder would not have been
      //    entered at all if it was marked filthy.
      const searchSession = Cc[
        "@mozilla.org/messenger/searchSession;1"
      ].createInstance(Ci.nsIMsgSearchSession);
      const searchTerms = [];

      searchSession.addScopeTerm(
        Ci.nsMsgSearchScope.offlineMail,
        this._indexingFolder
      );

      // first term: (GLODA_MESSAGE_ID_PROPERTY > GLODA_FIRST_VALID_MESSAGE_ID-1
      let searchTerm = searchSession.createTerm();
      searchTerm.booleanAnd = false; // actually don't care here
      searchTerm.beginsGrouping = true;
      searchTerm.attrib = Ci.nsMsgSearchAttrib.Uint32HdrProperty;
      // use != 0 if we're allow pre-bad ids.
      searchTerm.op = aAllowPreBadIds
        ? Ci.nsMsgSearchOp.Isnt
        : Ci.nsMsgSearchOp.IsGreaterThan;
      let value = searchTerm.value;
      value.attrib = searchTerm.attrib;
      value.status = aAllowPreBadIds ? 0 : GLODA_FIRST_VALID_MESSAGE_ID - 1;
      searchTerm.value = value;
      searchTerm.hdrProperty = GLODA_MESSAGE_ID_PROPERTY;
      searchTerms.push(searchTerm);

      //  second term: && GLODA_DIRTY_PROPERTY Isnt kMessageFilthy)
      searchTerm = searchSession.createTerm();
      searchTerm.booleanAnd = true;
      searchTerm.endsGrouping = true;
      searchTerm.attrib = Ci.nsMsgSearchAttrib.Uint32HdrProperty;
      searchTerm.op = Ci.nsMsgSearchOp.Isnt;
      value = searchTerm.value;
      value.attrib = searchTerm.attrib;
      value.status = this.kMessageFilthy;
      searchTerm.value = value;
      searchTerm.hdrProperty = GLODA_DIRTY_PROPERTY;
      searchTerms.push(searchTerm);

      // The use-case of already indexed messages does not want them reversed;
      //  we care about seeing the message keys in order.
      this._indexingEnumerator = this._indexingDatabase.getFilterEnumerator(
        searchTerms,
        false
      );
    } else if (aEnumKind == this.kEnumAllMsgs) {
      this._indexingEnumerator =
        this._indexingDatabase.reverseEnumerateMessages();
    } else {
      throw new Error("Unknown enumerator type requested:" + aEnumKind);
    }
  },

  _indexerLeaveFolder() {
    if (this._indexingFolder !== null) {
      if (this._indexingDatabase) {
        this._indexingDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
        // remove our listener!
        this._indexingDatabase.removeListener(this._databaseAnnouncerListener);
      }
      // let the gloda folder know we are done indexing
      this._indexingGlodaFolder.indexing = false;
      // null everyone out
      this._indexingFolder = null;
      this._indexingGlodaFolder = null;
      this._indexingDatabase = null;
      this._indexingEnumerator = null;
    }
  },

  /**
   * Event fed to us by our nsIFolderListener when a folder is loaded.  We use
   *  this event to know when a folder we were trying to open to index is
   *  actually ready to be indexed.  (The summary may have not existed, may have
   *  been out of date, or otherwise.)
   *
   * When a folder message summary file has been rebuilt via "Repair Folder",
   * we trigger a re-indexing of the gloda folder as well.
   *
   * @param {nsIMsgFolder} aFolder - An nsIMsgFolder, already QI'd.
   */
  _onFolderLoaded(aFolder) {
    const glodaFolder = GlodaDatastore._mapFolder(aFolder);
    if (glodaFolder.rebuildingFolderSummary) {
      glodaFolder.rebuildingFolderSummary = false;
      glodaFolder._dirtyStatus = glodaFolder.kFolderFilthy;
      GlodaDatastore.updateFolderDirtyStatus(glodaFolder);
      GlodaMsgIndexer.indexingSweepNeeded = true;
      return;
    }

    if (
      this._pendingFolderEntry !== null &&
      aFolder.URI == this._pendingFolderEntry.URI
    ) {
      this._indexerCompletePendingFolderEntry();
    }
  },

  // it's a getter so we can reference 'this'.  we could memoize.
  get workers() {
    return [
      [
        "folderSweep",
        {
          worker: this._worker_indexingSweep,
          jobCanceled: this._cleanup_indexingSweep,
          cleanup: this._cleanup_indexingSweep,
        },
      ],
      [
        "folder",
        {
          worker: this._worker_folderIndex,
          recover: this._recover_indexMessage,
          cleanup: this._cleanup_indexing,
        },
      ],
      [
        "folderCompact",
        {
          worker: this._worker_folderCompactionPass,
          // compaction enters the folder so needs to know how to leave
          cleanup: this._cleanup_indexing,
        },
      ],
      [
        "message",
        {
          worker: this._worker_messageIndex,
          onSchedule: this._schedule_messageIndex,
          jobCanceled: this._canceled_messageIndex,
          recover: this._recover_indexMessage,
          cleanup: this._cleanup_indexing,
        },
      ],
      [
        "delete",
        {
          worker: this._worker_processDeletes,
        },
      ],

      [
        "fixMissingContacts",
        {
          worker: this._worker_fixMissingContacts,
        },
      ],
    ];
  },

  _schemaMigrationInitiated: false,
  _considerSchemaMigration() {
    if (
      !this._schemaMigrationInitiated &&
      GlodaDatastore._actualSchemaVersion === 26
    ) {
      const job = new IndexingJob("fixMissingContacts", null);
      GlodaIndexer.indexJob(job);
      this._schemaMigrationInitiated = true;
    }
  },

  initialSweep() {
    this.indexingSweepNeeded = true;
  },

  _indexingSweepActive: false,
  /**
   * Indicate that an indexing sweep is desired.  We kick-off an indexing
   *  sweep at start-up and whenever we receive an event-based notification
   *  that we either can't process as an event or that we normally handle
   *  during the sweep pass anyways.
   */
  set indexingSweepNeeded(aNeeded) {
    if (!this._indexingSweepActive && aNeeded) {
      const job = new IndexingJob("folderSweep", null);
      job.mappedFolders = false;
      GlodaIndexer.indexJob(job);
      this._indexingSweepActive = true;
    }
  },

  /**
   * Performs the folder sweep, locating folders that should be indexed, and
   *  creating a folder indexing job for them, and rescheduling itself for
   *  execution after that job is completed.  Once it indexes all the folders,
   *  if we believe we have deletions to process (or just don't know), it kicks
   *  off a deletion processing job.
   *
   * Folder traversal logic is based off the spotlight/vista indexer code; we
   *  retrieve the list of servers and folders each time want to find a new
   *  folder to index.  This avoids needing to maintain a perfect model of the
   *  folder hierarchy at all times.  (We may eventually want to do that, but
   *  this is sufficient and safe for now.)  Although our use of dirty flags on
   *  the folders allows us to avoid tracking the 'last folder' we processed,
   *  we do so to avoid getting 'trapped' in a folder with a high rate of
   *  changes.
   */
  *_worker_indexingSweep(aJob) {
    if (!aJob.mappedFolders) {
      // Walk the folders and make sure all the folders we would want to index
      //  are mapped.  Build up a list of GlodaFolders as we go, so that we can
      //  sort them by their indexing priority.
      const foldersToProcess = (aJob.foldersToProcess = []);

      for (const folder of MailServices.accounts.allFolders) {
        if (this.shouldIndexFolder(folder)) {
          foldersToProcess.push(Gloda.getFolderForFolder(folder));
        }
      }

      // sort the folders by priority (descending)
      foldersToProcess.sort(function (a, b) {
        return b.indexingPriority - a.indexingPriority;
      });

      aJob.mappedFolders = true;
    }

    // -- process the folders (in sorted order)
    while (aJob.foldersToProcess.length) {
      const glodaFolder = aJob.foldersToProcess.shift();
      // ignore folders that:
      // - have been deleted out of existence!
      // - are not dirty/have not been compacted
      // - are actively being compacted or repaired
      if (
        glodaFolder._deleted ||
        (!glodaFolder.dirtyStatus && !glodaFolder.compacted) ||
        glodaFolder.compacting ||
        glodaFolder.rebuildingFolderSummary
      ) {
        continue;
      }

      // If the folder is marked as compacted, give it a compaction job.
      if (glodaFolder.compacted) {
        GlodaIndexer.indexJob(new IndexingJob("folderCompact", glodaFolder.id));
      }

      // add a job for the folder indexing if it was dirty
      if (glodaFolder.dirtyStatus) {
        GlodaIndexer.indexJob(new IndexingJob("folder", glodaFolder.id));
      }

      // re-schedule this job (although this worker will die)
      GlodaIndexer.indexJob(aJob);
      yield GlodaConstants.kWorkDone;
    }

    // consider deletion
    if (this.pendingDeletions || this.pendingDeletions === null) {
      GlodaIndexer.indexJob(new IndexingJob("delete", null));
    }

    // we don't have any more work to do...
    this._indexingSweepActive = false;
    yield GlodaConstants.kWorkDone;
  },

  /**
   * The only state we need to cleanup is that there is no longer an active
   *  indexing sweep.
   */
  _cleanup_indexingSweep() {
    this._indexingSweepActive = false;
  },

  /**
   * The number of headers to look at before yielding with kWorkSync.  This
   *  is for time-slicing purposes so we still yield to the UI periodically.
   */
  HEADER_CHECK_SYNC_BLOCK_SIZE: 25,

  FOLDER_COMPACTION_PASS_BATCH_SIZE: 512,
  /**
   * Special indexing pass for (local) folders than have been compacted.  The
   *  compaction can cause message keys to change because message keys in local
   *  folders are simply offsets into the mbox file.  Accordingly, we need to
   *  update the gloda records/objects to point them at the new message key.
   *
   * Our general algorithm is to perform two traversals in parallel.  The first
   *  is a straightforward enumeration of the message headers in the folder that
   *  apparently have been already indexed.  These provide us with the message
   *  key and the "gloda-id" property.
   * The second is a list of tuples containing a gloda message id, its current
   *  message key per the gloda database, and the message-id header.  We re-fill
   *  the list with batches on-demand.  This allows us to both avoid dispatching
   *  needless UPDATEs as well as deal with messages that were tracked by the
   *  PendingCommitTracker but were discarded by the compaction notification.
   *
   * We end up processing two streams of gloda-id's and some extra info.  In
   *  the normal case we expect these two streams to line up exactly and all
   *  we need to do is update the message key if it has changed.
   *
   * There are a few exceptional cases where things do not line up:
   * 1) The gloda database knows about a message that the enumerator does not
   *    know about...
   *   a) This message exists in the folder (identified using its message-id
   *      header).  This means the message got indexed but PendingCommitTracker
   *      had to forget about the info when the compaction happened.  We
   *      re-establish the link and track the message in PendingCommitTracker
   *      again.
   *   b) The message does not exist in the folder.  This means the message got
   *      indexed, PendingCommitTracker had to forget about the info, and
   *      then the message either got moved or deleted before now.  We mark
   *      the message as deleted; this allows the gloda message to be reused
   *      if the move target has not yet been indexed or purged if it already
   *      has been and the gloda message is a duplicate.  And obviously, if the
   *      event that happened was actually a delete, then the delete is the
   *      right thing to do.
   * 2) The enumerator knows about a message that the gloda database does not
   *    know about.  This is unexpected and should not happen.  We log a
   *    warning.  We are able to differentiate this case from case #1a by
   *    retrieving the message header associated with the next gloda message
   *    (using the message-id header per 1a again).  If the gloda message's
   *    message key is after the enumerator's message key then we know this is
   *    case #2.  (It implies an insertion in the enumerator stream which is how
   *    we define the unexpected case.)
   *
   * Besides updating the database rows, we also need to make sure that
   *  in-memory representations are updated.  Immediately after dispatching
   *  UPDATE changes to the database we use the same set of data to walk the
   *  live collections and update any affected messages.  We are then able to
   *  discard the information.  Although this means that we will have to
   *  potentially walk the live collections multiple times, unless something
   *  has gone horribly wrong, the number of collections should be reasonable
   *  and the lookups are cheap.  We bias batch sizes accordingly.
   *
   * Because we operate based on chunks we need to make sure that when we
   *  actually deal with multiple chunks that we don't step on our own feet with
   *  our database updates.  Since compaction of message key K results in a new
   *  message key K' such that K' <= K, we can reliably issue database
   *  updates for all values <= K.  Which means our feet are safe no matter
   *  when we issue the update command.  For maximum cache benefit, we issue
   *  our updates prior to our new query since they should still be maximally
   *  hot at that point.
   */
  *_worker_folderCompactionPass(aJob, aCallbackHandle) {
    yield this._indexerEnterFolder(aJob.id);

    // It's conceivable that with a folder sweep we might end up trying to
    //  compact a folder twice.  Bail early in this case.
    if (!this._indexingGlodaFolder.compacted) {
      yield GlodaConstants.kWorkDone;
    }

    // this is a forward enumeration (sometimes we reverse enumerate; not here)
    this._indexerGetEnumerator(this.kEnumIndexedMsgs);

    const HEADER_CHECK_SYNC_BLOCK_SIZE = this.HEADER_CHECK_SYNC_BLOCK_SIZE;
    const FOLDER_COMPACTION_PASS_BATCH_SIZE =
      this.FOLDER_COMPACTION_PASS_BATCH_SIZE;

    // Tuples of [gloda id, message key, message-id header] from
    //  folderCompactionPassBlockFetch
    let glodaIdsMsgKeysHeaderIds = [];
    // Unpack each tuple from glodaIdsMsgKeysHeaderIds into these guys.
    // (Initialize oldMessageKey because we use it to kickstart our query.)
    let oldGlodaId,
      oldMessageKey = -1,
      oldHeaderMessageId;
    // parallel lists of gloda ids and message keys to pass to
    //  GlodaDatastore.updateMessageLocations
    let updateGlodaIds = [];
    let updateMessageKeys = [];
    // list of gloda id's to mark deleted
    let deleteGlodaIds = [];

    // for GC reasons we need to track the number of headers seen
    let numHeadersSeen = 0;

    // We are consuming two lists; our loop structure has to reflect that.
    let headerIter = this._indexingEnumerator[Symbol.iterator]();
    let mayHaveMoreGlodaMessages = true;
    let keepIterHeader = false;
    let keepGlodaTuple = false;
    let msgHdr = null;
    while (headerIter || mayHaveMoreGlodaMessages) {
      let glodaId;
      if (headerIter) {
        if (!keepIterHeader) {
          const result = headerIter.next();
          if (result.done) {
            headerIter = null;
            msgHdr = null;
            // do the loop check again
            continue;
          }
          msgHdr = result.value;
        } else {
          keepIterHeader = false;
        }
      }

      if (msgHdr) {
        numHeadersSeen++;
        if (numHeadersSeen % HEADER_CHECK_SYNC_BLOCK_SIZE == 0) {
          yield GlodaConstants.kWorkSync;
        }

        // There is no need to check with PendingCommitTracker.  If a message
        //  somehow got indexed between the time the compaction killed
        //  everything and the time we run, that is a bug.
        glodaId = msgHdr.getUint32Property(GLODA_MESSAGE_ID_PROPERTY);
        // (there is also no need to check for gloda dirty since the enumerator
        //  filtered that for us.)
      }

      // get more [gloda id, message key, message-id header] tuples if out
      if (!glodaIdsMsgKeysHeaderIds.length && mayHaveMoreGlodaMessages) {
        // Since we operate on blocks, getting a new block implies we should
        //  flush the last block if applicable.
        if (updateGlodaIds.length) {
          GlodaDatastore.updateMessageLocations(
            updateGlodaIds,
            updateMessageKeys,
            aJob.id,
            true
          );
          updateGlodaIds = [];
          updateMessageKeys = [];
        }

        if (deleteGlodaIds.length) {
          GlodaDatastore.markMessagesDeletedByIDs(deleteGlodaIds);
          deleteGlodaIds = [];
        }

        GlodaDatastore.folderCompactionPassBlockFetch(
          aJob.id,
          oldMessageKey + 1,
          FOLDER_COMPACTION_PASS_BATCH_SIZE,
          aCallbackHandle.wrappedCallback
        );
        glodaIdsMsgKeysHeaderIds = yield GlodaConstants.kWorkAsync;
        // Reverse so we can use pop instead of shift and I don't need to be
        //  paranoid about performance.
        glodaIdsMsgKeysHeaderIds.reverse();

        if (!glodaIdsMsgKeysHeaderIds.length) {
          mayHaveMoreGlodaMessages = false;

          // We shouldn't be in the loop anymore if headerIter is dead now.
          if (!headerIter) {
            break;
          }
        }
      }

      if (!keepGlodaTuple) {
        if (mayHaveMoreGlodaMessages) {
          [oldGlodaId, oldMessageKey, oldHeaderMessageId] =
            glodaIdsMsgKeysHeaderIds.pop();
        } else {
          oldGlodaId = oldMessageKey = oldHeaderMessageId = null;
        }
      } else {
        keepGlodaTuple = false;
      }

      // -- normal expected case
      if (glodaId == oldGlodaId) {
        // only need to do something if the key is not right
        if (msgHdr.messageKey != oldMessageKey) {
          updateGlodaIds.push(glodaId);
          updateMessageKeys.push(msgHdr.messageKey);
        }
      } else {
        // -- exceptional cases
        // This should always return a value unless something is very wrong.
        //  We do not want to catch the exception if one happens.
        const idBasedHeader = oldHeaderMessageId
          ? this._indexingDatabase.getMsgHdrForMessageID(oldHeaderMessageId)
          : null;
        // - Case 1b.
        // We want to mark the message as deleted.
        if (idBasedHeader == null) {
          deleteGlodaIds.push(oldGlodaId);
        } else if (
          idBasedHeader &&
          ((msgHdr && idBasedHeader.messageKey < msgHdr.messageKey) || !msgHdr)
        ) {
          // - Case 1a
          // The expected case is that the message referenced by the gloda
          //  database precedes the header the enumerator told us about.  This
          //  is expected because if PendingCommitTracker did not mark the
          //  message as indexed/clean then the enumerator would not tell us
          //  about it.
          // Also, if we ran out of headers from the enumerator, this is a dead
          //  giveaway that this is the expected case.
          // tell the pending commit tracker about the gloda database one
          PendingCommitTracker.track(idBasedHeader, oldGlodaId);
          // and we might need to update the message key too
          if (idBasedHeader.messageKey != oldMessageKey) {
            updateGlodaIds.push(oldGlodaId);
            updateMessageKeys.push(idBasedHeader.messageKey);
          }
          // Take another pass through the loop so that we check the
          //  enumerator header against the next message in the gloda
          //  database.
          keepIterHeader = true;
        } else if (msgHdr) {
          // - Case 2
          // Whereas if the message referenced by gloda has a message key
          //  greater than the one returned by the enumerator, then we have a
          //  header claiming to be indexed by gloda that gloda does not
          //  actually know about.  This is exceptional and gets a warning.
          this._log.warn(
            "Observed header that claims to be gloda indexed " +
              "but that gloda has never heard of during " +
              "compaction." +
              " In folder: " +
              msgHdr.folder.URI +
              " sketchy key: " +
              msgHdr.messageKey +
              " subject: " +
              msgHdr.mime2DecodedSubject
          );
          // Keep this tuple around for the next enumerator provided header
          keepGlodaTuple = true;
        }
      }
    }
    // If we don't flush the update, no one will!
    if (updateGlodaIds.length) {
      GlodaDatastore.updateMessageLocations(
        updateGlodaIds,
        updateMessageKeys,
        aJob.id,
        true
      );
    }
    if (deleteGlodaIds.length) {
      GlodaDatastore.markMessagesDeletedByIDs(deleteGlodaIds);
    }

    this._indexingGlodaFolder._setCompactedState(false);

    this._indexerLeaveFolder();
    yield GlodaConstants.kWorkDone;
  },

  /**
   * Index the contents of a folder.
   */
  *_worker_folderIndex(aJob, aCallbackHandle) {
    yield this._indexerEnterFolder(aJob.id);

    if (!this.shouldIndexFolder(this._indexingFolder)) {
      aJob.safelyInvokeCallback(true);
      yield GlodaConstants.kWorkDone;
    }

    // Make sure listeners get notified about this job.
    GlodaIndexer._notifyListeners();

    // there is of course a cost to all this header investigation even if we
    //  don't do something.  so we will yield with kWorkSync for every block.
    const HEADER_CHECK_SYNC_BLOCK_SIZE = this.HEADER_CHECK_SYNC_BLOCK_SIZE;

    // we can safely presume if we are here that this folder has been selected
    //  for offline processing...

    // -- Filthy Folder
    // A filthy folder may have misleading properties on the message that claim
    //  the message is indexed.  They are misleading because the database, for
    //  whatever reason, does not have the messages (accurately) indexed.
    // We need to walk all the messages and mark them filthy if they have a
    //  dirty property.  Once we have done this, we can downgrade the folder's
    //  dirty status to plain dirty.  We do this rather than trying to process
    //  everyone in one go in a filthy context because if we have to terminate
    //  indexing before we quit, we don't want to have to re-index messages next
    //  time.  (This could even lead to never completing indexing in a
    //  pathological situation.)
    const glodaFolder = GlodaDatastore._mapFolder(this._indexingFolder);
    if (glodaFolder.dirtyStatus == glodaFolder.kFolderFilthy) {
      this._indexerGetEnumerator(this.kEnumIndexedMsgs, true);
      let count = 0;
      for (const msgHdr of this._indexingEnumerator) {
        // we still need to avoid locking up the UI, pause periodically...
        if (++count % HEADER_CHECK_SYNC_BLOCK_SIZE == 0) {
          yield GlodaConstants.kWorkSync;
        }

        const glodaMessageId = msgHdr.getUint32Property(
          GLODA_MESSAGE_ID_PROPERTY
        );
        // if it has a gloda message id, we need to mark it filthy
        if (glodaMessageId != 0) {
          msgHdr.setUint32Property(GLODA_DIRTY_PROPERTY, this.kMessageFilthy);
        }
        // if it doesn't have a gloda message id, we will definitely index it,
        //  so no action is required.
      }
      // Commit the filthy status changes to the message database.
      this._indexingDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);

      // this will automatically persist to the database
      glodaFolder._downgradeDirtyStatus(glodaFolder.kFolderDirty);
    }

    // Figure out whether we're supposed to index _everything_ or just what
    //  has not yet been indexed.
    const force = "force" in aJob && aJob.force;
    const enumeratorType = force ? this.kEnumAllMsgs : this.kEnumMsgsToIndex;

    // Pass 1: count the number of messages to index.
    //  We do this in order to be able to report to the user what we're doing.
    // TODO: give up after reaching a certain number of messages in folders
    //  with ridiculous numbers of messages and make the interface just say
    //  something like "over N messages to go."

    this._indexerGetEnumerator(enumeratorType);

    let numMessagesToIndex = 0;
    // eslint-disable-next-line no-unused-vars
    for (const ignore of this._indexingEnumerator) {
      // We're only counting, so do bigger chunks on this pass.
      ++numMessagesToIndex;
      if (numMessagesToIndex % (HEADER_CHECK_SYNC_BLOCK_SIZE * 8) == 0) {
        yield GlodaConstants.kWorkSync;
      }
    }

    aJob.goal = numMessagesToIndex;

    if (numMessagesToIndex > 0) {
      // We used up the iterator, get a new one.
      this._indexerGetEnumerator(enumeratorType);

      // Pass 2: index the messages.
      let count = 0;
      for (const msgHdr of this._indexingEnumerator) {
        // per above, we want to periodically release control while doing all
        // this header traversal/investigation.
        if (++count % HEADER_CHECK_SYNC_BLOCK_SIZE == 0) {
          yield GlodaConstants.kWorkSync;
        }

        // To keep our counts more accurate, increment the offset before
        //  potentially skipping any messages.
        ++aJob.offset;

        // Skip messages that have not yet been reported to us as existing via
        //  msgsClassified.
        if (
          this._indexingFolder.getProcessingFlags(msgHdr.messageKey) &
          NOT_YET_REPORTED_PROCESSING_FLAGS
        ) {
          continue;
        }

        // Because the gloda id could be in-flight, we need to double-check the
        //  enumerator here since it can't know about our in-memory stuff.
        const [glodaId, glodaDirty] =
          PendingCommitTracker.getGlodaState(msgHdr);
        // if the message seems valid and we are not forcing indexing, skip it.
        //  (that means good gloda id and not dirty)
        if (
          !force &&
          glodaId >= GLODA_FIRST_VALID_MESSAGE_ID &&
          glodaDirty == this.kMessageClean
        ) {
          continue;
        }

        this._log.debug(">>>  calling _indexMessage");
        yield aCallbackHandle.pushAndGo(
          this._indexMessage(msgHdr, aCallbackHandle),
          { what: "indexMessage", msgHdr }
        );
        this._log.debug("<<<  back from _indexMessage");
      }
    }

    // This will trigger an (async) db update which cannot hit the disk prior to
    //  the actual database records that constitute the clean state.
    // XXX There is the slight possibility that, in the event of a crash, this
    //  will hit the disk but the gloda-id properties on the headers will not
    //  get set.  This should ideally be resolved by detecting a non-clean
    //  shutdown and marking all folders as dirty.
    glodaFolder._downgradeDirtyStatus(glodaFolder.kFolderClean);

    // by definition, it's not likely we'll visit this folder again anytime soon
    this._indexerLeaveFolder();

    aJob.safelyInvokeCallback(true);

    yield GlodaConstants.kWorkDone;
  },

  /**
   * Invoked when a "message" job is scheduled so that we can clear
   *  _pendingAddJob if that is the job.  We do this so that work items are not
   *  added to _pendingAddJob while it is being processed.
   */
  _schedule_messageIndex(aJob) {
    // we do not want new work items to be added as we are processing, so
    //  clear _pendingAddJob.  A new job will be created as needed.
    if (aJob === this._pendingAddJob) {
      this._pendingAddJob = null;
    }
    // update our goal from the items length
    aJob.goal = aJob.items.length;
  },
  /**
   * If the job gets canceled, we need to make sure that we clear out pending
   *  add job or our state will get wonky.
   */
  _canceled_messageIndex(aJob) {
    if (aJob === this._pendingAddJob) {
      this._pendingAddJob = null;
    }
  },

  /**
   * Index a specific list of messages that we know to index from
   *  event-notification hints.
   */
  *_worker_messageIndex(aJob, aCallbackHandle) {
    // if we are already in the correct folder, our "get in the folder" clause
    //  will not execute, so we need to make sure this value is accurate in
    //  that case.  (and we want to avoid multiple checks...)
    for (; aJob.offset < aJob.items.length; aJob.offset++) {
      const item = aJob.items[aJob.offset];
      // item is either [folder ID, message key] or
      //                [folder ID, message ID]

      const glodaFolderId = item[0];
      // If the folder has been deleted since we queued, skip this message
      if (!GlodaDatastore._folderIdKnown(glodaFolderId)) {
        continue;
      }
      const glodaFolder = GlodaDatastore._mapFolderID(glodaFolderId);

      // Stay out of folders that:
      // - are compacting or being repaired / compacted and not yet processed
      // - got deleted (this would be redundant if we had a stance on id nukage)
      // (these things could have changed since we queued the event)
      if (
        glodaFolder.compacting ||
        glodaFolder.rebuildingFolderSummary ||
        glodaFolder.compacted ||
        glodaFolder._deleted
      ) {
        continue;
      }

      // get in the folder
      if (this._indexingGlodaFolder != glodaFolder) {
        yield this._indexerEnterFolder(glodaFolderId);

        // Now that we have the real nsIMsgFolder, sanity-check that we should
        //  be indexing it.  (There are some checks that require the
        //  nsIMsgFolder.)
        if (!this.shouldIndexFolder(this._indexingFolder)) {
          continue;
        }
      }

      let msgHdr;
      // GetMessageHeader can be affected by the use cache, so we need to check
      //  ContainsKey first to see if the header is really actually there.
      if (typeof item[1] == "number") {
        msgHdr =
          this._indexingDatabase.containsKey(item[1]) &&
          this._indexingFolder.GetMessageHeader(item[1]);
      } else {
        // Same deal as in move processing.
        // TODO fixme to not assume singular message-id's.
        msgHdr = this._indexingDatabase.getMsgHdrForMessageID(item[1]);
      }

      if (msgHdr) {
        yield aCallbackHandle.pushAndGo(
          this._indexMessage(msgHdr, aCallbackHandle),
          { what: "indexMessage", msgHdr }
        );
      } else {
        yield GlodaConstants.kWorkSync;
      }
    }

    // There is no real reason to stay 'in' the folder.  If we are going to get
    //  more events from the folder, its database would have to be open for us
    //  to get the events, so it's not like we're creating an efficiency
    //  problem where we unload a folder just to load it again in 2 seconds.
    // (Well, at least assuming the views are good about holding onto the
    //  database references even though they go out of their way to avoid
    //  holding onto message header references.)
    this._indexerLeaveFolder();

    yield GlodaConstants.kWorkDone;
  },

  /**
   * Recover from a "folder" or "message" job failing inside a call to
   *  |_indexMessage|, marking the message bad.  If we were not in an
   *  |_indexMessage| call, then fail to recover.
   *
   * @param {IndexingJob} aJob - The job that was being worked. We ignore this for now.
   * @param {object[]} aContextStack - The callbackHandle mechanism's context
   *   stack. When we invoke pushAndGo for _indexMessage we put something in so
   *   we can detect when it is on the async stack.
   *
   * @returns {1|false} 1 if we were able to recover (because we want the call stack
   *   popped down to our worker), false if we can't.
   */
  _recover_indexMessage(aJob, aContextStack) {
    // See if indexMessage is on the stack...
    if (
      aContextStack.length >= 2 &&
      aContextStack[1] &&
      "what" in aContextStack[1] &&
      aContextStack[1].what == "indexMessage"
    ) {
      // it is, so this is probably recoverable.

      this._log.debug(
        "Exception while indexing message, marking it bad (gloda id of 1)."
      );

      // -- Mark the message as bad
      const msgHdr = aContextStack[1].msgHdr;
      // (In the worst case, the header is no longer valid, which will result in
      //  exceptions.  We need to be prepared for that.)
      try {
        msgHdr.setUint32Property(
          GLODA_MESSAGE_ID_PROPERTY,
          GLODA_BAD_MESSAGE_ID
        );
        // clear the dirty bit if it has one
        if (msgHdr.getUint32Property(GLODA_DIRTY_PROPERTY)) {
          msgHdr.setUint32Property(GLODA_DIRTY_PROPERTY, 0);
        }
      } catch (ex) {
        // If we are indexing a folder and the message header is no longer
        //  valid, then it's quite likely the whole folder is no longer valid.
        //  But since in the event-driven message indexing case we could have
        //  other valid things to look at, let's try and recover.  The folder
        //  indexing case will come back to us shortly and we will indicate
        //  recovery is not possible at that point.
        // So do nothing here since by popping the indexing of the specific
        //  message out of existence we are recovering.
      }
      return 1;
    }
    return false;
  },

  /**
   * Cleanup after an aborted "folder" or "message" job.
   */
  _cleanup_indexing(aJob) {
    this._indexerLeaveFolder();
    aJob.safelyInvokeCallback(false);
  },

  /**
   * Maximum number of deleted messages to process at a time.  Arbitrary; there
   *  are no real known performance constraints at this point.
   */
  DELETED_MESSAGE_BLOCK_SIZE: 32,

  /**
   * Process pending deletes...
   */
  *_worker_processDeletes(aJob, aCallbackHandle) {
    // Count the number of messages we will eventually process.  People freak
    //  out when the number is constantly increasing because they think gloda
    //  has gone rogue.  (Note: new deletions can still accumulate during
    //  our execution, so we may 'expand' our count a little still.)
    this._datastore.countDeletedMessages(aCallbackHandle.wrappedCallback);
    aJob.goal = yield GlodaConstants.kWorkAsync;
    this._log.debug(
      "There are currently " +
        aJob.goal +
        " messages awaiting" +
        " deletion processing."
    );

    // get a block of messages to delete.
    const query = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE, {
      noDbQueryValidityConstraints: true,
    });
    query._deleted(1);
    query.limit(this.DELETED_MESSAGE_BLOCK_SIZE);
    let deletedCollection = query.getCollection(aCallbackHandle);
    yield GlodaConstants.kWorkAsync;

    while (deletedCollection.items.length) {
      for (const message of deletedCollection.items) {
        // If it turns out our count is wrong (because some new deletions
        //  happened since we entered this worker), let's issue a new count
        //  and use that to accurately update our goal.
        if (aJob.offset >= aJob.goal) {
          this._datastore.countDeletedMessages(aCallbackHandle.wrappedCallback);
          aJob.goal += yield GlodaConstants.kWorkAsync;
        }

        yield aCallbackHandle.pushAndGo(
          this._deleteMessage(message, aCallbackHandle)
        );
        aJob.offset++;
        yield GlodaConstants.kWorkSync;
      }

      deletedCollection = query.getCollection(aCallbackHandle);
      yield GlodaConstants.kWorkAsync;
    }
    this.pendingDeletions = false;

    yield GlodaConstants.kWorkDone;
  },

  *_worker_fixMissingContacts(aJob, aCallbackHandle) {
    const identityContactInfos = [];

    // -- asynchronously get a list of all identities without contacts
    // The upper bound on the number of messed up contacts is the number of
    //  contacts in the user's address book.  This should be small enough
    //  (and the data size small enough) that this won't explode thunderbird.
    const queryStmt = GlodaDatastore._createAsyncStatement(
      "SELECT identities.id, identities.contactID, identities.value " +
        "FROM identities " +
        "LEFT JOIN contacts ON identities.contactID = contacts.id " +
        "WHERE identities.kind = 'email' AND contacts.id IS NULL",
      true
    );
    queryStmt.executeAsync({
      handleResult(aResultSet) {
        let row;
        while ((row = aResultSet.getNextRow())) {
          identityContactInfos.push({
            identityId: row.getInt64(0),
            contactId: row.getInt64(1),
            email: row.getString(2),
          });
        }
      },
      handleError() {},
      handleCompletion() {
        GlodaDatastore._asyncCompleted();
        aCallbackHandle.wrappedCallback();
      },
    });
    queryStmt.finalize();
    GlodaDatastore._pendingAsyncStatements++;
    yield GlodaConstants.kWorkAsync;

    // -- perform fixes only if there were missing contacts
    if (identityContactInfos.length) {
      const yieldEvery = 64;
      // - create the missing contacts
      for (let i = 0; i < identityContactInfos.length; i++) {
        if (i % yieldEvery === 0) {
          yield GlodaConstants.kWorkSync;
        }

        const info = identityContactInfos[i],
          card = MailServices.ab.cardForEmailAddress(info.email),
          contact = new GlodaContact(
            GlodaDatastore,
            info.contactId,
            null,
            null,
            card ? card.displayName || info.email : info.email,
            0,
            0
          );
        GlodaDatastore.insertContact(contact);

        // update the in-memory rep of the identity to know about the contact
        //  if there is one.
        const identity = GlodaCollectionManager.cacheLookupOne(
          GlodaConstants.NOUN_IDENTITY,
          info.identityId,
          false
        );
        if (identity) {
          // Unfortunately, although this fixes the (reachable) Identity and
          //  exposes the Contact, it does not make the Contact reachable from
          //  the collection manager.  This will make explicit queries that look
          //  up the contact potentially see the case where
          //  contact.identities[0].contact !== contact.  Alternately, that
          //  may not happen and instead the "contact" object we created above
          //  may become unlinked.  (I'd have to trace some logic I don't feel
          //  like tracing.)  Either way, The potential fallout is minimal
          //  since the object identity invariant will just lapse and popularity
          //  on the contact may become stale, and neither of those meaningfully
          //  affect the operation of anything in Thunderbird.
          // If we really cared, we could find all the dominant collections
          //  that reference the identity and update their corresponding
          //  contact collection to make it reachable.  That use-case does not
          //  exist outside of here, which is why we're punting.
          identity._contact = contact;
          contact._identities = [identity];
        }

        // NOTE: If the addressbook indexer did anything useful other than
        //  adapting to name changes, we could schedule indexing of the cards at
        //  this time.  However, as of this writing, it doesn't, and this task
        //  is a one-off relevant only to the time of this writing.
      }

      // - mark all folders as dirty, initiate indexing sweep
      this.dirtyAllKnownFolders();
      this.indexingSweepNeeded = true;
    }

    // -- mark the schema upgrade, be done
    GlodaDatastore._updateSchemaVersion(GlodaDatastore._schemaVersion);
    yield GlodaConstants.kWorkDone;
  },

  /**
   * Determine whether a folder is suitable for indexing.
   *
   * @param {nsIMsgFolder} aMsgFolder - An nsIMsgFolder you want to see if we
   *   should index.
   * @returns {boolean} true if we want to index messages in this type of
   *   folder, false if we do not.
   */
  shouldIndexFolder(aMsgFolder) {
    const folderFlags = aMsgFolder.flags;
    // Completely ignore non-mail and virtual folders.  They should never even
    //  get to be GlodaFolder instances.
    if (
      !(folderFlags & Ci.nsMsgFolderFlags.Mail) ||
      folderFlags & Ci.nsMsgFolderFlags.Virtual
    ) {
      return false;
    }

    // Some folders do not really exist; we can detect this by getStringProperty
    //  exploding when we call it.  This is primarily a concern because
    //  _mapFolder calls said exploding method, but we also don't want to
    //  even think about indexing folders that don't exist.  (Such folders are
    //  likely the result of a messed up profile.)
    try {
      // flags is used because it should always be in the cache avoiding a miss
      //  which would compel an msf open.
      aMsgFolder.getStringProperty("flags");
    } catch (ex) {
      return false;
    }

    // Now see what our gloda folder information has to say about the folder.
    const glodaFolder = GlodaDatastore._mapFolder(aMsgFolder);
    return glodaFolder.indexingPriority != glodaFolder.kIndexingNeverPriority;
  },

  /**
   * Sets the indexing priority for this folder and persists it both to Gloda,
   * and, for backup purposes, to the nsIMsgFolder via string property as well.
   *
   * Setting this priority may cause the indexer to either reindex this folder,
   * or remove this folder from the existing index.
   *
   * @param {nsIMsgFolder} aFolder
   * @param {number} aPriority (one of the priority constants from GlodaFolder)
   */
  setFolderIndexingPriority(aFolder, aPriority) {
    const glodaFolder = GlodaDatastore._mapFolder(aFolder);

    // if there's been no change, we're done
    if (aPriority == glodaFolder.indexingPriority) {
      return;
    }

    // save off the old priority, and set the new one
    const previousPrio = glodaFolder.indexingPriority;
    glodaFolder._indexingPriority = aPriority;

    // persist the new priority
    GlodaDatastore.updateFolderIndexingPriority(glodaFolder);
    aFolder.setStringProperty("indexingPriority", Number(aPriority).toString());

    // if we've been told never to index this folder...
    if (aPriority == glodaFolder.kIndexingNeverPriority) {
      // stop doing so
      if (this._indexingFolder == aFolder) {
        GlodaIndexer.killActiveJob();
      }

      // mark all existing messages as deleted
      GlodaDatastore.markMessagesDeletedByFolderID(glodaFolder.id);

      // re-index
      GlodaMsgIndexer.indexingSweepNeeded = true;
    } else if (previousPrio == glodaFolder.kIndexingNeverPriority) {
      // there's no existing index, but the user now wants one
      glodaFolder._dirtyStatus = glodaFolder.kFolderFilthy;
      GlodaDatastore.updateFolderDirtyStatus(glodaFolder);
      GlodaMsgIndexer.indexingSweepNeeded = true;
    }
  },

  /**
   * Resets the indexing priority on the given folder to whatever the default
   * is for folders of that type.
   *
   * NOTE: Calls setFolderIndexingPriority under the hood, so has identical
   *       potential reindexing side-effects
   *
   * @param {nsIMsgFolder} aFolder
   * @param {boolean} aAllowSpecialFolderIndexing
   */
  resetFolderIndexingPriority(aFolder, aAllowSpecialFolderIndexing) {
    this.setFolderIndexingPriority(
      aFolder,
      GlodaDatastore.getDefaultIndexingPriority(
        aFolder,
        aAllowSpecialFolderIndexing
      )
    );
  },

  /**
   * Queue all of the folders of all of the accounts of the current profile
   *  for indexing.  We traverse all folders and queue them immediately to try
   *  and have an accurate estimate of the number of folders that need to be
   *  indexed.  (We previously queued accounts rather than immediately
   *  walking their list of folders.)
   */
  indexEverything() {
    this._log.info("Queueing all accounts for indexing.");

    GlodaDatastore._beginTransaction();
    for (const account of MailServices.accounts.accounts) {
      this.indexAccount(account);
    }
    GlodaDatastore._commitTransaction();
  },

  /**
   * Queue all of the folders belonging to an account for indexing.
   *
   * @param {nsIMsgAccount} aAccount - Account to index.
   */
  indexAccount(aAccount) {
    const rootFolder = aAccount.incomingServer.rootFolder;
    if (rootFolder instanceof Ci.nsIMsgFolder) {
      this._log.info("Queueing account folders for indexing: " + aAccount.key);

      for (const folder of rootFolder.descendants) {
        if (this.shouldIndexFolder(folder)) {
          GlodaIndexer.indexJob(
            new IndexingJob("folder", GlodaDatastore._mapFolder(folder).id)
          );
        }
      }
    } else {
      this._log.info("Skipping Account, root folder not nsIMsgFolder");
    }
  },

  /**
   * Queue a single folder for indexing given an nsIMsgFolder.
   *
   * @param {nsIMsgFolder} aMsgFolder - Folder.
   * @param {object} aOptions
   * @param {Function} [aOptions.callback] - A callback to invoke when the
   *   folder finishes indexing. First argument is true if the task ran to
   *   completion successfully, false if we had to abort for some reason.
   * @param {boolean} [aOptions.force=false] - Should we force the indexing of
   *   all messages in the folder (true) or just index what hasn't been indexed
   *   (false).
   * @returns {boolean} true if we are going to index the folder, false if not.
   */
  indexFolder(aMsgFolder, aOptions) {
    if (!this.shouldIndexFolder(aMsgFolder)) {
      return false;
    }
    const glodaFolder = GlodaDatastore._mapFolder(aMsgFolder);
    // Stay out of compacting/compacted folders and folders being repaired.
    if (
      glodaFolder.compacting ||
      glodaFolder.compacted ||
      glodaFolder.rebuildingFolderSummary
    ) {
      return false;
    }

    this._log.info(
      "Queue-ing folder for indexing: " + aMsgFolder.localizedName
    );
    const job = new IndexingJob("folder", glodaFolder.id);
    if (aOptions) {
      if ("callback" in aOptions) {
        job.callback = aOptions.callback;
      }
      if ("force" in aOptions) {
        job.force = true;
      }
    }
    GlodaIndexer.indexJob(job);
    return true;
  },

  /**
   * Queue a list of messages for indexing.
   *
   * @param {any[]} aFoldersAndMessages - List of [nsIMsgFolder, message key] tuples.
   */
  indexMessages(aFoldersAndMessages) {
    const job = new IndexingJob("message", null);
    job.items = aFoldersAndMessages.map(fm => [
      GlodaDatastore._mapFolder(fm[0]).id,
      fm[1],
    ]);
    GlodaIndexer.indexJob(job);
  },

  /**
   * Mark all known folders as dirty so that the next indexing sweep goes
   *  into all folders and checks their contents to see if they need to be
   *  indexed.
   *
   * This is being added for the migration case where we want to try and reindex
   *  all of the messages that had been marked with GLODA_BAD_MESSAGE_ID but
   *  which is now GLODA_OLD_BAD_MESSAGE_ID and so we should attempt to reindex
   *  them.
   */
  dirtyAllKnownFolders() {
    // Just iterate over the datastore's folder map and tell each folder to
    //  be dirty if its priority is not disabled.
    for (const folderID in GlodaDatastore._folderByID) {
      const glodaFolder = GlodaDatastore._folderByID[folderID];
      if (glodaFolder.indexingPriority !== glodaFolder.kIndexingNeverPriority) {
        glodaFolder._ensureFolderDirty();
      }
    }
  },

  /**
   * Given a message header, return whether this message is likely to have
   * been indexed or not.
   *
   * This means the message must:
   * - Be in a folder eligible for gloda indexing. (Not News, etc.)
   * - Be in a non-filthy folder.
   * - Be gloda-indexed and non-filthy.
   *
   * @param {nsIMsgDBHdr} aMsgHdr - A message header.
   * @returns {boolean} true if the message is likely to have been indexed.
   */
  isMessageIndexed(aMsgHdr) {
    // If it's in a folder that we flat out do not index, say no.
    if (!this.shouldIndexFolder(aMsgHdr.folder)) {
      return false;
    }
    const glodaFolder = GlodaDatastore._mapFolder(aMsgHdr.folder);
    const [glodaId, glodaDirty] = PendingCommitTracker.getGlodaState(aMsgHdr);
    return (
      glodaId >= GLODA_FIRST_VALID_MESSAGE_ID &&
      glodaDirty != GlodaMsgIndexer.kMessageFilthy &&
      glodaFolder &&
      glodaFolder.dirtyStatus != glodaFolder.kFolderFilthy
    );
  },

  /* *********** Event Processing *********** */

  /**
   * Tracks messages we have received msgKeyChanged notifications for in order
   *  to provide batching and to suppress needless reindexing when we receive
   *  the expected follow-up msgsClassified notification.
   *
   * The entries in this dictionary should be extremely short-lived as we
   *  receive the msgKeyChanged notification as the offline fake header is
   *  converted into a real header (which is accompanied by a msgAdded
   *  notification we don't pay attention to).  Once the headers finish
   *  updating, the message classifier will get its at-bat and should likely
   *  find that the messages have already been classified and so fast-path
   *  them.
   *
   * The keys in this dictionary are chosen to be consistent with those of
   *  PendingCommitTracker: the folder.URI + "#" + the (new) message key.
   * The values in the dictionary are either an object with "id" (the gloda
   *  id), "key" (the new message key), and "dirty" (is it dirty and so
   *  should still be queued for indexing) attributes, or null indicating that
   *  no change in message key occurred and so no database changes are required.
   */
  _keyChangedBatchInfo: {},

  /**
   * Common logic for things that want to feed event-driven indexing.  This gets
   *  called by both |_msgFolderListener.msgsClassified| when we are first
   *  seeing a message as well as by |_folderListener| when things happen to
   *  existing messages.  Although we could slightly specialize for the
   *  new-to-us case, it works out to be cleaner to just treat them the same
   *  and take a very small performance hit.
   *
   * @param {nsIMsgDBHdr[]} aMsgHdrs - Messages to treat as potentially changed.
   * @param {boolean} aDirtyingEvent - Is this event inherently dirtying?  Receiving a
   *     msgsClassified notification is not inherently dirtying because it is
   *     just telling us that a message exists.  We use this knowledge to
   *     ignore the msgsClassified notifications for messages we have received
   *     msgKeyChanged notifications for and fast-pathed.  Since it is possible
   *     for user action to do something that dirties the message between the
   *     time we get the msgKeyChanged notification and when we receive the
   *     msgsClassified notification, we want to make sure we don't get
   *     confused.  (Although since we remove the message from our ignore-set
   *     after the first notification, we would likely just mistakenly treat
   *     the msgsClassified notification as something dirtying, so it would
   *     still work out...)
   */
  _reindexChangedMessages(aMsgHdrs, aDirtyingEvent) {
    let glodaIdsNeedingDeletion = null;
    let messageKeyChangedIds = null,
      messageKeyChangedNewKeys = null;
    for (const msgHdr of aMsgHdrs) {
      // -- Index this folder?
      const msgFolder = msgHdr.folder;
      if (!this.shouldIndexFolder(msgFolder)) {
        continue;
      }
      // -- Ignore messages in filthy folders!
      // A filthy folder can only be processed by an indexing sweep, and at
      //  that point the message will get indexed.
      const glodaFolder = GlodaDatastore._mapFolder(msgHdr.folder);
      if (glodaFolder.dirtyStatus == glodaFolder.kFolderFilthy) {
        continue;
      }

      // -- msgKeyChanged event follow-up
      if (!aDirtyingEvent) {
        const keyChangedKey = msgHdr.folder.URI + "#" + msgHdr.messageKey;
        if (keyChangedKey in this._keyChangedBatchInfo) {
          var keyChangedInfo = this._keyChangedBatchInfo[keyChangedKey];
          delete this._keyChangedBatchInfo[keyChangedKey];

          // Null means to ignore this message because the key did not change
          //  (and the message was not dirty so it is safe to ignore.)
          if (keyChangedInfo == null) {
            continue;
          }
          // (the key may be null if we only generated the entry because the
          //  message was dirty)
          if (keyChangedInfo.key !== null) {
            if (messageKeyChangedIds == null) {
              messageKeyChangedIds = [];
              messageKeyChangedNewKeys = [];
            }
            messageKeyChangedIds.push(keyChangedInfo.id);
            messageKeyChangedNewKeys.push(keyChangedInfo.key);
          }
          // ignore the message because it was not dirty
          if (!keyChangedInfo.isDirty) {
            continue;
          }
        }
      }

      // -- Index this message?
      // We index local messages, IMAP messages that are offline, and IMAP
      // messages that aren't offline but whose folders aren't offline either
      const isFolderLocal = msgFolder instanceof Ci.nsIMsgLocalMailFolder;
      if (!isFolderLocal) {
        if (
          !(msgHdr.flags & Ci.nsMsgMessageFlags.Offline) &&
          msgFolder.getFlag(Ci.nsMsgFolderFlags.Offline)
        ) {
          continue;
        }
      }
      // Ignore messages whose processing flags indicate it has not yet been
      //  classified.  In the IMAP case if the Offline flag is going to get set
      //  we are going to see it before the msgsClassified event so this is
      //  very important.
      if (
        msgFolder.getProcessingFlags(msgHdr.messageKey) &
        NOT_YET_REPORTED_PROCESSING_FLAGS
      ) {
        continue;
      }

      const [glodaId, glodaDirty] = PendingCommitTracker.getGlodaState(msgHdr);

      const isSpam =
        msgHdr.getStringProperty(JUNK_SCORE_PROPERTY) == JUNK_SPAM_SCORE_STR;

      // -- Is the message currently gloda indexed?
      if (
        glodaId >= GLODA_FIRST_VALID_MESSAGE_ID &&
        glodaDirty != this.kMessageFilthy
      ) {
        // - Is the message spam?
        if (isSpam) {
          // Treat this as a deletion...
          if (!glodaIdsNeedingDeletion) {
            glodaIdsNeedingDeletion = [];
          }
          glodaIdsNeedingDeletion.push(glodaId);
          // and skip to the next message
          continue;
        }

        // - Mark the message dirty if it is clean.
        // (This is the only case in which we need to mark dirty so that the
        //  indexing sweep takes care of things if we don't process this in
        //  an event-driven fashion.  If the message has no gloda-id or does
        //  and it's already dirty or filthy, it is already marked for
        //  indexing.)
        if (glodaDirty == this.kMessageClean) {
          msgHdr.setUint32Property(GLODA_DIRTY_PROPERTY, this.kMessageDirty);
        }
        // if the message is pending clean, this change invalidates that.
        PendingCommitTracker.noteDirtyHeader(msgHdr);
      } else if (isSpam) {
        // If it's not indexed but is spam, ignore it.
        continue;
      }
      // (we want to index the message if we are here)

      // mark the folder dirty too, so we know to look inside
      glodaFolder._ensureFolderDirty();

      if (this._pendingAddJob == null) {
        this._pendingAddJob = new IndexingJob("message", null);
        GlodaIndexer.indexJob(this._pendingAddJob);
      }
      // only queue the message if we haven't overflowed our event-driven budget
      if (this._pendingAddJob.items.length < this._indexMaxEventQueueMessages) {
        this._pendingAddJob.items.push([
          GlodaDatastore._mapFolder(msgFolder).id,
          msgHdr.messageKey,
        ]);
      } else {
        this.indexingSweepNeeded = true;
      }
    }

    // Process any message key changes (from earlier msgKeyChanged events)
    if (messageKeyChangedIds != null) {
      GlodaDatastore.updateMessageKeys(
        messageKeyChangedIds,
        messageKeyChangedNewKeys
      );
    }

    // If we accumulated any deletions in there, batch them off now.
    if (glodaIdsNeedingDeletion) {
      GlodaDatastore.markMessagesDeletedByIDs(glodaIdsNeedingDeletion);
      this.pendingDeletions = true;
    }
  },

  /* ***** Folder Changes ***** */
  /**
   * All additions and removals are queued for processing.  Indexing messages
   * is potentially phenomenally expensive, and deletion can still be
   * relatively expensive due to our need to delete the message, its
   * attributes, and all attributes that reference it.  Additionally,
   * attribute deletion costs are higher than attribute look-up because
   * there is the actual row plus its 3 indices, and our covering indices are
   * no help there.
   *
   * @type {nsIMsgFolderListener}
   */
  _msgFolderListener: {
    indexer: null,

    /**
     * We no longer use the msgAdded notification, instead opting to wait until
     *  junk/trait classification has run (or decided not to run) and all
     *  filters have run.  The msgsClassified notification provides that for us.
     */
    msgAdded() {
      // we are never called! we do not enable this bit!
    },

    /**
     * Process (apparently newly added) messages that have been looked at by
     *  the message classifier.  This ensures that if the message was going
     *  to get marked as spam, this will have already happened.
     *
     * Besides truly new (to us) messages, We will also receive this event for
     *  messages that are the result of IMAP message move/copy operations,
     *  including both moves that generated offline fake headers and those that
     *  did not.  In the offline fake header case, however, we are able to
     *  ignore their msgsClassified events because we will have received a
     *  msgKeyChanged notification sometime in the recent past.
     */
    msgsClassified(aMsgHdrs) {
      this.indexer._log.debug("msgsClassified notification");
      try {
        GlodaMsgIndexer._reindexChangedMessages(aMsgHdrs, false);
      } catch (ex) {
        this.indexer._log.error("Explosion in msgsClassified handling:", ex);
      }
    },

    /**
     * Any messages which have had their junk state changed are marked for
     * reindexing.
     */
    msgsJunkStatusChanged(messages) {
      this.indexer._log.debug("JunkStatusChanged notification");
      GlodaMsgIndexer._reindexChangedMessages(messages, true);
    },

    /**
     * Handle real, actual deletion (move to trash and IMAP deletion model
     *  don't count); we only see the deletion here when it becomes forever,
     *  or rather _just before_ it becomes forever.  Because the header is
     *  going away, we need to either process things immediately or extract the
     *  information required to purge it later without the header.
     * To this end, we mark all messages that were indexed in the gloda message
     *  database as deleted.  We set our pending deletions flag to let our
     *  indexing logic know that after its next wave of folder traversal, it
     *  should perform a deletion pass.  If it turns out the messages are coming
     *  back, the fact that deletion is thus deferred can be handy, as we can
     *  reuse the existing gloda message.
     */
    msgsDeleted(aMsgHdrs) {
      this.indexer._log.debug("msgsDeleted notification");
      const glodaMessageIds = [];

      for (const msgHdr of aMsgHdrs) {
        const [glodaId, glodaDirty] =
          PendingCommitTracker.getGlodaState(msgHdr);
        if (
          glodaId >= GLODA_FIRST_VALID_MESSAGE_ID &&
          glodaDirty != GlodaMsgIndexer.kMessageFilthy
        ) {
          glodaMessageIds.push(glodaId);
        }
      }

      if (glodaMessageIds.length) {
        GlodaMsgIndexer._datastore.markMessagesDeletedByIDs(glodaMessageIds);
        GlodaMsgIndexer.pendingDeletions = true;
      }
    },

    /**
     * Process a move or copy.
     *
     * Moves to a local folder or an IMAP folder where we are generating offline
     *  fake headers are dealt with efficiently because we get both the source
     *  and destination headers.  The main ingredient to having offline fake
     *  headers is that allowUndo was true when the operation was performance.
     *  The only non-obvious thing is that we need to make sure that we deal
     *  with the impact of filthy folders and messages on gloda-id's (they
     *  invalidate the gloda-id).
     *
     * Moves to an IMAP folder that do not generate offline fake headers do not
     *  provide us with the target header, but the IMAP SetPendingAttributes
     *  logic will still attempt to propagate the properties on the message
     *  header so when we eventually see it in the msgsClassified notification,
     *  it should have the properties of the source message copied over.
     * We make sure that gloda-id's do not get propagated when messages are
     *  moved from IMAP folders that are marked filthy or are marked as not
     *  supposed to be indexed by clearing the pending attributes for the header
     *  being tracked by the destination IMAP folder.
     * We could fast-path the IMAP move case in msgsClassified by noticing that
     *  a message is showing up with a gloda-id header already and just
     *  performing an async location update.
     *
     * Moves that occur involving 'compacted' folders are fine and do not
     *  require special handling here.  The one tricky super-edge-case that
     *  can happen (and gets handled by the compaction pass) is the move of a
     *  message that got gloda indexed that did not already have a gloda-id and
     *  PendingCommitTracker did not get to flush the gloda-id before the
     *  compaction happened.  In that case our move logic cannot know to do
     *  anything and the gloda database still thinks the message lives in our
     *  folder.  The compaction pass will deal with this by marking the message
     *  as deleted.  The rationale being that marking it deleted allows the
     *  message to be re-used if it gets indexed in the target location, or if
     *  the target location has already been indexed, we no longer need the
     *  duplicate and it should be deleted.  (Also, it is unable to distinguish
     *  between a case where the message got deleted versus moved.)
     *
     * Because copied messages are, by their nature, duplicate messages, we
     *  do not particularly care about them.  As such, we defer their processing
     *  to the automatic sync logic that will happen much later on.  This is
     *  potentially desirable in case the user deletes some of the original
     *  messages, allowing us to reuse the gloda message representations when
     *  we finally get around to indexing the messages.  We do need to mark the
     *  folder as dirty, though, to clue in the sync logic.
     */
    msgsMoveCopyCompleted(aMove, aSrcMsgHdrs, aDestFolder, aDestMsgHdrs) {
      this.indexer._log.debug("MoveCopy notification.  Move: " + aMove);
      try {
        // ---- Move
        if (aMove) {
          // -- Effectively a deletion?
          // If the destination folder is not indexed, it's like these messages
          //  are being deleted.
          if (!GlodaMsgIndexer.shouldIndexFolder(aDestFolder)) {
            this.msgsDeleted(aSrcMsgHdrs);
            return;
          }

          // -- Avoid propagation of filthy gloda-id's.
          // If the source folder is filthy or should not be indexed (and so
          //  any gloda-id's found in there are gibberish), our only job is to
          //  strip the gloda-id's off of all the destination headers because
          //  none of the gloda-id's are valid (and so we certainly don't want
          //  to try and use them as a basis for updating message keys.)
          const srcMsgFolder = aSrcMsgHdrs[0].folder;
          if (
            !this.indexer.shouldIndexFolder(srcMsgFolder) ||
            GlodaDatastore._mapFolder(srcMsgFolder).dirtyStatus ==
              GlodaFolder.prototype.kFolderFilthy
          ) {
            // Local case, just modify the destination headers directly.
            if (aDestMsgHdrs.length > 0) {
              for (const destMsgHdr of aDestMsgHdrs) {
                // zero it out if it exists
                // (no need to deal with pending commit issues here; a filthy
                //  folder by definition has nothing indexed in it.)
                const glodaId = destMsgHdr.getUint32Property(
                  GLODA_MESSAGE_ID_PROPERTY
                );
                if (glodaId) {
                  destMsgHdr.setUint32Property(GLODA_MESSAGE_ID_PROPERTY, 0);
                }
              }

              // Since we are moving messages from a folder where they were
              //  effectively not indexed, it is up to us to make sure the
              //  messages now get indexed.
              this.indexer._reindexChangedMessages(aDestMsgHdrs);
              return;
            }

            // IMAP move case, we need to operate on the pending headers using
            //  the source header to get the pending header and as the
            //  indication of what has been already set on the pending header.
            let destDb;
            // so, this can fail, and there's not much we can do about it.
            try {
              destDb = aDestFolder.msgDatabase;
            } catch (ex) {
              this.indexer._log.warn(
                "Destination database for " +
                  aDestFolder.localizedName +
                  " not ready on IMAP move." +
                  " Gloda corruption possible."
              );
              return;
            }
            for (const srcMsgHdr of aSrcMsgHdrs) {
              // zero it out if it exists
              // (no need to deal with pending commit issues here; a filthy
              //  folder by definition has nothing indexed in it.)
              const glodaId = srcMsgHdr.getUint32Property(
                GLODA_MESSAGE_ID_PROPERTY
              );
              if (glodaId) {
                destDb.setUint32AttributeOnPendingHdr(
                  srcMsgHdr,
                  GLODA_MESSAGE_ID_PROPERTY,
                  0
                );
              }
            }

            // Nothing remains to be done. The msgsClassified event will take
            // care of making sure the message gets indexed.
            return;
          }

          // --- Have destination headers (local case):
          if (aDestMsgHdrs.length > 0) {
            // -- Update message keys for valid gloda-id's.
            // (Which means ignore filthy gloda-id's.)
            const glodaIds = [];
            const newMessageKeys = [];
            // Track whether we see any messages that are not gloda indexed so
            //  we know if we have to mark the destination folder dirty.
            let sawNonGlodaMessage = false;
            for (let iMsg = 0; iMsg < aSrcMsgHdrs.length; iMsg++) {
              const srcMsgHdr = aSrcMsgHdrs[iMsg];
              const destMsgHdr = aDestMsgHdrs[iMsg];

              const [glodaId, dirtyStatus] =
                PendingCommitTracker.getGlodaState(srcMsgHdr);
              if (
                glodaId >= GLODA_FIRST_VALID_MESSAGE_ID &&
                dirtyStatus != GlodaMsgIndexer.kMessageFilthy
              ) {
                // we may need to update the pending commit map (it checks)
                PendingCommitTracker.noteMove(srcMsgHdr, destMsgHdr);
                // but we always need to update our database
                glodaIds.push(glodaId);
                newMessageKeys.push(destMsgHdr.messageKey);
              } else {
                sawNonGlodaMessage = true;
              }
            }

            // this method takes care to update the in-memory representations
            //  too; we don't need to do anything
            if (glodaIds.length) {
              GlodaDatastore.updateMessageLocations(
                glodaIds,
                newMessageKeys,
                aDestFolder
              );
            }

            // Mark the destination folder dirty if we saw any messages that
            //  were not already gloda indexed.
            if (sawNonGlodaMessage) {
              const destGlodaFolder = GlodaDatastore._mapFolder(aDestFolder);
              destGlodaFolder._ensureFolderDirty();
              this.indexer.indexingSweepNeeded = true;
            }
          } else {
            // --- No dest headers (IMAP case):
            // Update any valid gloda indexed messages into their new folder to
            //  make the indexer's life easier when it sees the messages in their
            //  new folder.
            const glodaIds = [];

            const srcFolderIsLocal =
              srcMsgFolder instanceof Ci.nsIMsgLocalMailFolder;
            for (const msgHdr of aSrcMsgHdrs) {
              const [glodaId, dirtyStatus] =
                PendingCommitTracker.getGlodaState(msgHdr);
              if (
                glodaId >= GLODA_FIRST_VALID_MESSAGE_ID &&
                dirtyStatus != GlodaMsgIndexer.kMessageFilthy
              ) {
                // we may need to update the pending commit map (it checks)
                PendingCommitTracker.noteBlindMove(msgHdr);
                // but we always need to update our database
                glodaIds.push(glodaId);

                // XXX UNDO WORKAROUND
                // This constitutes a move from a local folder to an IMAP
                //  folder.  Undo does not currently do the right thing for us,
                //  but we have a chance of not orphaning the message if we
                //  mark the source header as dirty so that when the message
                //  gets re-added we see it.  (This does require that we enter
                //  the folder; we set the folder dirty after the loop to
                //  increase the probability of this but it's not foolproof
                //  depending on when the next indexing sweep happens and when
                //  the user performs an undo.)
                msgHdr.setUint32Property(
                  GLODA_DIRTY_PROPERTY,
                  GlodaMsgIndexer.kMessageDirty
                );
              }
            }
            // XXX ALSO UNDO WORKAROUND
            if (srcFolderIsLocal) {
              const srcGlodaFolder = GlodaDatastore._mapFolder(srcMsgFolder);
              srcGlodaFolder._ensureFolderDirty();
            }

            // quickly move them to the right folder, zeroing their message keys
            GlodaDatastore.updateMessageFoldersByKeyPurging(
              glodaIds,
              aDestFolder
            );
            // we _do not_ need to mark the folder as dirty, because the
            //  message added events will cause that to happen.
          }
        } else {
          // ---- Copy case
          // -- Do not propagate gloda-id's for copies
          // (Only applies if we have the destination header, which means local)
          for (const destMsgHdr of aDestMsgHdrs) {
            const glodaId = destMsgHdr.getUint32Property(
              GLODA_MESSAGE_ID_PROPERTY
            );
            if (glodaId) {
              destMsgHdr.setUint32Property(GLODA_MESSAGE_ID_PROPERTY, 0);
            }
          }

          // mark the folder as dirty; we'll get to it later.
          const destGlodaFolder = GlodaDatastore._mapFolder(aDestFolder);
          destGlodaFolder._ensureFolderDirty();
          this.indexer.indexingSweepNeeded = true;
        }
      } catch (ex) {
        this.indexer._log.error(
          "Problem encountered during message move/copy:",
          ex.stack
        );
      }
    },

    /**
     * Queue up message key changes that are a result of offline fake headers
     *  being made real for the actual update during the msgsClassified
     *  notification that is expected after this.  We defer the
     *  actual work (if there is any to be done; the fake header might have
     *  guessed the right UID correctly) so that we can batch our work.
     *
     * The expectation is that there will be no meaningful time window between
     *  this notification and the msgsClassified notification since the message
     *  classifier should not actually need to classify the messages (they
     *  should already have been classified) and so can fast-path them.
     */
    msgKeyChanged(aOldMsgKey, aNewMsgHdr) {
      try {
        let val = null;
        const newKey = aNewMsgHdr.messageKey;
        this.indexer._log.debug(
          `KeyChanged notification. old=${aOldMsgKey} new=${newKey}`
        );
        const [glodaId, glodaDirty] =
          PendingCommitTracker.getGlodaState(aNewMsgHdr);
        // If we haven't indexed this message yet, take no action, and leave it
        // up to msgsClassified to take proper action.
        if (glodaId < GLODA_FIRST_VALID_MESSAGE_ID) {
          return;
        }
        // take no action on filthy messages,
        // generate an entry if dirty or the keys don't match.
        if (
          glodaDirty !== GlodaMsgIndexer.kMessageFilthy &&
          (glodaDirty === GlodaMsgIndexer.kMessageDirty ||
            aOldMsgKey !== newKey)
        ) {
          val = {
            id: glodaId,
            key: aOldMsgKey !== newKey ? newKey : null,
            isDirty: glodaDirty === GlodaMsgIndexer.kMessageDirty,
          };
        }

        const key = aNewMsgHdr.folder.URI + "#" + aNewMsgHdr.messageKey;
        this.indexer._keyChangedBatchInfo[key] = val;
      } catch (ex) {
        // this is more for the unit test to fail rather than user error reporting
        this.indexer._log.error(
          "Problem encountered during msgKeyChanged" +
            " notification handling: " +
            ex +
            "\n\n" +
            ex.stack +
            " \n\n"
        );
      }
    },

    /**
     * Detect newly added folders before they get messages so we map them before
     * they get any messages added to them.  If we only hear about them after
     * they get their 1st message, then we will mark them filthy, but if we mark
     * them before that, they get marked clean.
     */
    folderAdded(aMsgFolder) {
      // This is invoked for its side-effect of invoking _mapFolder and doing so
      // only after filtering out folders we don't care about.
      GlodaMsgIndexer.shouldIndexFolder(aMsgFolder);
    },

    /**
     * Handles folder no-longer-exists-ence.  We mark all messages as deleted
     *  and remove the folder from our URI table.  Currently, if a folder that
     *  contains other folders is deleted, we may either receive one
     *  notification for the folder that is deleted, or a notification for the
     *  folder and one for each of its descendants.  This depends upon the
     *  underlying account implementation, so we explicitly handle each case.
     *  Namely, we treat it as if we're only planning on getting one, but we
     *  handle if the children are already gone for some reason.
     */
    folderDeleted(aFolder) {
      this.indexer._log.debug("folderDeleted notification");
      try {
        const delFunc = function (folder, indexer) {
          if (indexer._datastore._folderKnown(folder)) {
            indexer._log.info(
              "Processing deletion of folder " + folder.localizedName + "."
            );
            const glodaFolder = GlodaDatastore._mapFolder(folder);
            indexer._datastore.markMessagesDeletedByFolderID(glodaFolder.id);
            indexer._datastore.deleteFolderByID(glodaFolder.id);
            GlodaDatastore._killGlodaFolderIntoTombstone(glodaFolder);
          } else {
            indexer._log.info(
              "Ignoring deletion of folder " +
                folder.localizedName +
                " because it is unknown to gloda."
            );
          }
        };

        const descendantFolders = aFolder.descendants;
        // (the order of operations does not matter; child, non-child, whatever.)
        // delete the parent
        delFunc(aFolder, this.indexer);
        // delete all its descendants
        for (const folder of descendantFolders) {
          delFunc(folder, this.indexer);
        }

        this.indexer.pendingDeletions = true;
      } catch (ex) {
        this.indexer._log.error(
          "Problem encountered during folder deletion" +
            ": " +
            ex +
            "\n\n" +
            ex.stack +
            "\n\n"
        );
      }
    },

    /**
     * Handle a folder being copied or moved.
     * Moves are handled by a helper function shared with _folderRenameHelper
     *  (which takes care of any nesting involved).
     * Copies are actually ignored, because our periodic indexing traversal
     *  should discover these automatically.  We could hint ourselves into
     *  action, but arguably a set of completely duplicate messages is not
     *  a high priority for indexing.
     */
    folderMoveCopyCompleted(aMove, aSrcFolder, aDestFolder) {
      this.indexer._log.debug(
        "folderMoveCopy notification (Move: " + aMove + ")"
      );
      if (aMove) {
        const srcURI = aSrcFolder.URI;
        const targetURI =
          aDestFolder.URI + srcURI.substring(srcURI.lastIndexOf("/"));
        this._folderRenameHelper(aSrcFolder, targetURI);
      } else {
        this.indexer.indexingSweepNeeded = true;
      }
    },

    /**
     * We just need to update the URI <-> ID maps and the row in the database,
     *  all of which is actually done by the datastore for us.
     * This method needs to deal with the complexity where local folders will
     *  generate a rename notification for each sub-folder, but IMAP folders
     *  will generate only a single notification.  Our logic primarily handles
     *  this by not exploding if the original folder no longer exists.
     */
    _folderRenameHelper(aOrigFolder, aNewURI) {
      const newFolder = lazy.MailUtils.getOrCreateFolder(aNewURI);
      const specialFolderFlags =
        Ci.nsMsgFolderFlags.Trash | Ci.nsMsgFolderFlags.Junk;
      if (newFolder.isSpecialFolder(specialFolderFlags, true)) {
        const descendantFolders = newFolder.descendants;

        // First thing to do: make sure we don't index the resulting folder and
        //  its descendants.
        GlodaMsgIndexer.resetFolderIndexingPriority(newFolder);
        for (const folder of descendantFolders) {
          GlodaMsgIndexer.resetFolderIndexingPriority(folder);
        }

        // Remove from the index messages from the original folder
        this.folderDeleted(aOrigFolder);
      } else {
        const descendantFolders = aOrigFolder.descendants;

        const origURI = aOrigFolder.URI;
        // this rename is straightforward.
        GlodaDatastore.renameFolder(aOrigFolder, aNewURI);

        for (const folder of descendantFolders) {
          const oldSubURI = folder.URI;
          // mangle a new URI from the old URI.  we could also try and do a
          //  parallel traversal of the new folder hierarchy, but that seems like
          //  more work.
          const newSubURI = aNewURI + oldSubURI.substring(origURI.length);
          this.indexer._datastore.renameFolder(oldSubURI, newSubURI);
        }

        this.indexer._log.debug(
          "folder renamed: " + origURI + " to " + aNewURI
        );
      }
    },

    /**
     * Handle folder renames, dispatching to our rename helper (which also
     *  takes care of any nested folder issues.)
     */
    folderRenamed(aOrigFolder, aNewFolder) {
      this._folderRenameHelper(aOrigFolder, aNewFolder.URI);
    },

    /**
     * Helper used by folderCompactStart/folderReindexTriggered.
     */
    _reindexFolderHelper(folder, isCompacting) {
      // ignore folders we ignore...
      if (!GlodaMsgIndexer.shouldIndexFolder(folder)) {
        return;
      }

      const glodaFolder = GlodaDatastore._mapFolder(folder);
      if (isCompacting) {
        glodaFolder.compacting = true;
      }

      // Purge any explicit indexing of said folder.
      GlodaIndexer.purgeJobsUsingFilter(function (aJob) {
        return aJob.jobType == "folder" && aJob.id == glodaFolder.id;
      });

      // Abort the active job if it's in the folder (this covers both
      //  event-driven indexing that happens to be in the folder as well
      //  explicit folder indexing of the folder).
      if (GlodaMsgIndexer._indexingFolder == folder) {
        GlodaIndexer.killActiveJob();
      }

      // Tell the PendingCommitTracker to throw away anything it is tracking
      //  about the folder.  We will pick up the pieces in the compaction
      //  pass.
      PendingCommitTracker.noteFolderDatabaseGettingBlownAway(folder);

      // (We do not need to mark the folder dirty because if we were indexing
      //  it, it already must have been marked dirty.)

      // Repairing a local folder may change message keys and fix other
      // problems, so we prepare for a complete re-indexing of the folder.
      if (!isCompacting) {
        GlodaDatastore.markMessagesDeletedByFolderID(glodaFolder.id);
        glodaFolder.rebuildingFolderSummary = true;
      }
    },

    /**
     * folderCompactStart: Mark the folder as compacting in our in-memory
     * representation.  This should keep any new indexing out of the folder
     * until it is done compacting.  Also, kill any active or existing jobs
     * to index the folder.
     */
    folderCompactStart(folder) {
      this._reindexFolderHelper(folder, true);
    },

    /**
     * folderReindexTriggered: We do the same thing as folderCompactStart
     * but don't mark the folder as compacting.
     */
    folderReindexTriggered(folder) {
      this._reindexFolderHelper(folder, false);
    },

    /**
     * folderCompactFinish: Mark the folder as done compacting in our
     * in-memory representation.  Assuming the folder was known to us and
     * not marked filthy, queue a compaction job.
     */
    folderCompactFinish(folder) {
      // ignore folders we ignore...
      if (!GlodaMsgIndexer.shouldIndexFolder(folder)) {
        return;
      }

      const glodaFolder = GlodaDatastore._mapFolder(folder);
      glodaFolder.compacting = false;
      glodaFolder._setCompactedState(true);

      // Queue compaction unless the folder was filthy (in which case there
      //  are no valid gloda-id's to update.)
      if (glodaFolder.dirtyStatus != glodaFolder.kFolderFilthy) {
        GlodaIndexer.indexJob(new IndexingJob("folderCompact", glodaFolder.id));
      }

      // Queue indexing of the folder if it is dirty.  We are doing this
      //  mainly in case we were indexing it before the compaction started.
      //  It should be reasonably harmless if we weren't.
      // (It would probably be better to just make sure that there is an
      //  indexing sweep queued or active, and if it's already active that
      //  this folder is in the queue to be processed.)
      if (glodaFolder.dirtyStatus == glodaFolder.kFolderDirty) {
        GlodaIndexer.indexJob(new IndexingJob("folder", glodaFolder.id));
      }
    },
  },

  /**
   * A nsIFolderListener (listening on nsIMsgMailSession so we get all of
   *  these events) PRIMARILY to get folder loaded notifications.  Because of
   *  deficiencies in the nsIMsgFolderListener's events at this time, we also
   *  get our folder-added and newsgroup notifications from here for now.  (This
   *  will be rectified.)
   */
  _folderListener: {
    indexer: null,

    _init(aIndexer) {
      this.indexer = aIndexer;
    },

    onFolderAdded() {},
    onMessageAdded() {},
    onFolderRemoved() {},
    onMessageRemoved() {},
    onFolderPropertyChanged() {},
    /**
     * Detect changes to folder flags and reset our indexing priority.  This
     * is important because (all?) folders start out without any flags and
     * then get their flags added to them.
     */
    onFolderIntPropertyChanged(aFolderItem, aProperty, aOldValue, aNewValue) {
      if (aProperty !== "FolderFlag") {
        return;
      }
      if (!GlodaMsgIndexer.shouldIndexFolder(aFolderItem)) {
        return;
      }
      // Only reset priority if folder Special Use changes.
      if (
        (aOldValue & Ci.nsMsgFolderFlags.SpecialUse) ==
        (aNewValue & Ci.nsMsgFolderFlags.SpecialUse)
      ) {
        return;
      }
      GlodaMsgIndexer.resetFolderIndexingPriority(aFolderItem);
    },
    onFolderBoolPropertyChanged() {},
    /**
     * Notice when user activity adds/removes tags or changes a message's
     *  status.
     */
    onFolderPropertyFlagChanged(aMsgHdr, aProperty, aOldValue, aNewValue) {
      if (
        aProperty == "Keywords" ||
        // We could care less about the new flag changing.
        (aProperty == "Status" &&
          (aOldValue ^ aNewValue) != Ci.nsMsgMessageFlags.New &&
          // We do care about IMAP deletion, but msgsDeleted tells us that, so
          //  ignore IMAPDeleted too...
          (aOldValue ^ aNewValue) != Ci.nsMsgMessageFlags.IMAPDeleted) ||
        aProperty == "Flagged"
      ) {
        GlodaMsgIndexer._reindexChangedMessages([aMsgHdr], true);
      }
    },

    /**
     * Get folder loaded notifications for folders that had to do some
     *  (asynchronous) processing before they could be opened.
     */
    onFolderEvent(aFolder, aEvent) {
      if (aEvent == "FolderLoaded") {
        this.indexer._onFolderLoaded(aFolder);
      }
    },
  },

  /* ***** Rebuilding / Reindexing ***** */
  /**
   * Allow us to invalidate an outstanding folder traversal because the
   *  underlying database is going away.  We use other means for detecting
   *  modifications of the message (labeling, marked (un)read, starred, etc.)
   *
   * This is an nsIDBChangeListener listening to an nsIDBChangeAnnouncer.  To
   *  add ourselves, we get us a nice nsMsgDatabase, query it to the announcer,
   *  then call addListener.
   */
  _databaseAnnouncerListener: {
    indexer: null,
    /**
     * XXX We really should define the operations under which we expect this to
     *  occur.  While we know this must be happening as the result of a
     *  ForceClosed call, we don't have a comprehensive list of when this is
     *  expected to occur.  Some reasons:
     * - Compaction (although we should already have killed the job thanks to
     *    our compaction notification)
     * - UID validity rolls.
     * - Folder Rename
     * - Folder Delete
     * The fact that we already have the database open when getting this means
     *  that it had to be valid before we opened it, which hopefully rules out
     *  modification of the mbox file by an external process (since that is
     *  forbidden when we are running) and many other exotic things.
     *
     * So this really ends up just being a correctness / safety protection
     *  mechanism.  At least now that we have better compaction support.
     */
    onAnnouncerGoingAway() {
      // The fact that we are getting called means we have an active folder and
      //  that we therefore are the active job.  As such, we must kill the
      //  active job.
      // XXX In the future, when we support interleaved event-driven indexing
      //  that bumps long-running indexing tasks, the semantics of this will
      //  have to change a bit since we will want to maintain being active in a
      //  folder even when bumped.  However, we will probably have a more
      //  complex notion of indexing contexts on a per-job basis.
      GlodaIndexer.killActiveJob();
    },

    onHdrFlagsChanged() {},
    onHdrDeleted() {},
    onHdrAdded() {},
    onParentChanged() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
  },

  /**
   * Given a list of Message-ID's, return a matching list of lists of messages
   *  matching those Message-ID's.  So if you pass an array with three
   *  Message-ID's ["a", "b", "c"], you would get back an array containing
   *  3 lists, where the first list contains all the messages with a message-id
   *  of "a", and so forth.  The reason a list is returned rather than null/a
   *  message is that we accept the reality that we have multiple copies of
   *  messages with the same ID.
   * This call is asynchronous because it depends on previously created messages
   *  to be reflected in our results, which requires us to execute on the async
   *  thread where all our writes happen.  This also turns out to be a
   *  reasonable thing because we could imagine pathological cases where there
   *  could be a lot of message-id's and/or a lot of messages with those
   *  message-id's.
   *
   * The returned collection will include both 'ghost' messages (messages
   *  that exist for conversation-threading purposes only) as well as deleted
   *  messages in addition to the normal 'live' messages that non-privileged
   *  queries might return.
   */
  getMessagesByMessageID(aMessageIDs, aCallback, aCallbackThis) {
    const msgIDToIndex = {};
    const results = [];
    for (let iID = 0; iID < aMessageIDs.length; ++iID) {
      const msgID = aMessageIDs[iID];
      results.push([]);
      msgIDToIndex[msgID] = iID;
    }

    // (Note: although we are performing a lookup with no validity constraints
    //  and using the same object-relational-mapper-ish layer used by things
    //  that do have constraints, we are not at risk of exposing deleted
    //  messages to other code and getting it confused.  The only way code
    //  can find a message is if it shows up in their queries or gets announced
    //  via GlodaCollectionManager.itemsAdded, neither of which will happen.)
    const query = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE, {
      noDbQueryValidityConstraints: true,
    });
    query.headerMessageID.apply(query, aMessageIDs);
    query.frozen = true;

    const listener = new MessagesByMessageIdCallback(
      msgIDToIndex,
      results,
      aCallback,
      aCallbackThis
    );
    return query.getCollection(listener, null, { becomeNull: true });
  },

  /**
   * A reference to MsgHdrToMimeMessage that unit testing can clobber when it
   *  wants to cause us to hang or inject a fault.  If you are not
   *  glodaTestHelper.js then _do not touch this_.
   */
  _MsgHdrToMimeMessageFunc: MsgHdrToMimeMessage,
  /**
   * Primary message indexing logic.  This method is mainly concerned with
   *  getting all the information about the message required for threading /
   *  conversation building and subsequent processing.  It is responsible for
   *  determining whether to reuse existing gloda messages or whether a new one
   *  should be created.  Most attribute stuff happens in fund_attr.js or
   *  expl_attr.js.
   *
   * Prior to calling this method, the caller must have invoked
   *  |_indexerEnterFolder|, leaving us with the following true invariants
   *  below.
   *  - aMsgHdr.folder == this._indexingFolder
   *  - aMsgHdr.folder.msgDatabase == this._indexingDatabase
   *
   * @param {nsIMsgDBHdr} aMsgHdr
   * @param {object} aCallbackHandle
   */
  *_indexMessage(aMsgHdr, aCallbackHandle) {
    this._log.debug(
      "*** Indexing message: " + aMsgHdr.messageKey + " : " + aMsgHdr.subject
    );

    // If the message is offline, then get the message body as well
    let aMimeMsg;
    if (
      aMsgHdr.flags & Ci.nsMsgMessageFlags.Offline ||
      aMsgHdr.folder instanceof Ci.nsIMsgLocalMailFolder
    ) {
      this._MsgHdrToMimeMessageFunc(
        aMsgHdr,
        aCallbackHandle.callbackThis,
        aCallbackHandle.callback,
        false,
        {
          saneBodySize: true,
        }
      );
      aMimeMsg = (yield GlodaConstants.kWorkAsync)[1];
    } else {
      this._log.debug("  * Message is not offline -- only headers indexed");
    }

    this._log.debug("  * Got message, subject " + aMsgHdr.subject);

    if (this._unitTestSuperVerbose) {
      if (aMimeMsg) {
        this._log.debug("  * Got Mime " + aMimeMsg.prettyString());
      } else {
        this._log.debug("  * NO MIME MESSAGE!!!\n");
      }
    }

    // -- Find/create the conversation the message belongs to.
    // Our invariant is that all messages that exist in the database belong to
    //  a conversation.

    // - See if any of the ancestors exist and have a conversationID...
    // (references are ordered from old [0] to new [n-1])
    const references = Array.from(range(0, aMsgHdr.numReferences)).map(i =>
      aMsgHdr.getStringReference(i)
    );
    // also see if we already know about the message...
    references.push(aMsgHdr.messageId);

    this.getMessagesByMessageID(
      references,
      aCallbackHandle.callback,
      aCallbackHandle.callbackThis
    );
    // (ancestorLists has a direct correspondence to the message ids)
    const ancestorLists = yield GlodaConstants.kWorkAsync;

    this._log.debug("ancestors raw: " + ancestorLists);
    this._log.debug(
      "ref len: " + references.length + " anc len: " + ancestorLists.length
    );
    this._log.debug("references: " + references);
    this._log.debug("ancestors: " + ancestorLists);

    // pull our current message lookup results off
    references.pop();
    const candidateCurMsgs = ancestorLists.pop();

    let conversationID = null;
    let conversation = null;
    // -- figure out the conversation ID
    // if we have a clone/already exist, just use his conversation ID
    if (candidateCurMsgs.length > 0) {
      conversationID = candidateCurMsgs[0].conversationID;
      conversation = candidateCurMsgs[0].conversation;
    } else {
      // otherwise check out our ancestors
      // (walk from closest to furthest ancestor)
      for (
        let iAncestor = ancestorLists.length - 1;
        iAncestor >= 0;
        --iAncestor
      ) {
        const ancestorList = ancestorLists[iAncestor];

        if (ancestorList.length > 0) {
          // we only care about the first instance of the message because we are
          //  able to guarantee the invariant that all messages with the same
          //  message id belong to the same conversation.
          const ancestor = ancestorList[0];
          if (conversationID === null) {
            conversationID = ancestor.conversationID;
            conversation = ancestor.conversation;
          } else if (conversationID != ancestor.conversationID) {
            // XXX this inconsistency is known and understood and tracked by
            //  bug 478162 https://bugzilla.mozilla.org/show_bug.cgi?id=478162
            // this._log.error("Inconsistency in conversations invariant on " +
            //                ancestor.headerMessageID + ".  It has conv id " +
            //                ancestor.conversationID + " but expected " +
            //                conversationID + ". ID: " + ancestor.id);
          }
        }
      }
    }

    // nobody had one?  create a new conversation
    if (conversationID === null) {
      // (the create method could issue the id, making the call return
      //  without waiting for the database...)
      conversation = this._datastore.createConversation(
        aMsgHdr.mime2DecodedSubject,
        null,
        null
      );
      conversationID = conversation.id;
    }

    // Walk from furthest to closest ancestor, creating the ancestors that don't
    //  exist. (This is possible if previous messages that were consumed in this
    //  thread only had an in-reply-to or for some reason did not otherwise
    //  provide the full references chain.)
    for (let iAncestor = 0; iAncestor < ancestorLists.length; ++iAncestor) {
      const ancestorList = ancestorLists[iAncestor];

      if (ancestorList.length == 0) {
        this._log.debug(
          "creating message with: null, " +
            conversationID +
            ", " +
            references[iAncestor] +
            ", null."
        );
        const ancestor = this._datastore.createMessage(
          null,
          null, // ghost
          conversationID,
          null,
          references[iAncestor],
          null, // no subject
          null, // no body
          null
        ); // no attachments
        this._datastore.insertMessage(ancestor);
        ancestorLists[iAncestor].push(ancestor);
      }
    }
    // now all our ancestors exist, though they may be ghost-like...

    // find if there's a ghost version of our message or we already have indexed
    //  this message.
    let curMsg = null;
    this._log.debug(candidateCurMsgs.length + " candidate messages");
    for (let iCurCand = 0; iCurCand < candidateCurMsgs.length; iCurCand++) {
      const candMsg = candidateCurMsgs[iCurCand];

      this._log.debug(
        "candidate folderID: " +
          candMsg.folderID +
          " messageKey: " +
          candMsg.messageKey
      );

      if (candMsg.folderURI == this._indexingFolder.URI) {
        // if we are in the same folder and we have the same message key, we
        //  are definitely the same, stop looking.
        if (candMsg.messageKey == aMsgHdr.messageKey) {
          curMsg = candMsg;
          break;
        }
        // if (we are in the same folder and) the candidate message has a null
        //  message key, we treat it as our best option unless we find an exact
        //  key match. (this would happen because the 'move' notification case
        //  has to deal with not knowing the target message key.  this case
        //  will hopefully be somewhat improved in the future to not go through
        //  this path which mandates re-indexing of the message in its entirety)
        if (candMsg.messageKey === null) {
          curMsg = candMsg;
        } else if (
          curMsg === null &&
          !this._indexingDatabase.containsKey(candMsg.messageKey)
        ) {
          // (We are in the same folder and) the candidate message's underlying
          // message no longer exists/matches. Assume we are the same but
          // were betrayed by a re-indexing or something, but we have to make
          // sure a perfect match doesn't turn up.
          curMsg = candMsg;
        }
      } else if (curMsg === null && candMsg.folderID === null) {
        // a ghost/deleted message is fine
        curMsg = candMsg;
      }
    }

    const attachmentNames =
      aMimeMsg?.allAttachments.map(att => att.name) || null;

    let isConceptuallyNew, isRecordNew, insertFulltext;
    if (curMsg === null) {
      curMsg = this._datastore.createMessage(
        aMsgHdr.folder,
        aMsgHdr.messageKey,
        conversationID,
        aMsgHdr.date,
        aMsgHdr.messageId
      );
      curMsg._conversation = conversation;
      isConceptuallyNew = isRecordNew = insertFulltext = true;
    } else {
      isRecordNew = false;
      // the message is conceptually new if it was a ghost or dead.
      isConceptuallyNew = curMsg._isGhost || curMsg._isDeleted;
      // insert fulltext if it was a ghost
      insertFulltext = curMsg._isGhost;
      curMsg._folderID = this._datastore._mapFolder(aMsgHdr.folder).id;
      curMsg._messageKey = aMsgHdr.messageKey;
      curMsg.date = new Date(aMsgHdr.date / 1000);
      // the message may have been deleted; tell it to make sure it's not.
      curMsg._ensureNotDeleted();
      // note: we are assuming that our matching logic is flawless in that
      //  if this message was not a ghost, we are assuming the 'body'
      //  associated with the id is still exactly the same.  It is conceivable
      //  that there are cases where this is not true.
    }

    if (aMimeMsg) {
      const bodyPlain = aMimeMsg.coerceBodyToPlaintext(aMsgHdr.folder);
      if (bodyPlain) {
        curMsg._bodyLines = bodyPlain.split(/\r?\n/);
        // curMsg._content gets set by GlodaFundAttr.sys.mjs
      }
    }

    // Mark the message as new (for the purposes of fulltext insertion)
    if (insertFulltext) {
      curMsg._isNew = true;
    }

    curMsg._subject = aMsgHdr.mime2DecodedSubject;
    curMsg._attachmentNames = attachmentNames;

    // curMsg._indexAuthor gets set by GlodaFundAttr.sys.mjs
    // curMsg._indexRecipients gets set by GlodaFundAttr.sys.mjs

    // zero the notability so everything in grokNounItem can just increment
    curMsg.notability = 0;

    yield aCallbackHandle.pushAndGo(
      Gloda.grokNounItem(
        curMsg,
        { header: aMsgHdr, mime: aMimeMsg, bodyLines: curMsg._bodyLines },
        isConceptuallyNew,
        isRecordNew,
        aCallbackHandle
      )
    );

    delete curMsg._bodyLines;
    delete curMsg._content;
    delete curMsg._isNew;
    delete curMsg._indexAuthor;
    delete curMsg._indexRecipients;

    // we want to update the header for messages only after the transaction
    //  irrevocably hits the disk.  otherwise we could get confused if the
    //  transaction rolls back or what not.
    PendingCommitTracker.track(aMsgHdr, curMsg.id);

    yield GlodaConstants.kWorkDone;
  },

  /**
   * Wipe a message out of existence from our index.  This is slightly more
   *  tricky than one would first expect because there are potentially
   *  attributes not immediately associated with this message that reference
   *  the message.  Not only that, but deletion of messages may leave a
   *  conversation possessing only ghost messages, which we don't want, so we
   *  need to nuke the moot conversation and its moot ghost messages.
   * For now, we are actually punting on that trickiness, and the exact
   *  nuances aren't defined yet because we have not decided whether to store
   *  such attributes redundantly.  For example, if we have subject-pred-object,
   *  we could actually store this as attributes (subject, id, object) and
   *  (object, id, subject).  In such a case, we could query on (subject, *)
   *  and use the results to delete the (object, id, subject) case.  If we
   *  don't redundantly store attributes, we can deal with the problem by
   *  collecting up all the attributes that accept a message as their object
   *  type and issuing a delete against that.  For example, delete (*, [1,2,3],
   *  message id).
   * (We are punting because we haven't implemented support for generating
   *  attributes like that yet.)
   *
   * TODO: implement deletion of attributes that reference (deleted) messages.
   *
   * @param {nsIMsgDBHdr} aMessage
   * @param {object} aCallbackHandle
   */
  *_deleteMessage(aMessage, aCallbackHandle) {
    this._log.debug("*** Deleting message: " + aMessage);

    // -- delete our attributes
    // delete the message's attributes (if we implement the cascade delete, that
    //  could do the honors for us... right now we define the trigger in our
    //  schema but the back-end ignores it)
    GlodaDatastore.clearMessageAttributes(aMessage);

    // -- delete our message or ghost us, and maybe nuke the whole conversation
    // Look at the other messages in the conversation.
    // (Note: although we are performing a lookup with no validity constraints
    //  and using the same object-relational-mapper-ish layer used by things
    //  that do have constraints, we are not at risk of exposing deleted
    //  messages to other code and getting it confused.  The only way code
    //  can find a message is if it shows up in their queries or gets announced
    //  via GlodaCollectionManager.itemsAdded, neither of which will happen.)
    const convPrivQuery = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE, {
      noDbQueryValidityConstraints: true,
    });
    convPrivQuery.conversation(aMessage.conversation);
    const conversationCollection = convPrivQuery.getCollection(aCallbackHandle);
    yield GlodaConstants.kWorkAsync;

    const conversationMsgs = conversationCollection.items;

    // Count the number of ghosts messages we see to determine if we are
    //  the last message alive.
    let ghostCount = 0;
    let twinMessageExists = false;
    for (const convMsg of conversationMsgs) {
      // ignore our own message
      if (convMsg.id == aMessage.id) {
        continue;
      }

      if (convMsg._isGhost) {
        ghostCount++;
      } else if (
        // This message is our (living) twin if it is not a ghost, not deleted,
        // and has the same message-id header.
        !convMsg._isDeleted &&
        convMsg.headerMessageID == aMessage.headerMessageID
      ) {
        twinMessageExists = true;
      }
    }

    // -- If everyone else is a ghost, blow away the conversation.
    // If there are messages still alive or deleted but we have not yet gotten
    //  to them yet _deleteMessage, then do not do this.  (We will eventually
    //  hit this case if they are all deleted.)
    if (conversationMsgs.length - 1 == ghostCount) {
      // - Obliterate each message
      for (const msg of conversationMsgs) {
        GlodaDatastore.deleteMessageByID(msg.id);
      }
      // - Obliterate the conversation
      GlodaDatastore.deleteConversationByID(aMessage.conversationID);
      // *no one* should hold a reference or use aMessage after this point,
      //  trash it so such ne'er do'wells are made plain.
      aMessage._objectPurgedMakeYourselfUnpleasant();
    } else if (twinMessageExists) {
      // -- Ghost or purge us as appropriate
      // Purge us if we have a (living) twin; no ghost required.
      GlodaDatastore.deleteMessageByID(aMessage.id);
      // *no one* should hold a reference or use aMessage after this point,
      //  trash it so such ne'er do'wells are made plain.
      aMessage._objectPurgedMakeYourselfUnpleasant();
    } else {
      // No twin, a ghost is required, we become the ghost.
      aMessage._ghost();
      GlodaDatastore.updateMessage(aMessage);
      // ghosts don't have fulltext. purge it.
      GlodaDatastore.deleteMessageTextByID(aMessage.id);
    }

    yield GlodaConstants.kWorkDone;
  },
};

GlodaIndexer.registerIndexer(GlodaMsgIndexer);
