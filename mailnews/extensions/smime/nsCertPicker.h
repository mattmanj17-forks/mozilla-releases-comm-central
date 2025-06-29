/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_EXTENSIONS_SMIME_NSCERTPICKER_H_
#define COMM_MAILNEWS_EXTENSIONS_SMIME_NSCERTPICKER_H_

#include "nsICertPickDialogs.h"
#include "nsIUserCertPicker.h"

#define NS_CERT_PICKER_CID \
  {0x735959a1, 0xaf01, 0x447e, {0xb0, 0x2d, 0x56, 0xe9, 0x68, 0xfa, 0x52, 0xb4}}

class nsCertPicker : public nsICertPickDialogs, public nsIUserCertPicker {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSICERTPICKDIALOGS
  NS_DECL_NSIUSERCERTPICKER

  nsCertPicker();
  nsresult Init();

 protected:
  virtual ~nsCertPicker();
};

#endif  // COMM_MAILNEWS_EXTENSIONS_SMIME_NSCERTPICKER_H_
