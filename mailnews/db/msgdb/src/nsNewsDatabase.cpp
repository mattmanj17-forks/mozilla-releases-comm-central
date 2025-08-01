/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsNewsDatabase.h"

#include "MailNewsTypes.h"
#include "mozilla/Preferences.h"
#include "msgCore.h"
#include "nsIMsgDBView.h"
#include "nsIMsgThread.h"
#include "nsMsgKeySet.h"
#include "nsMsgMessageFlags.h"
#include "nsCOMPtr.h"
#include "prlog.h"
#include "nsIMsgNewsFolder.h"

using mozilla::Preferences;

nsNewsDatabase::nsNewsDatabase() { m_readSet = nullptr; }

nsNewsDatabase::~nsNewsDatabase() {}

NS_IMPL_ADDREF_INHERITED(nsNewsDatabase, nsMsgDatabase)
NS_IMPL_RELEASE_INHERITED(nsNewsDatabase, nsMsgDatabase)

NS_IMETHODIMP nsNewsDatabase::QueryInterface(REFNSIID aIID,
                                             void** aInstancePtr) {
  if (!aInstancePtr) return NS_ERROR_NULL_POINTER;
  *aInstancePtr = nullptr;

  if (aIID.Equals(NS_GET_IID(nsINewsDatabase))) {
    *aInstancePtr = static_cast<nsINewsDatabase*>(this);
  }

  if (*aInstancePtr) {
    AddRef();
    return NS_OK;
  }

  return nsMsgDatabase::QueryInterface(aIID, aInstancePtr);
}

nsresult nsNewsDatabase::Close(bool forceCommit) {
  return nsMsgDatabase::Close(forceCommit);
}

nsresult nsNewsDatabase::ForceClosed() { return nsMsgDatabase::ForceClosed(); }

nsresult nsNewsDatabase::Commit(nsMsgDBCommit commitType) {
  if (m_dbFolderInfo && m_readSet) {
    // let's write out our idea of the read set so we can compare it with that
    // of the .rc file next time we start up.
    nsCString readSet;
    m_readSet->Output(getter_Copies(readSet));
    m_dbFolderInfo->SetCharProperty("readSet", readSet);
  }
  return nsMsgDatabase::Commit(commitType);
}

uint32_t nsNewsDatabase::GetCurVersion() { return kMsgDBVersion; }

NS_IMETHODIMP nsNewsDatabase::IsRead(nsMsgKey key, bool* pRead) {
  NS_ASSERTION(pRead, "null out param in IsRead");
  if (!pRead) return NS_ERROR_NULL_POINTER;

  if (!m_readSet) return NS_ERROR_FAILURE;

  *pRead = m_readSet->IsMember(key);
  return NS_OK;
}

nsresult nsNewsDatabase::IsHeaderRead(nsIMsgDBHdr* msgHdr, bool* pRead) {
  nsresult rv;
  nsMsgKey messageKey;

  if (!msgHdr || !pRead) return NS_ERROR_NULL_POINTER;

  rv = msgHdr->GetMessageKey(&messageKey);
  if (NS_FAILED(rv)) return rv;

  rv = IsRead(messageKey, pRead);
  return rv;
}

NS_IMETHODIMP nsNewsDatabase::GetReadSet(nsMsgKeySet** pSet) {
  if (!pSet) return NS_ERROR_NULL_POINTER;
  *pSet = m_readSet;
  return NS_OK;
}

NS_IMETHODIMP nsNewsDatabase::SetReadSet(nsMsgKeySet* pSet) {
  m_readSet = pSet;

  if (m_readSet) {
    // compare this read set with the one in the db folder info.
    // If not equivalent, sync with this one.
    nsCString dbReadSet;
    if (m_dbFolderInfo) m_dbFolderInfo->GetCharProperty("readSet", dbReadSet);
    nsCString newsrcReadSet;
    m_readSet->Output(getter_Copies(newsrcReadSet));
    if (!dbReadSet.Equals(newsrcReadSet)) SyncWithReadSet();
  }
  return NS_OK;
}

bool nsNewsDatabase::SetHdrReadFlag(nsIMsgDBHdr* msgHdr, bool bRead) {
  nsresult rv;
  bool isRead;
  rv = IsHeaderRead(msgHdr, &isRead);

  if (isRead == bRead) {
    // give the base class a chance to update m_flags.
    nsMsgDatabase::SetHdrReadFlag(msgHdr, bRead);
    return false;
  } else {
    nsMsgKey messageKey;

    // give the base class a chance to update m_flags.
    nsMsgDatabase::SetHdrReadFlag(msgHdr, bRead);
    rv = msgHdr->GetMessageKey(&messageKey);
    if (NS_FAILED(rv)) return false;

    NS_ASSERTION(m_readSet, "m_readSet is null");
    if (!m_readSet) return false;

    if (!bRead) {
      m_readSet->Remove(messageKey);

      rv = NotifyReadChanged(nullptr);
      if (NS_FAILED(rv)) return false;
    } else {
      if (m_readSet->Add(messageKey) < 0) return false;

      rv = NotifyReadChanged(nullptr);
      if (NS_FAILED(rv)) return false;
    }
  }
  return true;
}

nsresult nsNewsDatabase::SyncWithReadSet() {
  // The code below attempts to update the underlying nsMsgDatabase's idea
  // of read/unread flags to match the read set in the .newsrc file. It should
  // only be called when they don't match, e.g., we crashed after committing the
  // db but before writing out the .newsrc
  nsCOMPtr<nsIMsgEnumerator> hdrs;
  nsresult rv = EnumerateMessages(getter_AddRefs(hdrs));
  NS_ENSURE_SUCCESS(rv, rv);

  bool hasMore = false, readInNewsrc, isReadInDB, changed = false;
  int32_t numMessages = 0, numUnreadMessages = 0;

  // Scan all messages in DB
  while (NS_SUCCEEDED(rv = hdrs->HasMoreElements(&hasMore)) && hasMore) {
    nsCOMPtr<nsIMsgDBHdr> header;
    rv = hdrs->GetNext(getter_AddRefs(header));
    NS_ENSURE_SUCCESS(rv, rv);

    rv = nsMsgDatabase::IsHeaderRead(header, &isReadInDB);
    NS_ENSURE_SUCCESS(rv, rv);

    nsMsgKey messageKey;
    header->GetMessageKey(&messageKey);
    IsRead(messageKey, &readInNewsrc);

    numMessages++;
    if (!readInNewsrc) numUnreadMessages++;

    // If DB and readSet disagree on Read/Unread, fix DB
    if (readInNewsrc != isReadInDB) {
      MarkHdrRead(header, readInNewsrc, nullptr);
      changed = true;
    }
  }

  // Update FolderInfo Counters
  if (m_dbFolderInfo) {
    do {
      int32_t oldMessages, oldUnreadMessages;
      rv = m_dbFolderInfo->GetNumMessages(&oldMessages);
      if (NS_FAILED(rv)) break;
      if (oldMessages != numMessages) {
        changed = true;
        m_dbFolderInfo->ChangeNumMessages(numMessages - oldMessages);
      }
      rv = m_dbFolderInfo->GetNumUnreadMessages(&oldUnreadMessages);
      if (NS_FAILED(rv)) break;
      if (oldUnreadMessages != numUnreadMessages) {
        changed = true;
        m_dbFolderInfo->ChangeNumUnreadMessages(numUnreadMessages -
                                                oldUnreadMessages);
      }
    } while (false);
  }

  if (changed) Commit(nsMsgDBCommitType::kLargeCommit);

  return rv;
}

nsresult nsNewsDatabase::AdjustExpungedBytesOnDelete(nsIMsgDBHdr* msgHdr) {
  uint32_t msgFlags;
  msgHdr->GetFlags(&msgFlags);
  if (msgFlags & nsMsgMessageFlags::Offline && m_dbFolderInfo) {
    uint32_t size = 0;
    (void)msgHdr->GetOfflineMessageSize(&size);
    return m_dbFolderInfo->ChangeExpungedBytes(size);
  }
  return NS_OK;
}

NS_IMETHODIMP
nsNewsDatabase::GetDefaultViewFlags(
    nsMsgViewFlagsTypeValue* aDefaultViewFlags) {
  NS_ENSURE_ARG_POINTER(aDefaultViewFlags);
  Preferences::GetInt("mailnews.default_news_view_flags", aDefaultViewFlags);
  if (*aDefaultViewFlags < nsMsgViewFlagsType::kNone ||
      *aDefaultViewFlags >
          (nsMsgViewFlagsType::kThreadedDisplay |
           nsMsgViewFlagsType::kShowIgnored | nsMsgViewFlagsType::kUnreadOnly |
           nsMsgViewFlagsType::kExpandAll | nsMsgViewFlagsType::kGroupBySort))
    *aDefaultViewFlags = nsMsgViewFlagsType::kThreadedDisplay;
  return NS_OK;
}

NS_IMETHODIMP
nsNewsDatabase::GetDefaultSortType(nsMsgViewSortTypeValue* aDefaultSortType) {
  NS_ENSURE_ARG_POINTER(aDefaultSortType);
  Preferences::GetInt("mailnews.default_news_sort_type", aDefaultSortType);
  if (*aDefaultSortType < nsMsgViewSortType::byDate ||
      *aDefaultSortType > nsMsgViewSortType::byAccount)
    *aDefaultSortType = nsMsgViewSortType::byThread;
  return NS_OK;
}

NS_IMETHODIMP
nsNewsDatabase::GetDefaultSortOrder(
    nsMsgViewSortOrderValue* aDefaultSortOrder) {
  NS_ENSURE_ARG_POINTER(aDefaultSortOrder);
  Preferences::GetInt("mailnews.default_news_sort_order", aDefaultSortOrder);
  if (*aDefaultSortOrder != nsMsgViewSortOrder::descending)
    *aDefaultSortOrder = nsMsgViewSortOrder::ascending;
  return NS_OK;
}

nsresult nsNewsDatabase::GetEffectiveCharset(nsIMdbRow* row,
                                             nsACString& resultCharset) {
  resultCharset.Truncate();
  nsresult rv = RowCellColumnToCharPtr(row, m_messageCharSetColumnToken,
                                       getter_Copies(resultCharset));
  if (NS_FAILED(rv) || resultCharset.IsEmpty() ||
      resultCharset.EqualsLiteral("us-ascii")) {
    if (mCachedCharset.IsEmpty()) {
      mCachedCharset.AssignLiteral("UTF-8");
      nsCOMPtr<nsIMsgNewsFolder> newsfolder(do_QueryInterface(m_folder));
      if (newsfolder) {
        newsfolder->GetCharset(mCachedCharset);
      }
    }
    resultCharset.Assign(mCachedCharset);
  }
  return rv;
}
