/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_NEWS_SRC_NSNEWSDOWNLOADDIALOGARGS_H_
#define COMM_MAILNEWS_NEWS_SRC_NSNEWSDOWNLOADDIALOGARGS_H_

#include "nsINewsDownloadDialogArgs.h"
#include "nsString.h"

class nsNewsDownloadDialogArgs : public nsINewsDownloadDialogArgs {
 public:
  nsNewsDownloadDialogArgs();

  NS_DECL_ISUPPORTS
  NS_DECL_NSINEWSDOWNLOADDIALOGARGS

 private:
  virtual ~nsNewsDownloadDialogArgs();

  nsString mGroupName;
  int32_t mArticleCount;
  nsCString mServerKey;
  bool mHitOK;
  bool mDownloadAll;
};

#endif  // COMM_MAILNEWS_NEWS_SRC_NSNEWSDOWNLOADDIALOGARGS_H_
