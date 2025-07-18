/* -*- Mode: C; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/*
  mimeenc.c --- MIME encoders and decoders, version 2 (see mimei.h)
  Copyright (c) 1996 Netscape Communications Corporation, all rights reserved.
  Created: Jamie Zawinski <jwz@netscape.com>, 15-May-96.
*/

#ifndef COMM_MAILNEWS_MIME_SRC_MODMIMEE_H_
#define COMM_MAILNEWS_MIME_SRC_MODMIMEE_H_

#include "nscore.h"  // for nullptr
#include "mime_closure.h"

typedef int (*MimeConverterOutputCallback)(const char* buf, int32_t size,
                                           MimeClosure closure);

/* This file defines interfaces to generic implementations of Base64,
   Quoted-Printable, and UU decoders; and of Base64 and Quoted-Printable
   encoders.
 */

/* Opaque objects used by the encoder/decoder to store state. */
typedef struct MimeDecoderData MimeDecoderData;

struct MimeObject;

/* functions for creating that opaque data.
 */
MimeDecoderData* MimeB64DecoderInit(MimeConverterOutputCallback output_fn,
                                    MimeClosure closure);

MimeDecoderData* MimeQPDecoderInit(MimeConverterOutputCallback output_fn,
                                   MimeClosure closure,
                                   MimeObject* object = nullptr);

MimeDecoderData* MimeUUDecoderInit(MimeConverterOutputCallback output_fn,
                                   MimeClosure closure);
MimeDecoderData* MimeYDecoderInit(MimeConverterOutputCallback output_fn,
                                  MimeClosure closure);

/* Push data through the encoder/decoder, causing the above-provided write_fn
   to be called with encoded/decoded data. */
int MimeDecoderWrite(MimeDecoderData* data, const char* buffer, int32_t size,
                     int32_t* outSize);

/* When you're done encoding/decoding, call this to free the data.  If
   abort_p is false, then calling this may cause the write_fn to be called
   one last time (as the last buffered data is flushed out.)
 */
int MimeDecoderDestroy(MimeDecoderData* data, bool abort_p);

#endif  // COMM_MAILNEWS_MIME_SRC_MODMIMEE_H_
