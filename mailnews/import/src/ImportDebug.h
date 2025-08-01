/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_IMPORT_SRC_IMPORTDEBUG_H_
#define COMM_MAILNEWS_IMPORT_SRC_IMPORTDEBUG_H_

#ifdef NS_DEBUG
#  define IMPORT_DEBUG 1
#endif

#include "mozilla/Logging.h"
extern mozilla::LazyLogModule
    IMPORTLOGMODULE;  // defined in nsImportService.cpp

#define IMPORT_LOG0(x) MOZ_LOG(IMPORTLOGMODULE, mozilla::LogLevel::Debug, (x))
#define IMPORT_LOG1(x, y) \
  MOZ_LOG(IMPORTLOGMODULE, mozilla::LogLevel::Debug, (x, y))
#define IMPORT_LOG2(x, y, z) \
  MOZ_LOG(IMPORTLOGMODULE, mozilla::LogLevel::Debug, (x, y, z))
#define IMPORT_LOG3(a, b, c, d) \
  MOZ_LOG(IMPORTLOGMODULE, mozilla::LogLevel::Debug, (a, b, c, d))

#endif  // COMM_MAILNEWS_IMPORT_SRC_IMPORTDEBUG_H_
