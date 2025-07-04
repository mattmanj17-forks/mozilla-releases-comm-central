/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_MIME_SRC_NSSTREAMCONVERTER_H_
#define COMM_MAILNEWS_MIME_SRC_NSSTREAMCONVERTER_H_

#include "nsIStreamConverter.h"
#include "nsIMimeStreamConverter.h"
#include "nsIMimeEmitter.h"
#include "nsIURI.h"
#include "nsIAsyncInputStream.h"
#include "nsIAsyncOutputStream.h"
#include "nsIChannel.h"
#include "nsString.h"
#include "nsCOMPtr.h"

#define MIME_FORWARD_HTML_PREFIX "<HTML><BODY><BR><BR>"

class nsStreamConverter : public nsIStreamConverter,
                          public nsIMimeStreamConverter {
 public:
  nsStreamConverter();

  NS_DECL_THREADSAFE_ISUPPORTS

  // nsIMimeStreamConverter support
  NS_DECL_NSIMIMESTREAMCONVERTER
  // nsIStreamConverter methods
  NS_DECL_NSISTREAMCONVERTER
  // nsIStreamListener methods
  NS_DECL_NSISTREAMLISTENER

  // nsIRequestObserver methods
  NS_DECL_NSIREQUESTOBSERVER

  // nsIThreadRetargetableStreamListener methods
  NS_DECL_NSITHREADRETARGETABLESTREAMLISTENER

  ////////////////////////////////////////////////////////////////////////////
  // nsStreamConverter specific methods:
  ////////////////////////////////////////////////////////////////////////////
  NS_IMETHOD Init(nsIURI* aURI, nsIStreamListener* aOutListener,
                  nsIChannel* aChannel);
  NS_IMETHOD GetContentType(char** aOutputContentType);
  NS_IMETHOD InternalCleanup(void);
  NS_IMETHOD DetermineOutputFormat(const char* url, nsMimeOutputType* newType);
  NS_IMETHOD FirePendingStartRequest(void);

 private:
  virtual ~nsStreamConverter();
  nsresult Close();

  // the input and output streams form a pipe...they need to be passed around
  // together..
  nsCOMPtr<nsIAsyncOutputStream> mOutputStream;  // output stream
  nsCOMPtr<nsIAsyncInputStream> mInputStream;

  nsCOMPtr<nsIStreamListener> mOutListener;  // output stream listener
  nsCOMPtr<nsIChannel> mOutgoingChannel;

  nsCOMPtr<nsIMimeEmitter> mEmitter;  // emitter being used...
  nsCOMPtr<nsIURI> mURI;              // URI being processed
  nsMimeOutputType mOutputType;       // the output type we should use for the
                                      // operation
  bool mAlreadyKnowOutputType;

  void* mBridgeStream;  // internal libmime data stream

  // Type of output, entire message, header only, body only
  nsCString mOutputFormat;
  nsCString mRealContentType;  // if we know the content type for real, this
                               // will be set (used by attachments)

  nsCString
      mOverrideFormat;  // this is a possible override for emitter creation

  nsCOMPtr<nsIMimeStreamConverterListener> mMimeStreamConverterListener;
  bool mForwardInline;
  bool mForwardInlineFilter;
  bool mOverrideComposeFormat;
  nsString mForwardToAddress;
  nsCOMPtr<nsIMsgIdentity> mIdentity;
  nsCString mOriginalMsgURI;
  nsCOMPtr<nsIMsgDBHdr> mOrigMsgHdr;

  nsCString mFromType;
  nsCString mToType;
  nsIRequest* mPendingRequest;  // used when we need to delay to fire
                                // onStartRequest
};

#endif  // COMM_MAILNEWS_MIME_SRC_NSSTREAMCONVERTER_H_
