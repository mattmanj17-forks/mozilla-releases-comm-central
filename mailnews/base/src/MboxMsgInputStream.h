/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_MBOXMSGINPUTSTREAM_H_
#define COMM_MAILNEWS_BASE_SRC_MBOXMSGINPUTSTREAM_H_

#include "nsIInputStream.h"
#include "nsCOMPtr.h"
#include "mozilla/Buffer.h"
#include "mozilla/Mutex.h"

class MboxParser;

/**
 * MboxMsgInputStream reads messages from an underlying mbox stream. Messages
 * will be read in sequence beginning at the position of the underlying stream,
 * returning EOF at the end of each message. Subsequent messages can be read by
 * calling `Continue()`.
 *
 * Escaped ">From " lines in the body of the message will be silently
 * unescaped. The caller should never need to deal with (or be aware of)
 * escaping.
 *
 * The underlying stream is expected to be pre-positioned at the beginning of
 * the "From " line indicating a new message.
 *
 * MboxMsgInputStream should be regarded as taking ownership of the
 * underlying stream: when the MboxMsgInputStream is closed, the underlying
 * stream is also closed.
 */
class MboxMsgInputStream : public nsIInputStream {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIINPUTSTREAM

  /**
   * mboxStream is a stream for reading the raw mbox data, positioned at the
   * "From " line.
   * MboxMsgInputStream assumes ownership of mboxStream, and will close it
   * when done.
   * When a non-zero maxAllowedSize is given, read at most this amount of
   * bytes from the stream.
   * The maxAllowedSize parameter allows the caller to specify a safety limit,
   * if it knows that the number of expected bytes is smaller than the
   * given number. This is useful if the mbox stream doesn't contain the
   * expected separators.
   */
  explicit MboxMsgInputStream(nsIInputStream* mboxStream,
                              uint32_t maxAllowedSize);

  MboxMsgInputStream() = delete;

  /**
   * A null message is an empty message where there isn't even a "From "
   * separator line, most likely due to an empty mbox file.
   * It's a bit of an icky special case, but we'll use this when doing an
   * async scan over an empty mbox file without returning a spurious empty
   * message - see MboxScanner, in nsMsgBrkMBoxStore.cpp.
   */
  bool IsNullMessage();

  /**
   * Start reading the next message, if any. Think of it as a "reopen".
   * The stream must have been completely exhausted to EOF (by calling Read())
   * before Continue() can be called.
   * If no more messages are available (i.e. we've hit the end of the mbox),
   * then `more` will contain false upon return.
   *
   * Continue() will fail if stream has been closed.
   * This is because Close() also closes the underlying stream.
   */
  nsresult Continue(bool& more);

  /**
   * Return the offset at which the current message is located. This would be
   * the location of the "From " separator line.
   * NOTE: this value is relative to where the underlying stream was
   * positioned when the MboxMsgInputStream was constructed!
   * If a seek was performed beforehand, that position is considered offset 0.
   */
  uint64_t MsgOffset();

  /**
   * If the "From " line contained a sender, it can be accessed here.
   * Otherwise an empty string will be returned.
   */
  nsCString EnvAddr();

  /**
   * If the "From " line contained a timestamp, it can be accessed here.
   * Otherwise 0 will be returned.
   */
  PRTime EnvDate();

 protected:
  virtual ~MboxMsgInputStream();

  nsresult PumpData();

  // The underlying mbox stream we're parsing.
  nsCOMPtr<nsIInputStream> mRawStream;
  nsresult mStatus;

  // Our input buffer.
  mozilla::Buffer<char> mBuf;
  // Number of consumed bytes in mBuf (starting from position 0).
  size_t mUsed;
  // Number of unconsumed bytes in mBuf (starting at position mUsed).
  size_t mUnused;

  // Total bytes consumed from mbox file so far.
  uint64_t mTotalUsed;
  // The offset at which the current message began.
  uint64_t mMsgOffset;

  uint32_t mLimitOutputBytes;
  uint32_t mOutputBytes;
  bool mOverflow;

  // Hide gory parsing details with pIMPL.
  mozilla::UniquePtr<MboxParser> mParser;

 private:
  mozilla::Mutex mLock;
};

#endif  // COMM_MAILNEWS_BASE_SRC_MBOXMSGINPUTSTREAM_H_
