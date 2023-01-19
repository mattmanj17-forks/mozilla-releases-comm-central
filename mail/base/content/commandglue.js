/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Command-specific code. This stuff should be called by the widgets
 */

/* import-globals-from mailWindow.js */
/* import-globals-from messenger.js */
/* global BigInt */

var { MailViewConstants } = ChromeUtils.import(
  "resource:///modules/MailViewManager.jsm"
);

function isNewsURI(uri) {
  if (!uri) {
    return false;
  }
  return uri.startsWith("news:/") || uri.startsWith("news-message:/");
}

function SetNewsFolderColumns() {
  var sizeColumn = document.getElementById("sizeCol");
  var bundle = document.getElementById("bundle_messenger");

  if (gDBView.usingLines) {
    sizeColumn.setAttribute("label", bundle.getString("linesColumnHeader"));
    sizeColumn.setAttribute(
      "tooltiptext",
      bundle.getString("linesColumnTooltip2")
    );
  } else {
    sizeColumn.setAttribute("label", bundle.getString("sizeColumnHeader"));
    sizeColumn.setAttribute(
      "tooltiptext",
      bundle.getString("sizeColumnTooltip2")
    );
  }
}

/**
 * For non-folder based tabs, message counts don't apply.
 * Therefore hide the counts for those folders. For folder based tabs
 * let the tab decide whether or not to show it in UpdateStatusMessageCounts().
 */
var statusMessageCountsMonitor = {
  onTabTitleChanged() {},
  onTabSwitched(aTab, aOldTab) {
    if (aTab.mode.name != "folder" && aTab.mode.name != "glodaSearch") {
      document.getElementById("unreadMessageCount").hidden = true;
      document.getElementById("totalMessageCount").hidden = true;
    }
  },
};

function UpdateStatusMessageCounts(folder) {
  var unreadElement = document.getElementById("unreadMessageCount");
  var totalElement = document.getElementById("totalMessageCount");
  if (folder && !folder.isServer && unreadElement && totalElement) {
    var numSelected = 0; // TODO
    var bundle = document.getElementById("bundle_messenger");

    var numUnread =
      numSelected > 1
        ? bundle.getFormattedString("selectedMsgStatus", [numSelected])
        : bundle.getFormattedString("unreadMsgStatus", [
            folder.getNumUnread(false),
          ]);
    var numTotal = bundle.getFormattedString("totalMsgStatus", [
      folder.getTotalMessages(false),
    ]);

    unreadElement.setAttribute("value", numUnread);
    totalElement.setAttribute("value", numTotal);
    unreadElement.hidden = false;
    totalElement.hidden = false;
  }
}

function UpdateStatusQuota(folder) {
  if (!document.getElementById("quotaPanel")) {
    // No quotaPanel in here, like for the search window.
    return;
  }

  if (!(folder && folder instanceof Ci.nsIMsgImapMailFolder)) {
    document.getElementById("quotaPanel").hidden = true;
    return;
  }

  let quotaUsagePercentage = q =>
    Number((100n * BigInt(q.usage)) / BigInt(q.limit));

  // For display on main window panel only include quota names containing
  // "STORAGE" or "MESSAGE". This will exclude unusual quota names containing
  // items like "MAILBOX" and "LEVEL" from the panel bargraph. All quota names
  // will still appear on the folder properties quota window.
  // Note: Quota name is typically something like "User Quota / STORAGE".
  let folderQuota = folder
    .getQuota()
    .filter(
      quota =>
        quota.name.toUpperCase().includes("STORAGE") ||
        quota.name.toUpperCase().includes("MESSAGE")
    );
  // If folderQuota not empty, find the index of the element with highest
  //  percent usage and determine if it is above the panel display threshold.
  if (folderQuota.length > 0) {
    let highest = folderQuota.reduce((acc, current) =>
      quotaUsagePercentage(acc) > quotaUsagePercentage(current) ? acc : current
    );
    let percent = quotaUsagePercentage(highest);
    if (
      percent <
      Services.prefs.getIntPref("mail.quota.mainwindow_threshold.show")
    ) {
      document.getElementById("quotaPanel").hidden = true;
    } else {
      document.getElementById("quotaPanel").hidden = false;
      document.getElementById("quotaMeter").setAttribute("value", percent);
      var bundle = document.getElementById("bundle_messenger");
      document.getElementById(
        "quotaLabel"
      ).value = bundle.getFormattedString("percent", [percent]);
      document.getElementById(
        "quotaLabel"
      ).tooltipText = bundle.getFormattedString("quotaTooltip2", [
        highest.usage,
        highest.limit,
      ]);
      let quotaPanel = document.getElementById("quotaPanel");
      if (
        percent <
        Services.prefs.getIntPref("mail.quota.mainwindow_threshold.warning")
      ) {
        quotaPanel.classList.remove("alert-warning", "alert-critical");
      } else if (
        percent <
        Services.prefs.getIntPref("mail.quota.mainwindow_threshold.critical")
      ) {
        quotaPanel.classList.remove("alert-critical");
        quotaPanel.classList.add("alert-warning");
      } else {
        quotaPanel.classList.remove("alert-warning");
        quotaPanel.classList.add("alert-critical");
      }
    }
  } else {
    document.getElementById("quotaPanel").hidden = true;
  }
}

function ConvertSortTypeToColumnID(sortKey) {
  var columnID;

  // Hack to turn this into an integer, if it was a string.
  // It would be a string if it came from XULStore.json.
  sortKey = sortKey - 0;

  switch (sortKey) {
    // In the case of None, we default to the date column
    // This appears to be the case in such instances as
    // Global search, so don't complain about it.
    case Ci.nsMsgViewSortType.byNone:
    case Ci.nsMsgViewSortType.byDate:
      columnID = "dateCol";
      break;
    case Ci.nsMsgViewSortType.byReceived:
      columnID = "receivedCol";
      break;
    case Ci.nsMsgViewSortType.byAuthor:
      columnID = "senderCol";
      break;
    case Ci.nsMsgViewSortType.byRecipient:
      columnID = "recipientCol";
      break;
    case Ci.nsMsgViewSortType.bySubject:
      columnID = "subjectCol";
      break;
    case Ci.nsMsgViewSortType.byLocation:
      columnID = "locationCol";
      break;
    case Ci.nsMsgViewSortType.byAccount:
      columnID = "accountCol";
      break;
    case Ci.nsMsgViewSortType.byUnread:
      columnID = "unreadButtonColHeader";
      break;
    case Ci.nsMsgViewSortType.byStatus:
      columnID = "statusCol";
      break;
    case Ci.nsMsgViewSortType.byTags:
      columnID = "tagsCol";
      break;
    case Ci.nsMsgViewSortType.bySize:
      columnID = "sizeCol";
      break;
    case Ci.nsMsgViewSortType.byPriority:
      columnID = "priorityCol";
      break;
    case Ci.nsMsgViewSortType.byFlagged:
      columnID = "flaggedCol";
      break;
    case Ci.nsMsgViewSortType.byThread:
      columnID = "threadCol";
      break;
    case Ci.nsMsgViewSortType.byId:
      columnID = "idCol";
      break;
    case Ci.nsMsgViewSortType.byJunkStatus:
      columnID = "junkStatusCol";
      break;
    case Ci.nsMsgViewSortType.byAttachments:
      columnID = "attachmentCol";
      break;
    case Ci.nsMsgViewSortType.byCustom:
      // TODO: either change try() catch to if (property exists) or restore the getColumnHandler() check
      try {
        // getColumnHandler throws an error when the ID is not handled
        columnID = gDBView.curCustomColumn;
      } catch (err) {
        // error - means no handler
        dump(
          "ConvertSortTypeToColumnID: custom sort key but no handler for column '" +
            columnID +
            "'\n"
        );
        columnID = "dateCol";
      }

      break;
    case Ci.nsMsgViewSortType.byCorrespondent:
      columnID = "correspondentCol";
      break;
    default:
      dump("unsupported sort key: " + sortKey + "\n");
      columnID = "dateCol";
      break;
  }
  return columnID;
}

var gDBView = null;
var gCurViewFlags;
var gCurSortType;

/**
 * Our multiplexed tabbing model ends up sending synthetic folder pane
 *  selection change notifications.  We want to ignore these because the
 *  user may explicitly re-select a folder intentionally, and we want to
 *  be able to know that.  So we filter out the synthetics here.
 * The tabbing logic sets this global to help us out.
 */
var gIgnoreSyntheticFolderPaneSelectionChange = false;
function FolderPaneSelectionChange() {}

function Undo() {
  messenger.undo(msgWindow);
}

function Redo() {
  messenger.redo(msgWindow);
}