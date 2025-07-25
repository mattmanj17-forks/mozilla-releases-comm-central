/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_COMPOSE_SRC_NSMSGQUOTE_H_
#define COMM_MAILNEWS_COMPOSE_SRC_NSMSGQUOTE_H_

#include "nsIMsgQuote.h"
#include "nsIMimeStreamConverter.h"
#include "nsIChannel.h"
#include "nsCOMPtr.h"
#include "nsWeakReference.h"

class nsMsgQuote;

class nsMsgQuoteListener : public nsIMsgQuoteListener {
 public:
  nsMsgQuoteListener();

  NS_DECL_THREADSAFE_ISUPPORTS

  // nsIMimeStreamConverterListener support
  NS_DECL_NSIMIMESTREAMCONVERTERLISTENER
  NS_DECL_NSIMSGQUOTELISTENER

 private:
  virtual ~nsMsgQuoteListener();
  nsWeakPtr mMsgQuote;
};

class nsMsgQuote : public nsIMsgQuote, public nsSupportsWeakReference {
 public:
  nsMsgQuote();

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIMSGQUOTE

 private:
  virtual ~nsMsgQuote();
  //
  // Implementation data...
  //
  nsWeakPtr mStreamListener;
  bool mQuoteHeaders;
  nsCOMPtr<nsIMsgQuoteListener> mQuoteListener;
  nsCOMPtr<nsIChannel> mQuoteChannel;
};

#endif  // COMM_MAILNEWS_COMPOSE_SRC_NSMSGQUOTE_H_
