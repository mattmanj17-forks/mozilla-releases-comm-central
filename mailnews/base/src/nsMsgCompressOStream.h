/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_NSMSGCOMPRESSOSTREAM_H_
#define COMM_MAILNEWS_BASE_SRC_NSMSGCOMPRESSOSTREAM_H_

#include "nsIOutputStream.h"
#include "nsCOMPtr.h"
#include "mozilla/UniquePtr.h"
#include "zlib.h"

class nsMsgCompressOStream final : public nsIOutputStream {
 public:
  nsMsgCompressOStream();

  NS_DECL_THREADSAFE_ISUPPORTS

  NS_DECL_NSIOUTPUTSTREAM

  nsresult InitOutputStream(nsIOutputStream* rawStream);

 protected:
  ~nsMsgCompressOStream();
  nsCOMPtr<nsIOutputStream> m_oStream;
  mozilla::UniquePtr<char[]> m_zbuf;
  z_stream m_zstream;
};

#endif  // COMM_MAILNEWS_BASE_SRC_NSMSGCOMPRESSOSTREAM_H_
