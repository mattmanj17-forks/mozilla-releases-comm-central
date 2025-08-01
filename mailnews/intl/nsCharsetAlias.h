/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_INTL_NSCHARSETALIAS_H_
#define COMM_MAILNEWS_INTL_NSCHARSETALIAS_H_

#include "nscore.h"
#include "nsString.h"

class nsCharsetConverterManager;
class nsScriptableUnicodeConverter;

class nsCharsetAlias {
  friend class nsCharsetConverterManager;
  friend class nsScriptableUnicodeConverter;
  static nsresult GetPreferredInternal(const nsACString& aAlias,
                                       nsACString& aResult);

 public:
  static nsresult GetPreferred(const nsACString& aAlias, nsACString& aResult);
  static nsresult Equals(const nsACString& aCharset1,
                         const nsACString& aCharset2, bool* aResult);
};

#endif  // COMM_MAILNEWS_INTL_NSCHARSETALIAS_H_
