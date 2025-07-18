/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_MAILNEWSDLF_H_
#define COMM_MAILNEWS_BASE_SRC_MAILNEWSDLF_H_

#include "nsIDocumentLoaderFactory.h"
#include "nsMimeTypes.h"

namespace mozilla {
namespace mailnews {

/*
 * This factory is a thin wrapper around the text/html loader factory. All it
 * does is convert message/rfc822 to text/html and delegate the rest of the
 * work to the text/html factory.
 */
class MailNewsDLF : public nsIDocumentLoaderFactory {
 public:
  MailNewsDLF();

  NS_DECL_ISUPPORTS
  NS_DECL_NSIDOCUMENTLOADERFACTORY

 private:
  virtual ~MailNewsDLF();
};
}  // namespace mailnews
}  // namespace mozilla

#define MAILNEWSDLF_CATEGORIES              \
  {"Gecko-Content-Viewers", MESSAGE_RFC822, \
   "@mozilla.org/mailnews/document-loader-factory;1"},

#endif  // COMM_MAILNEWS_BASE_SRC_MAILNEWSDLF_H_
