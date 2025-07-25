/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * This Original Code has been modified by IBM Corporation. Modifications made
 * by IBM described herein are Copyright (c) International Business Machines
 * Corporation, 2000. Modifications to Mozilla code or documentation identified
 * per MPL Section 3.3
 *
 * Date             Modified by     Description of modification
 * 04/20/2000       IBM Corp.      OS/2 VisualAge build.
 */

#ifndef COMM_MAILNEWS_BASE_SRC_NSMSGACCOUNTMANAGER_H_
#define COMM_MAILNEWS_BASE_SRC_NSMSGACCOUNTMANAGER_H_

#include "nscore.h"
#include "nsIMsgAccountManager.h"
#include "nsCOMPtr.h"
#include "nsIMsgOutgoingServer.h"
#include "nsIMsgFolderCache.h"
#include "nsIMsgFolder.h"
#include "nsIObserver.h"
#include "nsWeakReference.h"
#include "nsCOMArray.h"
#include "nsIMsgSearchSession.h"
#include "nsInterfaceHashtable.h"
#include "nsIMsgDatabase.h"
#include "nsIDBChangeListener.h"
#include "nsTObserverArray.h"
#include "nsIAsyncShutdown.h"

class VirtualFolderChangeListener final : public nsIDBChangeListener {
 public:
  VirtualFolderChangeListener();

  NS_DECL_ISUPPORTS
  NS_DECL_NSIDBCHANGELISTENER

  nsresult Init();
  /**
   * Posts an event to update the summary totals and commit the db.
   * We post the event to avoid committing each time we're called
   * in a synchronous loop.
   */
  nsresult PostUpdateEvent(nsIMsgFolder* folder, nsIMsgDatabase* db);
  /// Handles event posted to event queue to batch notifications.
  void ProcessUpdateEvent(nsIMsgFolder* folder, nsIMsgDatabase* db);

  void DecrementNewMsgCount();

  // folder we're listening to db changes on behalf of.
  nsCOMPtr<nsIMsgFolder> m_virtualFolder;
  // folder whose db we're listening to.
  nsCOMPtr<nsIMsgFolder> m_folderWatching;
  nsCOMPtr<nsIMsgSearchSession> m_searchSession;
  bool m_searchOnMsgStatus;
  bool m_batchingEvents;

 private:
  ~VirtualFolderChangeListener() {}
};

class nsMsgAccountManager : public nsIMsgAccountManager,
                            public nsIObserver,
                            public nsSupportsWeakReference,
                            public nsIFolderListener,
                            public nsIAsyncShutdownBlocker {
 public:
  nsMsgAccountManager();

  NS_DECL_THREADSAFE_ISUPPORTS

  /* nsIMsgAccountManager methods */

  NS_DECL_NSIMSGACCOUNTMANAGER
  NS_DECL_NSIOBSERVER
  NS_DECL_NSIFOLDERLISTENER
  NS_DECL_NSIASYNCSHUTDOWNBLOCKER

  nsresult Init();
  void LogoutOfServer(nsIMsgIncomingServer* aServer);

 private:
  virtual ~nsMsgAccountManager();

  bool m_accountsLoaded;
  nsCOMPtr<nsIMsgFolderCache> m_msgFolderCache;
  nsTArray<nsCOMPtr<nsIMsgAccount>> m_accounts;
  nsInterfaceHashtable<nsCStringHashKey, nsIMsgIdentity> m_identities;
  nsInterfaceHashtable<nsCStringHashKey, nsIMsgIncomingServer>
      m_incomingServers;
  nsCOMPtr<nsIMsgAccount> m_defaultAccount;
  nsCOMArray<nsIIncomingServerListener> m_incomingServerListeners;
  nsTObserverArray<RefPtr<VirtualFolderChangeListener>>
      m_virtualFolderListeners;
  nsTArray<nsCOMPtr<nsIMsgFolder>> m_virtualFolders;
  nsCOMPtr<nsIMsgFolder> m_folderDoingEmptyTrash;
  nsCOMPtr<nsIMsgFolder> m_folderDoingCleanupInbox;
  bool m_emptyTrashInProgress;
  bool m_cleanupInboxInProgress;

  nsCString mAccountKeyList;

  // These are static because the account manager may go away during
  // shutdown, and get recreated.
  static bool m_haveShutdown;
  static bool m_shutdownInProgress;

  bool m_userAuthenticated;
  bool m_loadingVirtualFolders;
  bool m_virtualFoldersLoaded;

  /* we call FindServer() a lot.  so cache the last server found */
  nsCOMPtr<nsIMsgIncomingServer> m_lastFindServerResult;
  nsCString m_lastFindServerHostName;
  nsCString m_lastFindServerUserName;
  int32_t m_lastFindServerPort;
  nsCString m_lastFindServerType;

  nsresult Shutdown();
  nsresult CleanupOnExit();

  void SetLastServerFound(nsIMsgIncomingServer* server,
                          const nsACString& hostname,
                          const nsACString& username, const int32_t port,
                          const nsACString& type);

  // Where to start looking for an empty server key. This should only increase
  // as servers are created to ensure keys are unique within a session.
  uint32_t m_lastUniqueServerKey;

  /* internal creation routines - updates m_identities and m_incomingServers */
  nsresult createKeyedAccount(const nsCString& key, bool forcePositionToEnd,
                              nsIMsgAccount** _retval);
  nsresult createKeyedServer(const nsACString& key, const nsACString& username,
                             const nsACString& password, const nsACString& type,
                             nsIMsgIncomingServer** _retval);

  nsresult createKeyedIdentity(const nsACString& key, nsIMsgIdentity** _retval);

  nsresult GetLocalFoldersPrettyName(nsString& localFoldersName);

  /**
   * Check if the given account can be the set as the default account.
   */
  nsresult CheckDefaultAccount(nsIMsgAccount* aAccount, bool& aCanBeDefault);

  // sets the pref for the default server
  nsresult setDefaultAccountPref(nsIMsgAccount* aDefaultAccount);

  // Write out the accounts pref from the m_accounts list of accounts.
  nsresult OutputAccountsPref();

  // fires notifications to the appropriate root folders
  nsresult notifyDefaultServerChange(nsIMsgAccount* aOldAccount,
                                     nsIMsgAccount* aNewAccount);

  //
  // account enumerators
  // ("element" is always an account)
  //

  // find the servers that correspond to the given identity
  static bool findServersForIdentity(nsISupports* element, void* aData);

  void findAccountByServerKey(const nsCString& aKey, nsIMsgAccount** aResult);

  //
  // server enumerators
  // ("element" is always a server)
  //

  nsresult findServerInternal(const nsACString& username,
                              const nsACString& hostname,
                              const nsACString& type, int32_t port,
                              nsIMsgIncomingServer** aResult);

  // handle virtual folders
  static nsresult GetVirtualFoldersFile(nsCOMPtr<nsIFile>& file);
  static nsresult WriteLineToOutputStream(const char* prefix, const char* line,
                                          nsIOutputStream* outputStream);
  void ParseAndVerifyVirtualFolderScope(nsCString& buffer);
  nsresult AddVFListenersForVF(nsIMsgFolder* virtualFolder,
                               const nsCString& srchFolderUris);

  nsresult RemoveVFListenerForVF(nsIMsgFolder* virtualFolder,
                                 nsIMsgFolder* folder);

  nsresult RemoveFolderFromSmartFolder(nsIMsgFolder* aFolder,
                                       uint32_t flagsChanged);

  nsresult SetSendLaterUriPref(nsIMsgIncomingServer* server);

  nsCOMPtr<nsIMsgDBService> m_dbService;

  // account deletion handling

  /**
   * Removes the given folder from the folder cache, along with all its cached
   * properties.
   */
  nsresult RemoveFolderFromCache(nsIMsgFolder* aFolder);
};

#endif  // COMM_MAILNEWS_BASE_SRC_NSMSGACCOUNTMANAGER_H_
