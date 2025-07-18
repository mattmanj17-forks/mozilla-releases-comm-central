/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_IMPORT_SRC_NSAPPLEMAILIMPORT_H_
#define COMM_MAILNEWS_IMPORT_SRC_NSAPPLEMAILIMPORT_H_

#include "nsIImportModule.h"
#include "nsCOMPtr.h"
#include "nsIStringBundle.h"
#include "nsIImportMail.h"

#define NS_APPLEMAILIMPL_CID \
  {0x9117a1ea, 0xe012, 0x43b5, {0xa0, 0x20, 0xcb, 0x8a, 0x66, 0xcc, 0x09, 0xe1}}

#define NS_APPLEMAILIMPORT_CID \
  {0x6d3f101c, 0x70ec, 0x4e04, {0xb6, 0x8d, 0x99, 0x08, 0xd1, 0xae, 0xdd, 0xf3}}

#define NS_APPLEMAILIMPL_CONTRACTID "@mozilla.org/import/import-appleMailImpl;1"

#define kAppleMailSupportsString "mail"

class nsIImportService;

class nsAppleMailImportModule : public nsIImportModule {
 public:
  nsAppleMailImportModule();

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIIMPORTMODULE

 private:
  virtual ~nsAppleMailImportModule();

  nsCOMPtr<nsIStringBundle> mBundle;
};

class nsAppleMailImportMail : public nsIImportMail {
 public:
  nsAppleMailImportMail();

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIIMPORTMAIL

  nsresult Initialize();

 private:
  virtual ~nsAppleMailImportMail();

  void FindAccountMailDirs(
      nsIFile* aRoot,
      nsTArray<RefPtr<nsIImportMailboxDescriptor>>& aMailboxDescs,
      nsIImportService* aImportService);
  nsresult FindMboxDirs(
      nsIFile* aFolder,
      nsTArray<RefPtr<nsIImportMailboxDescriptor>>& aMailboxDescs,
      nsIImportService* aImportService);
  nsresult AddMboxDir(
      nsIFile* aFolder,
      nsTArray<RefPtr<nsIImportMailboxDescriptor>>& aMailboxDescs,
      nsIImportService* aImportService);

  // aInfoString is the format to a "foo %s" string. It may be NULL if the error
  // string needs no such format.
  void ReportStatus(const char16_t* aErrorName, nsString& aName,
                    nsAString& aStream);
  static void SetLogs(const nsAString& success, const nsAString& error,
                      char16_t** aOutErrorLog, char16_t** aSuccessLog);

  nsCOMPtr<nsIStringBundle> mBundle;
  uint32_t mProgress;
  uint16_t mCurDepth;
};

#endif  // COMM_MAILNEWS_IMPORT_SRC_NSAPPLEMAILIMPORT_H_
