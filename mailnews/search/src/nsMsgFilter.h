/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_SEARCH_SRC_NSMSGFILTER_H_
#define COMM_MAILNEWS_SEARCH_SRC_NSMSGFILTER_H_

#include "nscore.h"
#include "nsCOMPtr.h"
#include "nsISupports.h"
#include "nsIMsgFilter.h"
#include "nsIMsgSearchScopeTerm.h"
#include "nsMsgSearchBoolExpression.h"
#include "nsIMsgFilterCustomAction.h"

class nsMsgRuleAction : public nsIMsgRuleAction {
 public:
  NS_DECL_ISUPPORTS

  nsMsgRuleAction();

  NS_DECL_NSIMSGRULEACTION

 private:
  virtual ~nsMsgRuleAction();

  nsMsgRuleActionType m_type;
  // this used to be a union - why bother?
  nsMsgPriorityValue m_priority; /* priority to set rule to */
  nsCString m_folderUri;
  int32_t m_junkScore; /* junk score (or arbitrary int value?) */
  // arbitrary string value. Currently, email address to forward to
  nsCString m_strValue;
  nsCString m_customId;
  nsCOMPtr<nsIMsgFilterCustomAction> m_customAction;
};

class nsMsgFilter : public nsIMsgFilter {
 public:
  NS_DECL_ISUPPORTS

  nsMsgFilter();

  NS_DECL_NSIMSGFILTER

  nsMsgFilterTypeType GetType() { return m_type; }
  void SetType(nsMsgFilterTypeType type) { m_type = type; }
  bool GetEnabled() { return m_enabled; }
  void SetFilterScript(nsCString* filterName);

  bool IsScript() {
    return (m_type & (nsMsgFilterType::InboxJavaScript |
                      nsMsgFilterType::NewsJavaScript)) != 0;
  }

  // filing routines.
  nsresult SaveRule(nsIOutputStream* aStream);

  int16_t GetVersion();
#ifdef DEBUG
  void Dump();
#endif

  nsresult ConvertMoveOrCopyToFolderValue(nsIMsgRuleAction* filterAction,
                                          nsCString& relativePath);
  static const char* GetActionStr(nsMsgRuleActionType action);
  static nsresult GetActionFilingStr(nsMsgRuleActionType action,
                                     nsCString& actionStr);
  static nsMsgRuleActionType GetActionForFilingStr(nsCString& actionStr);

 protected:
  /*
   * Reporting function for filtering success/failure.
   * Logging has to be enabled for the message to appear.
   */
  nsresult LogRuleHitGeneric(nsIMsgRuleAction* aFilterAction,
                             nsIMsgDBHdr* aMsgHdr, nsresult aRcode,
                             const nsACString& aErrmsg);

  virtual ~nsMsgFilter();

  nsMsgFilterTypeType m_type;
  nsString m_filterName;
  nsCString m_scriptFileName;  // iff this filter is a script.
  nsCString m_description;
  nsCString m_unparsedBuffer;

  bool m_enabled;
  bool m_temporary;
  bool m_unparseable;
  nsIMsgFilterList* m_filterList;                /* owning filter list */
  nsTArray<RefPtr<nsIMsgSearchTerm>> m_termList; /* criteria terms */
  nsCOMPtr<nsIMsgSearchScopeTerm>
      m_scope; /* default for mail rules is inbox, but news rules could
              have a newsgroup - LDAP would be invalid */
  nsTArray<nsCOMPtr<nsIMsgRuleAction>> m_actionList;
  nsMsgSearchBoolExpression* m_expressionTree;
};

#endif  // COMM_MAILNEWS_SEARCH_SRC_NSMSGFILTER_H_
