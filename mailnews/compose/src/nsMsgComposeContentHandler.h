/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_COMPOSE_SRC_NSMSGCOMPOSECONTENTHANDLER_H_
#define COMM_MAILNEWS_COMPOSE_SRC_NSMSGCOMPOSECONTENTHANDLER_H_

#include "nsIContentHandler.h"
#include "nsIMsgIdentity.h"

class nsMsgComposeContentHandler : public nsIContentHandler {
 public:
  nsMsgComposeContentHandler();

  NS_DECL_ISUPPORTS
  NS_DECL_NSICONTENTHANDLER
 private:
  virtual ~nsMsgComposeContentHandler();
  nsresult GetBestIdentity(nsIInterfaceRequestor* aWindowContext,
                           nsIMsgIdentity** identity);
};

#endif  // COMM_MAILNEWS_COMPOSE_SRC_NSMSGCOMPOSECONTENTHANDLER_H_
