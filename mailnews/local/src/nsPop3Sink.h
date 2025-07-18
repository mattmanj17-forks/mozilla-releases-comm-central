/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_LOCAL_SRC_NSPOP3SINK_H_
#define COMM_MAILNEWS_LOCAL_SRC_NSPOP3SINK_H_

#include "nscore.h"
#include "nsCOMPtr.h"
#include "nsIPop3Sink.h"
#include "nsIOutputStream.h"
#include "prmem.h"
#include "prio.h"
#include "plstr.h"
#include "prenv.h"
#include "nsIMsgFolder.h"
#include "nsTArray.h"
#include "nsString.h"

class nsParseNewMailState;
class nsIMsgFolder;

class nsPop3Sink : public nsIPop3Sink {
 public:
  nsPop3Sink();

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIPOP3SINK
  nsresult GetServerFolder(nsIMsgFolder** aFolder);

  static char* GetDummyEnvelope(void);

 protected:
  virtual ~nsPop3Sink();
  nsresult WriteLineToMailbox(const nsACString& buffer);
  nsresult ReleaseFolderLock();
  nsresult DiscardStalePartialMessages(nsIPop3Protocol* protocol);

  uint32_t m_biffState;
  int32_t m_numNewMessages;
  int32_t m_numNewMessagesInFolder;
  int32_t m_numMsgsDownloaded;
  bool m_senderAuthed;
  nsCOMPtr<nsIPop3IncomingServer> m_popServer;
  // Currently the folder we want to update about biff info
  nsCOMPtr<nsIMsgFolder> m_folder;
  RefPtr<nsParseNewMailState> m_newMailParser;
  nsCOMPtr<nsIOutputStream>
      m_outFileStream;  // the file we write to, which may be temporary
  nsCOMPtr<nsIMsgPluggableStore> m_msgStore;
  bool m_uidlDownload;
  bool m_buildMessageUri;
  nsCOMPtr<nsIMsgWindow> m_window;
  nsCString m_messageUri;
  nsCString m_baseMessageUri;
  nsCString m_origMessageUri;
  nsCString m_accountKey;
};

#endif  // COMM_MAILNEWS_LOCAL_SRC_NSPOP3SINK_H_
