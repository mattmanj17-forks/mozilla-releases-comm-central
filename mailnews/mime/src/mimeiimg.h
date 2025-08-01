/* -*- Mode: C; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_MIME_SRC_MIMEIIMG_H_
#define COMM_MAILNEWS_MIME_SRC_MIMEIIMG_H_

#include "mimeleaf.h"

/* The MimeInlineImage class implements those MIME image types which can be
   displayed inline.
 */

typedef struct MimeInlineImageClass MimeInlineImageClass;
typedef struct MimeInlineImage MimeInlineImage;

struct MimeInlineImageClass {
  MimeLeafClass leaf;
};

extern MimeInlineImageClass mimeInlineImageClass;

struct MimeInlineImage {
  MimeLeaf leaf;

  /* Opaque data object for the backend-specific inline-image-display code
   (internal-external-reconnect nastiness.) */
  mime_image_stream_data* image_data;
};

#define MimeInlineImageClassInitializer(ITYPE, CSUPER) \
  {MimeLeafClassInitializer(ITYPE, CSUPER)}

#endif  // COMM_MAILNEWS_MIME_SRC_MIMEIIMG_H_
