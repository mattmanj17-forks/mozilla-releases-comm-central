/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <stdio.h>
#include "nsMimeRawEmitter.h"
#include "plstr.h"
#include "nscore.h"
#include "prmem.h"

/*
 * nsMimeRawEmitter definitions....
 */
nsMimeRawEmitter::nsMimeRawEmitter() {}

nsMimeRawEmitter::~nsMimeRawEmitter(void) {}

NS_IMETHODIMP
nsMimeRawEmitter::WriteBody(const nsACString& buf, uint32_t* amountWritten) {
  Write(buf, amountWritten);
  return NS_OK;
}
