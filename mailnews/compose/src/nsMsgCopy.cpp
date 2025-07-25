/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgCopy.h"

#include "nsCOMPtr.h"
#include "nsISupports.h"
#include "nsIThread.h"
#include "nscore.h"
#include "mozilla/RefPtr.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgMessageFlags.h"
#include "nsIMsgFolder.h"
#include "nsIMsgAccountManager.h"
#include "nsIMsgFolder.h"
#include "nsIMsgIncomingServer.h"
#include "nsIMsgProtocolInfo.h"
#include "nsISupports.h"
#include "nsIURL.h"
#include "nsNetCID.h"
#include "nsMsgCompUtils.h"
#include "prcmon.h"
#include "nsIMsgImapMailFolder.h"
#include "nsThreadUtils.h"
#include "nsIMsgWindow.h"
#include "nsIMsgProgress.h"
#include "prmem.h"
#include "nsServiceManagerUtils.h"
#include "nsMsgUtils.h"
#include "nsIURIMutator.h"
#include "mozilla/Components.h"

////////////////////////////////////////////////////////////////////////////////////
// This is the listener class for the copy operation. We have to create this
// class to listen for message copy completion and eventually notify the caller
////////////////////////////////////////////////////////////////////////////////////
NS_IMPL_ISUPPORTS(CopyListener, nsIMsgCopyServiceListener)

CopyListener::CopyListener(void) { mCopyInProgress = false; }

CopyListener::~CopyListener(void) {}

nsresult CopyListener::OnStartCopy() {
#ifdef NS_DEBUG
  printf("CopyListener::OnStartCopy()\n");
#endif

  if (mComposeAndSend) mComposeAndSend->NotifyListenerOnStartCopy();
  return NS_OK;
}

nsresult CopyListener::OnProgress(uint32_t aProgress, uint32_t aProgressMax) {
#ifdef NS_DEBUG
  printf("CopyListener::OnProgress() %d of %d\n", aProgress, aProgressMax);
#endif

  if (mComposeAndSend)
    mComposeAndSend->NotifyListenerOnProgressCopy(aProgress, aProgressMax);

  return NS_OK;
}

nsresult CopyListener::SetMessageKey(nsMsgKey aMessageKey) {
  if (mComposeAndSend) mComposeAndSend->SetMessageKey(aMessageKey);
  return NS_OK;
}

NS_IMETHODIMP
CopyListener::GetMessageId(nsACString& aMessageId) {
  if (mComposeAndSend) mComposeAndSend->GetMessageId(aMessageId);
  return NS_OK;
}

nsresult CopyListener::OnStopCopy(nsresult aStatus) {
  if (NS_SUCCEEDED(aStatus)) {
#ifdef NS_DEBUG
    printf("CopyListener: SUCCESSFUL ON THE COPY OPERATION!\n");
#endif
  } else {
#ifdef NS_DEBUG
    printf("CopyListener: COPY OPERATION FAILED!\n");
#endif
  }

  if (mCopyInProgress) {
    PR_CEnterMonitor(this);
    PR_CNotifyAll(this);
    mCopyInProgress = false;
    PR_CExitMonitor(this);
  }
  if (mComposeAndSend) mComposeAndSend->NotifyListenerOnStopCopy(aStatus);

  return NS_OK;
}

nsresult CopyListener::SetMsgComposeAndSendObject(nsIMsgSend* obj) {
  if (obj) mComposeAndSend = obj;

  return NS_OK;
}

////////////////////////////////////////////////////////////////////////////////////
// END  END  END  END  END  END  END  END  END  END  END  END  END  END  END
// This is the listener class for the copy operation. We have to create this
// class to listen for message copy completion and eventually notify the caller
////////////////////////////////////////////////////////////////////////////////////

NS_IMPL_ISUPPORTS(nsMsgCopy, nsIMsgCopy, nsIUrlListener)

nsMsgCopy::nsMsgCopy() {
  mFile = nullptr;
  mMode = nsIMsgSend::nsMsgDeliverNow;
  mSavePref = nullptr;
  mIsDraft = false;
  mMsgFlags = nsMsgMessageFlags::Read;
}

nsMsgCopy::~nsMsgCopy() { PR_Free(mSavePref); }

NS_IMETHODIMP
nsMsgCopy::StartCopyOperation(nsIMsgIdentity* aUserIdentity, nsIFile* aFile,
                              nsMsgDeliverMode aMode, nsIMsgSend* aMsgSendObj,
                              const nsACString& aSavePref,
                              nsIMsgDBHdr* aMsgToReplace) {
  nsCOMPtr<nsIMsgFolder> dstFolder;
  bool isDraft = false;
  uint32_t msgFlags = nsMsgMessageFlags::Read;
  bool waitForUrl = false;
  nsresult rv;

  if (!aMsgSendObj) return NS_ERROR_INVALID_ARG;

  // Store away the server location...
  if (!aSavePref.IsEmpty()) mSavePref = ToNewCString(aSavePref);

  //
  // Vars for implementation...
  //

  // QueueForLater (Outbox)
  if (aMode == nsIMsgSend::nsMsgQueueForLater ||
      aMode == nsIMsgSend::nsMsgDeliverBackground) {
    rv = GetUnsentMessagesFolder(aUserIdentity, getter_AddRefs(dstFolder),
                                 &waitForUrl);
    isDraft = false;
    // Do not mark outgoing messages as read.
    msgFlags = 0;
    if (!dstFolder || NS_FAILED(rv)) {
      return NS_ERROR_FAILURE;
    }
  } else if (aMode == nsIMsgSend::nsMsgSaveAsDraft)  // SaveAsDraft (Drafts)
  {
    rv = GetDraftsFolder(aUserIdentity, getter_AddRefs(dstFolder), &waitForUrl);
    isDraft = true;
    // Do not mark drafts as read.
    msgFlags = 0;
    if (!dstFolder || NS_FAILED(rv)) return NS_ERROR_FAILURE;
  } else if (aMode ==
             nsIMsgSend::nsMsgSaveAsTemplate)  // SaveAsTemplate (Templates)
  {
    rv = GetTemplatesFolder(aUserIdentity, getter_AddRefs(dstFolder),
                            &waitForUrl);
    // Mark saved templates as read.
    isDraft = false;
    msgFlags = nsMsgMessageFlags::Read;
    if (!dstFolder || NS_FAILED(rv)) return NS_ERROR_FAILURE;
  } else  // SaveInSentFolder (Sent) -  nsMsgDeliverNow or nsMsgSendUnsent
  {
    rv = GetSentFolder(aUserIdentity, getter_AddRefs(dstFolder), &waitForUrl);
    // Mark send messages as read.
    isDraft = false;
    msgFlags = nsMsgMessageFlags::Read;
    if (!dstFolder || NS_FAILED(rv)) return NS_ERROR_FAILURE;
  }

  nsCOMPtr<nsIMsgWindow> msgWindow;

  if (aMsgSendObj) {
    nsCOMPtr<nsIMsgProgress> progress;
    aMsgSendObj->GetProgress(getter_AddRefs(progress));
    if (progress) progress->GetMsgWindow(getter_AddRefs(msgWindow));
  }

  mMode = aMode;
  mFile = aFile;
  mDstFolder = dstFolder;
  mMsgToReplace = aMsgToReplace;
  mIsDraft = isDraft;
  mMsgSendObj = aMsgSendObj;
  mMsgFlags = msgFlags;
  if (!waitForUrl) {
    // cache info needed for DoCopy and call DoCopy when OnStopUrl is called.
    rv = DoCopy(aFile, dstFolder, aMsgToReplace, isDraft, msgFlags, msgWindow,
                aMsgSendObj);
    // N.B. "this" may be deleted when this call returns.
  }
  return rv;
}

nsresult nsMsgCopy::DoCopy(nsIFile* aDiskFile, nsIMsgFolder* dstFolder,
                           nsIMsgDBHdr* aMsgToReplace, bool aIsDraft,
                           uint32_t aMsgFlags, nsIMsgWindow* msgWindow,
                           nsIMsgSend* aMsgSendObj) {
  nsresult rv = NS_OK;

  // Check sanity
  if ((!aDiskFile) || (!dstFolder)) return NS_ERROR_INVALID_ARG;

  // Call copyservice with dstFolder, disk file, and txnManager
  if (NS_SUCCEEDED(rv)) {
    RefPtr<CopyListener> copyListener = new CopyListener();
    if (!copyListener) return NS_ERROR_OUT_OF_MEMORY;

    copyListener->SetMsgComposeAndSendObject(aMsgSendObj);
    nsCOMPtr<nsIThread> thread;

    if (aIsDraft) {
      nsCOMPtr<nsIMsgImapMailFolder> imapFolder = do_QueryInterface(dstFolder);
      nsCOMPtr<nsIMsgAccountManager> accountManager =
          mozilla::components::AccountManager::Service();
      bool shutdownInProgress = false;
      rv = accountManager->GetShutdownInProgress(&shutdownInProgress);

      if (NS_SUCCEEDED(rv) && shutdownInProgress && imapFolder) {
        // set the following only when we were in the middle of shutdown
        // process
        copyListener->mCopyInProgress = true;
        thread = do_GetCurrentThread();
      }
    }
    nsCOMPtr<nsIMsgCopyService> copyService =
        mozilla::components::Copy::Service();
    rv = copyService->CopyFileMessage(aDiskFile, dstFolder, aMsgToReplace,
                                      aIsDraft, aMsgFlags, EmptyCString(),
                                      copyListener, msgWindow);
    // copyListener->mCopyInProgress can only be set when we are in the
    // middle of the shutdown process
    while (copyListener->mCopyInProgress) {
      PR_CEnterMonitor(copyListener);
      PR_CWait(copyListener, PR_MicrosecondsToInterval(1000UL));
      PR_CExitMonitor(copyListener);
      if (thread) NS_ProcessPendingEvents(thread);
    }
  }

  return rv;
}

NS_IMETHODIMP
nsMsgCopy::GetDstFolder(nsIMsgFolder** aDstFolder) {
  NS_ENSURE_ARG_POINTER(aDstFolder);
  NS_IF_ADDREF(*aDstFolder = mDstFolder);
  return NS_OK;
}

// nsIUrlListener methods
NS_IMETHODIMP
nsMsgCopy::OnStartRunningUrl(nsIURI* aUrl) { return NS_OK; }

NS_IMETHODIMP
nsMsgCopy::OnStopRunningUrl(nsIURI* aUrl, nsresult aExitCode) {
  nsresult rv = aExitCode;
  if (NS_SUCCEEDED(aExitCode)) {
    rv = DoCopy(mFile, mDstFolder, mMsgToReplace, mIsDraft, mMsgFlags, nullptr,
                mMsgSendObj);
  }
  return rv;
}

nsresult nsMsgCopy::GetUnsentMessagesFolder(nsIMsgIdentity* userIdentity,
                                            nsIMsgFolder** folder,
                                            bool* waitForUrl) {
  nsresult ret = LocateMessageFolder(
      userIdentity, nsIMsgSend::nsMsgQueueForLater, mSavePref, folder);
  if (*folder) (*folder)->SetFlag(nsMsgFolderFlags::Queue);
  CreateIfMissing(folder, waitForUrl);
  return ret;
}

nsresult nsMsgCopy::GetDraftsFolder(nsIMsgIdentity* userIdentity,
                                    nsIMsgFolder** folder, bool* waitForUrl) {
  nsresult ret = LocateMessageFolder(userIdentity, nsIMsgSend::nsMsgSaveAsDraft,
                                     mSavePref, folder);
  if (*folder) (*folder)->SetFlag(nsMsgFolderFlags::Drafts);
  CreateIfMissing(folder, waitForUrl);
  return ret;
}

nsresult nsMsgCopy::GetTemplatesFolder(nsIMsgIdentity* userIdentity,
                                       nsIMsgFolder** folder,
                                       bool* waitForUrl) {
  nsresult ret = LocateMessageFolder(
      userIdentity, nsIMsgSend::nsMsgSaveAsTemplate, mSavePref, folder);
  if (*folder) (*folder)->SetFlag(nsMsgFolderFlags::Templates);
  CreateIfMissing(folder, waitForUrl);
  return ret;
}

nsresult nsMsgCopy::GetSentFolder(nsIMsgIdentity* userIdentity,
                                  nsIMsgFolder** folder, bool* waitForUrl) {
  nsresult ret = LocateMessageFolder(userIdentity, nsIMsgSend::nsMsgDeliverNow,
                                     mSavePref, folder);
  if (*folder) {
    // If mSavePref is the same as the identity's fcc folder, set the sent flag.
    nsCString identityFccUri;
    userIdentity->GetFccFolderURI(identityFccUri);  // TODO
    if (identityFccUri.Equals(mSavePref))
      (*folder)->SetFlag(nsMsgFolderFlags::SentMail);
  }
  CreateIfMissing(folder, waitForUrl);
  return ret;
}

nsresult nsMsgCopy::CreateIfMissing(nsIMsgFolder** folder, bool* waitForUrl) {
  nsresult rv = NS_OK;
  if (folder && *folder) {
    nsCOMPtr<nsIMsgFolder> parent;
    (*folder)->GetParent(getter_AddRefs(parent));
    if (!parent) {
      nsCOMPtr<nsIFile> folderPath;
      // for local folders, path is to the berkeley mailbox.
      // for imap folders, path needs to have .msf appended to the name
      (*folder)->GetFilePath(getter_AddRefs(folderPath));

      nsCOMPtr<nsIMsgIncomingServer> server;
      rv = (*folder)->GetServer(getter_AddRefs(server));
      NS_ENSURE_SUCCESS(rv, rv);

      nsCOMPtr<nsIMsgProtocolInfo> protocolInfo;
      rv = server->GetProtocolInfo(getter_AddRefs(protocolInfo));
      NS_ENSURE_SUCCESS(rv, rv);

      bool isAsyncFolder;
      rv = protocolInfo->GetFoldersCreatedAsync(&isAsyncFolder);
      NS_ENSURE_SUCCESS(rv, rv);

      // if we can't get the path from the folder, then try to create the
      // storage. for imap, it doesn't matter if the .msf file exists - it still
      // might not exist on the server, so we should try to create it
      bool exists = false;
      if (!isAsyncFolder && folderPath) folderPath->Exists(&exists);
      if (!exists) {
        (*folder)->CreateStorageIfMissing(this);
        if (isAsyncFolder) *waitForUrl = true;

        rv = NS_OK;
      }
    }
  }
  return rv;
}
////////////////////////////////////////////////////////////////////////////////////
// Utility Functions for MsgFolders
////////////////////////////////////////////////////////////////////////////////////
nsresult LocateMessageFolder(nsIMsgIdentity* userIdentity,
                             nsMsgDeliverMode aFolderType,
                             const char* aFolderURI, nsIMsgFolder** msgFolder) {
  nsresult rv = NS_OK;

  if (!msgFolder) return NS_ERROR_NULL_POINTER;
  *msgFolder = nullptr;

  if (!aFolderURI || !*aFolderURI) return NS_ERROR_INVALID_ARG;

  // as long as it doesn't start with anyfolder://
  if (PL_strncasecmp(ANY_SERVER, aFolderURI, strlen(aFolderURI)) != 0) {
    nsCOMPtr<nsIMsgFolder> folder;
    rv = GetOrCreateFolder(nsDependentCString(aFolderURI),
                           getter_AddRefs(folder));
    NS_ENSURE_SUCCESS(rv, rv);
    // Don't check validity of folder - caller will handle creating it.
    nsCOMPtr<nsIMsgIncomingServer> server;
    // make sure that folder hierarchy is built so that legitimate parent-child
    // relationship is established.
    rv = folder->GetServer(getter_AddRefs(server));
    NS_ENSURE_SUCCESS(rv, rv);
    return server->GetMsgFolderFromURI(folder, nsDependentCString(aFolderURI),
                                       msgFolder);
  } else {
    if (!userIdentity) return NS_ERROR_INVALID_ARG;

    nsCOMPtr<nsIMsgAccountManager> accountManager =
        mozilla::components::AccountManager::Service();
    // If any folder will do, go look for one.
    nsTArray<RefPtr<nsIMsgIncomingServer>> servers;
    rv = accountManager->GetServersForIdentity(userIdentity, servers);
    NS_ENSURE_SUCCESS(rv, rv);

    // Ok, we have to look through the servers and try to find the server that
    // has a valid folder of the type that interests us...
    for (auto inServer : servers) {
      // Now that we have the server...we need to get the named message folder

      // If aFolderURI is passed in, then the user has chosen a specific
      // mail folder to save the message, but if it is null, just find the
      // first one and make that work. The folder is specified as a URI, like
      // the following:
      //
      //   mailbox://nobody@Local Folders/Sent
      //                  imap://rhp@nsmail-2/Drafts
      //                  newsgroup://news.mozilla.org/netscape.test
      //
      nsCString serverURI;
      rv = inServer->GetServerURI(serverURI);
      if (NS_FAILED(rv) || serverURI.IsEmpty()) continue;

      nsCOMPtr<nsIMsgFolder> rootFolder;
      rv = inServer->GetRootFolder(getter_AddRefs(rootFolder));

      if (NS_FAILED(rv) || (!rootFolder)) continue;

      // use the defaults by getting the folder by flags
      if (aFolderType == nsIMsgSend::nsMsgQueueForLater ||
          aFolderType == nsIMsgSend::nsMsgDeliverBackground) {
        // QueueForLater (Outbox)
        rootFolder->GetFolderWithFlags(nsMsgFolderFlags::Queue, msgFolder);
      } else if (aFolderType ==
                 nsIMsgSend::nsMsgSaveAsDraft)  // SaveAsDraft (Drafts)
      {
        rootFolder->GetFolderWithFlags(nsMsgFolderFlags::Drafts, msgFolder);
      } else if (aFolderType ==
                 nsIMsgSend::nsMsgSaveAsTemplate)  // SaveAsTemplate (Templates)
      {
        rootFolder->GetFolderWithFlags(nsMsgFolderFlags::Templates, msgFolder);
      } else  // SaveInSentFolder (Sent) -  nsMsgDeliverNow or nsMsgSendUnsent
      {
        rootFolder->GetFolderWithFlags(nsMsgFolderFlags::SentMail, msgFolder);
      }

      if (*msgFolder) {
        return NS_OK;
      }
    }
  }
  return NS_ERROR_FAILURE;
}

//
// Figure out if a folder is local or not and return a boolean to
// say so.
//
nsresult MessageFolderIsLocal(nsIMsgIdentity* userIdentity,
                              nsMsgDeliverMode aFolderType,
                              const char* aFolderURI, bool* aResult) {
  nsresult rv;

  if (!aFolderURI) return NS_ERROR_NULL_POINTER;

  nsCOMPtr<nsIURL> url;
  rv = NS_MutateURI(NS_STANDARDURLMUTATOR_CONTRACTID)
           .SetSpec(nsDependentCString(aFolderURI))
           .Finalize(url);
  if (NS_FAILED(rv)) return rv;

  /* mailbox:/ means its local (on disk) */
  rv = url->SchemeIs("mailbox", aResult);
  if (NS_FAILED(rv)) return rv;
  return NS_OK;
}
