/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_SEARCH_SRC_NSMSGFILTERLIST_H_
#define COMM_MAILNEWS_SEARCH_SRC_NSMSGFILTERLIST_H_

#include "nscore.h"
#include "nsIMsgFolder.h"
#include "nsIMsgFilterList.h"
#include "nsCOMPtr.h"
#include "nsTArray.h"
#include "nsIFile.h"
#include "nsIOutputStream.h"

const int16_t kFileVersion = 9;
const int16_t kManualContextVersion = 9;
const int16_t k60Beta1Version = 7;
const int16_t k45Version = 6;

////////////////////////////////////////////////////////////////////////////////////////
// The Msg Filter List is an interface designed to make accessing filter lists
// easier. Clients typically open a filter list and either enumerate the
// filters, or add new filters, or change the order around...
//
////////////////////////////////////////////////////////////////////////////////////////

class nsIMsgFilter;
class nsMsgFilter;

class nsMsgFilterList : public nsIMsgFilterList {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGFILTERLIST

  nsMsgFilterList();

  nsresult Close();
  nsresult LoadTextFilters(already_AddRefed<nsIInputStream> aStream);

  bool m_temporaryList;

 protected:
  virtual ~nsMsgFilterList();

  nsresult ComputeArbitraryHeaders();
  nsresult SaveTextFilters(nsIOutputStream* aStream);
  // file streaming methods
  int ReadChar(nsIInputStream* aStream);
  int SkipWhitespace(nsIInputStream* aStream);
  bool StrToBool(nsCString& str);
  int LoadAttrib(nsMsgFilterFileAttribValue& attrib, nsIInputStream* aStream);
  const char* GetStringForAttrib(nsMsgFilterFileAttribValue attrib);
  nsresult LoadValue(nsCString& value, nsIInputStream* aStream);
  int16_t m_fileVersion;
  bool m_loggingEnabled;
  bool m_startWritingToBuffer;  // tells us when to start writing one whole
                                // filter to m_unparsedBuffer
  nsCOMPtr<nsIMsgFolder> m_folder;
  nsMsgFilter* m_curFilter;  // filter we're filing in or out(?)
  nsCString m_listId;
  nsTArray<nsCOMPtr<nsIMsgFilter> > m_filters;
  nsCString m_arbitraryHeaders;
  nsCOMPtr<nsIFile> m_defaultFile;
  nsCString m_unparsedFilterBuffer;  // holds one entire filter unparsed

 private:
  nsresult GetLogFile(nsIFile** aFile);
  nsresult EnsureLogFile(nsIFile* file);
  nsCOMPtr<nsIOutputStream> m_logStream;
};

#endif  // COMM_MAILNEWS_SEARCH_SRC_NSMSGFILTERLIST_H_
