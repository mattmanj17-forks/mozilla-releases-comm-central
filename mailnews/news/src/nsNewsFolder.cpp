/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsNewsFolder.h"

#include "nsIDBFolderInfo.h"
#include "prlog.h"

#include "msgCore.h"  // precompiled header...
#include "nsIMsgMailNewsUrl.h"
#include "nsMsgFolderFlags.h"
#include "MailNewsTypes.h"
#include "prprf.h"
#include "prsystem.h"
#include "nsTArray.h"
#include "nsINntpService.h"
#include "nsIMsgFilterService.h"
#include "nsCOMPtr.h"
#include "nsMsgUtils.h"

#include "nsIMsgIncomingServer.h"
#include "nsINntpIncomingServer.h"
#include "nsINewsDatabase.h"
#include "nsILineInputStream.h"

#include "nsIMsgWindow.h"

#include "nsLocalFile.h"
#include "nsNetUtil.h"
#include "nsIAuthPrompt.h"
#include "nsIURL.h"
#include "nsNetCID.h"
#include "nsINntpUrl.h"

#include "nsIStringBundle.h"
#include "nsMsgI18N.h"

#include "nsIMsgFolderNotificationService.h"
#include "nsILoginInfo.h"
#include "nsILoginManager.h"
#include "mozilla/Components.h"
#include "mozilla/Preferences.h"
#include "nsIInputStream.h"
#include "nsIURIMutator.h"

#define kNewsRootURI "news:/"
#define kNewsMessageRootURI "news-message:/"

using mozilla::Preferences;

nsMsgNewsFolder::nsMsgNewsFolder(void)
    : mExpungedBytes(0),
      mGettingNews(false),
      mInitialized(false),
      m_downloadMessageForOfflineUse(false),
      mReadSet(nullptr) {
  mFolderSize = kSizeUnknown;
}

nsMsgNewsFolder::~nsMsgNewsFolder(void) {}

NS_IMPL_ADDREF_INHERITED(nsMsgNewsFolder, nsMsgDBFolder)
NS_IMPL_RELEASE_INHERITED(nsMsgNewsFolder, nsMsgDBFolder)

NS_IMETHODIMP nsMsgNewsFolder::QueryInterface(REFNSIID aIID,
                                              void** aInstancePtr) {
  if (!aInstancePtr) return NS_ERROR_NULL_POINTER;
  *aInstancePtr = nullptr;

  if (aIID.Equals(NS_GET_IID(nsIMsgNewsFolder)))
    *aInstancePtr = static_cast<nsIMsgNewsFolder*>(this);
  if (*aInstancePtr) {
    AddRef();
    return NS_OK;
  }

  return nsMsgDBFolder::QueryInterface(aIID, aInstancePtr);
}

////////////////////////////////////////////////////////////////////////////////

nsresult nsMsgNewsFolder::CreateSubFolders(nsIFile* path) {
  nsresult rv;
  bool isNewsServer = false;
  rv = GetIsServer(&isNewsServer);
  if (NS_FAILED(rv)) return rv;

  if (isNewsServer) {
    nsCOMPtr<nsINntpIncomingServer> nntpServer;
    rv = GetNntpServer(getter_AddRefs(nntpServer));
    NS_ENSURE_SUCCESS(rv, rv);

    rv = nntpServer->GetNewsrcFilePath(getter_AddRefs(mNewsrcFilePath));
    NS_ENSURE_SUCCESS(rv, rv);

    rv = LoadNewsrcFileAndCreateNewsgroups();
  } else  // is not a host, so it has no newsgroups.  (what about categories??)
    rv = NS_OK;
  return rv;
}

NS_IMETHODIMP
nsMsgNewsFolder::AddNewsgroup(const nsACString& name, const nsACString& setStr,
                              nsIMsgFolder** child) {
  NS_ENSURE_ARG_POINTER(child);
  nsresult rv;

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  rv = GetNntpServer(getter_AddRefs(nntpServer));
  if (NS_FAILED(rv)) return rv;

  nsAutoCString uri(mURI);
  uri.Append('/');
  // URI should use UTF-8
  // (see RFC2396 Uniform Resource Identifiers (URI): Generic Syntax)

  nsAutoCString escapedName;
  rv = NS_MsgEscapeEncodeURLPath(name, escapedName);
  if (NS_FAILED(rv)) return rv;

  rv = nntpServer->AddNewsgroup(name);
  if (NS_FAILED(rv)) return rv;

  uri.Append(escapedName);

  nsCOMPtr<nsIMsgFolder> folder;
  rv = GetOrCreateFolder(uri, getter_AddRefs(folder));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgNewsFolder> newsFolder(do_QueryInterface(folder, &rv));
  NS_ENSURE_SUCCESS(rv, rv);

  // Ensure any containing .sdb dir exists.
  nsCOMPtr<nsIFile> path;
  rv = CreateDirectoryForFolder(getter_AddRefs(path));
  NS_ENSURE_SUCCESS(rv, rv);

  // cache this for when we open the db
  rv = newsFolder->SetReadSetFromStr(setStr);

  rv = folder->SetParent(this);
  NS_ENSURE_SUCCESS(rv, rv);

  // this what shows up in the UI
  rv = folder->SetName(name);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = folder->SetFlag(nsMsgFolderFlags::Newsgroup);
  if (NS_FAILED(rv)) return rv;

  mSubFolders.AppendObject(folder);
  folder->SetParent(this);
  folder.forget(child);
  return rv;
}

nsresult nsMsgNewsFolder::ParseFolder(nsIFile* path) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

nsresult nsMsgNewsFolder::AddDirectorySeparator(nsIFile* path) {
  // don't concat the full separator with .sbd
  return (mURI.Equals(kNewsRootURI))
             ? NS_OK
             : nsMsgDBFolder::AddDirectorySeparator(path);
}

NS_IMETHODIMP
nsMsgNewsFolder::GetSubFolders(nsTArray<RefPtr<nsIMsgFolder>>& folders) {
  if (!mInitialized) {
    // do this first, so we make sure to do it, even on failure.
    // see bug #70494
    mInitialized = true;

    nsCOMPtr<nsIFile> path;
    nsresult rv = GetFilePath(getter_AddRefs(path));
    if (NS_FAILED(rv)) return rv;

    rv = CreateSubFolders(path);
    if (NS_FAILED(rv)) return rv;

    // force ourselves to get initialized from cache
    // Don't care if it fails.  this will fail the first time after
    // migration, but we continue on.  see #66018
    (void)UpdateSummaryTotals(false);
  }

  return nsMsgDBFolder::GetSubFolders(folders);
}

// Makes sure the database is open and exists.  If the database is valid then
// returns NS_OK.  Otherwise returns a failure error value.
nsresult nsMsgNewsFolder::GetDatabase() {
  nsresult rv;
  if (!mDatabase) {
    nsCOMPtr<nsIMsgDBService> msgDBService =
        do_GetService("@mozilla.org/msgDatabase/msgDBService;1", &rv);
    NS_ENSURE_SUCCESS(rv, rv);

    // Get the database, blowing it away if it's out of date.
    rv = msgDBService->OpenFolderDB(this, false, getter_AddRefs(mDatabase));
    if (NS_FAILED(rv))
      rv = msgDBService->CreateNewDB(this, getter_AddRefs(mDatabase));
    NS_ENSURE_SUCCESS(rv, rv);

    if (mAddListener) rv = mDatabase->AddListener(this);

    nsCOMPtr<nsINewsDatabase> db = do_QueryInterface(mDatabase, &rv);
    if (NS_FAILED(rv)) return rv;

    rv = db->SetReadSet(mReadSet);
    if (NS_FAILED(rv)) return rv;

    rv = UpdateSummaryTotals(true);
    if (NS_FAILED(rv)) return rv;
  }
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::UpdateFolder(nsIMsgWindow* aWindow) {
  // Get news.get_messages_on_select pref

  // Only if news.get_messages_on_select is true do we get new messages
  // automatically
  if (Preferences::GetBool("news.get_messages_on_select", true)) {
    nsresult rv = GetDatabase();  // want this cached...
    if (NS_SUCCEEDED(rv)) {
      if (mDatabase) {
        nsCOMPtr<nsIMsgRetentionSettings> retentionSettings;
        nsresult rv = GetRetentionSettings(getter_AddRefs(retentionSettings));
        if (NS_SUCCEEDED(rv))
          rv = mDatabase->ApplyRetentionSettings(retentionSettings, false);
      }
      // GetNewMessages has to be the last rv set before we get to the next
      // check, so that we'll have rv set to NS_MSG_ERROR_OFFLINE when offline
      // and send a folder loaded notification to the front end.
      rv = GetNewMessages(aWindow, nullptr);
    }
    if (rv != NS_MSG_ERROR_OFFLINE) return rv;
  }
  // We're not getting messages because either get_messages_on_select is
  // false or we're offline. Send an immediate folder loaded notification.
  NotifyFolderEvent(kFolderLoaded);
  (void)RefreshSizeOnDisk();
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetCanSubscribe(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = false;

  bool isNewsServer = false;
  nsresult rv = GetIsServer(&isNewsServer);
  if (NS_FAILED(rv)) return rv;

  // you can only subscribe to news servers, not news groups
  *aResult = isNewsServer;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetCanFileMessages(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  // you can't file messages into a news server or news group
  *aResult = false;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetCanCreateSubfolders(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = false;
  // you can't create subfolders on a news server or a news group
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetCanRename(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = false;
  // you can't rename a news server or a news group
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetCanCompact(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = false;
  // you can't compact a news server or a news group
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::SetNewsrcHasChanged(bool newsrcHasChanged) {
  nsresult rv;

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  rv = GetNntpServer(getter_AddRefs(nntpServer));
  if (NS_FAILED(rv)) return rv;
  return nntpServer->SetNewsrcHasChanged(newsrcHasChanged);
}

NS_IMETHODIMP nsMsgNewsFolder::CreateSubfolder(const nsACString& newsgroupName,
                                               nsIMsgWindow* msgWindow) {
  nsresult rv = NS_OK;
  if (newsgroupName.IsEmpty()) return NS_MSG_ERROR_INVALID_FOLDER_NAME;

  nsCOMPtr<nsIMsgFolder> child;
  // Now let's create the actual new folder
  rv = AddNewsgroup(newsgroupName, EmptyCString(), getter_AddRefs(child));

  if (NS_SUCCEEDED(rv))
    SetNewsrcHasChanged(true);  // subscribe UI does this - but maybe we got
                                // here through auto-subscribe

  if (NS_SUCCEEDED(rv) && child) {
    nsCOMPtr<nsINntpIncomingServer> nntpServer;
    rv = GetNntpServer(getter_AddRefs(nntpServer));
    if (NS_FAILED(rv)) return rv;

    nsCOMPtr<nsIDBFolderInfo> folderInfo;
    nsCOMPtr<nsIMsgDatabase> db;
    // Used to init some folder status of child.
    rv = child->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                     getter_AddRefs(db));
    NS_ENSURE_SUCCESS(rv, rv);

    NotifyFolderAdded(child);
    nsCOMPtr<nsIMsgFolderNotificationService> notifier =
        mozilla::components::FolderNotification::Service();
    notifier->NotifyFolderAdded(child);
  }
  return rv;
}

NS_IMETHODIMP nsMsgNewsFolder::DeleteStorage() {
  nsresult rv = nsMsgDBFolder::DeleteStorage();
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  rv = GetNntpServer(getter_AddRefs(nntpServer));
  if (NS_FAILED(rv)) return rv;

  rv = nntpServer->RemoveNewsgroup(mName);
  NS_ENSURE_SUCCESS(rv, rv);

  (void)RefreshSizeOnDisk();

  return SetNewsrcHasChanged(true);
}

NS_IMETHODIMP nsMsgNewsFolder::Rename(const nsACString& newName,
                                      nsIMsgWindow* msgWindow) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsMsgNewsFolder::GetAbbreviatedName(nsAString& aAbbreviatedName) {
  nsresult rv;

  rv = nsMsgDBFolder::GetLocalizedName(aAbbreviatedName);
  NS_ENSURE_SUCCESS(rv, rv);

  // only do this for newsgroup names, not for newsgroup hosts.
  bool isNewsServer = false;
  rv = GetIsServer(&isNewsServer);
  NS_ENSURE_SUCCESS(rv, rv);

  if (!isNewsServer) {
    nsCOMPtr<nsINntpIncomingServer> nntpServer;
    rv = GetNntpServer(getter_AddRefs(nntpServer));
    NS_ENSURE_SUCCESS(rv, rv);

    bool abbreviate = true;
    rv = nntpServer->GetAbbreviate(&abbreviate);
    NS_ENSURE_SUCCESS(rv, rv);

    if (abbreviate)
      rv = AbbreviatePrettyName(aAbbreviatedName, 1 /* hardcoded for now */);
  }
  return rv;
}

// original code from Oleg Rekutin
// rekusha@asan.com
// Public domain, created by Oleg Rekutin
//
// takes a newsgroup name, number of words from the end to leave unabberviated
// the newsgroup name, will get reset to the following format:
// x.x.x, where x is the first letter of each word and with the
// exception of last 'fullwords' words, which are left intact.
// If a word has a dash in it, it is abbreviated as a-b, where
// 'a' is the first letter of the part of the word before the
// dash and 'b' is the first letter of the part of the word after
// the dash
nsresult nsMsgNewsFolder::AbbreviatePrettyName(nsAString& prettyName,
                                               int32_t fullwords) {
  nsAutoString name(prettyName);
  int32_t totalwords = 0;  // total no. of words

  // get the total no. of words
  int32_t pos = 0;
  while (1) {
    pos = name.FindChar('.', pos);
    if (pos == -1) {
      totalwords++;
      break;
    } else {
      totalwords++;
      pos++;
    }
  }

  // get the no. of words to abbreviate
  int32_t abbrevnum = totalwords - fullwords;
  if (abbrevnum < 1) return NS_OK;  // nothing to abbreviate

  // build the ellipsis
  nsAutoString out;
  out += name[0];

  int32_t length = name.Length();
  int32_t newword = 0;  // == 2 if done with all abbreviated words

  fullwords = 0;
  char16_t currentChar;
  for (int32_t i = 1; i < length; i++) {
    // this temporary assignment is needed to fix an intel mac compiler bug.
    // See Bug #327037 for details.
    currentChar = name[i];
    if (newword < 2) {
      switch (currentChar) {
        case '.':
          fullwords++;
          // check if done with all abbreviated words...
          if (fullwords == abbrevnum)
            newword = 2;
          else
            newword = 1;
          break;
        case '-':
          newword = 1;
          break;
        default:
          if (newword)
            newword = 0;
          else
            continue;
      }
    }
    out.Append(currentChar);
  }
  prettyName = out;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetDBFolderInfoAndDB(nsIDBFolderInfo** folderInfo,
                                      nsIMsgDatabase** db) {
  NS_ENSURE_ARG_POINTER(folderInfo);
  NS_ENSURE_ARG_POINTER(db);
  nsresult openErr;
  openErr = GetDatabase();
  if (!mDatabase) {
    *db = nullptr;
    return openErr;
  }

  NS_ADDREF(*db = mDatabase);

  if (NS_SUCCEEDED(openErr)) openErr = (*db)->GetDBFolderInfo(folderInfo);
  return openErr;
}

/* this used to be MSG_FolderInfoNews::UpdateSummaryFromNNTPInfo() */
NS_IMETHODIMP
nsMsgNewsFolder::UpdateSummaryFromNNTPInfo(int32_t oldest, int32_t youngest,
                                           int32_t total) {
  NS_ENSURE_STATE(mReadSet);
  /* First, mark all of the articles now known to be expired as read. */
  if (oldest > 1) {
    nsCString oldSet;
    nsCString newSet;
    mReadSet->Output(getter_Copies(oldSet));
    mReadSet->AddRange(1, oldest - 1);
    mReadSet->Output(getter_Copies(newSet));
  }

  /* Now search the newsrc line and figure out how many of these messages are
   * marked as unread. */

  /* make sure youngest is a least 1. MSNews seems to return a youngest of 0. */
  if (youngest == 0) youngest = 1;

  int32_t unread = mReadSet->CountMissingInRange(oldest, youngest);
  NS_ASSERTION(unread >= 0, "CountMissingInRange reported unread < 0");
  if (unread < 0)
    // servers can send us stuff like "211 0 41 40 nz.netstatus"
    // we should handle it gracefully.
    unread = 0;

  if (unread > total) {
    /* This can happen when the newsrc file shows more unread than exist in the
     * group (total is not necessarily `end - start'.) */
    unread = total;
    int32_t deltaInDB = mNumTotalMessages - mNumUnreadMessages;
    // int32_t deltaInDB = m_totalInDB - m_unreadInDB;
    /* if we know there are read messages in the db, subtract that from the
     * unread total */
    if (deltaInDB > 0) unread -= deltaInDB;
  }

  bool dbWasOpen = mDatabase != nullptr;
  int32_t pendingUnreadDelta =
      unread - mNumUnreadMessages - mNumPendingUnreadMessages;
  int32_t pendingTotalDelta =
      total - mNumTotalMessages - mNumPendingTotalMessages;
  ChangeNumPendingUnread(pendingUnreadDelta);
  ChangeNumPendingTotalMessages(pendingTotalDelta);
  if (!dbWasOpen && mDatabase) {
    mDatabase->Commit(nsMsgDBCommitType::kLargeCommit);
    mDatabase->RemoveListener(this);
    mDatabase = nullptr;
  }
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetExpungedBytesCount(int64_t* count) {
  NS_ENSURE_ARG_POINTER(count);
  *count = mExpungedBytes;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetDeletable(bool* deletable) {
  NS_ENSURE_ARG_POINTER(deletable);

  *deletable = false;
  // For legacy reasons, there can be Saved search folders under news accounts.
  // Allow deleting those.
  GetFlag(nsMsgFolderFlags::Virtual, deletable);
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::RefreshSizeOnDisk() {
  uint64_t oldFolderSize = mFolderSize;
  // We set size to unknown to force it to get recalculated from disk.
  mFolderSize = kSizeUnknown;
  if (NS_SUCCEEDED(GetSizeOnDisk(&mFolderSize)))
    NotifyIntPropertyChanged(kFolderSize, oldFolderSize, mFolderSize);
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetSizeOnDisk(int64_t* size) {
  NS_ENSURE_ARG_POINTER(size);

  bool isServer = false;
  nsresult rv = GetIsServer(&isServer);
  // If this is the rootFolder, return 0 as a safe value.
  if (NS_FAILED(rv) || isServer) mFolderSize = 0;

  // 0 is a valid folder size (meaning empty file with no offline messages),
  // but 1 is not. So use -1 as a special value meaning no file size was fetched
  // from disk yet.
  if (mFolderSize == kSizeUnknown) {
    nsCOMPtr<nsIFile> diskFile;
    nsresult rv = GetFilePath(getter_AddRefs(diskFile));
    NS_ENSURE_SUCCESS(rv, rv);

    // If there were no news messages downloaded for offline use, the folder
    // file may not exist yet. In that case size is 0.
    bool exists = false;
    rv = diskFile->Exists(&exists);
    if (NS_FAILED(rv) || !exists) {
      mFolderSize = 0;
    } else {
      int64_t fileSize;
      rv = diskFile->GetFileSize(&fileSize);
      NS_ENSURE_SUCCESS(rv, rv);
      mFolderSize = fileSize;
    }
  }

  *size = mFolderSize;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::DeleteMessages(nsTArray<RefPtr<nsIMsgDBHdr>> const& msgHdrs,
                                nsIMsgWindow* aMsgWindow, bool deleteStorage,
                                bool isMove,
                                nsIMsgCopyServiceListener* listener,
                                bool allowUndo) {
  nsresult rv = NS_OK;
  NS_ENSURE_ARG_POINTER(aMsgWindow);

  if (!isMove) {
    nsCOMPtr<nsIMsgFolderNotificationService> notifier =
        mozilla::components::FolderNotification::Service();
    notifier->NotifyMsgsDeleted(msgHdrs);
  }

  rv = GetDatabase();
  NS_ENSURE_SUCCESS(rv, rv);

  rv = EnableNotifications(allMessageCountNotifications, false);
  if (NS_SUCCEEDED(rv)) {
    for (auto msgHdr : msgHdrs) {
      rv = mDatabase->DeleteHeader(msgHdr, nullptr, true, true);
      if (NS_FAILED(rv)) {
        break;
      }
    }
    EnableNotifications(allMessageCountNotifications, true);
  }

  if (!isMove)
    NotifyFolderEvent(NS_SUCCEEDED(rv) ? kDeleteOrMoveMsgCompleted
                                       : kDeleteOrMoveMsgFailed);

  if (listener) {
    listener->OnStartCopy();
    listener->OnStopCopy(NS_OK);
  }

  (void)RefreshSizeOnDisk();

  return rv;
}

NS_IMETHODIMP nsMsgNewsFolder::CancelMessage(nsIMsgDBHdr* msgHdr,
                                             nsIMsgWindow* aMsgWindow) {
  NS_ENSURE_ARG_POINTER(msgHdr);
  NS_ENSURE_ARG_POINTER(aMsgWindow);

  nsresult rv;

  nsCOMPtr<nsINntpService> nntpService =
      do_GetService("@mozilla.org/messenger/nntpservice;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  // for cancel, we need to
  // turn "newsmessage://sspitzer@news.mozilla.org/netscape.test#5428"
  // into "news://sspitzer@news.mozilla.org/23423@netscape.com"

  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = GetServer(getter_AddRefs(server));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString serverURI;
  rv = server->GetServerURI(serverURI);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString messageID;
  rv = msgHdr->GetMessageId(messageID);
  NS_ENSURE_SUCCESS(rv, rv);

  // we need to escape the message ID,
  // it might contain characters which will mess us up later, like #
  // see bug #120502
  nsCString escapedMessageID;
  MsgEscapeString(messageID, nsINetUtil::ESCAPE_URL_PATH, escapedMessageID);

  nsAutoCString cancelURL(serverURI.get());
  cancelURL += '/';
  cancelURL += escapedMessageID;
  cancelURL += "?cancel";

  nsCString messageURI;
  rv = GetUriForMsg(msgHdr, messageURI);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIURI> resultUri;
  return nntpService->CancelMessage(cancelURL, messageURI,
                                    nullptr /* consumer */, nullptr, aMsgWindow,
                                    getter_AddRefs(resultUri));
}

NS_IMETHODIMP nsMsgNewsFolder::GetNewMessages(nsIMsgWindow* aMsgWindow,
                                              nsIUrlListener* aListener) {
  return GetNewsMessages(aMsgWindow, false, aListener);
}

NS_IMETHODIMP nsMsgNewsFolder::GetNextNMessages(nsIMsgWindow* aMsgWindow) {
  return GetNewsMessages(aMsgWindow, true, nullptr);
}

nsresult nsMsgNewsFolder::GetNewsMessages(nsIMsgWindow* aMsgWindow,
                                          bool aGetOld,
                                          nsIUrlListener* aUrlListener) {
  nsresult rv = NS_OK;

  bool isNewsServer = false;
  rv = GetIsServer(&isNewsServer);
  NS_ENSURE_SUCCESS(rv, rv);

  if (isNewsServer) {
    nsCOMPtr<nsIMsgIncomingServer> server;
    rv = GetServer(getter_AddRefs(server));
    NS_ENSURE_SUCCESS(rv, rv);

    return server->PerformExpand(aMsgWindow);
  }

  nsCOMPtr<nsINntpService> nntpService =
      do_GetService("@mozilla.org/messenger/nntpservice;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  rv = GetNntpServer(getter_AddRefs(nntpServer));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIURI> resultUri;
  rv = nntpService->GetNewNews(nntpServer, mURI, aGetOld, this, aMsgWindow,
                               getter_AddRefs(resultUri));
  if (aUrlListener && NS_SUCCEEDED(rv) && resultUri) {
    nsCOMPtr<nsIMsgMailNewsUrl> msgUrl(do_QueryInterface(resultUri));
    if (msgUrl) msgUrl->RegisterListener(aUrlListener);
  }
  return rv;
}

nsresult nsMsgNewsFolder::LoadNewsrcFileAndCreateNewsgroups() {
  nsresult rv = NS_OK;
  if (!mNewsrcFilePath) return NS_ERROR_FAILURE;

  bool exists;
  rv = mNewsrcFilePath->Exists(&exists);
  if (NS_FAILED(rv)) return rv;

  if (!exists)
    // it is ok for the newsrc file to not exist yet
    return NS_OK;

  nsCOMPtr<nsIInputStream> fileStream;
  rv = NS_NewLocalFileInputStream(getter_AddRefs(fileStream), mNewsrcFilePath);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsILineInputStream> lineInputStream(
      do_QueryInterface(fileStream, &rv));
  NS_ENSURE_SUCCESS(rv, rv);

  bool more = true;
  nsCString line;

  while (more && NS_SUCCEEDED(rv)) {
    rv = lineInputStream->ReadLine(line, &more);
    if (line.IsEmpty()) continue;
    HandleNewsrcLine(line.get(), line.Length());
  }

  fileStream->Close();
  return rv;
}

int32_t nsMsgNewsFolder::HandleNewsrcLine(const char* line,
                                          uint32_t line_size) {
  nsresult rv;

  /* guard against blank line lossage */
  if (line[0] == '#' || line[0] == '\r' || line[0] == '\n') return 0;

  if ((line[0] == 'o' || line[0] == 'O') && !PL_strncasecmp(line, "options", 7))
    return 0;

  const char* s = nullptr;
  const char* setStr = nullptr;
  const char* end = line + line_size;

  for (s = line; s < end; s++)
    if ((*s == ':') || (*s == '!')) break;

  if (*s == 0) {
    return 0;
  }

  bool subscribed = (*s == ':');
  setStr = s + 1;

  if (*line == '\0') return 0;

  // previous versions of Communicator polluted the
  // newsrc files with articles
  // (this would happen when you clicked on a link like
  // news://news.mozilla.org/3746EF3F.6080309@netscape.com)
  //
  // legal newsgroup names can't contain @ or %
  //
  // News group names are structured into parts separated by dots,
  // for example "netscape.public.mozilla.mail-news".
  // Each part may be up to 14 characters long, and should consist
  // only of letters, digits, "+" and "-", with at least one letter
  //
  // @ indicates an article and %40 is @ escaped.
  // previous versions of Communicator also dumped
  // the escaped version into the newsrc file
  //
  // So lines like this in a newsrc file should be ignored:
  // 3746EF3F.6080309@netscape.com:
  // 3746EF3F.6080309%40netscape.com:
  if (PL_strchr(line, '@') || PL_strstr(line, "%40"))
    // skipping, it contains @ or %40
    subscribed = false;

  if (subscribed) {
    // we're subscribed, so add it
    nsCOMPtr<nsIMsgFolder> child;

    rv = AddNewsgroup(Substring(line, s), nsDependentCString(setStr),
                      getter_AddRefs(child));
    if (NS_FAILED(rv)) return -1;
  }

  return 0;
}

NS_IMETHODIMP nsMsgNewsFolder::GetGroupUsername(nsACString& aGroupUsername) {
  aGroupUsername = mGroupUsername;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::SetGroupUsername(
    const nsACString& aGroupUsername) {
  mGroupUsername = aGroupUsername;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetGroupPassword(nsACString& aGroupPassword) {
  aGroupPassword = mGroupPassword;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::SetGroupPassword(
    const nsACString& aGroupPassword) {
  mGroupPassword = aGroupPassword;
  return NS_OK;
}

nsresult nsMsgNewsFolder::CreateNewsgroupUrlForSignon(const char* ref,
                                                      nsAString& result) {
  nsresult rv;

  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = GetServer(getter_AddRefs(server));
  if (NS_FAILED(rv)) return rv;

  nsCOMPtr<nsINntpIncomingServer> nntpServer;
  rv = GetNntpServer(getter_AddRefs(nntpServer));
  if (NS_FAILED(rv)) return rv;

  bool singleSignon = true;
  rv = nntpServer->GetSingleSignon(&singleSignon);

  nsCOMPtr<nsIURL> url;
  if (singleSignon) {
    // Do not include username in the url when interacting with LoginManager.
    nsCString serverURI = "news://"_ns;
    nsCString hostName;
    rv = server->GetHostName(hostName);
    NS_ENSURE_SUCCESS(rv, rv);
    serverURI.Append(hostName);
    rv = NS_MutateURI(NS_STANDARDURLMUTATOR_CONTRACTID)
             .SetSpec(serverURI)
             .Finalize(url);
    NS_ENSURE_SUCCESS(rv, rv);
  } else {
    rv = NS_MutateURI(NS_STANDARDURLMUTATOR_CONTRACTID)
             .SetSpec(mURI)
             .Finalize(url);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  int32_t port = 0;
  rv = url->GetPort(&port);
  NS_ENSURE_SUCCESS(rv, rv);

  if (port <= 0) {
    nsCOMPtr<nsIMsgIncomingServer> server;
    rv = GetServer(getter_AddRefs(server));
    NS_ENSURE_SUCCESS(rv, rv);

    int32_t socketType;
    nsresult rv = server->GetSocketType(&socketType);
    NS_ENSURE_SUCCESS(rv, rv);

    // Only set this for ssl newsgroups as for non-ssl connections, we don't
    // need to specify the port as it is the default for the protocol and
    // password manager "blanks" those out.
    if (socketType == nsMsgSocketType::SSL) {
      rv = NS_MutateURI(url)
               .SetPort(nsINntpUrl::DEFAULT_NNTPS_PORT)
               .Finalize(url);
      NS_ENSURE_SUCCESS(rv, rv);
    }
  }

  nsCString rawResult;
  if (ref) {
    rv = NS_MutateURI(url).SetRef(nsDependentCString(ref)).Finalize(url);
    NS_ENSURE_SUCCESS(rv, rv);

    rv = url->GetSpec(rawResult);
    NS_ENSURE_SUCCESS(rv, rv);
  } else {
    // If the url doesn't have a path, make sure we don't get a '/' on the end
    // as that will confuse searching in password manager.
    nsCString spec;
    rv = url->GetSpec(spec);
    NS_ENSURE_SUCCESS(rv, rv);

    if (!spec.IsEmpty() && spec[spec.Length() - 1] == '/')
      rawResult = StringHead(spec, spec.Length() - 1);
    else
      rawResult = spec;
  }
  result = NS_ConvertASCIItoUTF16(rawResult);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetAuthenticationCredentials(nsIMsgWindow* aMsgWindow,
                                              bool mayPrompt, bool mustPrompt,
                                              bool* validCredentials) {
  // Not strictly necessary, but it would help consumers to realize that this is
  // a rather nonsensical combination.
  NS_ENSURE_FALSE(mustPrompt && !mayPrompt, NS_ERROR_INVALID_ARG);
  NS_ENSURE_ARG_POINTER(validCredentials);

  nsCOMPtr<nsIStringBundleService> bundleService =
      mozilla::components::StringBundle::Service();
  NS_ENSURE_TRUE(bundleService, NS_ERROR_UNEXPECTED);

  nsresult rv;
  nsCOMPtr<nsIStringBundle> bundle;
  rv = bundleService->CreateBundle("chrome://messenger/locale/news.properties",
                                   getter_AddRefs(bundle));
  NS_ENSURE_SUCCESS(rv, rv);

  nsString signonUrl;
  rv = CreateNewsgroupUrlForSignon(nullptr, signonUrl);
  NS_ENSURE_SUCCESS(rv, rv);

  // If we don't have a username or password, try to load it via the login mgr.
  // Do this even if mustPrompt is true, to prefill the dialog.
  if (mGroupUsername.IsEmpty() || mGroupPassword.IsEmpty()) {
    nsCOMPtr<nsILoginManager> loginMgr =
        do_GetService(NS_LOGINMANAGER_CONTRACTID, &rv);
    NS_ENSURE_SUCCESS(rv, rv);

    nsTArray<RefPtr<nsILoginInfo>> logins;
    rv = loginMgr->FindLogins(signonUrl, EmptyString(), signonUrl, logins);
    NS_ENSURE_SUCCESS(rv, rv);

    if (logins.Length() > 0) {
      nsString uniUsername, uniPassword;
      logins[0]->GetUsername(uniUsername);
      logins[0]->GetPassword(uniPassword);
      mGroupUsername = NS_LossyConvertUTF16toASCII(uniUsername);
      mGroupPassword = NS_LossyConvertUTF16toASCII(uniPassword);

      *validCredentials = true;
    }
  }

  // Show the prompt if we need to
  if (mustPrompt ||
      (mayPrompt && (mGroupUsername.IsEmpty() || mGroupPassword.IsEmpty()))) {
    nsCOMPtr<nsIAuthPrompt> authPrompt =
        do_GetService("@mozilla.org/messenger/msgAuthPrompt;1");
    if (!authPrompt) {
      return NS_ERROR_FAILURE;
    }

    if (authPrompt) {
      // Format the prompt text strings
      nsString promptTitle, promptText;
      bundle->GetStringFromName("enterUserPassTitle", promptTitle);

      nsAutoCString serverName;
      nsCOMPtr<nsIMsgIncomingServer> server;
      rv = GetServer(getter_AddRefs(server));
      NS_ENSURE_SUCCESS(rv, rv);

      server->GetPrettyName(serverName);

      nsCOMPtr<nsINntpIncomingServer> nntpServer;
      rv = GetNntpServer(getter_AddRefs(nntpServer));
      NS_ENSURE_SUCCESS(rv, rv);

      bool singleSignon = true;
      nntpServer->GetSingleSignon(&singleSignon);

      if (singleSignon) {
        AutoTArray<nsString, 1> params = {NS_ConvertUTF8toUTF16(serverName)};
        bundle->FormatStringFromName("enterUserPassServer", params, promptText);
      } else {
        AutoTArray<nsString, 2> params = {NS_ConvertUTF8toUTF16(mName),
                                          NS_ConvertUTF8toUTF16(serverName)};
        bundle->FormatStringFromName("enterUserPassGroup", params, promptText);
      }

      // Fill the signon url for the dialog
      nsString signonURL;
      rv = CreateNewsgroupUrlForSignon(nullptr, signonURL);
      NS_ENSURE_SUCCESS(rv, rv);

      // Prefill saved username/password
      char16_t* uniGroupUsername =
          ToNewUnicode(NS_ConvertASCIItoUTF16(mGroupUsername));
      char16_t* uniGroupPassword =
          ToNewUnicode(NS_ConvertASCIItoUTF16(mGroupPassword));

      // Prompt for the dialog
      rv = authPrompt->PromptUsernameAndPassword(
          promptTitle.get(), promptText.get(), signonURL.get(),
          nsIAuthPrompt::SAVE_PASSWORD_PERMANENTLY, &uniGroupUsername,
          &uniGroupPassword, validCredentials);

      nsAutoString uniPasswordAdopted, uniUsernameAdopted;
      uniPasswordAdopted.Adopt(uniGroupPassword);
      uniUsernameAdopted.Adopt(uniGroupUsername);
      NS_ENSURE_SUCCESS(rv, rv);

      // Only use the username/password if the user didn't cancel.
      if (*validCredentials) {
        SetGroupUsername(NS_LossyConvertUTF16toASCII(uniUsernameAdopted));
        SetGroupPassword(NS_LossyConvertUTF16toASCII(uniPasswordAdopted));
      } else {
        mGroupUsername.Truncate();
        mGroupPassword.Truncate();
      }
    }
  }

  *validCredentials = !(mGroupUsername.IsEmpty() || mGroupPassword.IsEmpty());
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::ForgetAuthenticationCredentials() {
  nsString signonUrl;
  nsresult rv = CreateNewsgroupUrlForSignon(nullptr, signonUrl);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsILoginManager> loginMgr =
      do_GetService(NS_LOGINMANAGER_CONTRACTID, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  nsTArray<RefPtr<nsILoginInfo>> logins;
  rv = loginMgr->FindLogins(signonUrl, EmptyString(), signonUrl, logins);
  NS_ENSURE_SUCCESS(rv, rv);

  // There should only be one-login stored for this url, however just in case
  // there isn't.
  for (uint32_t i = 0; i < logins.Length(); ++i)
    loginMgr->RemoveLogin(logins[i]);

  // Clear out the saved passwords for anyone else who tries to call.
  mGroupUsername.Truncate();
  mGroupPassword.Truncate();

  return NS_OK;
}

nsresult nsMsgNewsFolder::CreateBaseMessageURI(const nsACString& aURI) {
  nsAutoCString tailURI(aURI);

  // chop off news:/
  if (tailURI.Find(kNewsRootURI) == 0) {
    tailURI.Cut(0, PL_strlen(kNewsRootURI));
  };

  mBaseMessageURI = kNewsMessageRootURI;
  mBaseMessageURI += tailURI;

  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetCharset(nsACString& charset) {
  nsCOMPtr<nsIMsgIncomingServer> server;
  nsresult rv = GetServer(getter_AddRefs(server));
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsINntpIncomingServer> nserver(do_QueryInterface(server));
  NS_ENSURE_TRUE(nserver, NS_ERROR_NULL_POINTER);
  return nserver->GetCharset(charset);
}

NS_IMETHODIMP
nsMsgNewsFolder::GetNewsrcLine(nsACString& newsrcLine) {
  nsresult rv;
  nsAutoCString newsgroupName;
  rv = GetName(newsgroupName);
  if (NS_FAILED(rv)) return rv;

  newsrcLine = newsgroupName;
  newsrcLine.Append(':');

  if (mReadSet) {
    nsCString setStr;
    mReadSet->Output(getter_Copies(setStr));
    if (NS_SUCCEEDED(rv)) {
      newsrcLine.Append(' ');
      newsrcLine.Append(setStr);
      newsrcLine.AppendLiteral(MSG_LINEBREAK);
    }
  }
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::SetReadSetFromStr(const nsACString& newsrcLine) {
  mReadSet = nsMsgKeySet::Create(PromiseFlatCString(newsrcLine).get());
  NS_ENSURE_TRUE(mReadSet, NS_ERROR_OUT_OF_MEMORY);

  // Now that mReadSet is recreated, make sure it's stored in the db as well.
  nsCOMPtr<nsINewsDatabase> db = do_QueryInterface(mDatabase);
  if (db)  // it's ok not to have a db here.
    db->SetReadSet(mReadSet);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::OnReadChanged(nsIDBChangeListener* aInstigator) {
  return SetNewsrcHasChanged(true);
}

NS_IMETHODIMP
nsMsgNewsFolder::GetRawName(nsACString& aRawName) {
  nsresult rv;
  if (mRawName.IsEmpty()) {
    nsAutoCString name;
    rv = GetName(name);
    NS_ENSURE_SUCCESS(rv, rv);

    // convert to the server-side encoding
    nsCOMPtr<nsINntpIncomingServer> nntpServer;
    rv = GetNntpServer(getter_AddRefs(nntpServer));
    NS_ENSURE_SUCCESS(rv, rv);

    nsAutoCString dataCharset;
    rv = nntpServer->GetCharset(dataCharset);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = nsMsgI18NConvertFromUnicode(dataCharset, NS_ConvertUTF8toUTF16(name),
                                     mRawName);

    if (NS_FAILED(rv))
      LossyCopyUTF16toASCII(NS_ConvertUTF8toUTF16(name), mRawName);
  }
  aRawName = mRawName;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetNntpServer(nsINntpIncomingServer** result) {
  nsresult rv;
  NS_ENSURE_ARG_POINTER(result);

  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = GetServer(getter_AddRefs(server));
  if (NS_FAILED(rv)) return rv;

  nsCOMPtr<nsINntpIncomingServer> nntpServer = do_QueryInterface(server, &rv);
  if (NS_FAILED(rv)) return rv;
  nntpServer.forget(result);
  return NS_OK;
}

// this gets called after the message actually gets cancelled
// it removes the cancelled message from the db
NS_IMETHODIMP nsMsgNewsFolder::RemoveMessage(nsMsgKey key) {
  nsresult rv = GetDatabase();
  NS_ENSURE_SUCCESS(rv,
                    rv);  // if GetDatabase succeeds, mDatabase will be non-null

  // Notify listeners of a delete for a single message
  nsCOMPtr<nsIMsgFolderNotificationService> notifier =
      mozilla::components::FolderNotification::Service();
  nsCOMPtr<nsIMsgDBHdr> msgHdr;
  rv = mDatabase->GetMsgHdrForKey(key, getter_AddRefs(msgHdr));
  NS_ENSURE_SUCCESS(rv, rv);
  notifier->NotifyMsgsDeleted({msgHdr.get()});

  return mDatabase->DeleteMessage(key, nullptr, false);
}

NS_IMETHODIMP nsMsgNewsFolder::RemoveMessages(
    const nsTArray<nsMsgKey>& aMsgKeys) {
  nsresult rv = GetDatabase();
  NS_ENSURE_SUCCESS(rv,
                    rv);  // if GetDatabase succeeds, mDatabase will be non-null

  // Notify listeners of a multiple message delete
  nsCOMPtr<nsIMsgFolderNotificationService> notifier =
      mozilla::components::FolderNotification::Service();
  nsTArray<RefPtr<nsIMsgDBHdr>> msgHdrs;
  rv = MsgGetHeadersFromKeys(mDatabase, aMsgKeys, msgHdrs);
  NS_ENSURE_SUCCESS(rv, rv);
  notifier->NotifyMsgsDeleted(msgHdrs);

  return mDatabase->DeleteMessages(aMsgKeys, nullptr);
}

NS_IMETHODIMP nsMsgNewsFolder::CancelComplete() {
  NotifyFolderEvent(kDeleteOrMoveMsgCompleted);
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::GetSaveArticleOffline(bool* aBool) {
  NS_ENSURE_ARG(aBool);
  *aBool = m_downloadMessageForOfflineUse;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::SetSaveArticleOffline(bool aBool) {
  m_downloadMessageForOfflineUse = aBool;
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::DownloadAllForOffline(nsIUrlListener* listener,
                                                     nsIMsgWindow* msgWindow) {
  nsresult rv = NS_OK;

  nsCOMPtr<nsINntpService> nntpService(
      do_GetService("@mozilla.org/messenger/nntpservice;1", &rv));
  if (NS_SUCCEEDED(rv) && nntpService) {
    rv = nntpService->DownloadFolderForOffline(this, msgWindow);
  }

  return rv;
}

NS_IMETHODIMP nsMsgNewsFolder::DownloadMessagesForOffline(
    nsTArray<RefPtr<nsIMsgDBHdr>> const& messages, nsIMsgWindow* msgWindow) {
  nsresult rv = NS_OK;

  nsTArray<nsMsgKey> srcKeyArray(messages.Length());
  for (const auto& hdr : messages) {
    nsMsgKey key;
    rv = hdr->GetMessageKey(&key);
    if (NS_SUCCEEDED(rv)) srcKeyArray.AppendElement(key);
  }

  nsCOMPtr<nsINntpService> nntpService(
      do_GetService("@mozilla.org/messenger/nntpservice;1", &rv));
  if (NS_SUCCEEDED(rv) && nntpService) {
    rv = nntpService->DownloadMessagesForOffline(this, srcKeyArray, msgWindow);
  }

  return rv;
}

NS_IMETHODIMP nsMsgNewsFolder::GetLocalMsgStream(nsIMsgDBHdr* hdr,
                                                 nsIInputStream** stream) {
  return GetMsgInputStream(hdr, stream);
}

NS_IMETHODIMP nsMsgNewsFolder::NotifyArticleDownloaded(uint32_t articleNumber,
                                                       nsACString const& data) {
  if (!m_downloadMessageForOfflineUse) {
    return NS_OK;
  }
  nsresult rv =
      GetMessageHeader(articleNumber, getter_AddRefs(m_offlineHeader));
  NS_ENSURE_SUCCESS(rv, rv);
  StartNewOfflineMessage();  // Sets up m_tempMessageStream et al.
  if (m_tempMessageStream) {
    m_numOfflineMsgLines += data.CountChar('\n');

    uint32_t count = 0;
    rv = m_tempMessageStream->Write(data.BeginReading(), data.Length(), &count);
    m_tempMessageStreamBytesWritten += count;
    return EndNewOfflineMessage(rv);
  }
  return NS_OK;
}

NS_IMETHODIMP nsMsgNewsFolder::NotifyFinishedDownloadinghdrs() {
  bool wasCached = !!mDatabase;
  ChangeNumPendingTotalMessages(-mNumPendingTotalMessages);
  ChangeNumPendingUnread(-mNumPendingUnreadMessages);
  bool filtersRun;
  // run the bayesian spam filters, if enabled.
  CallFilterPlugins(nullptr, &filtersRun);

  // If the DB was not open before, close our reference to it now.
  if (!wasCached && mDatabase) {
    mDatabase->Commit(nsMsgDBCommitType::kLargeCommit);
    mDatabase->RemoveListener(this);
    // This also clears all of the cached headers that may have been added while
    // we were downloading messages (and those clearing refcount cycles in the
    // database).
    mDatabase->ClearCachedHdrs();
    mDatabase = nullptr;
  }

  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::ApplyRetentionSettings() {
  return nsMsgDBFolder::ApplyRetentionSettings(false);
}

NS_IMETHODIMP nsMsgNewsFolder::GetMessageIdForKey(nsMsgKey key,
                                                  nsACString& result) {
  nsresult rv = GetDatabase();
  if (!mDatabase) return rv;
  nsCOMPtr<nsIMsgDBHdr> hdr;
  rv = mDatabase->GetMsgHdrForKey(key, getter_AddRefs(hdr));
  NS_ENSURE_SUCCESS(rv, rv);
  return hdr->GetMessageId(result);
}

NS_IMETHODIMP nsMsgNewsFolder::Shutdown(bool shutdownChildren) {
  if (mFilterList) {
    // close the filter log stream
    nsresult rv = mFilterList->SetLogStream(nullptr);
    NS_ENSURE_SUCCESS(rv, rv);
    mFilterList = nullptr;
  }

  mInitialized = false;
  if (mReadSet) {
    // the nsINewsDatabase holds a weak ref to the readset,
    // and we outlive the db, so it's safe to delete it here.
    nsCOMPtr<nsINewsDatabase> db = do_QueryInterface(mDatabase);
    if (db) db->SetReadSet(nullptr);
    mReadSet = nullptr;
  }
  return nsMsgDBFolder::Shutdown(shutdownChildren);
}

NS_IMETHODIMP
nsMsgNewsFolder::SetFilterList(nsIMsgFilterList* aFilterList) {
  if (mIsServer) {
    nsCOMPtr<nsIMsgIncomingServer> server;
    nsresult rv = GetServer(getter_AddRefs(server));
    NS_ENSURE_SUCCESS(rv, rv);
    return server->SetFilterList(aFilterList);
  }

  mFilterList = aFilterList;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetFilterList(nsIMsgWindow* aMsgWindow,
                               nsIMsgFilterList** aResult) {
  if (mIsServer) {
    nsCOMPtr<nsIMsgIncomingServer> server;
    nsresult rv = GetServer(getter_AddRefs(server));
    NS_ENSURE_SUCCESS(rv, rv);
    return server->GetFilterList(aMsgWindow, aResult);
  }

  if (!mFilterList) {
    nsCOMPtr<nsIFile> thisFolder;
    nsresult rv = GetFilePath(getter_AddRefs(thisFolder));
    NS_ENSURE_SUCCESS(rv, rv);

    nsCOMPtr<nsIFile> filterFile = new nsLocalFile();
    rv = filterFile->InitWithFile(thisFolder);
    NS_ENSURE_SUCCESS(rv, rv);

    // in 4.x, the news filter file was
    // C:\Program
    // Files\Netscape\Users\meer\News\host-news.mcom.com\mcom.test.dat where the
    // summary file was C:\Program
    // Files\Netscape\Users\meer\News\host-news.mcom.com\mcom.test.snm we make
    // the rules file ".dat" in mozilla, so that migration works.

    // NOTE:
    // we don't we need to call NS_MsgHashIfNecessary()
    // it's already been hashed, if necessary
    nsAutoString filterFileName;
    rv = filterFile->GetLeafName(filterFileName);
    NS_ENSURE_SUCCESS(rv, rv);

    filterFileName.AppendLiteral(u".dat");

    rv = filterFile->SetLeafName(filterFileName);
    NS_ENSURE_SUCCESS(rv, rv);

    nsCOMPtr<nsIMsgFilterService> filterService =
        mozilla::components::Filter::Service();
    rv = filterService->OpenFilterList(filterFile, this, aMsgWindow,
                                       getter_AddRefs(mFilterList));
    NS_ENSURE_SUCCESS(rv, rv);
  }

  NS_IF_ADDREF(*aResult = mFilterList);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgNewsFolder::GetEditableFilterList(nsIMsgWindow* aMsgWindow,
                                       nsIMsgFilterList** aResult) {
  // We don't support pluggable filter list types for news.
  return GetFilterList(aMsgWindow, aResult);
}

NS_IMETHODIMP
nsMsgNewsFolder::SetEditableFilterList(nsIMsgFilterList* aFilterList) {
  return SetFilterList(aFilterList);
}

NS_IMETHODIMP
nsMsgNewsFolder::GetIncomingServerType(nsACString& serverType) {
  serverType.AssignLiteral("nntp");
  return NS_OK;
}
