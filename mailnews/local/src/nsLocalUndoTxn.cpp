/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsLocalUndoTxn.h"

#include "mozilla/Components.h"
#include "msgCore.h"
#include "nsIMsgHdr.h"
#include "nsImapCore.h"
#include "nsIImapService.h"
#include "nsIUrlListener.h"
#include "nsIMsgLocalMailFolder.h"
#include "nsIMsgMailSession.h"
#include "nsIMsgFolderNotificationService.h"
#include "nsIMsgDatabase.h"
#include "nsIMsgHdr.h"
#include "nsServiceManagerUtils.h"
#include "nsMsgUtils.h"
#include "nsMsgDBFolder.h"

NS_IMPL_ISUPPORTS_INHERITED(nsLocalMoveCopyMsgTxn, nsMsgTxn, nsIFolderListener)

nsLocalMoveCopyMsgTxn::nsLocalMoveCopyMsgTxn()
    : m_isMove(false),
      m_srcIsImap4(false),
      m_undoing(false),
      m_numHdrsCopied(0),
      mUndoFolderListener(nullptr) {}

nsLocalMoveCopyMsgTxn::~nsLocalMoveCopyMsgTxn() {}

nsresult nsLocalMoveCopyMsgTxn::Init(nsIMsgFolder* srcFolder,
                                     nsIMsgFolder* dstFolder, bool isMove) {
  nsresult rv;
  rv = SetSrcFolder(srcFolder);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = SetDstFolder(dstFolder);
  NS_ENSURE_SUCCESS(rv, rv);
  m_isMove = isMove;

  mUndoFolderListener = nullptr;

  nsCString protocolType;
  rv = srcFolder->GetURI(protocolType);
  protocolType.SetLength(protocolType.FindChar(':'));
  if (protocolType.LowerCaseEqualsLiteral("imap")) m_srcIsImap4 = true;
  return NS_OK;
}
nsresult nsLocalMoveCopyMsgTxn::GetSrcIsImap(bool* isImap) {
  *isImap = m_srcIsImap4;
  return NS_OK;
}
nsresult nsLocalMoveCopyMsgTxn::SetSrcFolder(nsIMsgFolder* srcFolder) {
  nsresult rv = NS_ERROR_NULL_POINTER;
  if (srcFolder) m_srcFolder = do_GetWeakReference(srcFolder, &rv);
  return rv;
}

nsresult nsLocalMoveCopyMsgTxn::SetDstFolder(nsIMsgFolder* dstFolder) {
  nsresult rv = NS_ERROR_NULL_POINTER;
  if (dstFolder) m_dstFolder = do_GetWeakReference(dstFolder, &rv);
  return rv;
}

nsresult nsLocalMoveCopyMsgTxn::AddSrcKey(nsMsgKey aKey) {
  m_srcKeyArray.AppendElement(aKey);
  return NS_OK;
}

nsresult nsLocalMoveCopyMsgTxn::AddDstKey(nsMsgKey aKey) {
  m_dstKeyArray.AppendElement(aKey);
  return NS_OK;
}

nsresult nsLocalMoveCopyMsgTxn::AddDstMsgSize(uint32_t msgSize) {
  m_dstSizeArray.AppendElement(msgSize);
  return NS_OK;
}

nsresult nsLocalMoveCopyMsgTxn::UndoImapDeleteFlag(nsIMsgFolder* folder,
                                                   nsTArray<nsMsgKey>& keyArray,
                                                   bool deleteFlag) {
  nsresult rv = NS_ERROR_FAILURE;
  if (m_srcIsImap4) {
    nsCOMPtr<nsIImapService> imapService = mozilla::components::Imap::Service();
    nsCOMPtr<nsIUrlListener> urlListener;
    nsCString msgIds;
    uint32_t i, count = keyArray.Length();
    urlListener = do_QueryInterface(folder, &rv);
    for (i = 0; i < count; i++) {
      if (!msgIds.IsEmpty()) msgIds.Append(',');
      msgIds.AppendInt((int32_t)keyArray[i]);
    }
    // This is to make sure that we are in the selected state
    // when executing the imap url; we don't want to load the
    // folder so use lite select to do the trick
    rv = imapService->LiteSelectFolder(folder, urlListener, nullptr, nullptr);
    if (!deleteFlag)
      rv = imapService->AddMessageFlags(folder, urlListener, msgIds,
                                        kImapMsgDeletedFlag, true);
    else
      rv = imapService->SubtractMessageFlags(folder, urlListener, msgIds,
                                             kImapMsgDeletedFlag, true);
    if (NS_SUCCEEDED(rv) && m_msgWindow) folder->UpdateFolder(m_msgWindow);
    rv = NS_OK;  // always return NS_OK to indicate that the src is imap
  } else
    rv = NS_ERROR_FAILURE;
  return rv;
}

NS_IMETHODIMP
nsLocalMoveCopyMsgTxn::UndoTransaction() {
  nsresult rv;
  nsCOMPtr<nsIMsgDatabase> dstDB;

  nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsIMsgLocalMailFolder> dstlocalMailFolder =
      do_QueryReferent(m_dstFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  dstlocalMailFolder->GetDatabaseWOReparse(getter_AddRefs(dstDB));

  if (!dstDB) {
    // This will listen for the db reparse finishing, and the corresponding
    // FolderLoadedNotification. When it gets that, it will then call
    // UndoTransactionInternal.
    mUndoFolderListener = new nsLocalUndoFolderListener(this, dstFolder);
    if (!mUndoFolderListener) return NS_ERROR_OUT_OF_MEMORY;
    NS_ADDREF(mUndoFolderListener);

    nsCOMPtr<nsIMsgMailSession> mailSession =
        mozilla::components::MailSession::Service();
    rv = mailSession->AddFolderListener(mUndoFolderListener,
                                        nsIFolderListener::event);
    NS_ENSURE_SUCCESS(rv, rv);

    rv = dstFolder->GetMsgDatabase(getter_AddRefs(dstDB));
    NS_ENSURE_SUCCESS(rv, rv);
  } else
    rv = UndoTransactionInternal();
  return rv;
}

nsresult nsLocalMoveCopyMsgTxn::UndoTransactionInternal() {
  nsresult rv = NS_ERROR_FAILURE;

  if (mUndoFolderListener) {
    nsCOMPtr<nsIMsgMailSession> mailSession =
        mozilla::components::MailSession::Service();
    rv = mailSession->RemoveFolderListener(mUndoFolderListener);
    NS_ENSURE_SUCCESS(rv, rv);

    NS_RELEASE(mUndoFolderListener);
    mUndoFolderListener = nullptr;
  }

  nsCOMPtr<nsIMsgDatabase> srcDB;
  nsCOMPtr<nsIMsgDatabase> dstDB;
  nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = srcFolder->GetMsgDatabase(getter_AddRefs(srcDB));
  if (NS_FAILED(rv)) return rv;

  rv = dstFolder->GetMsgDatabase(getter_AddRefs(dstDB));
  if (NS_FAILED(rv)) return rv;

  uint32_t count = m_srcKeyArray.Length();
  uint32_t i;

  // protect against a bogus undo txn without any source keys
  // see bug #179856 for details
  NS_ASSERTION(count, "no source keys");
  if (!count) return NS_ERROR_UNEXPECTED;

  if (m_isMove) {
    if (m_srcIsImap4) {
      bool deleteFlag =
          true;  // message has been deleted -we are trying to undo it
      CheckForToggleDelete(srcFolder, m_srcKeyArray[0],
                           &deleteFlag);  // there could have been a toggle.
      rv = UndoImapDeleteFlag(srcFolder, m_srcKeyArray, deleteFlag);
    } else  // undoing a move means moving the messages back.
    {
      nsTArray<RefPtr<nsIMsgDBHdr>> dstMessages(m_dstKeyArray.Length());
      m_numHdrsCopied = 0;
      m_srcKeyArray.Clear();
      for (i = 0; i < count; i++) {
        // GetMsgHdrForKey is not a test for whether the key exists, so check.
        bool hasKey = false;
        dstDB->ContainsKey(m_dstKeyArray[i], &hasKey);
        nsCOMPtr<nsIMsgDBHdr> dstHdr;
        if (hasKey)
          dstDB->GetMsgHdrForKey(m_dstKeyArray[i], getter_AddRefs(dstHdr));
        if (dstHdr) {
          nsCString messageId;
          dstHdr->GetMessageId(messageId);
          dstMessages.AppendElement(dstHdr);
          m_copiedMsgIds.AppendElement(messageId);
        } else {
          NS_WARNING("Cannot get old msg header");
        }
      }
      if (m_copiedMsgIds.Length()) {
        srcFolder->AddFolderListener(this);
        m_undoing = true;
        return srcFolder->CopyMessages(dstFolder, dstMessages, true, nullptr,
                                       nullptr, false, false);
      } else {
        // Nothing to do, probably because original messages were deleted.
        NS_WARNING("Undo did not find any messages to move");
      }
    }
    srcDB->SetSummaryValid(true);
  }

  dstDB->DeleteMessages(m_dstKeyArray, nullptr);
  dstDB->SetSummaryValid(true);

  return rv;
}

NS_IMETHODIMP
nsLocalMoveCopyMsgTxn::RedoTransaction() {
  nsresult rv;
  nsCOMPtr<nsIMsgDatabase> srcDB;
  nsCOMPtr<nsIMsgDatabase> dstDB;

  nsCOMPtr<nsIMsgFolder> srcFolder = do_QueryReferent(m_srcFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgFolder> dstFolder = do_QueryReferent(m_dstFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = srcFolder->GetMsgDatabase(getter_AddRefs(srcDB));
  if (NS_FAILED(rv)) return rv;
  rv = dstFolder->GetMsgDatabase(getter_AddRefs(dstDB));
  if (NS_FAILED(rv)) return rv;

  nsTArray<RefPtr<nsIMsgDBHdr>> srcMessages(m_srcKeyArray.Length());
  nsCOMPtr<nsIMsgDBHdr> srcHdr;
  m_numHdrsCopied = 0;
  m_dstKeyArray.Clear();
  for (nsMsgKey srcKey : m_srcKeyArray) {
    rv = srcDB->GetMsgHdrForKey(srcKey, getter_AddRefs(srcHdr));
    NS_ASSERTION(srcHdr, "fatal ... cannot get old msg header");
    if (NS_SUCCEEDED(rv) && srcHdr) {
      srcMessages.AppendElement(srcHdr);
      nsCString messageId;
      srcHdr->GetMessageId(messageId);
      m_copiedMsgIds.AppendElement(messageId);
    }
  }
  dstFolder->AddFolderListener(this);
  m_undoing = false;
  return dstFolder->CopyMessages(srcFolder, srcMessages, m_isMove, nullptr,
                                 nullptr, false, false);
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderAdded(nsIMsgFolder* parent,
                                                   nsIMsgFolder* child) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnMessageAdded(nsIMsgFolder* parent,
                                                    nsIMsgDBHdr* msgHdr) {
  nsresult rv;
  nsCOMPtr<nsIMsgFolder> folder =
      do_QueryReferent(m_undoing ? m_srcFolder : m_dstFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCString messageId;
  msgHdr->GetMessageId(messageId);
  if (m_copiedMsgIds.Contains(messageId)) {
    nsMsgKey msgKey;
    msgHdr->GetMessageKey(&msgKey);
    if (m_undoing)
      m_srcKeyArray.AppendElement(msgKey);
    else
      m_dstKeyArray.AppendElement(msgKey);
    if (++m_numHdrsCopied == m_copiedMsgIds.Length()) {
      folder->RemoveFolderListener(this);
      m_copiedMsgIds.Clear();
    }
  }
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderRemoved(nsIMsgFolder* parent,
                                                     nsIMsgFolder* child) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnMessageRemoved(nsIMsgFolder* parent,
                                                      nsIMsgDBHdr* msg) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, const nsACString& oldValue,
    const nsACString& newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderIntPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, int64_t oldValue,
    int64_t newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderBoolPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, bool oldValue,
    bool newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderPropertyFlagChanged(
    nsIMsgDBHdr* item, const nsACString& property, uint32_t oldFlag,
    uint32_t newFlag) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalMoveCopyMsgTxn::OnFolderEvent(nsIMsgFolder* aItem,
                                                   const nsACString& aEvent) {
  return NS_OK;
}

NS_IMPL_ISUPPORTS(nsLocalUndoFolderListener, nsIFolderListener)

nsLocalUndoFolderListener::nsLocalUndoFolderListener(
    nsLocalMoveCopyMsgTxn* aTxn, nsIMsgFolder* aFolder) {
  mTxn = aTxn;
  mFolder = aFolder;
}

nsLocalUndoFolderListener::~nsLocalUndoFolderListener() {}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderAdded(nsIMsgFolder* parent,
                                                       nsIMsgFolder* child) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnMessageAdded(nsIMsgFolder* parent,
                                                        nsIMsgDBHdr* msg) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderRemoved(nsIMsgFolder* parent,
                                                         nsIMsgFolder* child) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnMessageRemoved(nsIMsgFolder* parent,
                                                          nsIMsgDBHdr* msg) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, const nsACString& oldValue,
    const nsACString& newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderIntPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, int64_t oldValue,
    int64_t newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderBoolPropertyChanged(
    nsIMsgFolder* item, const nsACString& property, bool oldValue,
    bool newValue) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderPropertyFlagChanged(
    nsIMsgDBHdr* item, const nsACString& property, uint32_t oldFlag,
    uint32_t newFlag) {
  return NS_OK;
}

NS_IMETHODIMP nsLocalUndoFolderListener::OnFolderEvent(
    nsIMsgFolder* aItem, const nsACString& aEvent) {
  if (mTxn && mFolder && aItem == mFolder) {
    if (aEvent.Equals(kFolderLoaded)) return mTxn->UndoTransactionInternal();
  }

  return NS_ERROR_FAILURE;
}
