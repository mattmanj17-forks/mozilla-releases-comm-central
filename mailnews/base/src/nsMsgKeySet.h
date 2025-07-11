/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_NSMSGKEYSET_H_
#define COMM_MAILNEWS_BASE_SRC_NSMSGKEYSET_H_

#include "MailNewsTypes2.h"
#include "nsTArray.h"

// nsMsgKeySet represents a set of articles.  Typically, it is the set of
// read articles from a .newsrc file, but it can be used for other purposes
// too.

#if 0
// If a MSG_NewsHost* is supplied to the creation routine, then that
// MSG_NewsHost will be notified whenever a change is made to set.
class MSG_NewsHost;
#endif

class nsMsgKeySet {
 public:
  NS_INLINE_DECL_REFCOUNTING(nsMsgKeySet);
  // Creates an empty set.
  static nsMsgKeySet* Create(/* MSG_NewsHost* host = NULL*/);

  // Creates a set from the list of numbers, as might be found in a
  // newsrc file.
  static nsMsgKeySet* Create(const char* str /* , MSG_NewsHost* host = NULL*/);

  // Output() converts to a string representation suitable for writing to a
  // .newsrc file.
  nsresult Output(char** outputStr);

  // IsMember() returns whether the given article is a member of this set.
  bool IsMember(int32_t art);

  // Add() adds the given article to the set.  (Returns 1 if a change was
  // made, 0 if it was already there, and negative on error.)
  int Add(int32_t art);

  // Remove() removes the given article from the set.
  int Remove(int32_t art);

  // AddRange() adds the (inclusive) given range of articles to the set.
  int AddRange(int32_t first, int32_t last);

  // CountMissingInRange() takes an inclusive range of articles and returns
  // the number of articles in that range which are not in the set.
  int32_t CountMissingInRange(int32_t start, int32_t end);

  int32_t GetFirstMember();
  // For debugging only...
  int32_t getLength() { return m_length; }

  /**
   * Fill the passed in aArray with the keys in the message key set.
   */
  nsresult ToMsgKeyArray(nsTArray<nsMsgKey>& aArray);

#ifdef DEBUG
  static void RunTests();
#endif

 protected:
  nsMsgKeySet(/* MSG_NewsHost* host */);
  explicit nsMsgKeySet(const char* /* , MSG_NewsHost* host */);
  bool Grow();
  bool Optimize();

#ifdef DEBUG
  static void test_decoder(const char*);
  static void test_adder();
  static void test_ranges();
  static void test_member(bool with_cache);
#endif

  int32_t* m_data;     /* the numbers composing the `chunks' */
  int32_t m_data_size; /* size of that malloc'ed block */
  int32_t m_length;    /* active area */

  int32_t m_cached_value;       /* a potential set member, or -1 if unset*/
  int32_t m_cached_value_index; /* the index into `data' at which a search
                                   to determine whether `cached_value' was
                                   a member of the set ended. */
#ifdef NEWSRC_DOES_HOST_STUFF
  MSG_NewsHost* m_host;
#endif
  ~nsMsgKeySet();
};

#endif  // COMM_MAILNEWS_BASE_SRC_NSMSGKEYSET_H_
