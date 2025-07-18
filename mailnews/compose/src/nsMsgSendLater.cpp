/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgSendLater.h"

#include "nsCOMPtr.h"
#include "nsComponentManagerUtils.h"
#include "nsDebug.h"
#include "nsIMsgCompUtils.h"
#include "nsIMsgMailNewsUrl.h"
#include "nsMsgCompFields.h"
#include "nsMsgCopy.h"
#include "nsIMsgSend.h"
#include "nsIMsgMessageService.h"
#include "nsIMsgAccountManager.h"
#include "nsMsgCompUtils.h"
#include "nsMsgUtils.h"
#include "nsMailHeaders.h"
#include "nsMsgPrompts.h"
#include "nsISmtpUrl.h"
#include "nsIChannel.h"
#include "nsNetUtil.h"
#include "nsString.h"
#include "prlog.h"
#include "prmem.h"
#include "nsIObserverService.h"
#include "nsIMsgLocalMailFolder.h"
#include "nsIMsgDatabase.h"
#include "nsIInputStream.h"
#include "nsIOutputStream.h"
#include "nsIMsgWindow.h"
#include "nsMsgMessageFlags.h"
#include "mozilla/Components.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/Services.h"
#include "mozilla/Preferences.h"

using mozilla::Preferences;

// Consts for checking and sending mail in milliseconds

// 1 second from mail into the unsent messages folder to initially trying to
// send it.
const uint32_t kInitialMessageSendTime = 1000;

extern char* MimeHeaders_get_parameter(const char* header_value,
                                       const char* parm_name, char** charset,
                                       char** language);

NS_IMPL_ISUPPORTS(nsMsgSendLater, nsIMsgSendLater, nsIFolderListener,
                  nsIRequestObserver, nsIStreamListener, nsIObserver,
                  nsIUrlListener, nsIMsgShutdownTask)

nsMsgSendLater::nsMsgSendLater() {
  mSendingMessages = false;
  mTimerSet = false;
  mTotalSentSuccessfully = 0;
  mTotalSendCount = 0;
  mLeftoverBuffer = nullptr;

  m_to = nullptr;
  m_bcc = nullptr;
  m_fcc = nullptr;
  m_messageId = nullptr;
  m_newsgroups = nullptr;
  m_headers = nullptr;
  m_flags = 0;
  m_headersFP = 0;
  m_inhead = true;
  m_headersPosition = 0;

  m_bytesRead = 0;
  m_position = 0;
  m_flagsPosition = 0;
  m_headersSize = 0;

  mIdentityKey = nullptr;
  mAccountKey = nullptr;
  mDraftInfo = nullptr;

  mUserInitiated = false;
}

nsMsgSendLater::~nsMsgSendLater() {
  PR_Free(m_to);
  PR_Free(m_fcc);
  PR_Free(m_bcc);
  PR_Free(m_newsgroups);
  PR_Free(m_headers);
  PR_Free(mLeftoverBuffer);
  PR_Free(mIdentityKey);
  PR_Free(mAccountKey);
  PR_Free(mDraftInfo);
}

nsresult nsMsgSendLater::Init() {
  // If we're not sending in the background, don't do anything else
  if (!Preferences::GetBool("mailnews.sendInBackground")) return NS_OK;

  // We need to know when we're shutting down.
  nsCOMPtr<nsIObserverService> observerService =
      mozilla::services::GetObserverService();
  NS_ENSURE_TRUE(observerService, NS_ERROR_UNEXPECTED);

  nsresult rv;
  rv = observerService->AddObserver(this, "xpcom-shutdown", false);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = observerService->AddObserver(this, "quit-application", false);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = observerService->AddObserver(this, "msg-shutdown", false);
  NS_ENSURE_SUCCESS(rv, rv);

  // Subscribe to the unsent messages folder
  // XXX This code should be set up for multiple unsent folders, however we
  // don't support that at the moment, so for now just assume one folder.
  nsCOMPtr<nsIMsgFolder> folder;
  rv = GetUnsentMessagesFolder(nullptr, getter_AddRefs(folder));
  // There doesn't have to be a nsMsgQueueForLater flagged folder.
  if (NS_FAILED(rv) || !folder) return NS_OK;

  rv = folder->AddFolderListener(this);
  NS_ENSURE_SUCCESS(rv, rv);

  // XXX may want to send messages X seconds after startup if there are any.

  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::Observe(nsISupports* aSubject, const char* aTopic,
                        const char16_t* aData) {
  if (aSubject == mTimer && !strcmp(aTopic, "timer-callback")) {
    if (mTimer)
      mTimer->Cancel();
    else
      NS_ERROR("mTimer was null in nsMsgSendLater::Observe");

    mTimerSet = false;
    // If we've already started a send since the timer fired, don't start
    // another
    if (!mSendingMessages) InternalSendMessages(false, nullptr);
  } else if (!strcmp(aTopic, "quit-application")) {
    // If the timer is set, cancel it - we're quitting, the shutdown service
    // interfaces will sort out sending etc.
    if (mTimer) mTimer->Cancel();

    mTimerSet = false;
  } else if (!strcmp(aTopic, NS_XPCOM_SHUTDOWN_OBSERVER_ID)) {
    // We're shutting down. Unsubscribe from the unsentFolder notifications
    // they aren't any use to us now, we don't want to start sending more
    // messages.
    nsresult rv;
    if (mMessageFolder) {
      nsCOMPtr<nsIMsgFolder> folder = do_QueryReferent(mMessageFolder, &rv);
      if (folder) {
        rv = folder->RemoveFolderListener(this);
        NS_ENSURE_SUCCESS(rv, rv);
        folder->ForceDBClosed();
      }
    }

    // Now remove ourselves from the observer service as well.
    nsCOMPtr<nsIObserverService> observerService =
        mozilla::services::GetObserverService();
    NS_ENSURE_TRUE(observerService, NS_ERROR_UNEXPECTED);

    rv = observerService->RemoveObserver(this, "xpcom-shutdown");
    NS_ENSURE_SUCCESS(rv, rv);

    rv = observerService->RemoveObserver(this, "quit-application");
    NS_ENSURE_SUCCESS(rv, rv);

    rv = observerService->RemoveObserver(this, "msg-shutdown");
    NS_ENSURE_SUCCESS(rv, rv);
  }

  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::SetStatusFeedback(nsIMsgStatusFeedback* aFeedback) {
  mFeedback = aFeedback;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::GetStatusFeedback(nsIMsgStatusFeedback** aFeedback) {
  NS_ENSURE_ARG_POINTER(aFeedback);
  NS_IF_ADDREF(*aFeedback = mFeedback);
  return NS_OK;
}

// Stream is done...drive on!
NS_IMETHODIMP
nsMsgSendLater::OnStopRequest(nsIRequest* request, nsresult status) {
  nsresult rv;

  // First, this shouldn't happen, but if
  // it does, flush the buffer and move on.
  if (mLeftoverBuffer) {
    DeliverQueuedLine(mLeftoverBuffer, PL_strlen(mLeftoverBuffer));
  }

  if (mOutFile) mOutFile->Close();

  // See if we succeeded on reading the message from the message store?
  //
  if (NS_SUCCEEDED(status)) {
    // Message is done...send it!
    rv = CompleteMailFileSend();

#ifdef NS_DEBUG
    printf("nsMsgSendLater: Success on getting message...\n");
#endif

    // If the send operation failed..try the next one...
    if (NS_FAILED(rv)) {
      rv = StartNextMailFileSend(rv);
      if (NS_FAILED(rv))
        EndSendMessages(rv, nullptr, mTotalSendCount, mTotalSentSuccessfully);
    }
  } else {
    nsCOMPtr<nsIChannel> channel = do_QueryInterface(request);
    if (!channel) return NS_ERROR_FAILURE;

    // extract the prompt object to use for the alert from the url....
    nsCOMPtr<nsIURI> uri;
    nsCOMPtr<mozIDOMWindowProxy> domWindow;
    if (channel) {
      channel->GetURI(getter_AddRefs(uri));
      nsCOMPtr<nsIMsgMailNewsUrl> msgUrl(do_QueryInterface(uri));
      nsCOMPtr<nsIMsgWindow> msgWindow;
      if (msgUrl) msgUrl->GetMsgWindow(getter_AddRefs(msgWindow));
      if (msgWindow) msgWindow->GetDomWindow(getter_AddRefs(domWindow));
    }

    nsMsgDisplayMessageByName(domWindow, "errorQueuedDeliveryFailed");

    // Getting the data failed, but we will still keep trying to send the
    // rest...
    rv = StartNextMailFileSend(status);
    if (NS_FAILED(rv))
      EndSendMessages(rv, nullptr, mTotalSendCount, mTotalSentSuccessfully);
  }

  return rv;
}

char* FindEOL(char* inBuf, char* buf_end) {
  char* buf = inBuf;
  char* findLoc = nullptr;

  while (buf <= buf_end)
    if (*buf == 0)
      return buf;
    else if ((*buf == '\n') || (*buf == '\r')) {
      findLoc = buf;
      break;
    } else
      ++buf;

  if (!findLoc)
    return nullptr;
  else if ((findLoc + 1) > buf_end)
    return buf;

  if ((*findLoc == '\n' && *(findLoc + 1) == '\r') ||
      (*findLoc == '\r' && *(findLoc + 1) == '\n'))
    findLoc++;  // possibly a pair.
  return findLoc;
}

nsresult nsMsgSendLater::RebufferLeftovers(char* startBuf, uint32_t aLen) {
  PR_FREEIF(mLeftoverBuffer);
  mLeftoverBuffer = (char*)PR_Malloc(aLen + 1);
  if (!mLeftoverBuffer) return NS_ERROR_OUT_OF_MEMORY;

  memcpy(mLeftoverBuffer, startBuf, aLen);
  mLeftoverBuffer[aLen] = '\0';
  return NS_OK;
}

nsresult nsMsgSendLater::BuildNewBuffer(const char* aBuf, uint32_t aCount,
                                        uint32_t* totalBufSize) {
  // Only build a buffer when there are leftovers...
  if (!mLeftoverBuffer) {
    return NS_ERROR_FAILURE;
  }

  int32_t leftoverSize = PL_strlen(mLeftoverBuffer);
  char* newBuffer = (char*)PR_Realloc(mLeftoverBuffer, aCount + leftoverSize);
  NS_ENSURE_TRUE(newBuffer, NS_ERROR_OUT_OF_MEMORY);
  mLeftoverBuffer = newBuffer;

  memcpy(mLeftoverBuffer + leftoverSize, aBuf, aCount);
  *totalBufSize = aCount + leftoverSize;
  return NS_OK;
}

// Got data?
NS_IMETHODIMP
nsMsgSendLater::OnDataAvailable(nsIRequest* request, nsIInputStream* inStr,
                                uint64_t sourceOffset, uint32_t count) {
  NS_ENSURE_ARG_POINTER(inStr);

  // This is a little bit tricky since we have to chop random
  // buffers into lines and deliver the lines...plus keeping the
  // leftovers for next time...some fun, eh?
  //
  nsresult rv = NS_OK;
  char* startBuf;
  char* endBuf;
  char* lineEnd;
  char* newbuf = nullptr;
  uint32_t size;

  uint32_t aCount = count;
  char* aBuf = (char*)PR_Malloc(aCount + 1);

  inStr->Read(aBuf, count, &aCount);

  // First, create a new work buffer that will
  if (NS_FAILED(BuildNewBuffer(aBuf, aCount, &size)))  // no leftovers...
  {
    startBuf = (char*)aBuf;
    endBuf = (char*)(aBuf + aCount - 1);
  } else  // yum, leftovers...new buffer created...sitting in mLeftoverBuffer
  {
    newbuf = mLeftoverBuffer;
    startBuf = newbuf;
    endBuf = startBuf + size - 1;
    mLeftoverBuffer = nullptr;  // null out this
  }

  while (startBuf <= endBuf) {
    lineEnd = FindEOL(startBuf, endBuf);
    if (!lineEnd) {
      rv = RebufferLeftovers(startBuf, (endBuf - startBuf) + 1);
      break;
    }

    rv = DeliverQueuedLine(startBuf, (lineEnd - startBuf) + 1);
    if (NS_FAILED(rv)) break;

    startBuf = lineEnd + 1;
  }

  PR_Free(newbuf);
  PR_Free(aBuf);
  return rv;
}

NS_IMETHODIMP
nsMsgSendLater::OnStartRunningUrl(nsIURI* url) { return NS_OK; }

NS_IMETHODIMP
nsMsgSendLater::OnStopRunningUrl(nsIURI* url, nsresult aExitCode) {
  if (NS_SUCCEEDED(aExitCode)) InternalSendMessages(mUserInitiated, mIdentity);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::OnStartRequest(nsIRequest* request) { return NS_OK; }

////////////////////////////////////////////////////////////////////////////////////
// This is the listener class for the send operation. We have to create this
// class to listen for message send completion and eventually notify the caller
////////////////////////////////////////////////////////////////////////////////////
NS_IMPL_ISUPPORTS(SendOperationListener, nsIMsgSendListener,
                  nsIMsgCopyServiceListener)

SendOperationListener::SendOperationListener(nsMsgSendLater* aSendLater)
    : mSendLater(aSendLater) {}

SendOperationListener::~SendOperationListener(void) {}

NS_IMETHODIMP
SendOperationListener::OnGetDraftFolderURI(const char* aMsgID,
                                           const nsACString& aFolderURI) {
  return NS_OK;
}

NS_IMETHODIMP
SendOperationListener::OnStartSending(const char* aMsgID, uint32_t aMsgSize) {
#ifdef NS_DEBUG
  printf("SendOperationListener::OnStartSending()\n");
#endif
  return NS_OK;
}

NS_IMETHODIMP
SendOperationListener::OnSendProgress(const char* aMsgID, uint32_t aProgress,
                                      uint32_t aProgressMax) {
#ifdef NS_DEBUG
  printf("SendOperationListener::OnSendProgress()\n");
#endif
  return NS_OK;
}

NS_IMETHODIMP
SendOperationListener::OnStatus(const char* aMsgID, const char16_t* aMsg) {
#ifdef NS_DEBUG
  printf("SendOperationListener::OnStatus()\n");
#endif

  return NS_OK;
}

NS_IMETHODIMP
SendOperationListener::OnSendNotPerformed(const char* aMsgID,
                                          nsresult aStatus) {
  return NS_OK;
}

NS_IMETHODIMP
SendOperationListener::OnStopSending(const char* aMsgID, nsresult aStatus,
                                     const char16_t* aMsg,
                                     nsIFile* returnFile) {
  if (mSendLater && !mSendLater->OnSendStepFinished(aStatus))
    mSendLater = nullptr;

  return NS_OK;
}

NS_IMETHODIMP
SendOperationListener::OnTransportSecurityError(
    const char* msgID, nsresult status, nsITransportSecurityInfo* secInfo,
    nsACString const& location) {
  return NS_OK;
}

// nsIMsgCopyServiceListener

NS_IMETHODIMP
SendOperationListener::OnStartCopy(void) { return NS_OK; }

NS_IMETHODIMP
SendOperationListener::OnProgress(uint32_t aProgress, uint32_t aProgressMax) {
  return NS_OK;
}

NS_IMETHODIMP
SendOperationListener::SetMessageKey(nsMsgKey aKey) {
  MOZ_ASSERT_UNREACHABLE("SendOperationListener::SetMessageKey()");
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP
SendOperationListener::GetMessageId(nsACString& messageId) {
  MOZ_ASSERT_UNREACHABLE("SendOperationListener::GetMessageId()");
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP
SendOperationListener::OnStopCopy(nsresult aStatus) {
  if (mSendLater) {
    mSendLater->OnCopyStepFinished(aStatus);
    mSendLater = nullptr;
  }

  return NS_OK;
}

nsresult nsMsgSendLater::CompleteMailFileSend() {
  // get the identity from the key
  // if no key, or we fail to find the identity
  // use the default identity on the default account
  nsCOMPtr<nsIMsgIdentity> identity;
  nsresult rv = GetIdentityFromKey(mIdentityKey, getter_AddRefs(identity));
  NS_ENSURE_SUCCESS(rv, rv);
  if (!identity) return NS_ERROR_UNEXPECTED;

  // If for some reason the tmp file didn't get created, we've failed here
  bool created;
  mTempFile->Exists(&created);
  if (!created) return NS_ERROR_FAILURE;

  nsCOMPtr<nsIMsgCompFields> compFields =
      do_CreateInstance("@mozilla.org/messengercompose/composefields;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgSend> pMsgSend =
      do_CreateInstance("@mozilla.org/messengercompose/send;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  // Since we have already parsed all of the headers, we are simply going to
  // set the composition fields and move on.
  nsCString author;
  mMessage->GetAuthor(author);

  nsMsgCompFields* fields = (nsMsgCompFields*)compFields.get();

  fields->SetFrom(author.get());

  if (m_to) {
    fields->SetTo(m_to);
  }

  if (m_bcc) {
    fields->SetBcc(m_bcc);
  }

  if (m_fcc) {
    fields->SetFcc(m_fcc);
  }

  char* messageId = m_messageId;

  if (!messageId) {
    // If the message headers don't include a message ID, generate one.
    // Otherwise, the message won't be able to send with some protocols (e.g.
    // SMTP).
    nsCOMPtr<nsIMsgCompUtils> compUtils =
        do_CreateInstance("@mozilla.org/messengercompose/computils;1", &rv);
    NS_ENSURE_SUCCESS(rv, rv);

    nsCString newMessageId;
    rv = compUtils->MsgGenerateMessageId(identity, ""_ns, newMessageId);
    NS_ENSURE_SUCCESS(rv, rv);

    messageId = ToNewCString(newMessageId);
  }

  fields->SetMessageId(messageId);

  if (m_newsgroups) fields->SetNewsgroups(m_newsgroups);

  // Extract the returnReceipt, receiptHeaderType and DSN from the draft info.
  if (mDraftInfo) {
    char* param =
        MimeHeaders_get_parameter(mDraftInfo, "receipt", nullptr, nullptr);
    if (!param || strcmp(param, "0") == 0) {
      fields->SetReturnReceipt(false);
    } else {
      int receiptType = 0;
      fields->SetReturnReceipt(true);
      sscanf(param, "%d", &receiptType);
      fields->SetReceiptHeaderType(((int32_t)receiptType) - 1);
    }
    PR_FREEIF(param);
    param = MimeHeaders_get_parameter(mDraftInfo, "DSN", nullptr, nullptr);
    fields->SetDSN(param && strcmp(param, "1") == 0);
    PR_FREEIF(param);
  }

  // Create the listener for the send operation...
  RefPtr<SendOperationListener> sendListener = new SendOperationListener(this);

  RefPtr<mozilla::dom::Promise> promise;
  rv = pMsgSend->SendMessageFile(
      identity, mAccountKey,
      compFields,                   // nsIMsgCompFields *fields,
      mTempFile,                    // nsIFile *sendFile,
      true,                         // bool deleteSendFileOnCompletion,
      false,                        // bool digest_p,
      nsIMsgSend::nsMsgSendUnsent,  // nsMsgDeliverMode mode,
      nullptr,                      // nsIMsgDBHdr *msgToReplace,
      sendListener, mFeedback, nullptr, getter_AddRefs(promise));
  return rv;
}

nsresult nsMsgSendLater::StartNextMailFileSend(nsresult prevStatus) {
  if (mTotalSendCount >= (uint32_t)mMessagesToSend.Count()) {
    // Notify that this message has finished being sent.
    NotifyListenersOnProgress(mTotalSendCount, mMessagesToSend.Count(), 100,
                              100);

    // EndSendMessages resets everything for us
    EndSendMessages(prevStatus, nullptr, mTotalSendCount,
                    mTotalSentSuccessfully);

    // XXX Should we be releasing references so that we don't hold onto items
    // unnecessarily.
    return NS_OK;
  }

  // If we've already sent a message, and are sending more, send out a progress
  // update with 100% for both send and copy as we must have finished by now.
  if (mTotalSendCount > 0) {
    NotifyListenersOnProgress(mTotalSendCount, mMessagesToSend.Count(), 100,
                              100);
  }

  mMessage = mMessagesToSend[mTotalSendCount++];

  if (!mMessageFolder) return NS_ERROR_UNEXPECTED;

  nsCString messageURI;
  nsresult rv;
  nsCOMPtr<nsIMsgFolder> folder = do_QueryReferent(mMessageFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  folder->GetUriForMsg(mMessage, messageURI);

  rv = nsMsgCreateTempFile("nsqmail.tmp", getter_AddRefs(mTempFile));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgMessageService> messageService;
  rv = GetMessageServiceFromURI(messageURI, getter_AddRefs(messageService));
  if (NS_FAILED(rv) && !messageService) return NS_ERROR_FACTORY_NOT_LOADED;

  nsCString identityKey;
  rv = mMessage->GetStringProperty(HEADER_X_MOZILLA_IDENTITY_KEY, identityKey);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgIdentity> identity;
  rv = GetIdentityFromKey(identityKey.get(), getter_AddRefs(identity));
  NS_ENSURE_SUCCESS(rv, rv);
  if (!identity) return NS_ERROR_UNEXPECTED;

  // Notify that we're just about to start sending this message
  NotifyListenersOnMessageStartSending(mTotalSendCount, mMessagesToSend.Count(),
                                       identity);

  // Setup what we need to parse the data stream correctly
  m_inhead = true;
  m_headersFP = 0;
  m_headersPosition = 0;
  m_bytesRead = 0;
  m_position = 0;
  m_flagsPosition = 0;
  m_headersSize = 0;
  PR_FREEIF(mLeftoverBuffer);

  nsCOMPtr<nsIURI> dummyNull;
  rv = messageService->StreamMessage(messageURI, this, nullptr, nullptr, false,
                                     ""_ns, false, getter_AddRefs(dummyNull));
  return rv;
}

NS_IMETHODIMP
nsMsgSendLater::GetUnsentMessagesFolder(nsIMsgIdentity* aIdentity,
                                        nsIMsgFolder** aFolder) {
  nsresult rv = NS_OK;
  nsCOMPtr<nsIMsgFolder> folder = do_QueryReferent(mMessageFolder);
  if (!folder) {
    nsCString uri;
    GetFolderURIFromUserPrefs(nsIMsgSend::nsMsgQueueForLater, aIdentity, uri);
    rv = LocateMessageFolder(aIdentity, nsIMsgSend::nsMsgQueueForLater,
                             uri.get(), getter_AddRefs(folder));
    mMessageFolder = do_GetWeakReference(folder);
    if (!mMessageFolder) return NS_ERROR_FAILURE;
  }
  if (folder) folder.forget(aFolder);
  return rv;
}

NS_IMETHODIMP
nsMsgSendLater::HasUnsentMessages(nsIMsgIdentity* aIdentity, bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = false;
  nsresult rv;

  nsCOMPtr<nsIMsgAccountManager> accountManager =
      mozilla::components::AccountManager::Service();
  nsTArray<RefPtr<nsIMsgAccount>> accounts;
  rv = accountManager->GetAccounts(accounts);
  NS_ENSURE_SUCCESS(rv, rv);

  if (accounts.IsEmpty())
    return NS_OK;  // no account set up -> no unsent messages

  // XXX This code should be set up for multiple unsent folders, however we
  // don't support that at the moment, so for now just assume one folder.
  if (!mMessageFolder) {
    nsCOMPtr<nsIMsgFolder> folder;
    rv = GetUnsentMessagesFolder(nullptr, getter_AddRefs(folder));
    // There doesn't have to be a nsMsgQueueForLater flagged folder.
    if (NS_FAILED(rv) || !folder) return NS_OK;
  }
  rv = ReparseDBIfNeeded(nullptr);
  NS_ENSURE_SUCCESS(rv, rv);

  int32_t totalMessages;
  nsCOMPtr<nsIMsgFolder> folder = do_QueryReferent(mMessageFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = folder->GetTotalMessages(false, &totalMessages);
  NS_ENSURE_SUCCESS(rv, rv);

  *aResult = totalMessages > 0;
  return NS_OK;
}

//
// To really finalize this capability, we need to have the ability to get
// the message from the mail store in a stream for processing. The flow
// would be something like this:
//
//      foreach (message in Outbox folder)
//         get stream of Nth message
//         if (not done with headers)
//            Tack on to current buffer of headers
//         when done with headers
//            BuildHeaders()
//            Write Headers to Temp File
//         after done with headers
//            write rest of message body to temp file
//
//          when done with the message
//            do send operation
//
//          when send is complete
//            Copy from Outbox to FCC folder
//            Delete from Outbox folder
//
//
NS_IMETHODIMP
nsMsgSendLater::SendUnsentMessages(nsIMsgIdentity* aIdentity) {
  return InternalSendMessages(true, aIdentity);
}

// Returns NS_OK if the db is OK, an error otherwise, e.g., we had to reparse.
nsresult nsMsgSendLater::ReparseDBIfNeeded(nsIUrlListener* aListener) {
  // This will kick off a reparse, if needed. So the next time we check if
  // there are unsent messages, the db will be up to date.
  nsCOMPtr<nsIMsgDatabase> unsentDB;
  nsresult rv;
  nsCOMPtr<nsIMsgLocalMailFolder> locFolder(
      do_QueryReferent(mMessageFolder, &rv));
  NS_ENSURE_SUCCESS(rv, rv);
  return locFolder->GetDatabaseWithReparse(aListener, nullptr,
                                           getter_AddRefs(unsentDB));
}

nsresult nsMsgSendLater::InternalSendMessages(bool aUserInitiated,
                                              nsIMsgIdentity* aIdentity) {
  if (WeAreOffline()) return NS_MSG_ERROR_OFFLINE;

  // Protect against being called whilst we're already sending.
  if (mSendingMessages) {
    NS_ERROR("nsMsgSendLater is already sending messages");
    return NS_ERROR_FAILURE;
  }

  nsresult rv;

  // XXX This code should be set up for multiple unsent folders, however we
  // don't support that at the moment, so for now just assume one folder.
  if (!mMessageFolder) {
    nsCOMPtr<nsIMsgFolder> folder;
    rv = GetUnsentMessagesFolder(nullptr, getter_AddRefs(folder));
    if (NS_FAILED(rv) || !folder) return NS_ERROR_FAILURE;
  }
  nsCOMPtr<nsIMsgDatabase> unsentDB;
  // Remember these in case we need to reparse the db.
  mUserInitiated = aUserInitiated;
  mIdentity = aIdentity;
  rv = ReparseDBIfNeeded(this);
  NS_ENSURE_SUCCESS(rv, rv);
  mIdentity = nullptr;  // don't hold onto the identity since we're a service.

  nsCOMPtr<nsIMsgFolder> folder = do_QueryReferent(mMessageFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsIMsgEnumerator> enumerator;
  rv = folder->GetMessages(getter_AddRefs(enumerator));
  NS_ENSURE_SUCCESS(rv, rv);

  // Build mMessagesToSend array.
  bool hasMoreElements = false;
  while (NS_SUCCEEDED(enumerator->HasMoreElements(&hasMoreElements)) &&
         hasMoreElements) {
    nsCOMPtr<nsIMsgDBHdr> messageHeader;
    rv = enumerator->GetNext(getter_AddRefs(messageHeader));
    if (NS_SUCCEEDED(rv)) {
      if (aUserInitiated) {
        // If the user initiated the send, add all messages
        mMessagesToSend.AppendObject(messageHeader);
      } else {
        // Else just send those that are NOT marked as Queued.
        uint32_t flags;
        rv = messageHeader->GetFlags(&flags);
        if (NS_SUCCEEDED(rv) && !(flags & nsMsgMessageFlags::Queued))
          mMessagesToSend.AppendObject(messageHeader);
      }
    }
  }

  // We're now sending messages so its time to signal that and reset our counts.
  mSendingMessages = true;
  mTotalSentSuccessfully = 0;
  mTotalSendCount = 0;

  // Notify the listeners that we are starting a send.
  NotifyListenersOnStartSending(mMessagesToSend.Count());

  return StartNextMailFileSend(NS_OK);
}

nsresult nsMsgSendLater::SetOrigMsgDisposition() {
  if (!mMessage) return NS_ERROR_NULL_POINTER;

  // We're finished sending a queued message. We need to look at mMessage
  // and see if we need to set replied/forwarded
  // flags for the original message that this message might be a reply to
  // or forward of.
  nsCString originalMsgURIs;
  nsCString queuedDisposition;
  mMessage->GetStringProperty(ORIG_URI_PROPERTY, originalMsgURIs);
  mMessage->GetStringProperty(QUEUED_DISPOSITION_PROPERTY, queuedDisposition);
  if (!queuedDisposition.IsEmpty()) {
    nsTArray<nsCString> uriArray;
    ParseString(originalMsgURIs, ',', uriArray);
    for (uint32_t i = 0; i < uriArray.Length(); i++) {
      nsCOMPtr<nsIMsgDBHdr> msgHdr;
      nsresult rv = GetMsgDBHdrFromURI(uriArray[i], getter_AddRefs(msgHdr));
      NS_ENSURE_SUCCESS(rv, rv);
      if (msgHdr) {
        // get the folder for the message resource
        nsCOMPtr<nsIMsgFolder> msgFolder;
        msgHdr->GetFolder(getter_AddRefs(msgFolder));
        if (msgFolder) {
          nsMsgDispositionState dispositionSetting =
              nsIMsgFolder::nsMsgDispositionState_None;
          if (queuedDisposition.EqualsLiteral("replied"))
            dispositionSetting = nsIMsgFolder::nsMsgDispositionState_Replied;
          else if (queuedDisposition.EqualsLiteral("forwarded"))
            dispositionSetting = nsIMsgFolder::nsMsgDispositionState_Forwarded;
          else if (queuedDisposition.EqualsLiteral("redirected"))
            dispositionSetting = nsIMsgFolder::nsMsgDispositionState_Redirected;

          msgFolder->AddMessageDispositionState(msgHdr, dispositionSetting);
        }
      }
    }
  }
  return NS_OK;
}

nsresult nsMsgSendLater::DeleteCurrentMessage() {
  if (!mMessage) {
    NS_ERROR("nsMsgSendLater: Attempt to delete an already deleted message");
    return NS_OK;
  }

  // Get the composition fields interface
  if (!mMessageFolder) return NS_ERROR_UNEXPECTED;
  nsresult rv;
  nsCOMPtr<nsIMsgFolder> folder = do_QueryReferent(mMessageFolder, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  rv = folder->DeleteMessages({&*mMessage}, nullptr, true, false, nullptr,
                              false /*allowUndo*/);
  if (NS_FAILED(rv)) return NS_ERROR_FAILURE;

  // Null out the message so we don't try and delete it again.
  mMessage = nullptr;

  return NS_OK;
}

//
// This function parses the headers, and also deletes from the header block
// any headers which should not be delivered in mail, regardless of whether
// they were present in the queue file.  Such headers include: BCC, FCC,
// Sender, X-Mozilla-Status, X-Mozilla-News-Host, and Content-Length.
// (Content-Length is for the disk file only, and must not be allowed to
// escape onto the network, since it depends on the local linebreak
// representation.  Arguably, we could allow Lines to escape, but it's not
// required by NNTP.)
//
nsresult nsMsgSendLater::BuildHeaders() {
  char* buf = m_headers;
  char* buf_end = buf + m_headersFP;

  PR_FREEIF(m_to);
  PR_FREEIF(m_bcc);
  PR_FREEIF(m_newsgroups);
  PR_FREEIF(m_fcc);
  PR_FREEIF(mIdentityKey);
  PR_FREEIF(mAccountKey);
  m_flags = 0;

  while (buf < buf_end) {
    bool prune_p = false;
    bool do_flags_p = false;
    char* colon = PL_strchr(buf, ':');
    char* end;
    char* value = 0;
    char** header = 0;
    char* header_start = buf;

    if (!colon) break;

    end = colon;
    while (end > buf && (*end == ' ' || *end == '\t')) end--;

    switch (buf[0]) {
      case 'B':
      case 'b':
        if (!PL_strncasecmp("BCC", buf, end - buf)) {
          header = &m_bcc;
        }
        break;
      case 'C':
      case 'c':
        if (!PL_strncasecmp("CC", buf, end - buf))
          header = &m_to;
        else if (!PL_strncasecmp(HEADER_CONTENT_LENGTH, buf, end - buf))
          prune_p = true;
        break;
      case 'F':
      case 'f':
        if (!PL_strncasecmp("FCC", buf, end - buf)) {
          header = &m_fcc;
          prune_p = true;
        }
        break;
      case 'L':
      case 'l':
        if (!PL_strncasecmp("Lines", buf, end - buf)) prune_p = true;
        break;
      case 'M':
      case 'm':
        if (!PL_strncasecmp("Message-ID", buf, end - buf))
          header = &m_messageId;
        break;
      case 'N':
      case 'n':
        if (!PL_strncasecmp("Newsgroups", buf, end - buf))
          header = &m_newsgroups;
        break;
      case 'S':
      case 's':
        if (!PL_strncasecmp("Sender", buf, end - buf)) prune_p = true;
        break;
      case 'T':
      case 't':
        if (!PL_strncasecmp("To", buf, end - buf)) header = &m_to;
        break;
      case 'X':
      case 'x': {
        if (buf + strlen(HEADER_X_MOZILLA_STATUS2) == end &&
            !PL_strncasecmp(HEADER_X_MOZILLA_STATUS2, buf, end - buf))
          prune_p = true;
        else if (buf + strlen(HEADER_X_MOZILLA_STATUS) == end &&
                 !PL_strncasecmp(HEADER_X_MOZILLA_STATUS, buf, end - buf))
          prune_p = do_flags_p = true;
        else if (!PL_strncasecmp(HEADER_X_MOZILLA_DRAFT_INFO, buf, end - buf)) {
          prune_p = true;
          header = &mDraftInfo;
        } else if (!PL_strncasecmp(HEADER_X_MOZILLA_KEYWORDS, buf, end - buf))
          prune_p = true;
        else if (!PL_strncasecmp(HEADER_X_MOZILLA_NEWSHOST, buf, end - buf)) {
          prune_p = true;
        } else if (!PL_strncasecmp(HEADER_X_MOZILLA_IDENTITY_KEY, buf,
                                   end - buf)) {
          prune_p = true;
          header = &mIdentityKey;
        } else if (!PL_strncasecmp(HEADER_X_MOZILLA_ACCOUNT_KEY, buf,
                                   end - buf)) {
          prune_p = true;
          header = &mAccountKey;
        }
        break;
      }
    }

    buf = colon + 1;
    while (*buf == ' ' || *buf == '\t') buf++;

    value = buf;

  SEARCH_NEWLINE:
    while (*buf != 0 && *buf != '\r' && *buf != '\n') buf++;

    if (buf + 1 >= buf_end)
      ;
    // If "\r\n " or "\r\n\t" is next, that doesn't terminate the header.
    else if (buf + 2 < buf_end && (buf[0] == '\r' && buf[1] == '\n') &&
             (buf[2] == ' ' || buf[2] == '\t')) {
      buf += 3;
      goto SEARCH_NEWLINE;
    }
    // If "\r " or "\r\t" or "\n " or "\n\t" is next, that doesn't terminate
    // the header either.
    else if ((buf[0] == '\r' || buf[0] == '\n') &&
             (buf[1] == ' ' || buf[1] == '\t')) {
      buf += 2;
      goto SEARCH_NEWLINE;
    }

    if (header) {
      int L = buf - value;
      if (*header) {
        char* newh = (char*)PR_Realloc((*header), PL_strlen(*header) + L + 10);
        if (!newh) return NS_ERROR_OUT_OF_MEMORY;
        *header = newh;
        newh = (*header) + PL_strlen(*header);
        *newh++ = ',';
        *newh++ = ' ';
        memcpy(newh, value, L);
        newh[L] = 0;
      } else {
        *header = (char*)PR_Malloc(L + 1);
        if (!*header) return NS_ERROR_OUT_OF_MEMORY;
        memcpy((*header), value, L);
        (*header)[L] = 0;
      }
    } else if (do_flags_p) {
      char* s = value;
      PR_ASSERT(*s != ' ' && *s != '\t');
      NS_ASSERTION(MsgIsHex(s, 4), "Expected 4 hex digits for flags.");
      m_flags = MsgUnhex(s, 4);
    }

    if (*buf == '\r' || *buf == '\n') {
      if (*buf == '\r' && buf[1] == '\n') buf++;
      buf++;
    }

    if (prune_p) {
      char* to = header_start;
      char* from = buf;
      while (from < buf_end) *to++ = *from++;
      buf = header_start;
      buf_end = to;
      m_headersFP = buf_end - m_headers;
    }
  }

  m_headers[m_headersFP++] = '\r';
  m_headers[m_headersFP++] = '\n';

  // Now we have parsed out all of the headers we need and we
  // can proceed.
  return NS_OK;
}

nsresult DoGrowBuffer(int32_t desired_size, int32_t element_size,
                      int32_t quantum, char** buffer, int32_t* size) {
  if (*size <= desired_size) {
    char* new_buf;
    int32_t increment = desired_size - *size;
    if (increment < quantum)  // always grow by a minimum of N bytes
      increment = quantum;

    new_buf =
        (*buffer ? (char*)PR_Realloc(*buffer, (*size + increment) *
                                                  (element_size / sizeof(char)))
                 : (char*)PR_Malloc((*size + increment) *
                                    (element_size / sizeof(char))));
    if (!new_buf) return NS_ERROR_OUT_OF_MEMORY;
    *buffer = new_buf;
    *size += increment;
  }
  return NS_OK;
}

#define do_grow_headers(desired_size)                                 \
  (((desired_size) >= m_headersSize)                                  \
       ? DoGrowBuffer((desired_size), sizeof(char), 1024, &m_headers, \
                      &m_headersSize)                                 \
       : NS_OK)

nsresult nsMsgSendLater::DeliverQueuedLine(const char* line, int32_t length) {
  int32_t flength = length;

  m_bytesRead += length;

  // convert existing newline to CRLF
  // Don't need this because the calling routine is taking care of it.
  //  if (length > 0 && (line[length-1] == '\r' ||
  //     (line[length-1] == '\n' && (length < 2 || line[length-2] != '\r'))))
  //  {
  //    line[length-1] = '\r';
  //    line[length++] = '\n';
  //  }
  //
  //
  // We are going to check if we are looking at a "From - " line. If so,
  // then just eat it and return NS_OK
  //
  if (!PL_strncasecmp(line, "From - ", 7)) return NS_OK;

  if (m_inhead) {
    if (m_headersPosition == 0) {
      // This line is the first line in a header block.
      // Remember its position.
      m_headersPosition = m_position;

      // Also, since we're now processing the headers, clear out the
      // slots which we will parse data into, so that the values that
      // were used the last time around do not persist.

      // We must do that here, and not in the previous clause of this
      // `else' (the "I've just seen a `From ' line clause") because
      // that clause happens before delivery of the previous message is
      // complete, whereas this clause happens after the previous msg
      // has been delivered.  If we did this up there, then only the
      // last message in the folder would ever be able to be both
      // mailed and posted (or fcc'ed.)
      PR_FREEIF(m_to);
      PR_FREEIF(m_bcc);
      PR_FREEIF(m_newsgroups);
      PR_FREEIF(m_fcc);
      PR_FREEIF(mIdentityKey);
    }

    if (line[0] == '\r' || line[0] == '\n' || line[0] == 0) {
      // End of headers.  Now parse them; open the temp file;
      // and write the appropriate subset of the headers out.
      m_inhead = false;

      nsresult rv = MsgNewBufferedFileOutputStream(getter_AddRefs(mOutFile),
                                                   mTempFile, -1, 00600);
      NS_ENSURE_SUCCESS(rv, rv);

      nsresult status = BuildHeaders();
      if (NS_FAILED(status)) return status;

      uint32_t n;
      rv = mOutFile->Write(m_headers, m_headersFP, &n);
      NS_ENSURE_SUCCESS(rv, rv);
      if (n != (uint32_t)m_headersFP) return NS_ERROR_FAILURE;
    } else {
      // Otherwise, this line belongs to a header.  So append it to the
      // header data.

      if (!PL_strncasecmp(line, HEADER_X_MOZILLA_STATUS,
                          PL_strlen(HEADER_X_MOZILLA_STATUS)))
        // Notice the position of the flags.
        m_flagsPosition = m_position;
      else if (m_headersFP == 0)
        m_flagsPosition = 0;

      nsresult status = do_grow_headers(length + m_headersFP + 10);
      if (NS_FAILED(status)) return status;

      memcpy(m_headers + m_headersFP, line, length);
      m_headersFP += length;
    }
  } else {
    // This is a body line.  Write it to the file.
    PR_ASSERT(mOutFile);
    if (mOutFile) {
      uint32_t wrote;
      nsresult rv = mOutFile->Write(line, length, &wrote);
      NS_ENSURE_SUCCESS(rv, rv);
      if (wrote < (uint32_t)length) return NS_ERROR_FAILURE;
    }
  }

  m_position += flength;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::AddListener(nsIMsgSendLaterListener* aListener) {
  NS_ENSURE_ARG_POINTER(aListener);
  mListenerArray.AppendElement(aListener);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::RemoveListener(nsIMsgSendLaterListener* aListener) {
  NS_ENSURE_ARG_POINTER(aListener);
  return mListenerArray.RemoveElement(aListener) ? NS_OK : NS_ERROR_INVALID_ARG;
}

NS_IMETHODIMP
nsMsgSendLater::GetSendingMessages(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = mSendingMessages;
  return NS_OK;
}

#define NOTIFY_LISTENERS(propertyfunc_, params_)                             \
  PR_BEGIN_MACRO                                                             \
  nsTObserverArray<nsCOMPtr<nsIMsgSendLaterListener>>::ForwardIterator iter( \
      mListenerArray);                                                       \
  nsCOMPtr<nsIMsgSendLaterListener> listener;                                \
  while (iter.HasMore()) {                                                   \
    listener = iter.GetNext();                                               \
    listener->propertyfunc_ params_;                                         \
  }                                                                          \
  PR_END_MACRO

void nsMsgSendLater::NotifyListenersOnStartSending(
    uint32_t aTotalMessageCount) {
  NOTIFY_LISTENERS(OnStartSending, (aTotalMessageCount));
}

void nsMsgSendLater::NotifyListenersOnMessageStartSending(
    uint32_t aCurrentMessage, uint32_t aTotalMessage,
    nsIMsgIdentity* aIdentity) {
  NOTIFY_LISTENERS(OnMessageStartSending,
                   (aCurrentMessage, aTotalMessage, mMessage, aIdentity));
}

void nsMsgSendLater::NotifyListenersOnProgress(uint32_t aCurrentMessage,
                                               uint32_t aTotalMessage,
                                               uint32_t aSendPercent,
                                               uint32_t aCopyPercent) {
  NOTIFY_LISTENERS(OnMessageSendProgress, (aCurrentMessage, aTotalMessage,
                                           aSendPercent, aCopyPercent));
}

void nsMsgSendLater::NotifyListenersOnMessageSendError(uint32_t aCurrentMessage,
                                                       nsresult aStatus,
                                                       const char16_t* aMsg) {
  NOTIFY_LISTENERS(OnMessageSendError,
                   (aCurrentMessage, mMessage, aStatus, aMsg));
}

/**
 * This function is called to end sending of messages, it resets the send later
 * system and notifies the relevant parties that we have finished.
 */
void nsMsgSendLater::EndSendMessages(nsresult aStatus, const char16_t* aMsg,
                                     uint32_t aTotalTried,
                                     uint32_t aSuccessful) {
  // Catch-all, we may have had an issue sending, so we may not be calling
  // StartNextMailFileSend to fully finish the sending. Therefore set
  // mSendingMessages to false here so that we don't think we're still trying
  // to send messages
  mSendingMessages = false;

  // Clear out our array of messages.
  mMessagesToSend.Clear();

  nsresult rv;
  nsCOMPtr<nsIMsgFolder> folder = do_QueryReferent(mMessageFolder, &rv);
  NS_ENSURE_SUCCESS(rv, );
  // We don't need to keep hold of the database now we've finished sending.
  (void)folder->SetMsgDatabase(nullptr);

  // or temp file or output stream
  mTempFile = nullptr;
  mOutFile = nullptr;

  NOTIFY_LISTENERS(OnStopSending, (aStatus, aMsg, aTotalTried, aSuccessful));

  // If we've got a shutdown listener, notify it that we've finished.
  if (mShutdownListener) {
    mShutdownListener->OnStopRunningUrl(nullptr, NS_OK);
    mShutdownListener = nullptr;
  }
}

/**
 * Called when the send part of sending a message is finished. This will set up
 * for the next step or "end" depending on the status.
 *
 * @param aStatus  The success or fail result of the send step.
 * @return         True if the copy process will continue, false otherwise.
 */
bool nsMsgSendLater::OnSendStepFinished(nsresult aStatus) {
  if (NS_SUCCEEDED(aStatus)) {
    SetOrigMsgDisposition();
    DeleteCurrentMessage();

    // Send finished, so that is now 100%, copy to proceed...
    NotifyListenersOnProgress(mTotalSendCount, mMessagesToSend.Count(), 100, 0);

    ++mTotalSentSuccessfully;
    return true;
  } else {
    // XXX we don't currently get a message string from the send service.
    NotifyListenersOnMessageSendError(mTotalSendCount, aStatus, nullptr);
    nsresult rv = StartNextMailFileSend(aStatus);
    // if this is the last message we're sending, we should report
    // the status failure.
    if (NS_FAILED(rv))
      EndSendMessages(rv, nullptr, mTotalSendCount, mTotalSentSuccessfully);
  }
  return false;
}

/**
 * Called when the copy part of sending a message is finished. This will send
 * the next message or handle failure as appropriate.
 *
 * @param aStatus  The success or fail result of the copy step.
 */
void nsMsgSendLater::OnCopyStepFinished(nsresult aStatus) {
  // Regardless of the success of the copy we will still keep trying
  // to send the rest...
  nsresult rv = StartNextMailFileSend(aStatus);
  if (NS_FAILED(rv))
    EndSendMessages(rv, nullptr, mTotalSendCount, mTotalSentSuccessfully);
}

// XXX todo
// maybe this should just live in the account manager?
nsresult nsMsgSendLater::GetIdentityFromKey(const char* aKey,
                                            nsIMsgIdentity** aIdentity) {
  NS_ENSURE_ARG_POINTER(aIdentity);

  nsresult rv;
  nsCOMPtr<nsIMsgAccountManager> accountManager =
      mozilla::components::AccountManager::Service();

  if (aKey) {
    nsTArray<RefPtr<nsIMsgIdentity>> identities;
    if (NS_SUCCEEDED(accountManager->GetAllIdentities(identities))) {
      for (auto lookupIdentity : identities) {
        nsCString key;
        lookupIdentity->GetKey(key);
        if (key.Equals(aKey)) {
          lookupIdentity.forget(aIdentity);
          return NS_OK;
        }
      }
    }
  }

  // If no aKey, or we failed to find the identity from the key
  // use the identity from the default account.
  nsCOMPtr<nsIMsgAccount> defaultAccount;
  rv = accountManager->GetDefaultAccount(getter_AddRefs(defaultAccount));
  NS_ENSURE_SUCCESS(rv, rv);

  if (defaultAccount)
    rv = defaultAccount->GetDefaultIdentity(aIdentity);
  else
    *aIdentity = nullptr;

  return rv;
}

nsresult nsMsgSendLater::StartTimer() {
  // No need to trigger if timer is already set
  if (mTimerSet) return NS_OK;

  // XXX only trigger for non-queued headers

  // Items from this function return NS_OK because the callee won't care about
  // the result anyway.
  nsresult rv;
  if (!mTimer) {
    mTimer = do_CreateInstance("@mozilla.org/timer;1", &rv);
    NS_ENSURE_SUCCESS(rv, NS_OK);
  }

  rv = mTimer->Init(static_cast<nsIObserver*>(this), kInitialMessageSendTime,
                    nsITimer::TYPE_ONE_SHOT);
  NS_ENSURE_SUCCESS(rv, NS_OK);

  mTimerSet = true;

  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::OnFolderAdded(nsIMsgFolder* /*parent*/,
                              nsIMsgFolder* /*child*/) {
  return StartTimer();
}

NS_IMETHODIMP
nsMsgSendLater::OnMessageAdded(nsIMsgFolder* /*parent*/, nsIMsgDBHdr* /*msg*/) {
  return StartTimer();
}

NS_IMETHODIMP
nsMsgSendLater::OnFolderRemoved(nsIMsgFolder* /*parent*/,
                                nsIMsgFolder* /*child*/) {
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::OnMessageRemoved(nsIMsgFolder* /*parent*/,
                                 nsIMsgDBHdr* /*msg*/) {
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::OnFolderPropertyChanged(nsIMsgFolder* aFolder,
                                        const nsACString& aProperty,
                                        const nsACString& aOldValue,
                                        const nsACString& aNewValue) {
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::OnFolderIntPropertyChanged(nsIMsgFolder* aFolder,
                                           const nsACString& aProperty,
                                           int64_t aOldValue,
                                           int64_t aNewValue) {
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::OnFolderBoolPropertyChanged(nsIMsgFolder* aFolder,
                                            const nsACString& aProperty,
                                            bool aOldValue, bool aNewValue) {
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::OnFolderPropertyFlagChanged(nsIMsgDBHdr* aMsg,
                                            const nsACString& aProperty,
                                            uint32_t aOldValue,
                                            uint32_t aNewValue) {
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::OnFolderEvent(nsIMsgFolder* aFolder, const nsACString& aEvent) {
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::GetNeedsToRunTask(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = mSendingMessages;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSendLater::DoShutdownTask(nsIUrlListener* aListener, nsIMsgWindow* aWindow,
                               bool* aResult) {
  if (mTimer) mTimer->Cancel();
  // If we're already sending messages, nothing to do, but save the shutdown
  // listener until we've finished.
  if (mSendingMessages) {
    mShutdownListener = aListener;
    return NS_OK;
  }
  // Else we have pending messages, we need to throw up a dialog to find out
  // if to send them or not.

  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP
nsMsgSendLater::GetCurrentTaskName(nsAString& aResult) {
  // XXX Bug 440794 will localize this, left as non-localized whilst we decide
  // on the actual strings and try out the UI.
  aResult = u"Sending Messages"_ns;
  return NS_OK;
}
