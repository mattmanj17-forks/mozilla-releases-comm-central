/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgSearchDBView.h"

#include "mozilla/Components.h"
#include "mozilla/Preferences.h"
#include "mozilla/ProfilerMarkers.h"
#include "msgCore.h"
#include "nsIMsgHdr.h"
#include "nsIMsgThread.h"
#include "nsIDBFolderInfo.h"
#include "nsIMsgCopyService.h"
#include "nsMsgUtils.h"
#include "nsTreeColumns.h"
#include "nsIMsgMessageService.h"
#include "nsMsgGroupThread.h"
#include "nsMsgMessageFlags.h"
#include "nsIMsgSearchSession.h"
#include "nsServiceManagerUtils.h"
#include "nsIMsgImapMailFolder.h"

using mozilla::Preferences;

static bool gReferenceOnlyThreading;

nsMsgSearchDBView::nsMsgSearchDBView() {
  m_totalMessagesInView = 0;
  m_nextThreadId = 1;
  mCurIndex = 0;
  mTotalIndices = 0;
  mCommand = -1;
}

nsMsgSearchDBView::~nsMsgSearchDBView() {}

NS_IMPL_ISUPPORTS_INHERITED(nsMsgSearchDBView, nsMsgDBView, nsIMsgDBView,
                            nsIMsgCopyServiceListener, nsIMsgSearchNotify)

NS_IMETHODIMP
nsMsgSearchDBView::Open(nsIMsgFolder* folder, nsMsgViewSortTypeValue sortType,
                        nsMsgViewSortOrderValue sortOrder,
                        nsMsgViewFlagsTypeValue viewFlags) {
  AUTO_PROFILER_LABEL("nsMsgSearchDBView::Open", MAILNEWS);
  // DBViewWrapper.sys.mjs likes to create search views with a sort order
  // of byNone, in order to have the order be the order the search results
  // are returned. But this doesn't work with threaded view, so make the
  // sort order be byDate if we're threaded.

  if (viewFlags & nsMsgViewFlagsType::kThreadedDisplay &&
      sortType == nsMsgViewSortType::byNone)
    sortType = nsMsgViewSortType::byDate;

  nsresult rv = nsMsgDBView::Open(folder, sortType, sortOrder, viewFlags);
  NS_ENSURE_SUCCESS(rv, rv);

  // For other view types this will happen in OpenWithHdrs called by
  // RebuildView.
  if (m_viewFlags & nsMsgViewFlagsType::kGroupBySort) {
    SaveSortInfo(sortType, sortOrder);
  }

  Preferences::GetBool("mail.strict_threading", &gReferenceOnlyThreading);

  // Our sort is automatically valid because we have no contents at this point!
  m_sortValid = true;
  m_folder = nullptr;
  return rv;
}

NS_IMETHODIMP
nsMsgSearchDBView::CloneDBView(nsIMessenger* aMessengerInstance,
                               nsIMsgWindow* aMsgWindow,
                               nsIMsgDBViewCommandUpdater* aCmdUpdater,
                               nsIMsgDBView** _retval) {
  nsMsgSearchDBView* newMsgDBView = new nsMsgSearchDBView();
  nsresult rv =
      CopyDBView(newMsgDBView, aMessengerInstance, aMsgWindow, aCmdUpdater);
  NS_ENSURE_SUCCESS(rv, rv);

  NS_IF_ADDREF(*_retval = newMsgDBView);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchDBView::CopyDBView(nsMsgDBView* aNewMsgDBView,
                              nsIMessenger* aMessengerInstance,
                              nsIMsgWindow* aMsgWindow,
                              nsIMsgDBViewCommandUpdater* aCmdUpdater) {
  nsMsgGroupView::CopyDBView(aNewMsgDBView, aMessengerInstance, aMsgWindow,
                             aCmdUpdater);
  nsMsgSearchDBView* newMsgDBView = (nsMsgSearchDBView*)aNewMsgDBView;

  // Now copy all of our private member data.
  newMsgDBView->mDestFolder = mDestFolder;
  newMsgDBView->mCommand = mCommand;
  newMsgDBView->mTotalIndices = mTotalIndices;
  newMsgDBView->mCurIndex = mCurIndex;
  newMsgDBView->m_nextThreadId = m_nextThreadId;
  newMsgDBView->m_totalMessagesInView = m_totalMessagesInView;

  newMsgDBView->m_folders.InsertObjectsAt(m_folders, 0);
  newMsgDBView->m_curCustomColumn = m_curCustomColumn;
  for (auto const& hdrs : m_hdrsForEachFolder) {
    newMsgDBView->m_hdrsForEachFolder.AppendElement(hdrs.Clone());
  }
  newMsgDBView->m_uniqueFoldersSelected.InsertObjectsAt(m_uniqueFoldersSelected,
                                                        0);

  int32_t count = m_dbToUseList.Count();
  for (int32_t i = 0; i < count; i++) {
    newMsgDBView->m_dbToUseList.AppendObject(m_dbToUseList[i]);
    // Register the new view with the database so it gets notifications.
    m_dbToUseList[i]->AddListener(newMsgDBView);
  }
  if (m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay) {
    // We need to clone the thread and msg hdr hash tables.
    for (auto iter = m_threadsTable.Iter(); !iter.Done(); iter.Next()) {
      newMsgDBView->m_threadsTable.InsertOrUpdate(
          iter.Key(), static_cast<nsMsgXFViewThread*>(iter.UserData())
                          ->Clone(newMsgDBView));
    }
    for (auto iter = m_hdrsTable.Iter(); !iter.Done(); iter.Next()) {
      newMsgDBView->m_hdrsTable.InsertOrUpdate(iter.Key(), iter.UserData());
    }
  }

  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchDBView::Close() {
  int32_t count = m_dbToUseList.Count();

  for (int32_t i = 0; i < count; i++) m_dbToUseList[i]->RemoveListener(this);

  m_dbToUseList.Clear();

  return nsMsgGroupView::Close();
}

void nsMsgSearchDBView::InternalClose() {
  m_threadsTable.Clear();
  m_hdrsTable.Clear();
  nsMsgGroupView::InternalClose();
  m_folders.Clear();
}

NS_IMETHODIMP
nsMsgSearchDBView::GetCellText(int32_t aRow, nsTreeColumn* aCol,
                               nsAString& aValue) {
  NS_ENSURE_TRUE(IsValidIndex(aRow), NS_MSG_INVALID_DBVIEW_INDEX);
  NS_ENSURE_ARG_POINTER(aCol);

  const nsAString& colID = aCol->GetId();
  // The only thing we contribute is location; dummy rows have no location, so
  // bail in that case. Otherwise, check if we are dealing with 'location'.
  // 'location', need to check for "lo" not just "l" to avoid "label" column.
  if (!(m_flags[aRow] & MSG_VIEW_FLAG_DUMMY) && colID.Length() >= 2 &&
      colID.First() == 'l' && colID.CharAt(1) == 'o')
    return FetchLocation(aRow, aValue);
  else
    return nsMsgGroupView::GetCellText(aRow, aCol, aValue);
}

nsresult nsMsgSearchDBView::HashHdr(nsIMsgDBHdr* msgHdr, nsString& aHashKey) {
  if (m_sortType == nsMsgViewSortType::byLocation) {
    aHashKey.Truncate();
    nsCOMPtr<nsIMsgFolder> folder;
    msgHdr->GetFolder(getter_AddRefs(folder));
    nsAutoString localizedName;
    folder->GetLocalizedName(localizedName);
    aHashKey.Assign(localizedName);
    return NS_OK;
  }

  return nsMsgGroupView::HashHdr(msgHdr, aHashKey);
}

nsresult nsMsgSearchDBView::FetchLocation(int32_t aRow,
                                          nsAString& aLocationString) {
  nsCOMPtr<nsIMsgFolder> folder;
  nsresult rv = GetFolderForViewIndex(aRow, getter_AddRefs(folder));
  NS_ENSURE_SUCCESS(rv, rv);
  nsAutoCString prettyPath;
  folder->GetPrettyPath(prettyPath);
  aLocationString.Assign(NS_ConvertUTF8toUTF16(prettyPath));
  return NS_OK;
}

nsresult nsMsgSearchDBView::OnNewHeader(nsIMsgDBHdr* newHdr,
                                        nsMsgKey aParentKey,
                                        bool /*ensureListed*/) {
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchDBView::OnHdrDeleted(nsIMsgDBHdr* aHdrDeleted, nsMsgKey aParentKey,
                                int32_t aFlags,
                                nsIDBChangeListener* aInstigator) {
  if (m_viewFlags & nsMsgViewFlagsType::kGroupBySort)
    return nsMsgGroupView::OnHdrDeleted(aHdrDeleted, aParentKey, aFlags,
                                        aInstigator);

  if (m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay) {
    nsMsgViewIndex deletedIndex = FindHdr(aHdrDeleted);
    uint32_t savedFlags = 0;
    if (deletedIndex != nsMsgViewIndex_None) {
      // Check if this message is currently selected. If it is, tell the front
      // end to be prepared for a delete.
      nsCOMPtr<nsIMsgDBViewCommandUpdater> commandUpdater(
          do_QueryReferent(mCommandUpdater));
      bool isMsgSelected = false;
      if (mTreeSelection && commandUpdater) {
        mTreeSelection->IsSelected(deletedIndex, &isMsgSelected);
        if (isMsgSelected) commandUpdater->UpdateNextMessageAfterDelete();
      }

      savedFlags = m_flags[deletedIndex];
      RemoveByIndex(deletedIndex);

      if (isMsgSelected) {
        // Now tell the front end that the delete happened.
        commandUpdater->SelectedMessageRemoved();
      }
    }

    nsCOMPtr<nsIMsgThread> thread;
    GetXFThreadFromMsgHdr(aHdrDeleted, getter_AddRefs(thread));
    if (thread) {
      nsMsgXFViewThread* viewThread =
          static_cast<nsMsgXFViewThread*>(thread.get());
      viewThread->RemoveChildHdr(aHdrDeleted, nullptr);
      nsCOMPtr<nsIMsgDBHdr> rootHdr;
      thread->GetRootHdr(getter_AddRefs(rootHdr));
      nsMsgViewIndex threadIndex = nsMsgViewIndex_None;
      if (rootHdr) {
        threadIndex = GetThreadRootIndex(rootHdr);
      }
      if (deletedIndex == nsMsgViewIndex_None && viewThread->MsgCount() == 1) {
        // Remove the last child of a collapsed thread. Need to find the root,
        // and remove the thread flags on it.
        if (IsValidIndex(threadIndex)) {
          AndExtraFlag(threadIndex,
                       ~(MSG_VIEW_FLAG_ISTHREAD | nsMsgMessageFlags::Elided |
                         MSG_VIEW_FLAG_HASCHILDREN));
        }
      } else if (savedFlags & MSG_VIEW_FLAG_HASCHILDREN) {
        if (savedFlags & nsMsgMessageFlags::Elided) {
          if (!rootHdr) {
            NS_WARNING("Invalid thread encountered.");
            return NS_ERROR_UNEXPECTED;
          }
          nsMsgKey msgKey;
          uint32_t msgFlags;
          rootHdr->GetMessageKey(&msgKey);
          rootHdr->GetFlags(&msgFlags);
          // Promote the new thread root.
          if (viewThread->MsgCount() > 1)
            msgFlags |= MSG_VIEW_FLAG_ISTHREAD | nsMsgMessageFlags::Elided |
                        MSG_VIEW_FLAG_HASCHILDREN;
          InsertMsgHdrAt(deletedIndex, rootHdr, msgKey, msgFlags, 0);
          if (!m_deletingRows)
            NoteChange(deletedIndex, 1,
                       nsMsgViewNotificationCode::insertOrDelete);
        } else if (viewThread->MsgCount() > 1) {
          OrExtraFlag(deletedIndex,
                      MSG_VIEW_FLAG_ISTHREAD | MSG_VIEW_FLAG_HASCHILDREN);
        }
      }
      if (IsValidIndex(threadIndex)) {
        NoteChange(threadIndex, 1, nsMsgViewNotificationCode::changed);
      }
    }
  } else {
    return nsMsgDBView::OnHdrDeleted(aHdrDeleted, aParentKey, aFlags,
                                     aInstigator);
  }

  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchDBView::OnHdrFlagsChanged(nsIMsgDBHdr* aHdrChanged,
                                     uint32_t aOldFlags, uint32_t aNewFlags,
                                     nsIDBChangeListener* aInstigator) {
  // Defer to base class if we're grouped or not threaded at all.
  if (m_viewFlags & nsMsgViewFlagsType::kGroupBySort ||
      !(m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay)) {
    return nsMsgGroupView::OnHdrFlagsChanged(aHdrChanged, aOldFlags, aNewFlags,
                                             aInstigator);
  }

  nsCOMPtr<nsIMsgThread> thread;
  bool foundMessageId;
  // Check if the hdr that changed is in a xf thread, and if the read flag
  // changed, update the thread unread count. GetXFThreadFromMsgHdr returns
  // the thread the header does or would belong to, so we need to also
  // check that the header is actually in the thread.
  GetXFThreadFromMsgHdr(aHdrChanged, getter_AddRefs(thread), &foundMessageId);
  if (foundMessageId) {
    nsMsgXFViewThread* viewThread =
        static_cast<nsMsgXFViewThread*>(thread.get());
    if (viewThread->HdrIndex(aHdrChanged) != -1) {
      uint32_t deltaFlags = (aOldFlags ^ aNewFlags);
      if (deltaFlags & nsMsgMessageFlags::Read)
        thread->MarkChildRead(aNewFlags & nsMsgMessageFlags::Read);
    }
  }

  return nsMsgDBView::OnHdrFlagsChanged(aHdrChanged, aOldFlags, aNewFlags,
                                        aInstigator);
}

void nsMsgSearchDBView::InsertMsgHdrAt(nsMsgViewIndex index, nsIMsgDBHdr* hdr,
                                       nsMsgKey msgKey, uint32_t flags,
                                       uint32_t level) {
  if ((int32_t)index < 0) {
    NS_ERROR("invalid insert index");
    index = 0;
    level = 0;
  } else if (index > m_keys.Length()) {
    NS_ERROR("inserting past end of array");
    index = m_keys.Length();
  }

  m_keys.InsertElementAt(index, msgKey);
  m_flags.InsertElementAt(index, flags);
  m_levels.InsertElementAt(index, level);
  nsCOMPtr<nsIMsgFolder> folder;
  hdr->GetFolder(getter_AddRefs(folder));
  m_folders.InsertObjectAt(folder, index);
}

void nsMsgSearchDBView::SetMsgHdrAt(nsIMsgDBHdr* hdr, nsMsgViewIndex index,
                                    nsMsgKey msgKey, uint32_t flags,
                                    uint32_t level) {
  m_keys[index] = msgKey;
  m_flags[index] = flags;
  m_levels[index] = level;
  nsCOMPtr<nsIMsgFolder> folder;
  hdr->GetFolder(getter_AddRefs(folder));
  m_folders.ReplaceObjectAt(folder, index);
}

void nsMsgSearchDBView::InsertEmptyRows(nsMsgViewIndex viewIndex,
                                        int32_t numRows) {
  for (int32_t i = 0; i < numRows; i++) {
    m_folders.InsertObjectAt(nullptr, viewIndex + i);
  }

  return nsMsgDBView::InsertEmptyRows(viewIndex, numRows);
}

void nsMsgSearchDBView::RemoveRows(nsMsgViewIndex viewIndex, int32_t numRows) {
  nsMsgDBView::RemoveRows(viewIndex, numRows);
  for (int32_t i = 0; i < numRows; i++) m_folders.RemoveObjectAt(viewIndex);
}

nsresult nsMsgSearchDBView::GetMsgHdrForViewIndex(nsMsgViewIndex index,
                                                  nsIMsgDBHdr** msgHdr) {
  if (index == nsMsgViewIndex_None || index >= (uint32_t)m_folders.Count()) {
    return NS_MSG_INVALID_DBVIEW_INDEX;
  }

  nsIMsgFolder* folder = m_folders[index];
  if (folder) {
    nsCOMPtr<nsIMsgDatabase> db;
    nsresult rv = folder->GetMsgDatabase(getter_AddRefs(db));
    NS_ENSURE_SUCCESS(rv, rv);
    if (db) {
      return db->GetMsgHdrForKey(m_keys[index], msgHdr);
    }
  }

  return NS_ERROR_FAILURE;
}

NS_IMETHODIMP
nsMsgSearchDBView::GetFolderForViewIndex(nsMsgViewIndex index,
                                         nsIMsgFolder** aFolder) {
  NS_ENSURE_ARG_POINTER(aFolder);

  if (index == nsMsgViewIndex_None || index >= (uint32_t)m_folders.Count())
    return NS_MSG_INVALID_DBVIEW_INDEX;

  NS_IF_ADDREF(*aFolder = m_folders[index]);
  return *aFolder ? NS_OK : NS_ERROR_NULL_POINTER;
}

nsresult nsMsgSearchDBView::GetDBForViewIndex(nsMsgViewIndex index,
                                              nsIMsgDatabase** db) {
  nsCOMPtr<nsIMsgFolder> aFolder;
  nsresult rv = GetFolderForViewIndex(index, getter_AddRefs(aFolder));
  NS_ENSURE_SUCCESS(rv, rv);
  return aFolder->GetMsgDatabase(db);
}

nsresult nsMsgSearchDBView::AddHdrFromFolder(nsIMsgDBHdr* msgHdr,
                                             nsIMsgFolder* folder) {
  if (m_viewFlags & nsMsgViewFlagsType::kGroupBySort)
    return nsMsgGroupView::OnNewHeader(msgHdr, nsMsgKey_None, true);

  nsMsgKey msgKey;
  uint32_t msgFlags;
  msgHdr->GetMessageKey(&msgKey);
  msgHdr->GetFlags(&msgFlags);

  if (m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay) {
    nsCOMPtr<nsIMsgThread> thread;
    nsCOMPtr<nsIMsgDBHdr> threadRoot;
    // If we find an xf thread in the hash table corresponding to the new msg's
    // message id, a previous header must be a reference child of the new
    // message, which means we need to reparent later.
    bool msgIsReferredTo;
    GetXFThreadFromMsgHdr(msgHdr, getter_AddRefs(thread), &msgIsReferredTo);
    bool newThread = !thread;
    nsMsgXFViewThread* viewThread;
    if (!thread) {
      viewThread = new nsMsgXFViewThread(this, m_nextThreadId++);
      if (!viewThread) return NS_ERROR_OUT_OF_MEMORY;

      thread = viewThread;
    } else {
      viewThread = static_cast<nsMsgXFViewThread*>(thread.get());
      thread->GetChildHdrAt(0, getter_AddRefs(threadRoot));
    }

    AddMsgToHashTables(msgHdr, thread);
    nsCOMPtr<nsIMsgDBHdr> parent;
    uint32_t posInThread;
    // We need to move threads in order to keep ourselves sorted
    // correctly.  We want the index of the original thread...we can do this by
    // getting the root header before we add the new header, and finding that.
    if (newThread || !viewThread->MsgCount()) {
      viewThread->AddHdr(msgHdr, false, posInThread, getter_AddRefs(parent));
      nsMsgViewIndex insertIndex = GetIndexForThread(msgHdr);
      NS_ASSERTION(insertIndex == m_levels.Length() ||
                       (IsValidIndex(insertIndex) && !m_levels[insertIndex]),
                   "inserting into middle of thread");
      if (insertIndex == nsMsgViewIndex_None)
        return NS_MSG_INVALID_DBVIEW_INDEX;

      if (!(m_viewFlags & nsMsgViewFlagsType::kExpandAll))
        msgFlags |= nsMsgMessageFlags::Elided;

      InsertMsgHdrAt(insertIndex, msgHdr, msgKey, msgFlags, 0);
      NoteChange(insertIndex, 1, nsMsgViewNotificationCode::insertOrDelete);
    } else {
      // Get the thread root index before we add the header, because adding
      // the header can change the sort position.
      nsMsgViewIndex threadIndex = GetThreadRootIndex(threadRoot);
      viewThread->AddHdr(msgHdr, msgIsReferredTo, posInThread,
                         getter_AddRefs(parent));
      if (!IsValidIndex(threadIndex)) {
        NS_ERROR("couldn't find thread index for newly inserted header");
        // Not really OK, but not failure exactly.
        return NS_OK;
      }

      NS_ASSERTION(!m_levels[threadIndex],
                   "threadRoot incorrect, or level incorrect");

      bool moveThread = false;
      if (m_sortType == nsMsgViewSortType::byDate ||
          m_sortType == nsMsgViewSortType::byReceived) {
        uint32_t newestMsgInThread = 0, msgDate = 0;
        viewThread->GetNewestMsgDate(&newestMsgInThread);
        msgHdr->GetDateInSeconds(&msgDate);
        moveThread = (msgDate == newestMsgInThread);
      }

      OrExtraFlag(threadIndex,
                  MSG_VIEW_FLAG_HASCHILDREN | MSG_VIEW_FLAG_ISTHREAD);
      if (!(m_flags[threadIndex] & nsMsgMessageFlags::Elided)) {
        if (parent) {
          // Since we know posInThread, we just want to insert the new hdr
          // at threadIndex + posInThread, and then rebuild the view until we
          // get to a sibling of the new hdr.
          uint8_t newMsgLevel = viewThread->ChildLevelAt(posInThread);
          InsertMsgHdrAt(threadIndex + posInThread, msgHdr, msgKey, msgFlags,
                         newMsgLevel);

          NoteChange(threadIndex + posInThread, 1,
                     nsMsgViewNotificationCode::insertOrDelete);
          for (nsMsgViewIndex viewIndex = threadIndex + ++posInThread;
               posInThread < viewThread->MsgCount() &&
               viewThread->ChildLevelAt(posInThread) > newMsgLevel;
               viewIndex++) {
            m_levels[viewIndex] = viewThread->ChildLevelAt(posInThread++);
          }

        } else {
          // The new header is the root, so we need to adjust all the children.
          InsertMsgHdrAt(threadIndex, msgHdr, msgKey, msgFlags, 0);
          OrExtraFlag(threadIndex,
                      MSG_VIEW_FLAG_HASCHILDREN | MSG_VIEW_FLAG_ISTHREAD);

          NoteChange(threadIndex, 1, nsMsgViewNotificationCode::insertOrDelete);
          nsMsgViewIndex i;
          for (i = threadIndex + 1;
               i < m_keys.Length() && (i == threadIndex + 1 || m_levels[i]);
               i++)
            m_levels[i] = m_levels[i] + 1;
          // Turn off thread flags on old root.
          AndExtraFlag(threadIndex + 1,
                       ~(MSG_VIEW_FLAG_ISTHREAD | nsMsgMessageFlags::Elided |
                         MSG_VIEW_FLAG_HASCHILDREN));

          NoteChange(threadIndex + 1, i - threadIndex + 1,
                     nsMsgViewNotificationCode::changed);
        }
      } else if (!parent) {
        // New parent came into collapsed thread.
        nsCOMPtr<nsIMsgFolder> msgFolder;
        msgHdr->GetFolder(getter_AddRefs(msgFolder));
        m_keys[threadIndex] = msgKey;
        m_folders.ReplaceObjectAt(msgFolder, threadIndex);
        m_flags[threadIndex] = msgFlags | MSG_VIEW_FLAG_ISTHREAD |
                               nsMsgMessageFlags::Elided |
                               MSG_VIEW_FLAG_HASCHILDREN;
        NoteChange(threadIndex, 1, nsMsgViewNotificationCode::changed);
      }

      if (moveThread) MoveThreadAt(threadIndex);
    }
  } else {
    m_folders.AppendObject(folder);
    // nsMsgKey_None means it's not a valid hdr.
    if (msgKey != nsMsgKey_None) {
      msgHdr->GetFlags(&msgFlags);
      m_keys.AppendElement(msgKey);
      m_levels.AppendElement(0);
      m_flags.AppendElement(msgFlags);
      NoteChange(GetSize() - 1, 1, nsMsgViewNotificationCode::insertOrDelete);
    }
  }

  return NS_OK;
}

// This method removes the thread at threadIndex from the view
// and puts it back in its new position, determined by the sort order.
// And, if the selection is affected, save and restore the selection.
void nsMsgSearchDBView::MoveThreadAt(nsMsgViewIndex threadIndex) {
  bool updatesSuppressed = mSuppressChangeNotification;
  // Turn off tree notifications so that we don't reload the current message.
  if (!updatesSuppressed) SetSuppressChangeNotifications(true);

  nsCOMPtr<nsIMsgDBHdr> threadHdr;
  GetMsgHdrForViewIndex(threadIndex, getter_AddRefs(threadHdr));

  uint32_t saveFlags = m_flags[threadIndex];
  bool threadIsExpanded = !(saveFlags & nsMsgMessageFlags::Elided);
  int32_t childCount = 0;
  nsMsgKey preservedKey;
  AutoTArray<nsMsgKey, 1> preservedSelection;
  int32_t selectionCount;
  int32_t currentIndex;
  bool hasSelection =
      mTreeSelection &&
      ((NS_SUCCEEDED(mTreeSelection->GetCurrentIndex(&currentIndex)) &&
        currentIndex >= 0 && (uint32_t)currentIndex < GetSize()) ||
       (NS_SUCCEEDED(mTreeSelection->GetRangeCount(&selectionCount)) &&
        selectionCount > 0));
  if (hasSelection) SaveAndClearSelection(&preservedKey, preservedSelection);

  if (threadIsExpanded) {
    ExpansionDelta(threadIndex, &childCount);
    childCount = -childCount;
  }

  nsTArray<nsMsgKey> threadKeys;
  nsTArray<uint32_t> threadFlags;
  nsTArray<uint8_t> threadLevels;
  nsCOMArray<nsIMsgFolder> threadFolders;

  if (threadIsExpanded) {
    threadKeys.SetCapacity(childCount);
    threadFlags.SetCapacity(childCount);
    threadLevels.SetCapacity(childCount);
    threadFolders.SetCapacity(childCount);
    for (nsMsgViewIndex index = threadIndex + 1;
         index < (nsMsgViewIndex)GetSize() && m_levels[index]; index++) {
      threadKeys.AppendElement(m_keys[index]);
      threadFlags.AppendElement(m_flags[index]);
      threadLevels.AppendElement(m_levels[index]);
      threadFolders.AppendObject(m_folders[index]);
    }

    uint32_t collapseCount;
    CollapseByIndex(threadIndex, &collapseCount);
  }

  nsMsgDBView::RemoveByIndex(threadIndex);
  m_folders.RemoveObjectAt(threadIndex);
  nsMsgViewIndex newIndex = GetIndexForThread(threadHdr);
  NS_ASSERTION(newIndex == m_levels.Length() ||
                   (IsValidIndex(newIndex) && !m_levels[newIndex]),
               "inserting into middle of thread");
  if (newIndex == nsMsgViewIndex_None) newIndex = 0;

  nsMsgKey msgKey;
  uint32_t msgFlags;
  threadHdr->GetMessageKey(&msgKey);
  threadHdr->GetFlags(&msgFlags);
  InsertMsgHdrAt(newIndex, threadHdr, msgKey, msgFlags, 0);

  if (threadIsExpanded) {
    m_keys.InsertElementsAt(newIndex + 1, threadKeys);
    m_flags.InsertElementsAt(newIndex + 1, threadFlags);
    m_levels.InsertElementsAt(newIndex + 1, threadLevels);
    m_folders.InsertObjectsAt(threadFolders, newIndex + 1);
  }

  m_flags[newIndex] = saveFlags;
  // Unfreeze selection.
  if (hasSelection) RestoreSelection(preservedKey, preservedSelection);

  if (!updatesSuppressed) SetSuppressChangeNotifications(false);

  nsMsgViewIndex lowIndex = threadIndex < newIndex ? threadIndex : newIndex;
  nsMsgViewIndex highIndex = lowIndex == threadIndex ? newIndex : threadIndex;
  NoteChange(lowIndex, highIndex - lowIndex + childCount + 1,
             nsMsgViewNotificationCode::changed);
}

nsresult nsMsgSearchDBView::GetMessageEnumerator(
    nsIMsgEnumerator** enumerator) {
  // We do not have an m_db, so the default behavior (in nsMsgDBView) is not
  // what we want (it will crash).  We just want someone to enumerate the
  // headers that we already have.  Conveniently, nsMsgDBView already knows
  // how to do this with its view enumerator, so we just use that.
  return nsMsgDBView::GetViewEnumerator(enumerator);
}

nsresult nsMsgSearchDBView::InsertHdrFromFolder(nsIMsgDBHdr* msgHdr,
                                                nsIMsgFolder* folder) {
  nsMsgViewIndex insertIndex = nsMsgViewIndex_None;
  // Threaded view always needs to go through AddHdrFromFolder since
  // it handles the xf view thread object creation.
  if (!(m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay))
    insertIndex = GetInsertIndex(msgHdr);

  if (insertIndex == nsMsgViewIndex_None)
    return AddHdrFromFolder(msgHdr, folder);

  nsMsgKey msgKey;
  uint32_t msgFlags;
  msgHdr->GetMessageKey(&msgKey);
  msgHdr->GetFlags(&msgFlags);
  InsertMsgHdrAt(insertIndex, msgHdr, msgKey, msgFlags, 0);

  // The call to NoteChange() has to happen after we add the key as
  // NoteChange() will call RowCountChanged() which will call our GetRowCount().
  NoteChange(insertIndex, 1, nsMsgViewNotificationCode::insertOrDelete);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchDBView::OnSearchHit(nsIMsgDBHdr* aMsgHdr, nsIMsgFolder* folder) {
  NS_ENSURE_ARG(aMsgHdr);
  NS_ENSURE_ARG(folder);

  if (m_folders.IndexOf(folder) < 0)
  // Do this just for new folder.
  {
    nsCOMPtr<nsIMsgDatabase> dbToUse;
    nsCOMPtr<nsIDBFolderInfo> folderInfo;
    folder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                 getter_AddRefs(dbToUse));
    if (dbToUse) {
      dbToUse->AddListener(this);
      m_dbToUseList.AppendObject(dbToUse);
    }
  }

  m_totalMessagesInView++;
  if (m_sortValid)
    return InsertHdrFromFolder(aMsgHdr, folder);
  else
    return AddHdrFromFolder(aMsgHdr, folder);
}

NS_IMETHODIMP
nsMsgSearchDBView::OnSearchDone(nsresult status) {
  // This batch began in OnNewSearch.
  if (mJSTree) mJSTree->EndUpdateBatch();

  // We want to set imap delete model once the search is over because setting
  // next message after deletion will happen before deleting the message and
  // search scope can change with every search.

  // Set to default in case it is non-imap folder.
  mDeleteModel = nsMsgImapDeleteModels::MoveToTrash;
  nsIMsgFolder* curFolder = m_folders.SafeObjectAt(0);
  if (curFolder) GetImapDeleteModel(curFolder);

  return NS_OK;
}

// For now also acts as a way of resetting the search datasource.
NS_IMETHODIMP
nsMsgSearchDBView::OnNewSearch() {
  int32_t oldSize = GetSize();

  int32_t count = m_dbToUseList.Count();
  for (int32_t j = 0; j < count; j++) m_dbToUseList[j]->RemoveListener(this);

  m_dbToUseList.Clear();
  m_folders.Clear();
  m_keys.Clear();
  m_levels.Clear();
  m_flags.Clear();
  m_totalMessagesInView = 0;

  // Needs to happen after we remove the keys, since RowCountChanged() will
  // call our GetRowCount().
  if (mTree) mTree->RowCountChanged(0, -oldSize);
  if (mJSTree) mJSTree->RowCountChanged(0, -oldSize);

  // mSearchResults->Clear();

  // Prevent updates for every message found. This batch ends in OnSearchDone.
  if (mJSTree) mJSTree->BeginUpdateBatch();

  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchDBView::GetViewType(nsMsgViewTypeValue* aViewType) {
  NS_ENSURE_ARG_POINTER(aViewType);
  *aViewType = nsMsgViewType::eShowSearch;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchDBView::SetSearchSession(nsIMsgSearchSession* aSession) {
  m_searchSession = do_GetWeakReference(aSession);
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchDBView::OnAnnouncerGoingAway(
    nsIDBChangeAnnouncer* instigator) {
  nsIMsgDatabase* db = static_cast<nsIMsgDatabase*>(instigator);
  if (db) {
    db->RemoveListener(this);
    m_dbToUseList.RemoveObject(db);
  }

  return NS_OK;
}

nsCOMArray<nsIMsgFolder>* nsMsgSearchDBView::GetFolders() { return &m_folders; }

NS_IMETHODIMP
nsMsgSearchDBView::GetCommandStatus(
    nsMsgViewCommandTypeValue command, bool* selectable_p,
    nsMsgViewCommandCheckStateValue* selected_p) {
  if (command != nsMsgViewCommandType::runJunkControls &&
      command != nsMsgViewCommandType::toggleThreadWatched)
    return nsMsgDBView::GetCommandStatus(command, selectable_p, selected_p);

  *selectable_p = false;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchDBView::DoCommandWithFolder(nsMsgViewCommandTypeValue command,
                                       nsIMsgFolder* destFolder) {
  mCommand = command;
  mDestFolder = destFolder;
  return nsMsgDBView::DoCommandWithFolder(command, destFolder);
}

NS_IMETHODIMP nsMsgSearchDBView::DoCommand(nsMsgViewCommandTypeValue command) {
  mCommand = command;
  if (command == nsMsgViewCommandType::deleteMsg ||
      command == nsMsgViewCommandType::deleteNoTrash ||
      command == nsMsgViewCommandType::selectAll ||
      command == nsMsgViewCommandType::selectThread ||
      command == nsMsgViewCommandType::selectFlagged ||
      command == nsMsgViewCommandType::expandAll ||
      command == nsMsgViewCommandType::collapseAll)
    return nsMsgDBView::DoCommand(command);

  nsresult rv = NS_OK;
  nsMsgViewIndexArray selection;
  if (command == nsMsgViewCommandType::markAllRead) {
    command = nsMsgViewCommandType::markMessagesRead;
    // Create a selection from all indices.
    int32_t viewSize = GetSize();
    selection.SetCapacity(viewSize);
    for (int32_t index = 0; index < viewSize; index++) {
      selection.AppendElement(index);
    }
  } else {
    GetIndicesForSelection(selection);
  }

  // We need to break apart the selection by folders, and then call
  // ApplyCommandToIndices with the command and the indices in the
  // selection that are from that folder.

  mozilla::UniquePtr<nsTArray<nsMsgViewIndex>[]> indexArrays;
  int32_t numArrays;
  rv = PartitionSelectionByFolder(selection, indexArrays, &numArrays);
  NS_ENSURE_SUCCESS(rv, rv);
  for (int32_t folderIndex = 0; folderIndex < numArrays; folderIndex++) {
    rv = ApplyCommandToIndices(command, (indexArrays.get())[folderIndex]);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  return rv;
}

// This method removes the specified line from the view, and adjusts the
// various flags and levels of affected messages.
nsresult nsMsgSearchDBView::RemoveByIndex(nsMsgViewIndex index) {
  if (!IsValidIndex(index)) return NS_MSG_INVALID_DBVIEW_INDEX;

  if (m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay) {
    nsCOMPtr<nsIMsgDBHdr> msgHdr;
    nsCOMPtr<nsIMsgThread> thread;
    nsresult rv = GetMsgHdrForViewIndex(index, getter_AddRefs(msgHdr));
    NS_ENSURE_SUCCESS(rv, rv);

    GetXFThreadFromMsgHdr(msgHdr, getter_AddRefs(thread));
    if (thread) {
      nsMsgXFViewThread* viewThread =
          static_cast<nsMsgXFViewThread*>(thread.get());
      if (viewThread->MsgCount() == 2) {
        // If we removed the next to last message in the thread,
        // we need to adjust the flags on the first message in the thread.
        nsMsgViewIndex threadIndex = m_levels[index] ? index - 1 : index;
        if (threadIndex != nsMsgViewIndex_None) {
          AndExtraFlag(threadIndex,
                       ~(MSG_VIEW_FLAG_ISTHREAD | nsMsgMessageFlags::Elided |
                         MSG_VIEW_FLAG_HASCHILDREN));
          m_levels[threadIndex] = 0;
          NoteChange(threadIndex, 1, nsMsgViewNotificationCode::changed);
        }
      }

      // Bump up the level of all the descendants of the message
      // that was removed, if the thread was expanded.
      uint8_t removedLevel = m_levels[index];
      nsMsgViewIndex i = index + 1;
      if (i < m_levels.Length() && m_levels[i] > removedLevel) {
        // Promote the child of the removed message.
        uint8_t promotedLevel = m_levels[i];
        m_levels[i] = promotedLevel - 1;
        i++;
        // Now promote all the children of the promoted message.
        for (; i < m_levels.Length() && m_levels[i] > promotedLevel; i++)
          m_levels[i] = m_levels[i] - 1;
      }
    }
  }

  m_folders.RemoveObjectAt(index);
  return nsMsgDBView::RemoveByIndex(index);
}

NS_IMETHODIMP nsMsgSearchDBView::ApplyCommandToIndices(
    nsMsgViewCommandTypeValue command,
    nsTArray<nsMsgViewIndex> const& selection) {
  mCommand = command;
  return nsMsgDBView::ApplyCommandToIndices(command, selection);
}

nsresult nsMsgSearchDBView::DeleteMessages(
    nsIMsgWindow* window, nsTArray<nsMsgViewIndex> const& selection,
    bool deleteStorage) {
  nsresult rv = GetFoldersAndHdrsForSelection(selection);
  NS_ENSURE_SUCCESS(rv, rv);

  // Remember the deleted messages in case the user undoes the delete,
  // and we want to restore the hdr to the view, even if it no
  // longer matches the search criteria.
  for (nsMsgViewIndex viewIndex : selection) {
    nsCOMPtr<nsIMsgDBHdr> msgHdr;
    (void)GetMsgHdrForViewIndex(viewIndex, getter_AddRefs(msgHdr));
    if (msgHdr) {
      RememberDeletedMsgHdr(msgHdr);
    }
  }
  return ProcessNextFolder(window);
}

nsresult nsMsgSearchDBView::CopyMessages(
    nsIMsgWindow* window, nsTArray<nsMsgViewIndex> const& selection,
    bool isMove, nsIMsgFolder* destFolder) {
  GetFoldersAndHdrsForSelection(selection);
  return ProcessNextFolder(window);
}

nsresult nsMsgSearchDBView::PartitionSelectionByFolder(
    nsTArray<nsMsgViewIndex> const& selection,
    mozilla::UniquePtr<nsTArray<nsMsgViewIndex>[]>& indexArrays,
    int32_t* numArrays) {
  nsCOMArray<nsIMsgFolder> uniqueFoldersSelected;
  nsTArray<uint32_t> numIndicesSelected;
  mCurIndex = 0;

  // Build unique folder list based on headers selected by the user.
  for (nsMsgViewIndex viewIndex : selection) {
    nsIMsgFolder* curFolder = m_folders[viewIndex];
    int32_t folderIndex = uniqueFoldersSelected.IndexOf(curFolder);
    if (folderIndex < 0) {
      uniqueFoldersSelected.AppendObject(curFolder);
      numIndicesSelected.AppendElement(1);
    } else {
      numIndicesSelected[folderIndex]++;
    }
  }

  int32_t numFolders = uniqueFoldersSelected.Count();
  indexArrays = mozilla::MakeUnique<nsTArray<nsMsgViewIndex>[]>(numFolders);
  *numArrays = numFolders;
  NS_ENSURE_TRUE(indexArrays, NS_ERROR_OUT_OF_MEMORY);
  for (int32_t folderIndex = 0; folderIndex < numFolders; folderIndex++) {
    (indexArrays.get())[folderIndex].SetCapacity(
        numIndicesSelected[folderIndex]);
  }
  for (nsMsgViewIndex viewIndex : selection) {
    nsIMsgFolder* curFolder = m_folders[viewIndex];
    int32_t folderIndex = uniqueFoldersSelected.IndexOf(curFolder);
    (indexArrays.get())[folderIndex].AppendElement(viewIndex);
  }
  return NS_OK;
}

nsresult nsMsgSearchDBView::GetFoldersAndHdrsForSelection(
    nsTArray<nsMsgViewIndex> const& selection) {
  nsresult rv = NS_OK;
  mCurIndex = 0;
  m_uniqueFoldersSelected.Clear();
  m_hdrsForEachFolder.Clear();

  AutoTArray<RefPtr<nsIMsgDBHdr>, 1> messages;
  rv = GetHeadersFromSelection(selection, messages);
  NS_ENSURE_SUCCESS(rv, rv);

  // Build unique folder list based on headers selected by the user.
  for (nsIMsgDBHdr* hdr : messages) {
    nsCOMPtr<nsIMsgFolder> curFolder;
    hdr->GetFolder(getter_AddRefs(curFolder));
    if (m_uniqueFoldersSelected.IndexOf(curFolder) < 0) {
      m_uniqueFoldersSelected.AppendObject(curFolder);
    }
  }

  // Group the headers selected by each folder.
  uint32_t numFolders = m_uniqueFoldersSelected.Count();
  for (uint32_t folderIndex = 0; folderIndex < numFolders; folderIndex++) {
    nsIMsgFolder* curFolder = m_uniqueFoldersSelected[folderIndex];
    nsTArray<RefPtr<nsIMsgDBHdr>> msgHdrsForOneFolder;
    for (nsIMsgDBHdr* hdr : messages) {
      nsCOMPtr<nsIMsgFolder> msgFolder;
      hdr->GetFolder(getter_AddRefs(msgFolder));
      if (NS_SUCCEEDED(rv) && msgFolder && msgFolder == curFolder) {
        msgHdrsForOneFolder.AppendElement(hdr);
      }
    }

    m_hdrsForEachFolder.AppendElement(msgHdrsForOneFolder.Clone());
  }

  return rv;
}

nsresult nsMsgSearchDBView::ApplyCommandToIndicesWithFolder(
    nsMsgViewCommandTypeValue command,
    nsTArray<nsMsgViewIndex> const& selection, nsIMsgFolder* destFolder) {
  mCommand = command;
  mDestFolder = destFolder;
  return nsMsgDBView::ApplyCommandToIndicesWithFolder(command, selection,
                                                      destFolder);
}

// nsIMsgCopyServiceListener methods

NS_IMETHODIMP
nsMsgSearchDBView::OnStartCopy() { return NS_OK; }

NS_IMETHODIMP
nsMsgSearchDBView::OnProgress(uint32_t aProgress, uint32_t aProgressMax) {
  return NS_OK;
}

// Believe it or not, these next two are msgcopyservice listener methods!
NS_IMETHODIMP
nsMsgSearchDBView::SetMessageKey(nsMsgKey aMessageKey) { return NS_OK; }

NS_IMETHODIMP
nsMsgSearchDBView::GetMessageId(nsACString& messageId) { return NS_OK; }

NS_IMETHODIMP
nsMsgSearchDBView::OnStopCopy(nsresult aStatus) {
  if (NS_SUCCEEDED(aStatus)) {
    mCurIndex++;
    if ((int32_t)mCurIndex < m_uniqueFoldersSelected.Count()) {
      nsCOMPtr<nsIMsgWindow> msgWindow(do_QueryReferent(mMsgWindowWeak));
      ProcessNextFolder(msgWindow);
    }
  }

  return NS_OK;
}

// End nsIMsgCopyServiceListener methods.

nsresult nsMsgSearchDBView::ProcessNextFolder(nsIMsgWindow* window) {
  nsresult rv = NS_OK;

  // Folder operations like copy/move are not implemented for .eml files.
  if (m_uniqueFoldersSelected.Count() == 0) {
    return NS_ERROR_NOT_IMPLEMENTED;
  }

  nsIMsgFolder* curFolder = m_uniqueFoldersSelected[mCurIndex];
  NS_ASSERTION(curFolder, "curFolder is null");
  nsTArray<RefPtr<nsIMsgDBHdr>> const& msgs = m_hdrsForEachFolder[mCurIndex];

  // Set to default in case it is non-imap folder.
  mDeleteModel = nsMsgImapDeleteModels::MoveToTrash;
  nsCOMPtr<nsIMsgImapMailFolder> imapFolder = do_QueryInterface(curFolder);
  if (imapFolder) {
    GetImapDeleteModel(curFolder);
  }

  const bool mCommandIsDelete = mCommand == nsMsgViewCommandType::deleteMsg ||
                                mCommand == nsMsgViewCommandType::deleteNoTrash;
  m_deletingRows = !(
      (mCommandIsDelete && mDeleteModel == nsMsgImapDeleteModels::IMAPDelete) ||
      mCommand == nsMsgViewCommandType::copyMessages);
  if (m_deletingRows) {
    m_totalMessagesInView -= msgs.Length();
    SetSuppressChangeNotifications(true);
  }

  if (mCommandIsDelete) {
    const bool deleteStorage =
        mCommand == nsMsgViewCommandType::deleteNoTrash ||
        mDeleteModel == nsMsgImapDeleteModels::DeleteNoTrash;
    if (!deleteStorage) {
      curFolder->MarkMessagesRead(msgs, true);
    }
    rv =
        curFolder->DeleteMessages(msgs, window, deleteStorage,
                                  false /* is move*/, this, true /*allowUndo*/);
    if (NS_SUCCEEDED(rv) && deleteStorage) {
      mCurIndex++;
      if ((int32_t)mCurIndex < m_uniqueFoldersSelected.Count()) {
        rv = ProcessNextFolder(window);
      }
    }
  } else {
    NS_ASSERTION(!(curFolder == mDestFolder),
                 "The source folder and the destination folder are the same");
    if (curFolder != mDestFolder) {
      nsCOMPtr<nsIMsgCopyService> copyService =
          mozilla::components::Copy::Service();
      if (mCommand == nsMsgViewCommandType::moveMessages)
        rv = copyService->CopyMessages(curFolder, msgs, mDestFolder,
                                       true /* isMove */, this, window,
                                       true /*allowUndo*/);
      else if (mCommand == nsMsgViewCommandType::copyMessages)
        rv = copyService->CopyMessages(curFolder, msgs, mDestFolder,
                                       false /* isMove */, this, window,
                                       true /*allowUndo*/);
    }
  }

  // If something went wrong deleting or moving messages, so that
  // OnDeleteCompleted may not be called, reset these here as well.
  if (NS_FAILED(rv)) {
    m_deletingRows = false;
    SetSuppressChangeNotifications(false);
  }

  // Reset to default.
  mDeleteModel = nsMsgImapDeleteModels::MoveToTrash;

  return rv;
}

NS_IMETHODIMP nsMsgSearchDBView::Sort(nsMsgViewSortTypeValue sortType,
                                      nsMsgViewSortOrderValue sortOrder) {
  if (!m_checkedCustomColumns && CustomColumnsInSortAndNotRegistered())
    return NS_OK;

  int32_t rowCountBeforeSort = GetSize();

  if (!rowCountBeforeSort) {
    m_sortType = sortType;
    m_sortOrder = sortOrder;
    SaveSortInfo(sortType, sortOrder);
    return NS_OK;
  }

  if (m_viewFlags & (nsMsgViewFlagsType::kThreadedDisplay |
                     nsMsgViewFlagsType::kGroupBySort)) {
    // ### This forgets which threads were expanded, and is sub-optimal
    // since it rebuilds the thread objects.
    UpdateSortInfo(sortType, sortOrder);
    SaveSortInfo(sortType, sortOrder);
    m_sortType = sortType;
    m_sortOrder = sortOrder;
    return RebuildView(m_viewFlags);
  }

  nsMsgKey preservedKey;
  AutoTArray<nsMsgKey, 1> preservedSelection;
  SaveAndClearSelection(&preservedKey, preservedSelection);

  nsresult rv = nsMsgDBView::Sort(sortType, sortOrder);
  // The sort may have changed the number of rows before we restore the
  // selection, tell the tree do this before we call restore selection.
  // This is safe when there is no selection.
  rv = AdjustRowCount(rowCountBeforeSort, GetSize());

  RestoreSelection(preservedKey, preservedSelection);
  if (mTree) mTree->Invalidate();
  if (mJSTree) mJSTree->Invalidate();

  NS_ENSURE_SUCCESS(rv, rv);
  return rv;
}

NS_IMETHODIMP
nsMsgSearchDBView::OpenWithHdrs(nsIMsgEnumerator* aHeaders,
                                nsMsgViewSortTypeValue aSortType,
                                nsMsgViewSortOrderValue aSortOrder,
                                nsMsgViewFlagsTypeValue aViewFlags) {
  if (aViewFlags & nsMsgViewFlagsType::kGroupBySort)
    return nsMsgGroupView::OpenWithHdrs(aHeaders, aSortType, aSortOrder,
                                        aViewFlags);

  m_sortType = aSortType;
  m_sortOrder = aSortOrder;
  m_viewFlags = aViewFlags;
  SaveSortInfo(m_sortType, m_sortOrder);

  bool hasMore;
  nsresult rv = NS_OK;
  while (NS_SUCCEEDED(rv) &&
         NS_SUCCEEDED(rv = aHeaders->HasMoreElements(&hasMore)) && hasMore) {
    nsCOMPtr<nsIMsgDBHdr> msgHdr;
    nsCOMPtr<nsIMsgFolder> folder;
    rv = aHeaders->GetNext(getter_AddRefs(msgHdr));
    if (NS_SUCCEEDED(rv) && msgHdr) {
      msgHdr->GetFolder(getter_AddRefs(folder));
      AddHdrFromFolder(msgHdr, folder);
    }
  }

  return rv;
}

nsMsgViewIndex nsMsgSearchDBView::FindHdr(nsIMsgDBHdr* msgHdr,
                                          nsMsgViewIndex startIndex,
                                          bool allowDummy) {
  nsCOMPtr<nsIMsgDBHdr> curHdr;
  uint32_t index;
  // It would be nice to take advantage of sorted views when possible.
  for (index = startIndex; index < GetSize(); index++) {
    GetMsgHdrForViewIndex(index, getter_AddRefs(curHdr));
    if (curHdr == msgHdr &&
        (allowDummy || !(m_flags[index] & MSG_VIEW_FLAG_DUMMY) ||
         (m_flags[index] & nsMsgMessageFlags::Elided)))
      break;
  }

  return index < GetSize() ? index : nsMsgViewIndex_None;
}

// This method looks for the XF thread that corresponds to this message hdr,
// first by looking up the message id, then references, and finally, if subject
// threading is turned on, the subject.
nsresult nsMsgSearchDBView::GetXFThreadFromMsgHdr(nsIMsgDBHdr* msgHdr,
                                                  nsIMsgThread** pThread,
                                                  bool* foundByMessageId) {
  NS_ENSURE_ARG_POINTER(msgHdr);
  NS_ENSURE_ARG_POINTER(pThread);

  nsAutoCString messageId;
  msgHdr->GetMessageId(messageId);
  *pThread = nullptr;
  m_threadsTable.Get(messageId, pThread);
  // The caller may want to know if we found the thread by the msgHdr's
  // messageId.
  if (foundByMessageId) *foundByMessageId = *pThread != nullptr;

  if (!*pThread) {
    uint16_t numReferences = 0;
    msgHdr->GetNumReferences(&numReferences);
    for (int32_t i = numReferences - 1; i >= 0 && !*pThread; i--) {
      nsAutoCString reference;
      msgHdr->GetStringReference(i, reference);
      if (reference.IsEmpty()) break;

      m_threadsTable.Get(reference, pThread);
    }
  }

  // If we're threading by subject, and we couldn't find the thread by ref,
  // just treat subject as an other ref.
  if (!*pThread && !gReferenceOnlyThreading) {
    nsCString subject;
    msgHdr->GetSubject(subject);
    // This is the raw rfc822 subject header, so this is OK.
    m_threadsTable.Get(subject, pThread);
  }

  return (*pThread) ? NS_OK : NS_ERROR_FAILURE;
}

bool nsMsgSearchDBView::GetMsgHdrFromHash(nsCString& reference,
                                          nsIMsgDBHdr** hdr) {
  return m_hdrsTable.Get(reference, hdr);
}

bool nsMsgSearchDBView::GetThreadFromHash(nsCString& reference,
                                          nsIMsgThread** thread) {
  return m_threadsTable.Get(reference, thread);
}

nsresult nsMsgSearchDBView::AddRefToHash(nsCString& reference,
                                         nsIMsgThread* thread) {
  // Check if this reference is already is associated with a thread;
  // If so, don't overwrite that association.
  nsCOMPtr<nsIMsgThread> oldThread;
  m_threadsTable.Get(reference, getter_AddRefs(oldThread));
  if (oldThread) return NS_OK;

  m_threadsTable.InsertOrUpdate(reference, thread);
  return NS_OK;
}

nsresult nsMsgSearchDBView::AddMsgToHashTables(nsIMsgDBHdr* msgHdr,
                                               nsIMsgThread* thread) {
  NS_ENSURE_ARG_POINTER(msgHdr);

  uint16_t numReferences = 0;
  nsresult rv;

  msgHdr->GetNumReferences(&numReferences);
  for (int32_t i = 0; i < numReferences; i++) {
    nsAutoCString reference;
    msgHdr->GetStringReference(i, reference);
    if (reference.IsEmpty()) break;

    rv = AddRefToHash(reference, thread);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  nsCString messageId;
  msgHdr->GetMessageId(messageId);
  m_hdrsTable.InsertOrUpdate(messageId, msgHdr);
  if (!gReferenceOnlyThreading) {
    nsCString subject;
    msgHdr->GetSubject(subject);
    // if we're threading by subject, just treat subject as an other ref.
    AddRefToHash(subject, thread);
  }

  return AddRefToHash(messageId, thread);
}

nsresult nsMsgSearchDBView::RemoveRefFromHash(nsCString& reference) {
  m_threadsTable.Remove(reference);
  return NS_OK;
}

nsresult nsMsgSearchDBView::RemoveMsgFromHashTables(nsIMsgDBHdr* msgHdr) {
  NS_ENSURE_ARG_POINTER(msgHdr);

  uint16_t numReferences = 0;
  nsresult rv = NS_OK;

  msgHdr->GetNumReferences(&numReferences);

  for (int32_t i = 0; i < numReferences; i++) {
    nsAutoCString reference;
    msgHdr->GetStringReference(i, reference);
    if (reference.IsEmpty()) break;

    rv = RemoveRefFromHash(reference);
    if (NS_FAILED(rv)) break;
  }

  nsCString messageId;
  msgHdr->GetMessageId(messageId);
  m_hdrsTable.Remove(messageId);
  RemoveRefFromHash(messageId);
  if (!gReferenceOnlyThreading) {
    nsCString subject;
    msgHdr->GetSubject(subject);
    // If we're threading by subject, just treat subject as an other ref.
    RemoveRefFromHash(subject);
  }

  return rv;
}

nsMsgGroupThread* nsMsgSearchDBView::CreateGroupThread(
    nsIMsgDatabase* /* db */) {
  nsMsgViewSortOrderValue threadSortOrder = nsMsgViewSortOrder::descending;
  if (m_sortType == nsMsgViewSortType::byDate ||
      m_sortType == nsMsgViewSortType::byReceived) {
    threadSortOrder = m_sortOrder;
  } else {
    if (Preferences::GetInt("mailnews.default_sort_order") ==
        nsMsgViewSortOrder::ascending) {
      threadSortOrder = nsMsgViewSortOrder::ascending;
    }
  }
  return new nsMsgXFGroupThread(threadSortOrder);
}

NS_IMETHODIMP
nsMsgSearchDBView::GetThreadContainingMsgHdr(nsIMsgDBHdr* msgHdr,
                                             nsIMsgThread** pThread) {
  if (m_viewFlags & nsMsgViewFlagsType::kGroupBySort)
    return nsMsgGroupView::GetThreadContainingMsgHdr(msgHdr, pThread);
  else if (m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay)
    return GetXFThreadFromMsgHdr(msgHdr, pThread);

  // If not threaded, use the real thread.
  nsCOMPtr<nsIMsgDatabase> msgDB;
  nsresult rv = GetDBForHeader(msgHdr, getter_AddRefs(msgDB));
  NS_ENSURE_SUCCESS(rv, rv);
  return msgDB->GetThreadContainingMsgHdr(msgHdr, pThread);
}

nsresult nsMsgSearchDBView::ListIdsInThread(
    nsIMsgThread* threadHdr, nsMsgViewIndex startOfThreadViewIndex,
    uint32_t* pNumListed) {
  NS_ENSURE_ARG_POINTER(threadHdr);
  NS_ENSURE_ARG_POINTER(pNumListed);

  // These children ids should be in thread order.
  uint32_t i;
  nsMsgViewIndex viewIndex = startOfThreadViewIndex + 1;
  *pNumListed = 0;

  uint32_t numChildren;
  threadHdr->GetNumChildren(&numChildren);
  NS_ASSERTION(numChildren, "Empty thread in view/db");
  if (!numChildren) return NS_OK;

  // Account for the existing thread root.
  numChildren--;
  InsertEmptyRows(viewIndex, numChildren);

  bool threadedView = m_viewFlags & nsMsgViewFlagsType::kThreadedDisplay &&
                      !(m_viewFlags & nsMsgViewFlagsType::kGroupBySort);
  nsMsgXFViewThread* viewThread;
  if (threadedView) viewThread = static_cast<nsMsgXFViewThread*>(threadHdr);

  for (i = 1; i <= numChildren; i++) {
    nsCOMPtr<nsIMsgDBHdr> msgHdr;
    threadHdr->GetChildHdrAt(i, getter_AddRefs(msgHdr));

    if (msgHdr) {
      nsMsgKey msgKey;
      uint32_t msgFlags;
      msgHdr->GetMessageKey(&msgKey);
      msgHdr->GetFlags(&msgFlags);
      uint8_t level = (threadedView) ? viewThread->ChildLevelAt(i) : 1;
      SetMsgHdrAt(msgHdr, viewIndex, msgKey, msgFlags & ~MSG_VIEW_FLAGS, level);
      (*pNumListed)++;
      viewIndex++;
    }
  }

  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchDBView::GetNumMsgsInView(int32_t* aNumMsgs) {
  NS_ENSURE_ARG_POINTER(aNumMsgs);
  *aNumMsgs = m_totalMessagesInView;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchDBView::SetViewFlags(nsMsgViewFlagsTypeValue aViewFlags) {
  nsresult rv = NS_OK;
  // If the grouping/threading has changed, rebuild the view.
  constexpr nsMsgViewFlagsTypeValue groupedOrThreaded =
      (nsMsgViewFlagsType::kGroupBySort | nsMsgViewFlagsType::kThreadedDisplay);
  if ((m_viewFlags & groupedOrThreaded) != (aViewFlags & groupedOrThreaded)) {
    rv = RebuildView(aViewFlags);
    // While threaded and grouped views are sorted as they are rebuilt,
    // switching to unthreaded simply preserves the sequence of the individual
    // headers. Therefore, sort in this case (even when coming from grouped,
    // to get the secondary sort right as well).
    if (!(aViewFlags & groupedOrThreaded)) {
      m_sortValid = false;
      Sort(m_sortType, m_sortOrder);
    }
  }
  NS_ENSURE_SUCCESS(rv, rv);
  return nsMsgDBView::SetViewFlags(aViewFlags);
}

NS_IMETHODIMP
nsMsgSearchDBView::OnDeleteCompleted(bool aSucceeded) {
  if (m_deletingRows) {
    SetSuppressChangeNotifications(false);
    m_deletingRows = false;
    if (mTree) {
      mTree->BeginUpdateBatch();
      // This seems to be the easiest way to update the row count of the
      // XUL tree and invalidate it.
      mTree->EndUpdateBatch();
    }
    if (mJSTree) mJSTree->Invalidate();
  }
  return NS_OK;
}
