/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MailNewsTypes.h"
#include "msgCore.h"
#include "nsMsgHdr.h"
#include "nsMsgDatabase.h"
#include "nsMsgUtils.h"
#include "nsMsgMessageFlags.h"
#include "nsIMsgThread.h"
#include "nsStringEnumerator.h"
#ifdef DEBUG
#  include "nsPrintfCString.h"
#endif

using namespace mozilla::mailnews;

NS_IMPL_ISUPPORTS(nsMsgHdr, nsIMsgDBHdr)

#define FLAGS_INITED 0x1
#define CACHED_VALUES_INITED 0x2
#define REFERENCES_INITED 0x4
#define THREAD_PARENT_INITED 0x8

nsMsgHdr::nsMsgHdr(nsMsgDatabase* db, nsIMdbRow* dbRow) {
  m_mdb = db;
  Init();
  m_mdbRow = dbRow;
  if (m_mdb) {
    NS_ADDREF(m_mdb);  // Released in DTOR.
    mdbOid outOid;
    if (dbRow && NS_SUCCEEDED(dbRow->GetOid(m_mdb->GetEnv(), &outOid))) {
      m_messageKey = outOid.mOid_Id;
      m_mdb->AddHdrToUseCache((nsIMsgDBHdr*)this, m_messageKey);
    }
  }
}

void nsMsgHdr::Init() {
  m_initedValues = 0;
  m_messageKey = nsMsgKey_None;
  m_messageSize = 0;
  m_date = 0;
  m_flags = 0;
  m_mdbRow = NULL;
  m_threadId = nsMsgKey_None;
  m_threadParent = nsMsgKey_None;
}

nsresult nsMsgHdr::InitCachedValues() {
  nsresult err = NS_OK;

  if (!m_mdb || !m_mdbRow) return NS_ERROR_NULL_POINTER;

  if (!(m_initedValues & CACHED_VALUES_INITED)) {
    uint32_t uint32Value;
    mdbOid outOid;
    if (NS_SUCCEEDED(m_mdbRow->GetOid(m_mdb->GetEnv(), &outOid)))
      m_messageKey = outOid.mOid_Id;

    err = GetUInt32Column(m_mdb->m_messageSizeColumnToken, &m_messageSize);

    err = GetUInt32Column(m_mdb->m_dateColumnToken, &uint32Value);
    Seconds2PRTime(uint32Value, &m_date);

    err = GetUInt32Column(m_mdb->m_messageThreadIdColumnToken, &m_threadId);

    if (NS_SUCCEEDED(err)) m_initedValues |= CACHED_VALUES_INITED;
  }
  return err;
}

nsresult nsMsgHdr::InitFlags() {
  nsresult err = NS_OK;

  if (!m_mdb) return NS_ERROR_NULL_POINTER;

  if (!(m_initedValues & FLAGS_INITED)) {
    err = GetUInt32Column(m_mdb->m_flagsColumnToken, &m_flags);
    m_flags &= ~nsMsgMessageFlags::New;  // don't get new flag from MDB

    if (NS_SUCCEEDED(err)) m_initedValues |= FLAGS_INITED;
  }

  return err;
}

nsMsgHdr::~nsMsgHdr() {
  if (m_mdbRow) {
    if (m_mdb) {
      NS_RELEASE(m_mdbRow);
      m_mdb->RemoveHdrFromUseCache((nsIMsgDBHdr*)this, m_messageKey);
    }
  }
  NS_IF_RELEASE(m_mdb);
}

NS_IMETHODIMP nsMsgHdr::GetMessageKey(nsMsgKey* result) {
  if (m_messageKey == nsMsgKey_None && m_mdbRow != NULL) {
    mdbOid outOid;
    if (NS_SUCCEEDED(m_mdbRow->GetOid(m_mdb->GetEnv(), &outOid)))
      m_messageKey = outOid.mOid_Id;
  }
  *result = m_messageKey;
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::GetThreadId(nsMsgKey* result) {
  if (!(m_initedValues & CACHED_VALUES_INITED)) InitCachedValues();

  if (result) {
    *result = m_threadId;
    return NS_OK;
  }
  return NS_ERROR_NULL_POINTER;
}

NS_IMETHODIMP nsMsgHdr::SetThreadId(nsMsgKey inKey) {
  m_threadId = inKey;
  return SetUInt32Column(m_threadId, m_mdb->m_messageThreadIdColumnToken);
}

NS_IMETHODIMP nsMsgHdr::SetMessageKey(nsMsgKey value) {
  m_messageKey = value;
  return NS_OK;
}

nsresult nsMsgHdr::GetRawFlags(uint32_t* result) {
  if (!(m_initedValues & FLAGS_INITED)) InitFlags();
  *result = m_flags;
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::GetFlags(uint32_t* result) {
  if (!(m_initedValues & FLAGS_INITED)) InitFlags();
  if (m_mdb)
    *result = m_mdb->GetStatusFlags(this, m_flags);
  else
    *result = m_flags;
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::SetFlags(uint32_t flags) {
  m_initedValues |= FLAGS_INITED;
  m_flags = flags;
  // don't write out nsMsgMessageFlags::New to MDB.
  return SetUInt32Column(m_flags & ~nsMsgMessageFlags::New,
                         m_mdb->m_flagsColumnToken);
}

NS_IMETHODIMP nsMsgHdr::OrFlags(uint32_t flags, uint32_t* result) {
  if (!(m_initedValues & FLAGS_INITED)) InitFlags();
  if ((m_flags & flags) != flags) SetFlags(m_flags | flags);
  *result = m_flags;
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::AndFlags(uint32_t flags, uint32_t* result) {
  if (!(m_initedValues & FLAGS_INITED)) InitFlags();
  if ((m_flags & flags) != m_flags) SetFlags(m_flags & flags);
  *result = m_flags;
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::MarkHasAttachments(bool bHasAttachments) {
  nsresult rv = NS_OK;

  if (m_mdb) {
    nsMsgKey key;
    rv = GetMessageKey(&key);
    if (NS_SUCCEEDED(rv))
      rv = m_mdb->MarkHasAttachments(key, bHasAttachments, nullptr);
  }
  return rv;
}

NS_IMETHODIMP nsMsgHdr::MarkRead(bool bRead) {
  nsresult rv = NS_OK;

  if (m_mdb) {
    nsMsgKey key;
    rv = GetMessageKey(&key);
    if (NS_SUCCEEDED(rv)) rv = m_mdb->MarkRead(key, bRead, nullptr);
  }
  return rv;
}

NS_IMETHODIMP nsMsgHdr::MarkFlagged(bool bFlagged) {
  nsresult rv = NS_OK;

  if (m_mdb) {
    nsMsgKey key;
    rv = GetMessageKey(&key);
    if (NS_SUCCEEDED(rv)) rv = m_mdb->MarkMarked(key, bFlagged, nullptr);
  }
  return rv;
}

NS_IMETHODIMP nsMsgHdr::SetStringProperty(const char* propertyName,
                                          const nsACString& propertyValue) {
  NS_ENSURE_ARG_POINTER(propertyName);
  if (!m_mdb || !m_mdbRow) return NS_ERROR_NULL_POINTER;
  return m_mdb->SetProperty(m_mdbRow, propertyName,
                            PromiseFlatCString(propertyValue).get());
}

NS_IMETHODIMP nsMsgHdr::GetStringProperty(const char* propertyName,
                                          nsACString& aPropertyValue) {
  NS_ENSURE_ARG_POINTER(propertyName);
  if (!m_mdb || !m_mdbRow) return NS_ERROR_NULL_POINTER;
  return m_mdb->GetProperty(m_mdbRow, propertyName,
                            getter_Copies(aPropertyValue));
}

NS_IMETHODIMP nsMsgHdr::GetUint32Property(const char* propertyName,
                                          uint32_t* pResult) {
  NS_ENSURE_ARG_POINTER(propertyName);
  if (!m_mdb || !m_mdbRow) return NS_ERROR_NULL_POINTER;
  return m_mdb->GetUint32Property(m_mdbRow, propertyName, pResult);
}

NS_IMETHODIMP nsMsgHdr::SetUint32Property(const char* propertyName,
                                          uint32_t value) {
  NS_ENSURE_ARG_POINTER(propertyName);
  if (!m_mdb || !m_mdbRow) return NS_ERROR_NULL_POINTER;
  return m_mdb->SetUint32Property(m_mdbRow, propertyName, value);
}

NS_IMETHODIMP nsMsgHdr::GetNumReferences(uint16_t* result) {
  if (!(m_initedValues & REFERENCES_INITED)) {
    const char* references;
    if (NS_SUCCEEDED(m_mdb->RowCellColumnToConstCharPtr(
            GetMDBRow(), m_mdb->m_referencesColumnToken, &references)))
      ParseReferences(references);
    m_initedValues |= REFERENCES_INITED;
  }

  if (result) *result = m_references.Length();
  // there is no real failure here; if there are no references, there are no
  //  references.
  return NS_OK;
}

nsresult nsMsgHdr::ParseReferences(const char* references) {
  const char* startNextRef = references;
  nsAutoCString resultReference;
  nsCString messageId;
  GetMessageId(messageId);

  while (startNextRef && *startNextRef) {
    startNextRef = GetNextReference(startNextRef, resultReference,
                                    startNextRef == references);
    // Don't add self-references.
    if (!resultReference.IsEmpty() && !resultReference.Equals(messageId))
      m_references.AppendElement(resultReference);
  }
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::GetStringReference(int32_t refNum,
                                           nsACString& resultReference) {
  nsresult err = NS_OK;

  if (!(m_initedValues & REFERENCES_INITED))
    GetNumReferences(nullptr);  // it can handle the null

  if ((uint32_t)refNum < m_references.Length())
    resultReference = m_references.ElementAt(refNum);
  else
    err = NS_ERROR_ILLEGAL_VALUE;
  return err;
}

NS_IMETHODIMP nsMsgHdr::GetDate(PRTime* result) {
  if (!(m_initedValues & CACHED_VALUES_INITED)) InitCachedValues();

  *result = m_date;
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::GetDateInSeconds(uint32_t* aResult) {
  return GetUInt32Column(m_mdb->m_dateColumnToken, aResult);
}

NS_IMETHODIMP nsMsgHdr::SetMessageId(const nsACString& messageId) {
  if (!messageId.IsEmpty() && messageId.CharAt(0) == '<') {
    // Trim `<>' from message ID.
    size_t substrLength = messageId.Length() - 1;
    if (messageId.CharAt(messageId.Length() - 1) == '>') {
      substrLength -= 1;
    }

    const auto toWrite = Substring(messageId, 1, substrLength);
    return SetStringColumn(PromiseFlatCString(toWrite).get(),
                           m_mdb->m_messageIdColumnToken);
  }

  return SetStringColumn(PromiseFlatCString(messageId).get(),
                         m_mdb->m_messageIdColumnToken);
}

NS_IMETHODIMP nsMsgHdr::SetSubject(const nsACString& subject) {
  return SetStringColumn(PromiseFlatCString(subject).get(),
                         m_mdb->m_subjectColumnToken);
}

NS_IMETHODIMP nsMsgHdr::SetAuthor(const nsACString& author) {
  return SetStringColumn(PromiseFlatCString(author).get(),
                         m_mdb->m_senderColumnToken);
}

NS_IMETHODIMP nsMsgHdr::SetReferences(const nsACString& references) {
  m_references.Clear();
  ParseReferences(PromiseFlatCString(references).get());

  m_initedValues |= REFERENCES_INITED;

  return SetStringColumn(PromiseFlatCString(references).get(),
                         m_mdb->m_referencesColumnToken);
}

NS_IMETHODIMP nsMsgHdr::SetRecipients(const nsACString& recipients) {
  // need to put in rfc822 address parsing code here (or make caller do it...)
  return SetStringColumn(PromiseFlatCString(recipients).get(),
                         m_mdb->m_recipientsColumnToken);
}

NS_IMETHODIMP nsMsgHdr::SetCcList(const nsACString& ccList) {
  return SetStringColumn(PromiseFlatCString(ccList).get(),
                         m_mdb->m_ccListColumnToken);
}

NS_IMETHODIMP nsMsgHdr::SetBccList(const nsACString& bccList) {
  return SetStringColumn(PromiseFlatCString(bccList).get(),
                         m_mdb->m_bccListColumnToken);
}

NS_IMETHODIMP nsMsgHdr::SetMessageSize(uint32_t messageSize) {
  SetUInt32Column(messageSize, m_mdb->m_messageSizeColumnToken);
  m_messageSize = messageSize;
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::GetOfflineMessageSize(uint32_t* result) {
  uint32_t size;
  nsresult res = GetUInt32Column(m_mdb->m_offlineMessageSizeColumnToken, &size);

  *result = size;
  return res;
}

NS_IMETHODIMP nsMsgHdr::SetOfflineMessageSize(uint32_t messageSize) {
  return SetUInt32Column(messageSize, m_mdb->m_offlineMessageSizeColumnToken);
}

NS_IMETHODIMP nsMsgHdr::SetLineCount(uint32_t lineCount) {
  SetUInt32Column(lineCount, m_mdb->m_numLinesColumnToken);
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::SetDate(PRTime date) {
  m_date = date;
  uint32_t seconds;
  PRTime2Seconds(date, &seconds);
  return SetUInt32Column((uint32_t)seconds, m_mdb->m_dateColumnToken);
}

NS_IMETHODIMP nsMsgHdr::SetPriority(nsMsgPriorityValue priority) {
  SetUInt32Column((uint32_t)priority, m_mdb->m_priorityColumnToken);
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::GetPriority(nsMsgPriorityValue* result) {
  if (!result) return NS_ERROR_NULL_POINTER;

  uint32_t priority = 0;
  nsresult rv = GetUInt32Column(m_mdb->m_priorityColumnToken, &priority);
  if (NS_FAILED(rv)) return rv;

  *result = (nsMsgPriorityValue)priority;
  return NS_OK;
}

// I'd like to not store the account key, if the msg is in
// the same account as it was received in, to save disk space and memory.
// This might be problematic when a message gets moved...
// And I'm not sure if we should short circuit it here,
// or at a higher level where it might be more efficient.
NS_IMETHODIMP nsMsgHdr::SetAccountKey(const nsACString& aAccountKey) {
  return SetStringProperty("account", aAccountKey);
}

NS_IMETHODIMP nsMsgHdr::GetAccountKey(nsACString& aResult) {
  return GetStringProperty("account", aResult);
}

NS_IMETHODIMP nsMsgHdr::GetStoreToken(nsACString& result) {
  GetStringProperty("storeToken", result);
  if (result.IsEmpty()) {
    // If .storeToken is unset, it _might_ be a very old database with a
    // .messageOffset value we can migrate from instead. Doing it here on the
    // fly saves us a tricky upfront migration pass.
    uint64_t offset;
    GetUInt64Column(m_mdb->m_offlineMsgOffsetColumnToken, &offset,
                    std::numeric_limits<uint64_t>::max());
    if (offset != std::numeric_limits<uint64_t>::max()) {
      result.Truncate();
      result.AppendInt(offset);
      // Save the value so we don't have to do this next time.
      SetStoreToken(result);
    }
  }
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::SetStoreToken(const nsACString& token) {
  return SetStringProperty("storeToken", token);
}

NS_IMETHODIMP nsMsgHdr::GetMessageSize(uint32_t* result) {
  uint32_t size;
  nsresult res = GetUInt32Column(m_mdb->m_messageSizeColumnToken, &size);

  *result = size;
  return res;
}

NS_IMETHODIMP nsMsgHdr::GetLineCount(uint32_t* result) {
  uint32_t linecount;
  nsresult res = GetUInt32Column(m_mdb->m_numLinesColumnToken, &linecount);
  *result = linecount;
  return res;
}

NS_IMETHODIMP nsMsgHdr::GetAuthor(nsACString& resultAuthor) {
  return m_mdb->RowCellColumnToCharPtr(GetMDBRow(), m_mdb->m_senderColumnToken,
                                       getter_Copies(resultAuthor));
}

NS_IMETHODIMP nsMsgHdr::GetSubject(nsACString& resultSubject) {
  return m_mdb->RowCellColumnToCharPtr(GetMDBRow(), m_mdb->m_subjectColumnToken,
                                       getter_Copies(resultSubject));
}

NS_IMETHODIMP nsMsgHdr::GetRecipients(nsACString& resultRecipients) {
  return m_mdb->RowCellColumnToCharPtr(GetMDBRow(),
                                       m_mdb->m_recipientsColumnToken,
                                       getter_Copies(resultRecipients));
}

NS_IMETHODIMP nsMsgHdr::GetCcList(nsACString& resultCCList) {
  return m_mdb->RowCellColumnToCharPtr(GetMDBRow(), m_mdb->m_ccListColumnToken,
                                       getter_Copies(resultCCList));
}

NS_IMETHODIMP nsMsgHdr::GetBccList(nsACString& resultBCCList) {
  return m_mdb->RowCellColumnToCharPtr(GetMDBRow(), m_mdb->m_bccListColumnToken,
                                       getter_Copies(resultBCCList));
}

NS_IMETHODIMP nsMsgHdr::GetMessageId(nsACString& resultMessageId) {
  return m_mdb->RowCellColumnToCharPtr(GetMDBRow(),
                                       m_mdb->m_messageIdColumnToken,
                                       getter_Copies(resultMessageId));
}

NS_IMETHODIMP nsMsgHdr::GetMime2DecodedAuthor(nsAString& resultAuthor) {
  return m_mdb->RowCellColumnToMime2DecodedString(
      GetMDBRow(), m_mdb->m_senderColumnToken, resultAuthor);
}

NS_IMETHODIMP nsMsgHdr::GetMime2DecodedSubject(nsAString& resultSubject) {
  return m_mdb->RowCellColumnToMime2DecodedString(
      GetMDBRow(), m_mdb->m_subjectColumnToken, resultSubject);
}

NS_IMETHODIMP nsMsgHdr::GetMime2DecodedRecipients(nsAString& resultRecipients) {
  return m_mdb->RowCellColumnToMime2DecodedString(
      GetMDBRow(), m_mdb->m_recipientsColumnToken, resultRecipients);
}

NS_IMETHODIMP nsMsgHdr::GetAuthorCollationKey(nsTArray<uint8_t>& resultAuthor) {
  return m_mdb->RowCellColumnToAddressCollationKey(
      GetMDBRow(), m_mdb->m_senderColumnToken, resultAuthor);
}

NS_IMETHODIMP nsMsgHdr::GetSubjectCollationKey(
    nsTArray<uint8_t>& resultSubject) {
  return m_mdb->RowCellColumnToCollationKey(
      GetMDBRow(), m_mdb->m_subjectColumnToken, resultSubject);
}

NS_IMETHODIMP nsMsgHdr::GetRecipientsCollationKey(
    nsTArray<uint8_t>& resultRecipients) {
  return m_mdb->RowCellColumnToCollationKey(
      GetMDBRow(), m_mdb->m_recipientsColumnToken, resultRecipients);
}

NS_IMETHODIMP nsMsgHdr::GetCharset(nsACString& aCharset) {
  return m_mdb->RowCellColumnToCharPtr(
      GetMDBRow(), m_mdb->m_messageCharSetColumnToken, getter_Copies(aCharset));
}

NS_IMETHODIMP nsMsgHdr::SetCharset(const nsACString& aCharset) {
  return SetStringColumn(PromiseFlatCString(aCharset).get(),
                         m_mdb->m_messageCharSetColumnToken);
}

NS_IMETHODIMP nsMsgHdr::GetEffectiveCharset(nsACString& resultCharset) {
  return m_mdb->GetEffectiveCharset(m_mdbRow, resultCharset);
}

NS_IMETHODIMP nsMsgHdr::SetThreadParent(nsMsgKey inKey) {
  m_threadParent = inKey;
  if (inKey == m_messageKey) NS_ASSERTION(false, "can't be your own parent");
  SetUInt32Column(m_threadParent, m_mdb->m_threadParentColumnToken);
  m_initedValues |= THREAD_PARENT_INITED;
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::GetThreadParent(nsMsgKey* result) {
  nsresult res;
  if (!(m_initedValues & THREAD_PARENT_INITED)) {
    res = GetUInt32Column(m_mdb->m_threadParentColumnToken, &m_threadParent,
                          nsMsgKey_None);
    if (NS_SUCCEEDED(res)) m_initedValues |= THREAD_PARENT_INITED;
  }
  *result = m_threadParent;
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::GetFolder(nsIMsgFolder** result) {
  NS_ENSURE_ARG(result);

  if (m_mdb && m_mdb->m_folder) {
    NS_ADDREF(*result = m_mdb->m_folder);
  } else
    *result = nullptr;
  return NS_OK;
}

nsresult nsMsgHdr::SetStringColumn(const char* str, mdb_token token) {
  NS_ENSURE_ARG_POINTER(str);
  return m_mdb->CharPtrToRowCellColumn(m_mdbRow, token, str);
}

nsresult nsMsgHdr::SetUInt32Column(uint32_t value, mdb_token token) {
  return m_mdb->UInt32ToRowCellColumn(m_mdbRow, token, value);
}

nsresult nsMsgHdr::GetUInt32Column(mdb_token token, uint32_t* pvalue,
                                   uint32_t defaultValue) {
  return m_mdb->RowCellColumnToUInt32(GetMDBRow(), token, pvalue, defaultValue);
}

nsresult nsMsgHdr::SetUInt64Column(uint64_t value, mdb_token token) {
  return m_mdb->UInt64ToRowCellColumn(m_mdbRow, token, value);
}

nsresult nsMsgHdr::GetUInt64Column(mdb_token token, uint64_t* pvalue,
                                   uint64_t defaultValue) {
  return m_mdb->RowCellColumnToUInt64(GetMDBRow(), token, pvalue, defaultValue);
}

/**
 * Roughly speaking, get the next message-id (starts with a '<' ends with a
 *  '>').  Except, we also try to handle the case where your reference is of
 *  a prehistoric vintage that just stuck any old random junk in there.  Our
 *  old logic would (unintentionally?) just trim the whitespace off the front
 *  and hand you everything after that.  We change things at all because that
 *  same behaviour does not make sense if we have already seen a proper message
 *  id.  We keep the old behaviour at all because it would seem to have
 *  benefits.  (See jwz's non-zero stats: http://www.jwz.org/doc/threading.html)
 * So, to re-state, if there is a valid message-id in there at all, we only
 *  return valid message-id's (sans bracketing '<' and '>').  If there isn't,
 *  our result (via "references") is a left-trimmed copy of the string.  If
 *  there is nothing in there, our result is an empty string.)  We do require
 *  that you pass allowNonDelimitedReferences what it demands, though.
 * For example: "<valid@stuff> this stuff is invalid" would net you
 *  "valid@stuff" and "this stuff is invalid" as results.  We now only would
 *  provide "valid-stuff" and an empty string (which you should ignore) as
 *  results.  However "this stuff is invalid" would return itself, allowing
 *  anything relying on that behaviour to keep working.
 *
 * Note: We accept anything inside the '<' and '>'; technically, we should want
 *  at least a '@' in there (per rfc 2822).  But since we're going out of our
 *  way to support weird things...
 *
 * @param startNextRef The position to start at; this should either be the start
 *     of your references string or our return value from a previous call.
 * @param reference You pass a nsCString by reference, we put the reference we
 *     find in it, if we find one.  It may be empty!  Beware!
 * @param allowNonDelimitedReferences Should we support the
 *     pre-reasonable-standards form of In-Reply-To where it could be any
 *     arbitrary string and our behaviour was just to take off leading
 *     whitespace.  It only makes sense to pass true for your first call to this
 *     function, as if you are around to make a second call, it means we found
 *     a properly formatted message-id and so we should only look for more
 *     properly formatted message-ids.
 *     NOTE: this option will also strip off a single leading '<' if there is
 *     one. Some examples:
 *        "   foo" => "foo"
 *        "  <bar" => "bar"
 *        "<<<foo" => "<<foo"
 *        "<foo@bar>" => "foo@bar"  (completed message-id)
 * @returns The next starting position of this routine, which may be pointing at
 *     a nul '\0' character to indicate termination.
 */
const char* nsMsgHdr::GetNextReference(const char* startNextRef,
                                       nsCString& reference,
                                       bool acceptNonDelimitedReferences) {
  const char* ptr = startNextRef;
  const char* whitespaceEndedAt = nullptr;
  const char* firstMessageIdChar = nullptr;

  // make the reference result string empty by default; we will set it to
  //  something valid if the time comes.
  reference.Truncate();

  // walk until we find a '<', but keep track of the first point we found that
  //  was not whitespace (as defined by previous versions of this code.)
  for (bool foundLessThan = false; !foundLessThan; ptr++) {
    switch (*ptr) {
      case '\0':
        // if we are at the end of the string, we found some non-whitespace, and
        //  the caller requested that we accept non-delimited whitespace,
        //  give them that as their reference.  (otherwise, leave it empty)
        if (acceptNonDelimitedReferences && whitespaceEndedAt)
          reference = whitespaceEndedAt;
        return ptr;
      case ' ':
      case '\r':
      case '\n':
      case '\t':
        // do nothing, make default case mean you didn't get whitespace
        break;
      case '<':
        firstMessageIdChar = ptr + 1;  // skip over the '<'
        foundLessThan = true;          // (flag to stop)
        // Ensure whitespaceEndedAt skips the leading '<' and is set to
        //  a non-NULL value, just in case the message-id is not valid (no '>')
        //  and the old-school support is desired.
        if (!whitespaceEndedAt) whitespaceEndedAt = ptr + 1;
        break;
      default:
        if (!whitespaceEndedAt) whitespaceEndedAt = ptr;
        break;
    }
  }

  // keep going until we hit a '>' or hit the end of the string
  for (; *ptr; ptr++) {
    if (*ptr == '>') {
      // it's valid, update reference, making sure to stop before the '>'
      reference.Assign(firstMessageIdChar, ptr - firstMessageIdChar);
      // and return a start point just after the '>'
      return ++ptr;
    }
  }

  // we did not have a fully-formed, valid message-id, so consider falling back
  if (acceptNonDelimitedReferences && whitespaceEndedAt)
    reference = whitespaceEndedAt;
  return ptr;
}

bool nsMsgHdr::IsParentOf(nsIMsgDBHdr* possibleChild) {
  uint16_t referenceToCheck = 0;
  possibleChild->GetNumReferences(&referenceToCheck);
  nsAutoCString reference;

  nsCString messageId;
  GetMessageId(messageId);

  while (referenceToCheck > 0) {
    possibleChild->GetStringReference(referenceToCheck - 1, reference);

    if (reference.Equals(messageId)) return true;
    // if reference didn't match, check if this ref is for a non-existent
    // header. If it is, continue looking at ancestors.
    nsCOMPtr<nsIMsgDBHdr> refHdr;
    if (!m_mdb) break;
    (void)m_mdb->GetMsgHdrForMessageID(reference.get(), getter_AddRefs(refHdr));
    if (refHdr) break;
    referenceToCheck--;
  }
  return false;
}

bool nsMsgHdr::IsAncestorOf(nsIMsgDBHdr* possibleChild) {
  const char* references;
  nsMsgHdr* curHdr =
      static_cast<nsMsgHdr*>(possibleChild);  // closed system, cast ok
  m_mdb->RowCellColumnToConstCharPtr(
      curHdr->GetMDBRow(), m_mdb->m_referencesColumnToken, &references);
  if (!references) return false;

  nsCString messageId;
  // should put < > around message id to make strstr strictly match
  GetMessageId(messageId);
  return (strstr(references, messageId.get()) != nullptr);
}

NS_IMETHODIMP nsMsgHdr::GetIsRead(bool* isRead) {
  NS_ENSURE_ARG_POINTER(isRead);
  if (!(m_initedValues & FLAGS_INITED)) InitFlags();
  *isRead = !!(m_flags & nsMsgMessageFlags::Read);
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::GetIsFlagged(bool* isFlagged) {
  NS_ENSURE_ARG_POINTER(isFlagged);
  if (!(m_initedValues & FLAGS_INITED)) InitFlags();
  *isFlagged = !!(m_flags & nsMsgMessageFlags::Marked);
  return NS_OK;
}

void nsMsgHdr::ReparentInThread(nsIMsgThread* thread) {
  NS_WARNING("Borked message header, attempting to fix!");
  uint32_t numChildren;
  thread->GetNumChildren(&numChildren);
  // bail out early for the singleton thread case.
  if (numChildren == 1) {
    SetThreadParent(nsMsgKey_None);
    return;
  } else {
    nsCOMPtr<nsIMsgDBHdr> curHdr;
    // loop through thread, looking for our proper parent.
    for (uint32_t childIndex = 0; childIndex < numChildren; childIndex++) {
      thread->GetChildHdrAt(childIndex, getter_AddRefs(curHdr));
      // closed system, cast ok
      nsMsgHdr* curMsgHdr = static_cast<nsMsgHdr*>(curHdr.get());
      if (curHdr && curMsgHdr->IsParentOf(this)) {
        nsMsgKey curHdrKey;
        curHdr->GetMessageKey(&curHdrKey);
        SetThreadParent(curHdrKey);
        return;
      }
    }
    // we didn't find it. So either the root header is our parent,
    // or we're the root.
    nsCOMPtr<nsIMsgDBHdr> rootHdr;
    thread->GetRootHdr(getter_AddRefs(rootHdr));
    NS_ASSERTION(rootHdr, "thread has no root hdr - shouldn't happen");
    if (rootHdr) {
      nsMsgKey rootKey;
      rootHdr->GetMessageKey(&rootKey);
      // if we're the root, our thread parent is -1.
      SetThreadParent(rootKey == m_messageKey ? nsMsgKey_None : rootKey);
    }
  }
}

bool nsMsgHdr::IsAncestorKilled(uint32_t ancestorsToCheck) {
  if (!(m_initedValues & FLAGS_INITED)) InitFlags();
  bool isKilled = m_flags & nsMsgMessageFlags::Ignored;

  if (!isKilled) {
    nsMsgKey threadParent;
    GetThreadParent(&threadParent);

    if (threadParent == m_messageKey) {
      // isKilled is false by virtue of the enclosing if statement
      NS_ERROR("Thread is parent of itself, please fix!");
      nsCOMPtr<nsIMsgThread> thread;
      (void)m_mdb->GetThreadContainingMsgHdr(this, getter_AddRefs(thread));
      if (!thread) return false;
      ReparentInThread(thread);
      // Something's wrong, but the problem happened some time ago, so erroring
      // out now is probably not a good idea. Ergo, we'll pretend to be OK, show
      // the user the thread (err on the side of caution), and let the assertion
      // alert debuggers to a problem.
      return false;
    }
    if (threadParent != nsMsgKey_None) {
      nsCOMPtr<nsIMsgDBHdr> parentHdr;
      (void)m_mdb->GetMsgHdrForKey(threadParent, getter_AddRefs(parentHdr));

      if (parentHdr) {
        // More proofing against crashers. This crasher was derived from the
        // fact that something got borked, leaving is in hand with a circular
        // reference to borked headers inducing these loops. The defining
        // characteristic of these headers is that they don't actually seat
        // themselves in the thread properly.
        nsCOMPtr<nsIMsgThread> thread;
        (void)m_mdb->GetThreadContainingMsgHdr(this, getter_AddRefs(thread));
        if (thread) {
          nsCOMPtr<nsIMsgDBHdr> claimant;
          (void)thread->GetChild(threadParent, getter_AddRefs(claimant));
          if (!claimant) {
            // attempt to reparent, and say the thread isn't killed,
            // erring on the side of safety.
            ReparentInThread(thread);
            return false;
          }
        }

        if (!ancestorsToCheck) {
          // We think we have a parent, but we have no more ancestors to check
          NS_ASSERTION(false, "cycle in parent relationship, please fix!");
          return false;
        }
        // closed system, cast ok
        nsMsgHdr* parent = static_cast<nsMsgHdr*>(parentHdr.get());
        return parent->IsAncestorKilled(ancestorsToCheck - 1);
      }
    }
  }
  return isKilled;
}

NS_IMETHODIMP nsMsgHdr::GetIsKilled(bool* isKilled) {
  NS_ENSURE_ARG_POINTER(isKilled);
  *isKilled = false;
  nsCOMPtr<nsIMsgThread> thread;
  (void)m_mdb->GetThreadContainingMsgHdr(this, getter_AddRefs(thread));
  // if we can't find the thread, let's at least check one level; maybe
  // the header hasn't been added to a thread yet.
  uint32_t numChildren = 1;
  if (thread) thread->GetNumChildren(&numChildren);
  if (!numChildren) return NS_ERROR_FAILURE;
  // We can't have as many ancestors as there are messages in the thread,
  // so tell IsAncestorKilled to only check numChildren - 1 ancestors.
  *isKilled = IsAncestorKilled(numChildren - 1);
  return NS_OK;
}

////////////////////////////////////////////////////////////////////////////////

#include "nsIStringEnumerator.h"
#define NULL_MORK_COLUMN 0
class nsMsgPropertyEnumerator : public nsStringEnumeratorBase {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIUTF8STRINGENUMERATOR

  using nsStringEnumeratorBase::GetNext;

  explicit nsMsgPropertyEnumerator(nsMsgHdr* aHdr);
  void PrefetchNext();

 protected:
  virtual ~nsMsgPropertyEnumerator();
  nsCOMPtr<nsIMdbRowCellCursor> mRowCellCursor;
  nsCOMPtr<nsIMdbEnv> m_mdbEnv;
  nsCOMPtr<nsIMdbStore> m_mdbStore;
  // Hold a reference to the hdr so it will hold an xpcom reference to the
  // underlying mdb row. The row cell cursor will crash if the underlying
  // row goes away.
  RefPtr<nsMsgHdr> m_hdr;
  bool mNextPrefetched;
  mdb_column mNextColumn;
};

nsMsgPropertyEnumerator::nsMsgPropertyEnumerator(nsMsgHdr* aHdr)
    : mNextPrefetched(false), mNextColumn(NULL_MORK_COLUMN) {
  RefPtr<nsMsgDatabase> mdb;
  nsCOMPtr<nsIMdbRow> mdbRow;

  if (aHdr && (mdbRow = aHdr->GetMDBRow()) && (m_hdr = aHdr) &&
      (mdb = aHdr->GetMdb()) && (m_mdbEnv = mdb->m_mdbEnv) &&
      (m_mdbStore = mdb->m_mdbStore)) {
    mdbRow->GetRowCellCursor(m_mdbEnv, -1, getter_AddRefs(mRowCellCursor));
  }
}

nsMsgPropertyEnumerator::~nsMsgPropertyEnumerator() {
  // Need to clear this before the nsMsgHdr and its corresponding
  // nsIMdbRow potentially go away.
  mRowCellCursor = nullptr;
}

NS_IMPL_ISUPPORTS(nsMsgPropertyEnumerator, nsIUTF8StringEnumerator,
                  nsIStringEnumerator)

NS_IMETHODIMP nsMsgPropertyEnumerator::GetNext(nsACString& aItem) {
  PrefetchNext();
  if (mNextColumn == NULL_MORK_COLUMN)
    return NS_ERROR_FAILURE;  // call HasMore first
  if (!m_mdbStore || !m_mdbEnv) return NS_ERROR_NOT_INITIALIZED;
  mNextPrefetched = false;
  char columnName[100];
  struct mdbYarn colYarn = {columnName, 0, sizeof(columnName), 0, 0, nullptr};
  // Get the column of the cell
  nsresult rv = m_mdbStore->TokenToString(m_mdbEnv, mNextColumn, &colYarn);
  NS_ENSURE_SUCCESS(rv, rv);

  aItem.Assign(static_cast<char*>(colYarn.mYarn_Buf), colYarn.mYarn_Fill);
  return NS_OK;
}

NS_IMETHODIMP nsMsgPropertyEnumerator::HasMore(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);

  PrefetchNext();
  *aResult = (mNextColumn != NULL_MORK_COLUMN);
  return NS_OK;
}

void nsMsgPropertyEnumerator::PrefetchNext(void) {
  if (!mNextPrefetched && m_mdbEnv && mRowCellCursor) {
    mNextPrefetched = true;
    nsCOMPtr<nsIMdbCell> cell;
    mRowCellCursor->NextCell(m_mdbEnv, getter_AddRefs(cell), &mNextColumn,
                             nullptr);
    if (mNextColumn == NULL_MORK_COLUMN) {
      // free up references
      m_mdbStore = nullptr;
      m_mdbEnv = nullptr;
      mRowCellCursor = nullptr;
    }
  }
}

////////////////////////////////////////////////////////////////////////////////

NS_IMETHODIMP nsMsgHdr::GetProperties(nsTArray<nsCString>& headers) {
  nsCOMPtr<nsIUTF8StringEnumerator> propertyEnumerator =
      new nsMsgPropertyEnumerator(this);
  bool hasMore;
  while (NS_SUCCEEDED(propertyEnumerator->HasMore(&hasMore)) && hasMore) {
    nsAutoCString property;
    propertyEnumerator->GetNext(property);
    headers.AppendElement(property);
  }
  return NS_OK;
}

NS_IMETHODIMP nsMsgHdr::GetUidOnServer(uint32_t* result) {
  uint32_t uid;
  nsresult rv = GetUInt32Column(m_mdb->m_uidOnServerColumnToken, &uid);
  *result = uid;
  return rv;
}

NS_IMETHODIMP nsMsgHdr::SetUidOnServer(uint32_t uid) {
  return SetUInt32Column(uid, m_mdb->m_uidOnServerColumnToken);
}

NS_IMETHODIMP nsMsgHdr::GetIsLive(bool* isLive) {
  // If it's attached to the messages table, it's live.
  bool found = false;
  nsresult rv = m_mdb->ContainsKey(m_messageKey, &found);
  NS_ENSURE_SUCCESS(rv, rv);
  *isLive = found;
  return NS_OK;
}
