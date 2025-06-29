/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_EXTENSIONS_SMIME_NSCMSSECUREMESSAGE_H_
#define COMM_MAILNEWS_EXTENSIONS_SMIME_NSCMSSECUREMESSAGE_H_

#include "nsICMSSecureMessage.h"
#include "cert.h"

// ===============================================
// nsCMSManager - implementation of nsICMSManager
// ===============================================

#define NS_CMSSECUREMESSAGE_CID \
  {0x5fb907e0, 0x1dd2, 0x11b2, {0xa7, 0xc0, 0xf1, 0x4c, 0x41, 0x6a, 0x62, 0xa1}}

class nsCMSSecureMessage : public nsICMSSecureMessage {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSICMSSECUREMESSAGE

  nsCMSSecureMessage();
  nsresult Init();

 private:
  virtual ~nsCMSSecureMessage();
  nsresult encode(const unsigned char* data, int32_t dataLen, char** _retval);
  nsresult decode(const char* data, unsigned char** result, int32_t* _retval);
  nsresult CheckUsageOk(nsIX509Cert* cert, SECCertificateUsage usage,
                        bool* _retval);
};

#endif  // COMM_MAILNEWS_EXTENSIONS_SMIME_NSCMSSECUREMESSAGE_H_
