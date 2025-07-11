/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsRssIncomingServer.h"

#include "mozilla/Components.h"
#include "mozilla/StaticPrefs_mail.h"
#include "nsMsgFolderFlags.h"
#include "nsINewsBlogFeedDownloader.h"
#include "nsIFile.h"
#include "nsIMsgFolderNotificationService.h"
#include "nsIMsgLocalMailFolder.h"
#include "nsServiceManagerUtils.h"
#include "nsMsgUtils.h"

nsrefcnt nsRssIncomingServer::gInstanceCount = 0;

NS_IMPL_ISUPPORTS_INHERITED(nsRssIncomingServer, nsMsgIncomingServer,
                            nsIRssIncomingServer, nsIMsgFolderListener,
                            nsILocalMailIncomingServer)

nsRssIncomingServer::nsRssIncomingServer() {
  m_canHaveFilters = true;

  if (gInstanceCount == 0) {
    nsCOMPtr<nsIMsgFolderNotificationService> notifyService =
        mozilla::components::FolderNotification::Service();
    notifyService->AddListener(
        this, nsIMsgFolderNotificationService::folderAdded |
                  nsIMsgFolderNotificationService::folderDeleted |
                  nsIMsgFolderNotificationService::folderMoveCopyCompleted |
                  nsIMsgFolderNotificationService::folderRenamed);
  }

  gInstanceCount++;
}

nsRssIncomingServer::~nsRssIncomingServer() {
  gInstanceCount--;

  if (gInstanceCount == 0) {
    nsCOMPtr<nsIMsgFolderNotificationService> notifyService =
        mozilla::components::FolderNotification::Service();
    // We might be here during XPCOM shutdown garbage collection, so the
    // notification service may no longer exist.
    if (notifyService) notifyService->RemoveListener(this);
  }
}

#ifdef MOZ_PANORAMA
nsresult nsRssIncomingServer::CreateRootFolder() {
  nsresult rv = nsMsgIncomingServer::CreateRootFolder();
  NS_ENSURE_SUCCESS(rv, rv);
  if (mozilla::StaticPrefs::mail_panorama_enabled_AtStartup()) {
    rv = CreateDefaultMailboxes();
    NS_ENSURE_SUCCESS(rv, rv);

    rv = SetFlagsOnDefaultMailboxes();
    NS_ENSURE_SUCCESS(rv, rv);
  }
  return NS_OK;
}
#endif  // MOZ_PANORAMA

nsresult nsRssIncomingServer::FillInDataSourcePath(
    const nsAString& aDataSourceName, nsIFile** aLocation) {
  nsresult rv;
  // Get the local path for this server.
  nsCOMPtr<nsIFile> localFile;
  rv = GetLocalPath(getter_AddRefs(localFile));
  NS_ENSURE_SUCCESS(rv, rv);

  // Append the name of the subscriptions data source.
  rv = localFile->Append(aDataSourceName);
  localFile.forget(aLocation);
  return rv;
}

// nsIRSSIncomingServer methods
NS_IMETHODIMP nsRssIncomingServer::GetSubscriptionsPath(nsIFile** aLocation) {
  return FillInDataSourcePath(u"feeds.json"_ns, aLocation);
}

NS_IMETHODIMP nsRssIncomingServer::GetFeedItemsPath(nsIFile** aLocation) {
  return FillInDataSourcePath(u"feeditems.json"_ns, aLocation);
}

NS_IMETHODIMP nsRssIncomingServer::CreateDefaultMailboxes() {
  // For Feeds, all we have is Trash.
  return CreateLocalFolder("Trash"_ns, nsMsgFolderFlags::Trash);
}

NS_IMETHODIMP nsRssIncomingServer::SetFlagsOnDefaultMailboxes() {
  nsCOMPtr<nsIMsgFolder> rootFolder;
  nsresult rv = GetRootFolder(getter_AddRefs(rootFolder));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgLocalMailFolder> localFolder =
      do_QueryInterface(rootFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  localFolder->SetFlagsOnDefaultMailboxes(nsMsgFolderFlags::Trash);
  return NS_OK;
}

NS_IMETHODIMP nsRssIncomingServer::PerformBiff(nsIMsgWindow* aMsgWindow) {
  // Get the account root (server) folder and pass it on.
  nsCOMPtr<nsIMsgFolder> rootRSSFolder;
  GetRootMsgFolder(getter_AddRefs(rootRSSFolder));
  nsCOMPtr<nsIUrlListener> urlListener = do_QueryInterface(rootRSSFolder);
  nsresult rv;
  bool isBiff = true;
  nsCOMPtr<nsINewsBlogFeedDownloader> rssDownloader =
      do_GetService("@mozilla.org/newsblog-feed-downloader;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  rssDownloader->DownloadFeed(rootRSSFolder, urlListener, isBiff, aMsgWindow);
  return NS_OK;
}

NS_IMETHODIMP nsRssIncomingServer::GetNewMail(nsIMsgWindow* aMsgWindow,
                                              nsIUrlListener* aUrlListener,
                                              nsIMsgFolder* aFolder,
                                              nsIURI** _retval) {
  // Pass the selected folder on to the downloader.
  if (_retval) {
    *_retval = nullptr;
  }
  NS_ENSURE_ARG_POINTER(aFolder);
  nsresult rv;
  bool isBiff = false;
  nsCOMPtr<nsINewsBlogFeedDownloader> rssDownloader =
      do_GetService("@mozilla.org/newsblog-feed-downloader;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  rssDownloader->DownloadFeed(aFolder, aUrlListener, isBiff, aMsgWindow);
  return NS_OK;
}

NS_IMETHODIMP nsRssIncomingServer::GetAccountManagerChrome(nsAString& aResult) {
  aResult.AssignLiteral("am-newsblog.xhtml");
  return NS_OK;
}

NS_IMETHODIMP nsRssIncomingServer::GetOfflineSupportLevel(
    int32_t* aSupportLevel) {
  NS_ENSURE_ARG_POINTER(aSupportLevel);
  *aSupportLevel = OFFLINE_SUPPORT_LEVEL_NONE;
  return NS_OK;
}

NS_IMETHODIMP nsRssIncomingServer::GetSupportsDiskSpace(
    bool* aSupportsDiskSpace) {
  NS_ENSURE_ARG_POINTER(aSupportsDiskSpace);
  *aSupportsDiskSpace = true;
  return NS_OK;
}

NS_IMETHODIMP nsRssIncomingServer::GetServerRequiresPasswordForBiff(
    bool* aServerRequiresPasswordForBiff) {
  NS_ENSURE_ARG_POINTER(aServerRequiresPasswordForBiff);
  // For Feed folders, we don't require a password.
  *aServerRequiresPasswordForBiff = false;
  return NS_OK;
}

NS_IMETHODIMP nsRssIncomingServer::GetCanSearchMessages(
    bool* canSearchMessages) {
  NS_ENSURE_ARG_POINTER(canSearchMessages);
  *canSearchMessages = true;
  return NS_OK;
}

NS_IMETHODIMP nsRssIncomingServer::MsgAdded(nsIMsgDBHdr* aMsg) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsRssIncomingServer::MsgPropertyChanged(
    nsIMsgDBHdr* aMsg, const char* aProperty, const nsACString& aOldValue,
    const nsACString& aNewValue) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsRssIncomingServer::MsgsClassified(
    const nsTArray<RefPtr<nsIMsgDBHdr>>& aMsgs, bool aJunkProcessed,
    bool aTraitProcessed) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsRssIncomingServer::MsgsJunkStatusChanged(
    const nsTArray<RefPtr<nsIMsgDBHdr>>& messages) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsRssIncomingServer::MsgsDeleted(
    const nsTArray<RefPtr<nsIMsgDBHdr>>& aMsgs) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsRssIncomingServer::MsgsMoveCopyCompleted(
    bool aMove, const nsTArray<RefPtr<nsIMsgDBHdr>>& aSrcMsgs,
    nsIMsgFolder* aDestFolder, const nsTArray<RefPtr<nsIMsgDBHdr>>& aDestMsgs) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsRssIncomingServer::MsgKeyChanged(nsMsgKey aOldKey,
                                                 nsIMsgDBHdr* aNewHdr) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsRssIncomingServer::FolderAdded(nsIMsgFolder* aFolder) {
  // Nothing to do. Not necessary for new folder adds, as a new folder never
  // has a subscription.
  return NS_OK;
}

NS_IMETHODIMP nsRssIncomingServer::FolderDeleted(nsIMsgFolder* aFolder) {
  // Not necessary for folder deletes, which are move to Trash and handled by
  // movecopy. Virtual folder or trash folder deletes send a folderdeleted,
  // but these should have no subscriptions already.
  return NS_OK;
}

NS_IMETHODIMP nsRssIncomingServer::FolderMoveCopyCompleted(
    bool aMove, nsIMsgFolder* aSrcFolder, nsIMsgFolder* aDestFolder) {
  return FolderChanged(aDestFolder, aSrcFolder, (aMove ? "move" : "copy"));
}

NS_IMETHODIMP nsRssIncomingServer::FolderRenamed(nsIMsgFolder* aOrigFolder,
                                                 nsIMsgFolder* aNewFolder) {
  return FolderChanged(aNewFolder, aOrigFolder, "rename");
}

nsresult nsRssIncomingServer::FolderChanged(nsIMsgFolder* aFolder,
                                            nsIMsgFolder* aOrigFolder,
                                            const char* aAction) {
  if (!aFolder) return NS_OK;

  nsresult rv;
  nsCOMPtr<nsINewsBlogFeedDownloader> rssDownloader =
      do_GetService("@mozilla.org/newsblog-feed-downloader;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  rssDownloader->UpdateSubscriptionsDS(aFolder, aOrigFolder, aAction);
  return rv;
}

NS_IMETHODIMP nsRssIncomingServer::MsgUnincorporatedMoved(
    nsIMsgFolder* srcFolder, nsIMsgDBHdr* msg) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsRssIncomingServer::FolderCompactStart(nsIMsgFolder* folder) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsRssIncomingServer::FolderCompactFinish(nsIMsgFolder* folder) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsRssIncomingServer::FolderReindexTriggered(
    nsIMsgFolder* folder) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
