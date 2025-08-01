/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_SEARCH_SRC_NSMSGSEARCHSESSION_H_
#define COMM_MAILNEWS_SEARCH_SRC_NSMSGSEARCHSESSION_H_

#include "nscore.h"
#include "nsMsgSearchBoolExpression.h"
#include "nsMsgSearchCore.h"
#include "nsIMsgSearchSession.h"
#include "nsIUrlListener.h"
#include "nsITimer.h"
#include "nsWeakReference.h"

class nsMsgSearchAdapter;
class nsMsgSearchBoolExpression;
class nsMsgSearchScopeTerm;

class nsMsgSearchSession : public nsIMsgSearchSession,
                           public nsIUrlListener,
                           public nsSupportsWeakReference {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGSEARCHSESSION
  NS_DECL_NSIURLLISTENER

  nsMsgSearchSession();

 protected:
  virtual ~nsMsgSearchSession();

  nsWeakPtr m_msgWindowWeak;
  nsresult Initialize();
  nsresult StartTimer();
  nsresult TimeSlice(bool* aDone);
  nsMsgSearchScopeTerm* GetRunningScope();
  void StopRunning();
  nsresult BeginSearching();
  nsresult DoNextSearch();
  nsresult SearchWOUrls();
  nsresult GetNextUrl();
  nsresult NotifyListenersDone(nsresult status);
  void EnableFolderNotifications(bool aEnable);
  void ReleaseFolderDBRef();

  nsTArray<RefPtr<nsMsgSearchScopeTerm>> m_scopeList;
  nsTArray<RefPtr<nsIMsgSearchTerm>> m_termList;

  nsTArray<nsCOMPtr<nsIMsgSearchNotify>> m_listenerList;
  nsTArray<int32_t> m_listenerFlagList;
  /**
   * Iterator index for m_listenerList/m_listenerFlagList.  We used to use an
   * nsTObserverArray for m_listenerList but its auto-adjusting iterator was
   * not helping us keep our m_listenerFlagList iterator correct.
   *
   * We are making the simplifying assumption that our notifications are
   * non-reentrant.  In the exceptional case that it turns out they are
   * reentrant, we assume that this is the result of canceling a search while
   * the session is active and initiating a new one.  In that case, we assume
   * the outer iteration can safely be abandoned.
   *
   * This value is defined to be the index of the next listener we will process.
   * This allows us to use the sentinel value of -1 to convey that no iteration
   * is in progress (and the iteration process to abort if the value transitions
   * to -1, which we always set on conclusion of our loop).
   */
  int32_t m_iListener;

  bool m_searchRunning;

  void DestroyTermList();
  void DestroyScopeList();

  static void TimerCallback(nsITimer* aTimer, void* aClosure);
  // support for searching multiple scopes in serial
  nsresult TimeSliceSerial(bool* aDone);
  nsresult TimeSliceParallel();

  nsMsgSearchAttribValue m_sortAttribute;
  uint32_t m_idxRunningScope;
  bool m_handlingError;
  nsCString m_runningUrl;  // The url for the current search
  nsCOMPtr<nsITimer> m_backgroundTimer;
  bool m_searchPaused;
  nsMsgSearchBoolExpression* m_expressionTree;
};

#endif  // COMM_MAILNEWS_SEARCH_SRC_NSMSGSEARCHSESSION_H_
