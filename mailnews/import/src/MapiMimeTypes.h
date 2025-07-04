/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_IMPORT_SRC_MAPIMIMETYPES_H_
#define COMM_MAILNEWS_IMPORT_SRC_MAPIMIMETYPES_H_

#include <windows.h>

#define kMaxMimeTypeSize 256

class CMimeTypes {
 public:
  static uint8_t* GetMimeType(const nsString& theExt);

 protected:
  // Registry stuff
  static BOOL GetKey(HKEY root, LPCWSTR pName, PHKEY pKey);
  static BOOL GetValueBytes(HKEY rootKey, LPCWSTR pValName, LPBYTE* ppBytes);
  static void ReleaseValueBytes(LPBYTE pBytes);
  static BOOL GetMimeTypeFromReg(const nsString& ext, LPBYTE* ppBytes);

  static uint8_t m_mimeBuffer[kMaxMimeTypeSize];
};

#endif  // COMM_MAILNEWS_IMPORT_SRC_MAPIMIMETYPES_H_
