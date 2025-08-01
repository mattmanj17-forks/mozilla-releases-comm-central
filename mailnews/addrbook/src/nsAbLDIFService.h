/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_ADDRBOOK_SRC_NSABLDIFSERVICE_H_
#define COMM_MAILNEWS_ADDRBOOK_SRC_NSABLDIFSERVICE_H_

#include "nsIAbCard.h"
#include "nsIAbLDIFService.h"
#include "nsString.h"

class nsAbLDIFService : public nsIAbLDIFService {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIABLDIFSERVICE

  nsAbLDIFService();

 private:
  virtual ~nsAbLDIFService();
  nsresult str_parse_line(char* line, char** type, char** value,
                          int* vlen) const;
  char* str_getline(char** next) const;
  nsresult GetLdifStringRecord(char* buf, int32_t len, int32_t& stopPos);
  void AddLdifRowToDatabase(nsIAbDirectory* aDirectory, bool aIsList);
  void AddLdifColToDatabase(nsIAbDirectory* aDirectory, nsIAbCard* newCard,
                            nsCString colType, nsCString column, bool bIsList);
  void ClearLdifRecordBuffer();
  void SplitCRLFAddressField(nsCString& inputAddress, nsCString& outputLine1,
                             nsCString& outputLine2) const;

  bool mStoreLocAsHome;
  nsCString mLdifLine;
  int32_t mLFCount;
  int32_t mCRCount;
};

#endif  // COMM_MAILNEWS_ADDRBOOK_SRC_NSABLDIFSERVICE_H_
