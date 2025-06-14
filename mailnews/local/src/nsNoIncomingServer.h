/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_LOCAL_SRC_NSNOINCOMINGSERVER_H_
#define COMM_MAILNEWS_LOCAL_SRC_NSNOINCOMINGSERVER_H_

#include "nsINoIncomingServer.h"
#include "nsILocalMailIncomingServer.h"
#include "nsMailboxServer.h"

/* get some implementation from nsMsgIncomingServer */
class nsNoIncomingServer : public nsMailboxServer,
                           public nsINoIncomingServer,
                           public nsILocalMailIncomingServer

{
 public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_NSINOINCOMINGSERVER
  NS_DECL_NSILOCALMAILINCOMINGSERVER

  nsNoIncomingServer();

#ifdef MOZ_PANORAMA
  nsresult CreateRootFolder() override;
#endif  // MOZ_PANORAMA
  NS_IMETHOD GetLocalStoreType(nsACString& type) override;
  NS_IMETHOD GetLocalDatabaseType(nsACString& type) override;
  NS_IMETHOD GetCanSearchMessages(bool* canSearchMessages) override;
  NS_IMETHOD GetServerRequiresPasswordForBiff(
      bool* aServerRequiresPasswordForBiff) override;
  NS_IMETHOD GetAccountManagerChrome(nsAString& aResult) override;

 private:
  virtual ~nsNoIncomingServer();
};

#endif  // COMM_MAILNEWS_LOCAL_SRC_NSNOINCOMINGSERVER_H_
