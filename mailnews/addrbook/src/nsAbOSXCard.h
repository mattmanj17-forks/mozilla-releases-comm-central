/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_ADDRBOOK_SRC_NSABOSXCARD_H_
#define COMM_MAILNEWS_ADDRBOOK_SRC_NSABOSXCARD_H_

#include "nsAbCardProperty.h"

#define NS_ABOSXCARD_URI_PREFIX "moz-abosxcard://"

#define NS_IABOSXCARD_IID \
  {0xa7e5b697, 0x772d, 0x4fb5, {0x81, 0x16, 0x23, 0xb7, 0x5a, 0xac, 0x94, 0x56}}

class nsIAbOSXCard : public nsISupports {
 public:
  NS_INLINE_DECL_STATIC_IID(NS_IABOSXCARD_IID)

  virtual nsresult Init(const char* aUri) = 0;
  virtual nsresult Update(bool aNotify) = 0;
  virtual nsresult GetURI(nsACString& aURI) = 0;
};

class nsAbOSXCard : public nsAbCardProperty, public nsIAbOSXCard {
 public:
  NS_DECL_ISUPPORTS_INHERITED

  nsresult Update(bool aNotify) override;
  nsresult GetURI(nsACString& aURI) override;
  nsresult Init(const char* aUri) override;
  NS_IMETHOD GetUID(nsACString& uid) override;
  NS_IMETHOD SetUID(const nsACString& aUID) override;
  // this is needed so nsAbOSXUtils.mm can get at nsAbCardProperty
  friend class nsAbOSXUtils;

 private:
  nsCString mURI;
  nsCString mUID;

  virtual ~nsAbOSXCard() {}
};

#endif  // COMM_MAILNEWS_ADDRBOOK_SRC_NSABOSXCARD_H_
