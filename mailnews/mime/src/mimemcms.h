/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_MIME_SRC_MIMEMCMS_H_
#define COMM_MAILNEWS_MIME_SRC_MIMEMCMS_H_

#include "mimemsig.h"

class nsICMSMessage;  // for function arguments in mimemcms.c

/* The MimeMultipartSignedCMS class implements a multipart/signed MIME
   container with protocol=application/x-CMS-signature, which passes the
   signed object through CMS code to verify the signature.  See mimemsig.h
   for details of the general mechanism on which this is built.
 */

typedef struct MimeMultipartSignedCMSClass MimeMultipartSignedCMSClass;
typedef struct MimeMultipartSignedCMS MimeMultipartSignedCMS;

struct MimeMultipartSignedCMSClass {
  MimeMultipartSignedClass msigned;
};

extern MimeMultipartSignedCMSClass mimeMultipartSignedCMSClass;

struct MimeMultipartSignedCMS {
  MimeMultipartSigned msigned;
};

#define MimeMultipartSignedCMSClassInitializer(ITYPE, CSUPER) \
  {MimeMultipartSignedClassInitializer(ITYPE, CSUPER)}

bool MimeMultCMSdata_isIgnored(MimeClosure crypto_closure);

#endif  // COMM_MAILNEWS_MIME_SRC_MIMEMCMS_H_
