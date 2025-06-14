/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_MIME_SRC_MIMECMS_H_
#define COMM_MAILNEWS_MIME_SRC_MIMECMS_H_

#include "mimecryp.h"

class nsICMSMessage;  // for function arguments in mimecms.h

/* The MimeEncryptedCMS class implements a type of MIME object where the
   object is passed through a CMS decryption engine to decrypt or verify
   signatures.  That module returns a new MIME object, which is then presented
   to the user.  See mimecryp.h for details of the general mechanism on which
   this is built.
 */

typedef struct MimeEncryptedCMSClass MimeEncryptedCMSClass;
typedef struct MimeEncryptedCMS MimeEncryptedCMS;

struct MimeEncryptedCMSClass {
  MimeEncryptedClass encrypted;
};

extern MimeEncryptedCMSClass mimeEncryptedCMSClass;

struct MimeEncryptedCMS {
  MimeEncrypted encrypted; /* superclass variables */
};

#define MimeEncryptedCMSClassInitializer(ITYPE, CSUPER) \
  {MimeEncryptedClassInitializer(ITYPE, CSUPER)}

#endif  // COMM_MAILNEWS_MIME_SRC_MIMECMS_H_
