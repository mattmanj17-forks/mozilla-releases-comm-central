/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_IMAP_SRC_NSIMAPURL_H_
#define COMM_MAILNEWS_IMAP_SRC_NSIMAPURL_H_

#include "nsIImapUrl.h"
#include "nsCOMPtr.h"
#include "nsMsgMailNewsUrl.h"
#include "nsIWeakReferenceUtils.h"
#include "nsIFile.h"
#include "mozilla/Mutex.h"

class nsImapUrl : public nsIImapUrl,
                  public nsMsgMailNewsUrl,
                  public nsIMsgMessageUrl,
                  public nsIMsgI18NUrl {
 public:
  NS_DECL_ISUPPORTS_INHERITED

  // nsMsgMailNewsUrl overrides
  nsresult SetSpecInternal(const nsACString& aSpec) override;
  nsresult SetQuery(const nsACString& aQuery) override;
  nsresult Clone(nsIURI** _retval) override;

  //////////////////////////////////////////////////////////////////////////////
  // we support the nsIImapUrl interface
  //////////////////////////////////////////////////////////////////////////////
  NS_DECL_NSIIMAPURL

  // nsIMsgMailNewsUrl overrides
  NS_IMETHOD IsUrlType(uint32_t type, bool* isType) override;
  NS_IMETHOD GetFolder(nsIMsgFolder** aFolder) override;
  NS_IMETHOD SetFolder(nsIMsgFolder* aFolder) override;
  // nsIMsgMessageUrl
  NS_DECL_NSIMSGMESSAGEURL
  NS_DECL_NSIMSGI18NURL

  // nsImapUrl
  nsImapUrl();

  static nsCString ConvertToCanonicalFormat(nsACString const& folderName,
                                            char onlineDelimiter);
  static nsresult EscapeSlashes(const char* sourcePath, char** resultPath);
  static nsresult UnescapeSlashes(nsACString& path);
  static nsresult UnescapeSlashes(char* path);

 protected:
  virtual ~nsImapUrl();
  virtual nsresult ParseUrl();

  char* m_listOfMessageIds;

  // handle the imap specific parsing
  void ParseImapPart(char* imapPartOfUrl);

  void ParseFolderPath(char** resultingCanonicalPath);
  void ParseSearchCriteriaString();
  void ParseUidChoice();
  void ParseMsgFlags();
  void ParseListOfMessageIds();
  void ParseCustomMsgFetchAttribute();
  void ParseNumBytes();

  nsresult GetMsgFolder(nsIMsgFolder** msgFolder);

  char* m_sourceCanonicalFolderPathSubString;
  char* m_destinationCanonicalFolderPathSubString;
  char* m_tokenPlaceHolder;
  char* m_urlidSubString;
  char m_onlineSubDirSeparator;
  char* m_searchCriteriaString;   // should we use m_search, or is this special?
  nsCString m_command;            // for custom commands
  nsCString m_msgFetchAttribute;  // for fetching custom msg attributes
  nsCString m_customAttributeResult;  // for fetching custom msg attributes
  nsCString m_customCommandResult;    // custom command response
  nsCString
      m_customAddFlags;  // these two are for setting and clearing custom flags
  nsCString m_customSubtractFlags;
  int32_t m_numBytesToFetch;  // when doing a msg body preview, how many bytes
                              // to read
  bool m_validUrl;
  bool m_runningUrl;
  bool m_idsAreUids;
  bool m_mimePartSelectorDetected;
  bool m_msgLoadingFromCache;  // if true, we might need to mark read on server
  bool m_externalLinkUrl;  // if true, we're running this url because the user
  // True if the fetch results should be put in the offline store.
  bool m_storeResultsOffline;
  bool m_storeOfflineOnFallback;
  bool m_localFetchOnly;
  bool m_rerunningUrl;  // first attempt running this failed with connection
                        // error; retrying
  bool m_moreHeadersToDownload;

  int32_t m_extraStatus;

  nsCString m_userName;
  nsCString m_serverKey;
  // event sinks
  imapMessageFlagsType m_flags;
  nsImapAction m_imapAction;

  nsWeakPtr m_imapFolder;
  nsWeakPtr m_imapMailFolderSink;
  nsWeakPtr m_imapMessageSink;

  nsWeakPtr m_imapServerSink;

  // online message copy support; i don't have a better solution yet
  nsCOMPtr<nsISupports> m_copyState;  // now, refcounted.
  nsCOMPtr<nsIFile> m_file;
  nsWeakPtr m_channelWeakPtr;

  // used by save message to disk
  nsCOMPtr<nsIFile> m_messageFile;
  bool m_addDummyEnvelope;
  bool m_canonicalLineEnding;  // CRLF

  nsCString mURI;           // the RDF URI associated with this url.
  bool mAutodetectCharset;  // used by nsIMsgI18NUrl...
  mozilla::Mutex mLock;
};

#endif  // COMM_MAILNEWS_IMAP_SRC_NSIMAPURL_H_
