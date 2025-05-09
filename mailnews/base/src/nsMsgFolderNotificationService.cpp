/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "msgCore.h"
#include "nsMsgFolderNotificationService.h"
#include "nsIMsgHdr.h"
#include "nsIMsgFolder.h"
#include "nsIMsgImapMailFolder.h"
#include "nsIImapIncomingServer.h"

//
//  nsMsgFolderNotificationService
//
NS_IMPL_ISUPPORTS(nsMsgFolderNotificationService,
                  nsIMsgFolderNotificationService)

nsMsgFolderNotificationService::nsMsgFolderNotificationService() {}

nsMsgFolderNotificationService::~nsMsgFolderNotificationService() {
  /* destructor code */
}

NS_IMETHODIMP nsMsgFolderNotificationService::GetHasListeners(
    bool* aHasListeners) {
  NS_ENSURE_ARG_POINTER(aHasListeners);
  *aHasListeners = mListeners.Length() > 0;
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::AddListener(
    nsIMsgFolderListener* aListener, msgFolderListenerFlag aFlags) {
  NS_ENSURE_ARG_POINTER(aListener);
  MsgFolderListener listener(aListener, aFlags);
  mListeners.AppendElementUnlessExists(listener);
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::RemoveListener(
    nsIMsgFolderListener* aListener) {
  NS_ENSURE_ARG_POINTER(aListener);

  mListeners.RemoveElement(aListener);
  return NS_OK;
}

#define NOTIFY_MSGFOLDER_LISTENERS(propertyflag_, propertyfunc_, params_) \
  PR_BEGIN_MACRO                                                          \
  nsTObserverArray<MsgFolderListener>::ForwardIterator iter(mListeners);  \
  while (iter.HasMore()) {                                                \
    const MsgFolderListener& listener = iter.GetNext();                   \
    if (listener.mFlags & propertyflag_)                                  \
      listener.mListener->propertyfunc_ params_;                          \
  }                                                                       \
  PR_END_MACRO

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyMsgAdded(
    nsIMsgDBHdr* aMsg) {
  NOTIFY_MSGFOLDER_LISTENERS(msgAdded, MsgAdded, (aMsg));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyMsgPropertyChanged(
    nsIMsgDBHdr* aMsg, const char* aProperty, const nsACString& aOldValue,
    const nsACString& aNewValue) {
  NOTIFY_MSGFOLDER_LISTENERS(msgPropertyChanged, MsgPropertyChanged,
                             (aMsg, aProperty, aOldValue, aNewValue));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyMsgsClassified(
    const nsTArray<RefPtr<nsIMsgDBHdr>>& aMsgs, bool aJunkProcessed,
    bool aTraitProcessed) {
  NOTIFY_MSGFOLDER_LISTENERS(msgsClassified, MsgsClassified,
                             (aMsgs, aJunkProcessed, aTraitProcessed));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyMsgsJunkStatusChanged(
    const nsTArray<RefPtr<nsIMsgDBHdr>>& messages) {
  NOTIFY_MSGFOLDER_LISTENERS(msgsJunkStatusChanged, MsgsJunkStatusChanged,
                             (messages));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyMsgsDeleted(
    const nsTArray<RefPtr<nsIMsgDBHdr>>& aMsgs) {
  NOTIFY_MSGFOLDER_LISTENERS(msgsDeleted, MsgsDeleted, (aMsgs));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyMsgsMoveCopyCompleted(
    bool aMove, const nsTArray<RefPtr<nsIMsgDBHdr>>& aSrcMsgs,
    nsIMsgFolder* aDestFolder, const nsTArray<RefPtr<nsIMsgDBHdr>>& aDestMsgs) {
  // IMAP delete model means that a "move" isn't really a move, it is a copy,
  // followed by storing the IMAP deleted flag on the message.
  bool isReallyMove = aMove;
  if (aMove && !mListeners.IsEmpty() && !aSrcMsgs.IsEmpty()) {
    nsresult rv;
    // Assume that all the source messages are from the same server.
    nsCOMPtr<nsIMsgFolder> msgFolder;
    rv = aSrcMsgs[0]->GetFolder(getter_AddRefs(msgFolder));
    NS_ENSURE_SUCCESS(rv, rv);

    nsCOMPtr<nsIMsgImapMailFolder> imapFolder(do_QueryInterface(msgFolder));
    if (imapFolder) {
      nsCOMPtr<nsIImapIncomingServer> imapServer;
      imapFolder->GetImapIncomingServer(getter_AddRefs(imapServer));
      if (imapServer) {
        nsMsgImapDeleteModel deleteModel;
        imapServer->GetDeleteModel(&deleteModel);
        if (deleteModel == nsMsgImapDeleteModels::IMAPDelete)
          isReallyMove = false;
      }
    }
  }

  NOTIFY_MSGFOLDER_LISTENERS(msgsMoveCopyCompleted, MsgsMoveCopyCompleted,
                             (isReallyMove, aSrcMsgs, aDestFolder, aDestMsgs));
  return NS_OK;
}

NS_IMETHODIMP
nsMsgFolderNotificationService::NotifyMsgKeyChanged(nsMsgKey aOldKey,
                                                    nsIMsgDBHdr* aNewHdr) {
  NOTIFY_MSGFOLDER_LISTENERS(msgKeyChanged, MsgKeyChanged, (aOldKey, aNewHdr));
  return NS_OK;
}

NS_IMETHODIMP
nsMsgFolderNotificationService::NotifyMsgUnincorporatedMoved(
    nsIMsgFolder* srcFolder, nsIMsgDBHdr* msg) {
  NOTIFY_MSGFOLDER_LISTENERS(msgUnincorporatedMoved, MsgUnincorporatedMoved,
                             (srcFolder, msg));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyFolderAdded(
    nsIMsgFolder* aFolder) {
  NOTIFY_MSGFOLDER_LISTENERS(folderAdded, FolderAdded, (aFolder));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyFolderDeleted(
    nsIMsgFolder* aFolder) {
  NOTIFY_MSGFOLDER_LISTENERS(folderDeleted, FolderDeleted, (aFolder));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyFolderMoveCopyCompleted(
    bool aMove, nsIMsgFolder* aSrcFolder, nsIMsgFolder* aDestFolder) {
  NOTIFY_MSGFOLDER_LISTENERS(folderMoveCopyCompleted, FolderMoveCopyCompleted,
                             (aMove, aSrcFolder, aDestFolder));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyFolderRenamed(
    nsIMsgFolder* aOrigFolder, nsIMsgFolder* aNewFolder) {
  NOTIFY_MSGFOLDER_LISTENERS(folderRenamed, FolderRenamed,
                             (aOrigFolder, aNewFolder));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyFolderCompactStart(
    nsIMsgFolder* folder) {
  NOTIFY_MSGFOLDER_LISTENERS(folderCompactStart, FolderCompactStart, (folder));
  return NS_OK;
}

NS_IMETHODIMP nsMsgFolderNotificationService::NotifyFolderCompactFinish(
    nsIMsgFolder* folder) {
  NOTIFY_MSGFOLDER_LISTENERS(folderCompactFinish, FolderCompactFinish,
                             (folder));
  return NS_OK;
}
NS_IMETHODIMP nsMsgFolderNotificationService::NotifyFolderReindexTriggered(
    nsIMsgFolder* folder) {
  NOTIFY_MSGFOLDER_LISTENERS(folderReindexTriggered, FolderReindexTriggered,
                             (folder));
  return NS_OK;
}
