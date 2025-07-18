/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_NSMSGPROGRESS_H_
#define COMM_MAILNEWS_BASE_SRC_NSMSGPROGRESS_H_

#include "nsIMsgProgress.h"
#include "nsCOMArray.h"
#include "nsIMsgStatusFeedback.h"
#include "nsString.h"
#include "nsIMsgWindow.h"
#include "nsIProgressEventSink.h"
#include "nsWeakReference.h"

class nsMsgProgress : public nsIMsgProgress,
                      public nsIMsgStatusFeedback,
                      public nsIProgressEventSink,
                      public nsSupportsWeakReference {
 public:
  nsMsgProgress();

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIMSGPROGRESS
  NS_DECL_NSIWEBPROGRESSLISTENER
  NS_DECL_NSIMSGSTATUSFEEDBACK
  NS_DECL_NSIPROGRESSEVENTSINK

 private:
  virtual ~nsMsgProgress();
  nsresult ReleaseListeners(void);

  bool m_closeProgress;
  bool m_processCanceled;
  nsString m_pendingStatus;
  int32_t m_pendingStateFlags;
  nsresult m_pendingStateValue;
  nsWeakPtr m_msgWindow;
  nsCOMArray<nsIWebProgressListener> m_listenerList;
};

#endif  // COMM_MAILNEWS_BASE_SRC_NSMSGPROGRESS_H_
