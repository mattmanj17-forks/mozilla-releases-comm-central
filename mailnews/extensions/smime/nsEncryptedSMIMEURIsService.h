/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_EXTENSIONS_SMIME_NSENCRYPTEDSMIMEURISSERVICE_H_
#define COMM_MAILNEWS_EXTENSIONS_SMIME_NSENCRYPTEDSMIMEURISSERVICE_H_

#include "nsIEncryptedSMIMEURIsSrvc.h"
#include "nsTArray.h"
#include "nsString.h"

class nsEncryptedSMIMEURIsService : public nsIEncryptedSMIMEURIsService {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIENCRYPTEDSMIMEURISSERVICE

  nsEncryptedSMIMEURIsService();

 protected:
  virtual ~nsEncryptedSMIMEURIsService();
  nsTArray<nsCString> mEncryptedURIs;
};

#endif  // COMM_MAILNEWS_EXTENSIONS_SMIME_NSENCRYPTEDSMIMEURISSERVICE_H_
