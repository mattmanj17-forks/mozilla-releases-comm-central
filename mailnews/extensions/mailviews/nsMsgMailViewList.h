/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_EXTENSIONS_MAILVIEWS_NSMSGMAILVIEWLIST_H_
#define COMM_MAILNEWS_EXTENSIONS_MAILVIEWS_NSMSGMAILVIEWLIST_H_

#include "nscore.h"
#include "nsIMsgMailViewList.h"
#include "nsCOMPtr.h"
#include "nsCOMArray.h"
#include "nsIStringBundle.h"
#include "nsString.h"
#include "nsIMsgFilterList.h"

// a mail View is just a name and an array of search terms
class nsMsgMailView : public nsIMsgMailView {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGMAILVIEW

  nsMsgMailView();

 protected:
  virtual ~nsMsgMailView();
  nsString mName;
  nsCOMPtr<nsIStringBundle> mBundle;
  nsTArray<RefPtr<nsIMsgSearchTerm>> mViewSearchTerms;
};

class nsMsgMailViewList : public nsIMsgMailViewList {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGMAILVIEWLIST

  nsMsgMailViewList();

 protected:
  virtual ~nsMsgMailViewList();
  nsresult
  LoadMailViews();  // reads in user defined mail views from our default file
  nsresult ConvertFilterListToMailViews();
  nsresult ConvertMailViewListToFilterList();

  nsCOMArray<nsIMsgMailView> m_mailViews;
  nsCOMPtr<nsIMsgFilterList>
      mFilterList;  // our internal filter list representation
};

#endif  // COMM_MAILNEWS_EXTENSIONS_MAILVIEWS_NSMSGMAILVIEWLIST_H_
