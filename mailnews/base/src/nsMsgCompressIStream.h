/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_NSMSGCOMPRESSISTREAM_H_
#define COMM_MAILNEWS_BASE_SRC_NSMSGCOMPRESSISTREAM_H_

#include "nsIAsyncInputStream.h"
#include "nsIInputStream.h"
#include "nsCOMPtr.h"
#include "mozilla/UniquePtr.h"
#include "zlib.h"

class nsMsgCompressIStream final : public nsIAsyncInputStream {
 public:
  nsMsgCompressIStream();

  NS_DECL_THREADSAFE_ISUPPORTS

  NS_DECL_NSIINPUTSTREAM
  NS_DECL_NSIASYNCINPUTSTREAM

  nsresult InitInputStream(nsIInputStream* rawStream);

 protected:
  ~nsMsgCompressIStream();
  nsresult DoInflation();
  nsCOMPtr<nsIInputStream> m_iStream;
  mozilla::UniquePtr<char[]> m_zbuf;
  mozilla::UniquePtr<char[]> m_databuf;
  char* m_dataptr;
  uint32_t m_dataleft;
  bool m_inflateAgain;
  z_stream m_zstream;
};

#endif  // COMM_MAILNEWS_BASE_SRC_NSMSGCOMPRESSISTREAM_H_
