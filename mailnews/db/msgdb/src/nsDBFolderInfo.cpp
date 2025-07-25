/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "msgCore.h"
#include "nsDBFolderInfo.h"
#include "nsMsgDatabase.h"
#include "nsMsgFolderFlags.h"
#include "nsIMsgDBView.h"
#include "nsImapCore.h"
#include "nsIWritablePropertyBag2.h"
#include "mozilla/SimpleEnumerator.h"
#include "nsIProperty.h"
#include "nsIVariant.h"

static const char* kDBFolderInfoScope = "ns:msg:db:row:scope:dbfolderinfo:all";
static const char* kDBFolderInfoTableKind = "ns:msg:db:table:kind:dbfolderinfo";

struct mdbOid gDBFolderInfoOID;

static const char* kNumMessagesColumnName = "numMsgs";
// have to leave this as numNewMsgs even though it's numUnread Msgs
static const char* kNumUnreadMessagesColumnName = "numNewMsgs";
static const char* kFlagsColumnName = "flags";
static const char* kFolderSizeColumnName = "folderSize";
static const char* kExpungedBytesColumnName = "expungedBytes";
static const char* kFolderDateColumnName = "folderDate";
static const char* kHighWaterMessageKeyColumnName = "highWaterKey";

static const char* kImapUidValidityColumnName = "UIDValidity";
static const char* kTotalPendingMessagesColumnName = "totPendingMsgs";
static const char* kUnreadPendingMessagesColumnName = "unreadPendingMsgs";
static const char* kMailboxNameColumnName = "mailboxName";
static const char* kKnownArtsSetColumnName = "knownArts";
static const char* kVersionColumnName = "version";
static const char* kLocaleColumnName = "locale";

NS_IMPL_ADDREF(nsDBFolderInfo)
NS_IMPL_RELEASE(nsDBFolderInfo)

NS_IMETHODIMP
nsDBFolderInfo::QueryInterface(REFNSIID iid, void** result) {
  if (!result) return NS_ERROR_NULL_POINTER;

  *result = nullptr;
  if (iid.Equals(NS_GET_IID(nsIDBFolderInfo)) ||
      iid.Equals(NS_GET_IID(nsISupports))) {
    *result = static_cast<nsIDBFolderInfo*>(this);
    AddRef();
    return NS_OK;
  }
  return NS_NOINTERFACE;
}

nsDBFolderInfo::nsDBFolderInfo(nsMsgDatabase* mdb)
    : m_flags(0),
      m_tableKindToken(0) {
  m_mdbTable = NULL;
  m_mdbRow = NULL;
  m_version = 1;                 // for upgrading...
  m_IMAPHierarchySeparator = 0;  // imap path separator
  // mail only (for now)
  m_folderSize = 0;
  m_folderDate = 0;
  m_expungedBytes = 0;  // sum of size of deleted messages in folder
  m_highWaterMessageKey = 0;

  m_numUnreadMessages = 0;
  m_numMessages = 0;
  // IMAP only
  m_ImapUidValidity = kUidUnknown;
  m_totalPendingMessages = 0;
  m_unreadPendingMessages = 0;

  m_mdbTokensInitialized = false;

  m_mdb = mdb;
  if (mdb) {
    nsresult err;

    err = m_mdb->GetStore()->StringToToken(mdb->GetEnv(), kDBFolderInfoScope,
                                           &m_rowScopeToken);
    if (NS_SUCCEEDED(err)) {
      err = m_mdb->GetStore()->StringToToken(
          mdb->GetEnv(), kDBFolderInfoTableKind, &m_tableKindToken);
      if (NS_SUCCEEDED(err)) {
        gDBFolderInfoOID.mOid_Scope = m_rowScopeToken;
        gDBFolderInfoOID.mOid_Id = 1;
      }
    }
    InitMDBInfo();
  }
}

nsDBFolderInfo::~nsDBFolderInfo() {
  // nsMsgDatabase strictly owns nsDBFolderInfo, so don't ref-count db.
  ReleaseExternalReferences();
}

// Release any objects we're holding onto. This needs to be safe
// to call multiple times.
void nsDBFolderInfo::ReleaseExternalReferences() {
  if (m_mdb) {
    if (m_mdbTable) {
      NS_RELEASE(m_mdbTable);
      m_mdbTable = nullptr;
    }
    if (m_mdbRow) {
      NS_RELEASE(m_mdbRow);
      m_mdbRow = nullptr;
    }
    m_mdb = nullptr;
  }
}

// this routine sets up a new db to know about the dbFolderInfo stuff...
nsresult nsDBFolderInfo::AddToNewMDB() {
  nsresult ret = NS_OK;
  if (m_mdb && m_mdb->GetStore()) {
    nsIMdbStore* store = m_mdb->GetStore();
    // create the unique table for the dbFolderInfo.
    nsresult err =
        store->NewTable(m_mdb->GetEnv(), m_rowScopeToken, m_tableKindToken,
                        true, nullptr, &m_mdbTable);

    // create the singleton row for the dbFolderInfo.
    err = store->NewRowWithOid(m_mdb->GetEnv(), &gDBFolderInfoOID, &m_mdbRow);

    // add the row to the singleton table.
    if (m_mdbRow && NS_SUCCEEDED(err))
      err = m_mdbTable->AddRow(m_mdb->GetEnv(), m_mdbRow);

    ret = err;  // what are we going to do about nsresult's?
  }
  return ret;
}

nsresult nsDBFolderInfo::InitFromExistingDB() {
  nsresult ret = NS_OK;
  if (m_mdb && m_mdb->GetStore()) {
    nsIMdbStore* store = m_mdb->GetStore();
    if (store) {
      mdb_pos rowPos;
      mdb_count outTableCount;  // current number of such tables
      mdb_bool mustBeUnique;    // whether port can hold only one of these
      mdb_bool hasOid;
      ret = store->GetTableKind(m_mdb->GetEnv(), m_rowScopeToken,
                                m_tableKindToken, &outTableCount, &mustBeUnique,
                                &m_mdbTable);
      // NS_ASSERTION(mustBeUnique && outTableCount == 1, "only one global db
      // info allowed");

      if (m_mdbTable) {
        // find singleton row for global info.
        ret = m_mdbTable->HasOid(m_mdb->GetEnv(), &gDBFolderInfoOID, &hasOid);
        if (NS_SUCCEEDED(ret)) {
          nsIMdbTableRowCursor* rowCursor;
          rowPos = -1;
          ret = m_mdbTable->GetTableRowCursor(m_mdb->GetEnv(), rowPos,
                                              &rowCursor);
          if (NS_SUCCEEDED(ret)) {
            ret = rowCursor->NextRow(m_mdb->GetEnv(), &m_mdbRow, &rowPos);
            NS_RELEASE(rowCursor);
            if (!m_mdbRow) ret = NS_ERROR_FAILURE;
            if (NS_SUCCEEDED(ret)) LoadMemberVariables();
          }
        }
      } else
        ret = NS_ERROR_FAILURE;
    }
  }
  return ret;
}

nsresult nsDBFolderInfo::InitMDBInfo() {
  nsresult ret = NS_OK;
  if (!m_mdbTokensInitialized && m_mdb && m_mdb->GetStore()) {
    nsIMdbStore* store = m_mdb->GetStore();
    nsIMdbEnv* env = m_mdb->GetEnv();

    store->StringToToken(env, kNumMessagesColumnName,
                         &m_numMessagesColumnToken);
    store->StringToToken(env, kNumUnreadMessagesColumnName,
                         &m_numUnreadMessagesColumnToken);
    store->StringToToken(env, kFlagsColumnName, &m_flagsColumnToken);
    store->StringToToken(env, kFolderSizeColumnName, &m_folderSizeColumnToken);
    store->StringToToken(env, kExpungedBytesColumnName,
                         &m_expungedBytesColumnToken);
    store->StringToToken(env, kFolderDateColumnName, &m_folderDateColumnToken);

    store->StringToToken(env, kHighWaterMessageKeyColumnName,
                         &m_highWaterMessageKeyColumnToken);
    store->StringToToken(env, kMailboxNameColumnName,
                         &m_mailboxNameColumnToken);

    store->StringToToken(env, kImapUidValidityColumnName,
                         &m_imapUidValidityColumnToken);
    store->StringToToken(env, kTotalPendingMessagesColumnName,
                         &m_totalPendingMessagesColumnToken);
    store->StringToToken(env, kUnreadPendingMessagesColumnName,
                         &m_unreadPendingMessagesColumnToken);
    store->StringToToken(env, kVersionColumnName, &m_versionColumnToken);
    m_mdbTokensInitialized = true;
  }

  return ret;
}

nsresult nsDBFolderInfo::LoadMemberVariables() {
  // it's really not an error for these properties to not exist...
  GetInt32PropertyWithToken(m_numMessagesColumnToken, m_numMessages);
  GetInt32PropertyWithToken(m_numUnreadMessagesColumnToken,
                            m_numUnreadMessages);
  GetInt32PropertyWithToken(m_flagsColumnToken, m_flags);
  GetInt64PropertyWithToken(m_folderSizeColumnToken, m_folderSize);
  GetUint32PropertyWithToken(m_folderDateColumnToken, m_folderDate);
  GetInt32PropertyWithToken(m_imapUidValidityColumnToken, m_ImapUidValidity,
                            kUidUnknown);
  GetInt64PropertyWithToken(m_expungedBytesColumnToken, m_expungedBytes);
  GetUint32PropertyWithToken(m_highWaterMessageKeyColumnToken,
                             m_highWaterMessageKey);
  int32_t version;

  GetInt32PropertyWithToken(m_versionColumnToken, version);
  m_version = (uint16_t)version;

  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetVersion(uint32_t version) {
  m_version = version;
  return SetUint32PropertyWithToken(m_versionColumnToken, (uint32_t)m_version);
}

NS_IMETHODIMP nsDBFolderInfo::GetVersion(uint32_t* version) {
  *version = m_version;
  return NS_OK;
}

nsresult nsDBFolderInfo::AdjustHighWater(nsMsgKey highWater, bool force) {
  if (force || m_highWaterMessageKey < highWater) {
    m_highWaterMessageKey = highWater;
    SetUint32PropertyWithToken(m_highWaterMessageKeyColumnToken, highWater);
  }

  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetHighWater(nsMsgKey highWater) {
  return AdjustHighWater(highWater, true);
}

NS_IMETHODIMP nsDBFolderInfo::OnKeyAdded(nsMsgKey aNewKey) {
  return AdjustHighWater(aNewKey, false);
}

NS_IMETHODIMP
nsDBFolderInfo::GetFolderSize(int64_t* size) {
  NS_ENSURE_ARG_POINTER(size);
  *size = m_folderSize;
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetFolderSize(int64_t size) {
  m_folderSize = size;
  return SetInt64Property(kFolderSizeColumnName, m_folderSize);
}

NS_IMETHODIMP
nsDBFolderInfo::GetFolderDate(uint32_t* folderDate) {
  NS_ENSURE_ARG_POINTER(folderDate);
  *folderDate = m_folderDate;
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetFolderDate(uint32_t folderDate) {
  m_folderDate = folderDate;
  return SetUint32PropertyWithToken(m_folderDateColumnToken, folderDate);
}

NS_IMETHODIMP nsDBFolderInfo::GetUserSortOrder(uint32_t* userSortOrder) {
  NS_ENSURE_ARG_POINTER(userSortOrder);
  return GetUint32Property("userSortOrder", nsIMsgFolder::NO_SORT_VALUE,
                           userSortOrder);
}

NS_IMETHODIMP nsDBFolderInfo::SetUserSortOrder(uint32_t userSortOrder) {
  return SetUint32Property("userSortOrder", userSortOrder);
}

NS_IMETHODIMP nsDBFolderInfo::GetHighWater(nsMsgKey* result) {
  // Sanity check highwater - if it gets too big, other code
  // can fail. Look through last 100 messages to recalculate
  // the highwater mark.
  *result = m_highWaterMessageKey;
  if (m_highWaterMessageKey > 0xFFFFFF00 && m_mdb) {
    nsCOMPtr<nsIMsgEnumerator> hdrs;
    nsresult rv = m_mdb->ReverseEnumerateMessages(getter_AddRefs(hdrs));
    if (NS_FAILED(rv)) return rv;
    bool hasMore = false;
    nsCOMPtr<nsIMsgDBHdr> pHeader;
    nsMsgKey recalculatedHighWater = 1;
    int32_t i = 0;
    while (i++ < 100 && NS_SUCCEEDED(rv = hdrs->HasMoreElements(&hasMore)) &&
           hasMore) {
      (void)hdrs->GetNext(getter_AddRefs(pHeader));
      if (pHeader) {
        nsMsgKey msgKey;
        pHeader->GetMessageKey(&msgKey);
        if (msgKey > recalculatedHighWater) recalculatedHighWater = msgKey;
      }
    }
    NS_ASSERTION(m_highWaterMessageKey >= recalculatedHighWater,
                 "highwater incorrect");
    m_highWaterMessageKey = recalculatedHighWater;
  }
  *result = m_highWaterMessageKey;
  return NS_OK;
}

// The size of the argument depends on the maximum size of a single message
NS_IMETHODIMP nsDBFolderInfo::ChangeExpungedBytes(int32_t delta) {
  return SetExpungedBytes(m_expungedBytes + delta);
}

NS_IMETHODIMP nsDBFolderInfo::SetMailboxName(const nsACString& newBoxName) {
  return SetPropertyWithToken(m_mailboxNameColumnToken,
                              NS_ConvertUTF8toUTF16(newBoxName));
}

NS_IMETHODIMP nsDBFolderInfo::GetMailboxName(nsACString& boxName) {
  nsAutoString name;
  nsresult rv = GetPropertyWithToken(m_mailboxNameColumnToken, name);
  NS_ENSURE_SUCCESS(rv, rv);
  boxName.Assign(NS_ConvertUTF16toUTF8(name));
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::ChangeNumUnreadMessages(int32_t delta) {
  m_numUnreadMessages += delta;
  // m_numUnreadMessages can never be set to negative.
  if (m_numUnreadMessages < 0) {
    m_numUnreadMessages = 0;
  }
  return SetUint32PropertyWithToken(m_numUnreadMessagesColumnToken,
                                    m_numUnreadMessages);
}

NS_IMETHODIMP nsDBFolderInfo::ChangeNumMessages(int32_t delta) {
  m_numMessages += delta;
  // m_numMessages can never be set to negative.
  if (m_numMessages < 0) {
    m_numMessages = 0;
  }
  return SetUint32PropertyWithToken(m_numMessagesColumnToken, m_numMessages);
}

NS_IMETHODIMP nsDBFolderInfo::GetNumUnreadMessages(int32_t* result) {
  *result = m_numUnreadMessages;
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetNumUnreadMessages(int32_t numUnreadMessages) {
  m_numUnreadMessages = numUnreadMessages;
  return SetUint32PropertyWithToken(m_numUnreadMessagesColumnToken,
                                    m_numUnreadMessages);
}

NS_IMETHODIMP nsDBFolderInfo::GetNumMessages(int32_t* result) {
  *result = m_numMessages;
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetNumMessages(int32_t numMessages) {
  m_numMessages = numMessages;
  return SetUint32PropertyWithToken(m_numMessagesColumnToken, m_numMessages);
}

NS_IMETHODIMP nsDBFolderInfo::GetExpungedBytes(int64_t* result) {
  *result = m_expungedBytes;
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetExpungedBytes(int64_t expungedBytes) {
  m_expungedBytes = expungedBytes;
  return SetInt64PropertyWithToken(m_expungedBytesColumnToken, m_expungedBytes);
}

NS_IMETHODIMP nsDBFolderInfo::GetFlags(int32_t* result) {
  *result = m_flags;
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetFlags(int32_t flags) {
  nsresult ret = NS_OK;

  if (m_flags != flags) {
    NS_ASSERTION((m_flags & nsMsgFolderFlags::Inbox) == 0 ||
                     (flags & nsMsgFolderFlags::Inbox) != 0,
                 "lost inbox flag");
    m_flags = flags;
    ret = SetInt32PropertyWithToken(m_flagsColumnToken, m_flags);
  }
  return ret;
}

NS_IMETHODIMP nsDBFolderInfo::OrFlags(int32_t flags, int32_t* result) {
  m_flags |= flags;
  *result = m_flags;
  return SetInt32PropertyWithToken(m_flagsColumnToken, m_flags);
}

NS_IMETHODIMP nsDBFolderInfo::AndFlags(int32_t flags, int32_t* result) {
  m_flags &= flags;
  *result = m_flags;
  return SetInt32PropertyWithToken(m_flagsColumnToken, m_flags);
}

NS_IMETHODIMP nsDBFolderInfo::GetImapUidValidity(int32_t* result) {
  *result = m_ImapUidValidity;
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetImapUidValidity(int32_t uidValidity) {
  m_ImapUidValidity = uidValidity;
  return SetUint32PropertyWithToken(m_imapUidValidityColumnToken,
                                    m_ImapUidValidity);
}

bool nsDBFolderInfo::TestFlag(int32_t flags) { return (m_flags & flags) != 0; }

NS_IMETHODIMP
nsDBFolderInfo::GetLocale(nsAString& result) {
  GetProperty(kLocaleColumnName, result);
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetLocale(const nsAString& locale) {
  return SetProperty(kLocaleColumnName, locale);
}

NS_IMETHODIMP
nsDBFolderInfo::GetImapTotalPendingMessages(int32_t* result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = m_totalPendingMessages;
  return NS_OK;
}

void nsDBFolderInfo::ChangeImapTotalPendingMessages(int32_t delta) {
  m_totalPendingMessages += delta;
  SetInt32PropertyWithToken(m_totalPendingMessagesColumnToken,
                            m_totalPendingMessages);
}

NS_IMETHODIMP
nsDBFolderInfo::GetImapUnreadPendingMessages(int32_t* result) {
  NS_ENSURE_ARG_POINTER(result);
  *result = m_unreadPendingMessages;
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::SetImapUnreadPendingMessages(
    int32_t numUnreadPendingMessages) {
  m_unreadPendingMessages = numUnreadPendingMessages;
  return SetUint32PropertyWithToken(m_unreadPendingMessagesColumnToken,
                                    m_unreadPendingMessages);
}

NS_IMETHODIMP nsDBFolderInfo::SetImapTotalPendingMessages(
    int32_t numTotalPendingMessages) {
  m_totalPendingMessages = numTotalPendingMessages;
  return SetUint32PropertyWithToken(m_totalPendingMessagesColumnToken,
                                    m_totalPendingMessages);
}

void nsDBFolderInfo::ChangeImapUnreadPendingMessages(int32_t delta) {
  m_unreadPendingMessages += delta;
  SetInt32PropertyWithToken(m_unreadPendingMessagesColumnToken,
                            m_unreadPendingMessages);
}

/* attribute nsMsgViewTypeValue viewType; */
NS_IMETHODIMP nsDBFolderInfo::GetViewType(nsMsgViewTypeValue* aViewType) {
  uint32_t viewTypeValue;
  nsresult rv = GetUint32Property("viewType", nsMsgViewType::eShowAllThreads,
                                  &viewTypeValue);
  *aViewType = viewTypeValue;
  return rv;
}
NS_IMETHODIMP nsDBFolderInfo::SetViewType(nsMsgViewTypeValue aViewType) {
  return SetUint32Property("viewType", aViewType);
}

/* attribute nsMsgViewFlagsTypeValue viewFlags; */
NS_IMETHODIMP nsDBFolderInfo::GetViewFlags(
    nsMsgViewFlagsTypeValue* aViewFlags) {
  nsMsgViewFlagsTypeValue defaultViewFlags;
  nsresult rv = m_mdb->GetDefaultViewFlags(&defaultViewFlags);
  NS_ENSURE_SUCCESS(rv, rv);

  uint32_t viewFlagsValue;
  rv = GetUint32Property("viewFlags", defaultViewFlags, &viewFlagsValue);
  *aViewFlags = viewFlagsValue;
  return rv;
}
NS_IMETHODIMP nsDBFolderInfo::SetViewFlags(nsMsgViewFlagsTypeValue aViewFlags) {
  return SetUint32Property("viewFlags", aViewFlags);
}

/* attribute nsMsgViewSortTypeValue sortType; */
NS_IMETHODIMP nsDBFolderInfo::GetSortType(nsMsgViewSortTypeValue* aSortType) {
  nsMsgViewSortTypeValue defaultSortType;
  nsresult rv = m_mdb->GetDefaultSortType(&defaultSortType);
  NS_ENSURE_SUCCESS(rv, rv);

  uint32_t sortTypeValue;
  rv = GetUint32Property("sortType", defaultSortType, &sortTypeValue);
  *aSortType = sortTypeValue;
  return rv;
}
NS_IMETHODIMP nsDBFolderInfo::SetSortType(nsMsgViewSortTypeValue aSortType) {
  return SetUint32Property("sortType", aSortType);
}

/* attribute nsMsgViewSortOrderValue sortOrder; */
NS_IMETHODIMP nsDBFolderInfo::GetSortOrder(
    nsMsgViewSortOrderValue* aSortOrder) {
  nsMsgViewSortOrderValue defaultSortOrder;
  nsresult rv = m_mdb->GetDefaultSortOrder(&defaultSortOrder);
  NS_ENSURE_SUCCESS(rv, rv);

  uint32_t sortOrderValue;
  rv = GetUint32Property("sortOrder", defaultSortOrder, &sortOrderValue);
  *aSortOrder = sortOrderValue;
  return rv;
}

NS_IMETHODIMP nsDBFolderInfo::SetSortOrder(nsMsgViewSortOrderValue aSortOrder) {
  return SetUint32Property("sortOrder", aSortOrder);
}

NS_IMETHODIMP nsDBFolderInfo::SetKnownArtsSet(const char* newsArtSet) {
  return m_mdb->SetProperty(m_mdbRow, kKnownArtsSetColumnName, newsArtSet);
}

NS_IMETHODIMP nsDBFolderInfo::GetKnownArtsSet(char** newsArtSet) {
  return m_mdb->GetProperty(m_mdbRow, kKnownArtsSetColumnName, newsArtSet);
}

// get arbitrary property, aka row cell value.
NS_IMETHODIMP nsDBFolderInfo::GetProperty(const char* propertyName,
                                          nsAString& resultProperty) {
  return m_mdb->GetPropertyAsNSString(m_mdbRow, propertyName, resultProperty);
}

NS_IMETHODIMP nsDBFolderInfo::SetCharProperty(
    const char* aPropertyName, const nsACString& aPropertyValue) {
  return m_mdb->SetProperty(m_mdbRow, aPropertyName,
                            PromiseFlatCString(aPropertyValue).get());
}

NS_IMETHODIMP nsDBFolderInfo::GetCharProperty(const char* propertyName,
                                              nsACString& resultProperty) {
  nsCString result;
  nsresult rv =
      m_mdb->GetProperty(m_mdbRow, propertyName, getter_Copies(result));
  if (NS_SUCCEEDED(rv)) resultProperty.Assign(result);
  return rv;
}

NS_IMETHODIMP nsDBFolderInfo::SetUint32Property(const char* propertyName,
                                                uint32_t propertyValue) {
  return m_mdb->SetUint32Property(m_mdbRow, propertyName, propertyValue);
}

NS_IMETHODIMP nsDBFolderInfo::SetInt64Property(const char* propertyName,
                                               int64_t propertyValue) {
  return m_mdb->SetUint64Property(m_mdbRow, propertyName,
                                  (uint64_t)propertyValue);
}

NS_IMETHODIMP nsDBFolderInfo::SetProperty(const char* propertyName,
                                          const nsAString& propertyStr) {
  return m_mdb->SetPropertyFromNSString(m_mdbRow, propertyName, propertyStr);
}

nsresult nsDBFolderInfo::SetPropertyWithToken(mdb_token aProperty,
                                              const nsAString& propertyStr) {
  return m_mdb->SetNSStringPropertyWithToken(m_mdbRow, aProperty, propertyStr);
}

nsresult nsDBFolderInfo::SetUint32PropertyWithToken(mdb_token aProperty,
                                                    uint32_t propertyValue) {
  return m_mdb->UInt32ToRowCellColumn(m_mdbRow, aProperty, propertyValue);
}

nsresult nsDBFolderInfo::SetInt64PropertyWithToken(mdb_token aProperty,
                                                   int64_t propertyValue) {
  return m_mdb->UInt64ToRowCellColumn(m_mdbRow, aProperty,
                                      (uint64_t)propertyValue);
}

nsresult nsDBFolderInfo::SetInt32PropertyWithToken(mdb_token aProperty,
                                                   int32_t propertyValue) {
  nsAutoString propertyStr;
  propertyStr.AppendInt(propertyValue, 16);
  return SetPropertyWithToken(aProperty, propertyStr);
}

nsresult nsDBFolderInfo::GetPropertyWithToken(mdb_token aProperty,
                                              nsAString& resultProperty) {
  return m_mdb->RowCellColumnTonsString(m_mdbRow, aProperty, resultProperty);
}

nsresult nsDBFolderInfo::GetUint32PropertyWithToken(mdb_token aProperty,
                                                    uint32_t& propertyValue,
                                                    uint32_t defaultValue) {
  return m_mdb->RowCellColumnToUInt32(m_mdbRow, aProperty, propertyValue,
                                      defaultValue);
}

nsresult nsDBFolderInfo::GetInt32PropertyWithToken(mdb_token aProperty,
                                                   int32_t& propertyValue,
                                                   int32_t defaultValue) {
  return m_mdb->RowCellColumnToUInt32(m_mdbRow, aProperty,
                                      (uint32_t&)propertyValue, defaultValue);
}

NS_IMETHODIMP nsDBFolderInfo::GetUint32Property(const char* propertyName,
                                                uint32_t defaultValue,
                                                uint32_t* propertyValue) {
  return m_mdb->GetUint32Property(m_mdbRow, propertyName, propertyValue,
                                  defaultValue);
}

NS_IMETHODIMP nsDBFolderInfo::GetInt64Property(const char* propertyName,
                                               int64_t defaultValue,
                                               int64_t* propertyValue) {
  return m_mdb->GetUint64Property(m_mdbRow, propertyName,
                                  (uint64_t*)propertyValue, defaultValue);
}

nsresult nsDBFolderInfo::GetInt64PropertyWithToken(mdb_token aProperty,
                                                   int64_t& propertyValue,
                                                   int64_t defaultValue) {
  return m_mdb->RowCellColumnToUInt64(m_mdbRow, aProperty,
                                      (uint64_t*)&propertyValue, defaultValue);
}

NS_IMETHODIMP nsDBFolderInfo::GetBooleanProperty(const char* propertyName,
                                                 bool defaultValue,
                                                 bool* propertyValue) {
  uint32_t defaultUint32Value = (defaultValue) ? 1 : 0;
  uint32_t returnValue;
  nsresult rv = m_mdb->GetUint32Property(m_mdbRow, propertyName, &returnValue,
                                         defaultUint32Value);
  *propertyValue = (returnValue != 0);
  return rv;
}
NS_IMETHODIMP nsDBFolderInfo::SetBooleanProperty(const char* propertyName,
                                                 bool propertyValue) {
  return m_mdb->SetUint32Property(m_mdbRow, propertyName,
                                  propertyValue ? 1 : 0);
}

NS_IMETHODIMP nsDBFolderInfo::GetFolderName(nsACString& folderName) {
  return GetCharProperty("folderName", folderName);
}

NS_IMETHODIMP nsDBFolderInfo::SetFolderName(const nsACString& folderName) {
  return SetCharProperty("folderName", folderName);
}

NS_IMETHODIMP nsDBFolderInfo::GetTransferInfo(nsIPropertyBag2** transferInfo) {
  NS_ENSURE_ARG_POINTER(transferInfo);
  NS_ENSURE_STATE(m_mdbRow);

  nsCOMPtr<nsIWritablePropertyBag2> newInfo =
      do_CreateInstance("@mozilla.org/hash-property-bag;1");

  mdb_count numCells;
  mdbYarn cellYarn;
  mdb_column cellColumn;
  char columnName[100];
  mdbYarn cellName = {columnName, 0, sizeof(columnName), 0, 0, nullptr};

  m_mdbRow->GetCount(m_mdb->GetEnv(), &numCells);
  // iterate over the cells in the dbfolderinfo remembering attribute names and
  // values.
  for (mdb_count cellIndex = 0; cellIndex < numCells; cellIndex++) {
    nsresult err = m_mdbRow->SeekCellYarn(m_mdb->GetEnv(), cellIndex,
                                          &cellColumn, nullptr);
    if (NS_SUCCEEDED(err)) {
      err = m_mdbRow->AliasCellYarn(m_mdb->GetEnv(), cellColumn, &cellYarn);
      if (NS_SUCCEEDED(err)) {
        m_mdb->GetStore()->TokenToString(m_mdb->GetEnv(), cellColumn,
                                         &cellName);
        nsAutoCString name(
            Substring((const char*)cellName.mYarn_Buf,
                      (const char*)cellName.mYarn_Buf + cellName.mYarn_Fill));
        nsAutoCString value(
            Substring((const char*)cellYarn.mYarn_Buf,
                      (const char*)cellYarn.mYarn_Buf + cellYarn.mYarn_Fill));
        newInfo->SetPropertyAsACString(NS_ConvertUTF8toUTF16(name), value);
      }
    }
  }

  newInfo.forget(transferInfo);
  return NS_OK;
}

NS_IMETHODIMP nsDBFolderInfo::InitFromTransferInfo(
    nsIPropertyBag2* aTransferInfo) {
  NS_ENSURE_ARG(aTransferInfo);

  nsCOMPtr<nsISimpleEnumerator> enumerator;
  aTransferInfo->GetEnumerator(getter_AddRefs(enumerator));

  for (const auto& property :
       mozilla::SimpleEnumerator<nsIProperty>(enumerator)) {
    nsAutoString name;
    property->GetName(name);
    nsCOMPtr<nsIVariant> variant;
    property->GetValue(getter_AddRefs(variant));
    nsAutoCString value;
    variant->GetAsACString(value);

    SetCharProperty(NS_ConvertUTF16toUTF8(name).get(), value);
  }

  LoadMemberVariables();
  return NS_OK;
}
