/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_COMPOSE_SRC_NSMSGATTACHMENT_H_
#define COMM_MAILNEWS_COMPOSE_SRC_NSMSGATTACHMENT_H_

#include "nsIMsgAttachment.h"
#include "nsString.h"

class nsMsgAttachment : public nsIMsgAttachment {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGATTACHMENT

  nsMsgAttachment();

 private:
  virtual ~nsMsgAttachment();
  nsresult DeleteAttachment();

  nsCString mName;
  nsCString mUrl;
  nsCString mMsgUri;
  nsCString mUrlCharset;
  bool mTemporary;
  bool mSendViaCloud;
  nsCString mCloudFileAccountKey;
  nsCString mCloudPartHeaderData;
  nsCString mContentLocation;
  nsCString mContentType;
  nsCString mContentTypeParam;
  nsCString mContentId;
  nsCString mCharset;
  nsCString mMacType;
  nsCString mMacCreator;
  nsCString mHtmlAnnotation;
  int64_t mSize;
};

#endif  // COMM_MAILNEWS_COMPOSE_SRC_NSMSGATTACHMENT_H_
