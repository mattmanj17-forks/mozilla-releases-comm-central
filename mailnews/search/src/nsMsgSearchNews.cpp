/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "msgCore.h"
#include "nsMsgSearchAdapter.h"
#include "nsUnicharUtils.h"
#include "nsMsgSearchScopeTerm.h"
#include "nsIMsgHdr.h"
#include "nsMsgSearchNews.h"
#include "nsIDBFolderInfo.h"
#include "prprf.h"
#include "nsIMsgDatabase.h"
#include "nsMsgUtils.h"
#include <ctype.h>

// Implementation of search for IMAP mail folders

// Implementation of search for newsgroups

//-----------------------------------------------------------------------------
//----------- Adapter class for searching XPAT-capable news servers -----------
//-----------------------------------------------------------------------------

const char* nsMsgSearchNews::m_kNntpFrom = "FROM ";
const char* nsMsgSearchNews::m_kNntpSubject = "SUBJECT ";
const char* nsMsgSearchNews::m_kTermSeparator = "/";

nsMsgSearchNews::nsMsgSearchNews(
    nsMsgSearchScopeTerm* scope,
    nsTArray<RefPtr<nsIMsgSearchTerm>> const& termList)
    : nsMsgSearchAdapter(scope, termList) {
  m_searchType = ST_UNINITIALIZED;
}

nsMsgSearchNews::~nsMsgSearchNews() {}

nsresult nsMsgSearchNews::ValidateTerms() {
  nsresult err = nsMsgSearchAdapter::ValidateTerms();
  if (NS_OK == err) {
    err = Encode(&m_encoding);
  }

  return err;
}

nsresult nsMsgSearchNews::Search(bool* aDone) {
  // the state machine runs in the news: handler
  nsresult err = NS_ERROR_NOT_IMPLEMENTED;
  return err;
}

char16_t* nsMsgSearchNews::EncodeToWildmat(const char16_t* value) {
  // Here we take advantage of XPAT's use of the wildmat format, which allows
  // a case-insensitive match by specifying each case possibility for each
  // character So, "FooBar" is encoded as "[Ff][Oo][Bb][Aa][Rr]"

  char16_t* caseInsensitiveValue =
      (char16_t*)moz_xmalloc(sizeof(char16_t) * ((4 * NS_strlen(value)) + 1));
  if (caseInsensitiveValue) {
    char16_t* walkValue = caseInsensitiveValue;
    while (*value) {
      if (isalpha(*value)) {
        *walkValue++ = (char16_t)'[';
        *walkValue++ = ToUpperCase((char16_t)*value);
        *walkValue++ = ToLowerCase((char16_t)*value);
        *walkValue++ = (char16_t)']';
      } else
        *walkValue++ = *value;
      value++;
    }
    *walkValue = 0;
  }
  return caseInsensitiveValue;
}

char* nsMsgSearchNews::EncodeTerm(nsIMsgSearchTerm* term) {
  // Develop an XPAT-style encoding for the search term

  NS_ASSERTION(term, "null term");
  if (!term) return nullptr;

  // Find a string to represent the attribute
  const char* attribEncoding = nullptr;
  nsMsgSearchAttribValue attrib;

  term->GetAttrib(&attrib);

  switch (attrib) {
    case nsMsgSearchAttrib::Sender:
      attribEncoding = m_kNntpFrom;
      break;
    case nsMsgSearchAttrib::Subject:
      attribEncoding = m_kNntpSubject;
      break;
    default:
      nsCString header;
      term->GetArbitraryHeader(header);
      if (header.IsEmpty()) {
        NS_ASSERTION(false, "malformed search");  // malformed search term?
        return nullptr;
      }
      attribEncoding = header.get();
  }

  // Build a string to represent the string pattern
  bool leadingStar = false;
  bool trailingStar = false;
  nsMsgSearchOpValue op;
  term->GetOp(&op);

  switch (op) {
    case nsMsgSearchOp::Contains:
      leadingStar = true;
      trailingStar = true;
      break;
    case nsMsgSearchOp::Is:
      break;
    case nsMsgSearchOp::BeginsWith:
      trailingStar = true;
      break;
    case nsMsgSearchOp::EndsWith:
      leadingStar = true;
      break;
    default:
      NS_ASSERTION(false, "malformed search");  // malformed search term?
      return nullptr;
  }

  nsCOMPtr<nsIMsgSearchValue> searchValue;

  nsresult rv = term->GetValue(getter_AddRefs(searchValue));
  if (NS_FAILED(rv) || !searchValue) return nullptr;

  nsString intlNonRFC1522Value;
  rv = searchValue->GetStr(intlNonRFC1522Value);
  if (NS_FAILED(rv) || intlNonRFC1522Value.IsEmpty()) return nullptr;

  char16_t* caseInsensitiveValue = EncodeToWildmat(intlNonRFC1522Value.get());
  if (!caseInsensitiveValue) return nullptr;

  nsAutoCString pattern;

  if (leadingStar) pattern.Append('*');
  pattern.Append(NS_ConvertUTF16toUTF8(caseInsensitiveValue));
  free(caseInsensitiveValue);
  if (trailingStar) pattern.Append('*');

  // Combine the XPAT command syntax with the attribute and the pattern to
  // form the term encoding
  const char xpatTemplate[] = "XPAT %s 1- %s";
  int termLength = (sizeof(xpatTemplate) - 1) + strlen(attribEncoding) +
                   pattern.Length() + 1;
  char* termEncoding = new char[termLength];
  PR_snprintf(termEncoding, termLength, xpatTemplate, attribEncoding,
              pattern.get());

  nsAutoCString escapedTerm;
  MsgEscapeString(nsDependentCString(termEncoding), nsINetUtil::ESCAPE_XALPHAS,
                  escapedTerm);
  return ToNewCString(escapedTerm);
}

nsresult nsMsgSearchNews::GetEncoding(char** result) {
  NS_ENSURE_ARG(result);
  *result = ToNewCString(m_encoding);
  return (*result) ? NS_OK : NS_ERROR_OUT_OF_MEMORY;
}

nsresult nsMsgSearchNews::Encode(nsCString* outEncoding) {
  NS_ASSERTION(outEncoding, "no out encoding");
  if (!outEncoding) return NS_ERROR_NULL_POINTER;

  nsresult err = NS_OK;

  uint32_t numTerms = m_searchTerms.Length();

  char** intermediateEncodings = new char*[numTerms];
  if (intermediateEncodings) {
    // Build an XPAT command for each term
    int encodingLength = 0;
    for (uint32_t i = 0; i < numTerms; i++) {
      nsIMsgSearchTerm* pTerm = m_searchTerms[i];
      // set boolean OR term if any of the search terms are an OR...this only
      // works if we are using homogeneous boolean operators.
      bool isBooleanOpAnd;
      pTerm->GetBooleanAnd(&isBooleanOpAnd);
      m_searchType = isBooleanOpAnd ? ST_AND_SEARCH : ST_OR_SEARCH;

      intermediateEncodings[i] = EncodeTerm(pTerm);
      if (intermediateEncodings[i])
        encodingLength +=
            strlen(intermediateEncodings[i]) + strlen(m_kTermSeparator);
    }
    encodingLength += strlen("?search");
    // Combine all the term encodings into one big encoding
    char* encoding = new char[encodingLength + 1];
    if (encoding) {
      PL_strcpy(encoding, "?search");

      for (uint32_t i = 0; i < numTerms; i++) {
        if (intermediateEncodings[i]) {
          PL_strcat(encoding, m_kTermSeparator);
          PL_strcat(encoding, intermediateEncodings[i]);
          delete[] intermediateEncodings[i];
        }
      }
      *outEncoding = encoding;
    } else
      err = NS_ERROR_OUT_OF_MEMORY;
  } else
    err = NS_ERROR_OUT_OF_MEMORY;
  delete[] intermediateEncodings;

  return err;
}

NS_IMETHODIMP nsMsgSearchNews::AddHit(nsMsgKey key) {
  m_candidateHits.AppendElement(key);
  return NS_OK;
}

/* void CurrentUrlDone (in nsresult exitCode); */
NS_IMETHODIMP nsMsgSearchNews::CurrentUrlDone(nsresult exitCode) {
  CollateHits();
  ReportHits();
  return NS_OK;
}

void nsMsgSearchNews::CollateHits() {
  // Since the XPAT commands are processed one at a time, the result set for the
  // entire query is the intersection of results for each XPAT command if an AND
  // search, otherwise we want the union of all the search hits (minus the
  // duplicates of course).

  uint32_t size = m_candidateHits.Length();
  if (!size) return;

  // Sort the article numbers first, so it's easy to tell how many hits
  // on a given article we got
  m_candidateHits.Sort();

  // For an OR search we only need to count the first occurrence of a candidate.
  uint32_t termCount = 1;
  MOZ_ASSERT(m_searchType != ST_UNINITIALIZED,
             "m_searchType accessed without being set");
  if (m_searchType == ST_AND_SEARCH) {
    // We have a traditional AND search which must be collated. In order to
    // get promoted into the hits list, a candidate article number must appear
    // in the results of each XPAT command. So if we fire 3 XPAT commands (one
    // per search term), the article number must appear 3 times. If it appears
    // fewer than 3 times, it matched some search terms, but not all.
    termCount = m_searchTerms.Length();
  }
  uint32_t candidateCount = 0;
  uint32_t candidate = m_candidateHits[0];
  for (uint32_t index = 0; index < size; ++index) {
    uint32_t possibleCandidate = m_candidateHits[index];
    if (candidate == possibleCandidate) {
      ++candidateCount;
    } else {
      candidateCount = 1;
      candidate = possibleCandidate;
    }
    if (candidateCount == termCount) m_hits.AppendElement(candidate);
  }
}

void nsMsgSearchNews::ReportHits() {
  nsCOMPtr<nsIMsgDatabase> db;
  nsCOMPtr<nsIDBFolderInfo> folderInfo;
  nsCOMPtr<nsIMsgFolder> scopeFolder;

  nsresult err = m_scope->GetFolder(getter_AddRefs(scopeFolder));
  if (NS_SUCCEEDED(err) && scopeFolder) {
    err = scopeFolder->GetDBFolderInfoAndDB(getter_AddRefs(folderInfo),
                                            getter_AddRefs(db));
  }

  if (db) {
    uint32_t size = m_hits.Length();
    for (uint32_t i = 0; i < size; ++i) {
      nsCOMPtr<nsIMsgDBHdr> header;

      db->GetMsgHdrForKey(m_hits.ElementAt(i), getter_AddRefs(header));
      if (header) ReportHit(header, scopeFolder);
    }
  }
}

// ### this should take an nsIMsgFolder instead of a string location.
void nsMsgSearchNews::ReportHit(nsIMsgDBHdr* pHeaders, nsIMsgFolder* folder) {
  // this is totally filched from msg_SearchOfflineMail until I decide whether
  // the right thing is to get them from the db or from NNTP
  nsCOMPtr<nsIMsgSearchSession> session;
  nsCOMPtr<nsIMsgFolder> scopeFolder;
  m_scope->GetFolder(getter_AddRefs(scopeFolder));
  m_scope->GetSearchSession(getter_AddRefs(session));
  if (session) session->AddSearchHit(pHeaders, scopeFolder);
}

nsresult nsMsgSearchValidityManager::InitNewsTable() {
  NS_ASSERTION(nullptr == m_newsTable, "don't call this twice!");
  nsresult rv = NewTable(getter_AddRefs(m_newsTable));

  if (NS_SUCCEEDED(rv)) {
    // clang-format off
    m_newsTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::Contains, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::Contains, 1);
    m_newsTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::Is, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::Is, 1);
    m_newsTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::BeginsWith, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::BeginsWith, 1);
    m_newsTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::EndsWith, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::EndsWith, 1);

    m_newsTable->SetAvailable(nsMsgSearchAttrib::Subject, nsMsgSearchOp::Contains, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::Subject, nsMsgSearchOp::Contains, 1);
    m_newsTable->SetAvailable(nsMsgSearchAttrib::Subject, nsMsgSearchOp::Is, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::Subject, nsMsgSearchOp::Is, 1);
    m_newsTable->SetAvailable(nsMsgSearchAttrib::Subject, nsMsgSearchOp::BeginsWith, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::Subject, nsMsgSearchOp::BeginsWith, 1);
    m_newsTable->SetAvailable(nsMsgSearchAttrib::Subject, nsMsgSearchOp::EndsWith, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::Subject, nsMsgSearchOp::EndsWith, 1);

#if 0
    // Size should be handled after the fact...
    m_newsTable->SetAvailable(nsMsgSearchAttrib::Size, nsMsgSearchOp::IsGreaterThan, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::Size, nsMsgSearchOp::IsGreaterThan, 1);
    m_newsTable->SetAvailable(nsMsgSearchAttrib::Size, nsMsgSearchOp::IsLessThan, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::Size, nsMsgSearchOp::IsLessThan, 1);
#endif
    m_newsTable->SetAvailable(nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::Contains, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::Contains, 1);
    m_newsTable->SetAvailable(nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::Is, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::Is, 1);
    m_newsTable->SetAvailable(nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::BeginsWith, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::BeginsWith, 1);
    m_newsTable->SetAvailable(nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::EndsWith, 1);
    m_newsTable->SetEnabled  (nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::EndsWith, 1);
    // clang-format on
  }

  return rv;
}

nsresult nsMsgSearchValidityManager::InitNewsFilterTable() {
  NS_ASSERTION(nullptr == m_newsFilterTable,
               "news filter table already initted");
  nsresult rv = NewTable(getter_AddRefs(m_newsFilterTable));

  if (NS_SUCCEEDED(rv)) {
    // clang-format off
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::Contains, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::Contains, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::DoesntContain, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::DoesntContain, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::Is, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::Is, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::Isnt, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::Isnt, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::BeginsWith, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::BeginsWith, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::EndsWith, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::EndsWith, 1);

    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::IsInAB, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::IsInAB, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Sender, nsMsgSearchOp::IsntInAB, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Sender, nsMsgSearchOp::IsntInAB, 1);

    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Subject, nsMsgSearchOp::Contains, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Subject, nsMsgSearchOp::Contains, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Subject, nsMsgSearchOp::DoesntContain, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Subject, nsMsgSearchOp::DoesntContain, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Subject, nsMsgSearchOp::Is, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Subject, nsMsgSearchOp::Is, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Subject, nsMsgSearchOp::Isnt, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Subject, nsMsgSearchOp::Isnt, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Subject, nsMsgSearchOp::BeginsWith, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Subject, nsMsgSearchOp::BeginsWith, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Subject, nsMsgSearchOp::EndsWith, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Subject, nsMsgSearchOp::EndsWith, 1);

    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Date, nsMsgSearchOp::IsBefore, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Date, nsMsgSearchOp::IsBefore, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Date, nsMsgSearchOp::IsAfter, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Date, nsMsgSearchOp::IsAfter, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Date, nsMsgSearchOp::Is, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Date, nsMsgSearchOp::Is, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Date, nsMsgSearchOp::Isnt, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Date, nsMsgSearchOp::Isnt, 1);

    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Size, nsMsgSearchOp::IsGreaterThan, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Size, nsMsgSearchOp::IsGreaterThan, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::Size, nsMsgSearchOp::IsLessThan, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::Size, nsMsgSearchOp::IsLessThan, 1);

    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::Contains, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::Contains, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::DoesntContain, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::DoesntContain, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::Is, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::Is, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::Isnt, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::Isnt, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::BeginsWith, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::BeginsWith, 1);
    m_newsFilterTable->SetAvailable(nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::EndsWith, 1);
    m_newsFilterTable->SetEnabled  (nsMsgSearchAttrib::OtherHeader, nsMsgSearchOp::EndsWith, 1);
    // clang-format on
  }

  return rv;
}
