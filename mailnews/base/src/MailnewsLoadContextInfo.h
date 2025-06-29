/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This was copied from netwerk/base/LoadContextInfo.h

#ifndef COMM_MAILNEWS_BASE_SRC_MAILNEWSLOADCONTEXTINFO_H_
#define COMM_MAILNEWS_BASE_SRC_MAILNEWSLOADCONTEXTINFO_H_

#include "nsILoadContextInfo.h"

class nsIChannel;
class nsILoadContext;

class MailnewsLoadContextInfo : public nsILoadContextInfo {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSILOADCONTEXTINFO

  MailnewsLoadContextInfo(bool aIsPrivate, bool aIsAnonymous,
                          mozilla::OriginAttributes aOriginAttributes);

 private:
  virtual ~MailnewsLoadContextInfo();

 protected:
  bool mIsPrivate : 1;
  bool mIsAnonymous : 1;
  mozilla::OriginAttributes mOriginAttributes;
};

#endif  // COMM_MAILNEWS_BASE_SRC_MAILNEWSLOADCONTEXTINFO_H_
