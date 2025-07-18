/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <mapidefs.h>
#include <mapi.h>
#include <winstring.h>
#include "msgMapiImp.h"
#include "msgMapiFactory.h"
#include "msgMapiMain.h"

#include "nsIMsgCompFields.h"
#include "msgMapiHook.h"
#include "nsString.h"
#include "nsCOMPtr.h"
#include "nsISupports.h"
#include "nsIMsgDatabase.h"
#include "nsMsgFolderFlags.h"
#include "nsIMsgHdr.h"
#include "MailNewsTypes.h"
#include "nsIMsgAccountManager.h"
#include "nsIMsgFolder.h"
#include "nsIMsgImapMailFolder.h"
#include <time.h>
#include "nsIInputStream.h"
#include "nsILineInputStream.h"
#include "nsISeekableStream.h"
#include "nsIFile.h"
#include "nsIFileStreams.h"
#include "nsNetCID.h"
#include "nsMsgMessageFlags.h"
#include "mozilla/mailnews/MimeHeaderParser.h"
#include "mozilla/Components.h"
#include "mozilla/ErrorNames.h"
#include "mozilla/Logging.h"

using namespace mozilla::mailnews;

mozilla::LazyLogModule MAPI("MAPI");

CMapiImp::CMapiImp() : m_cRef(1) { m_Lock = PR_NewLock(); }

CMapiImp::~CMapiImp() {
  if (m_Lock) PR_DestroyLock(m_Lock);
}

STDMETHODIMP CMapiImp::QueryInterface(const IID& aIid, void** aPpv) {
  if (aIid == IID_IUnknown) {
    *aPpv = static_cast<nsIMapi*>(this);
  } else if (aIid == IID_nsIMapi) {
    *aPpv = static_cast<nsIMapi*>(this);
  } else {
    *aPpv = nullptr;
    return E_NOINTERFACE;
  }

  reinterpret_cast<IUnknown*>(*aPpv)->AddRef();
  return S_OK;
}

STDMETHODIMP_(ULONG) CMapiImp::AddRef() { return ++m_cRef; }

STDMETHODIMP_(ULONG) CMapiImp::Release() {
  int32_t temp = --m_cRef;
  if (m_cRef == 0) {
    delete this;
    return 0;
  }

  return temp;
}

STDMETHODIMP CMapiImp::IsValid() { return S_OK; }

STDMETHODIMP CMapiImp::IsValidSession(unsigned long aSession) {
  nsMAPIConfiguration* pConfig = nsMAPIConfiguration::GetMAPIConfiguration();
  if (pConfig && pConfig->IsSessionValid(aSession)) return S_OK;

  return E_FAIL;
}

STDMETHODIMP CMapiImp::Initialize() {
  HRESULT hr = E_FAIL;

  if (!m_Lock) return E_FAIL;

  PR_Lock(m_Lock);

  // Initialize MAPI Configuration

  nsMAPIConfiguration* pConfig = nsMAPIConfiguration::GetMAPIConfiguration();
  if (pConfig != nullptr) hr = S_OK;

  PR_Unlock(m_Lock);

  return hr;
}

STDMETHODIMP CMapiImp::Login(unsigned long aUIArg, LPSTR aLogin,
                             LPSTR aPassWord, unsigned long aFlags,
                             unsigned long* aSessionId) {
  HRESULT hr = E_FAIL;
  bool bNewSession = false;
  nsCString id_key;

  MOZ_LOG(MAPI, mozilla::LogLevel::Debug,
          ("CMapiImp::Login using flags %lu", aFlags));
  if (aFlags & MAPI_NEW_SESSION) bNewSession = true;

  // Check For Profile Name
  if (aLogin != nullptr && aLogin[0] != '\0') {
    if (!nsMapiHook::VerifyUserName(nsDependentCString(aLogin), id_key)) {
      *aSessionId = MAPI_E_LOGIN_FAILURE;
      MOZ_LOG(MAPI, mozilla::LogLevel::Debug,
              ("CMapiImp::Login failed for username %s", aLogin));
      NS_ASSERTION(false, "failed verifying user name");
      return hr;
    }
  } else {
    // get default account
    nsresult rv;
    nsCOMPtr<nsIMsgAccountManager> accountManager =
        mozilla::components::AccountManager::Service();
    nsCOMPtr<nsIMsgAccount> account;
    rv = accountManager->GetDefaultAccount(getter_AddRefs(account));
    NS_ENSURE_SUCCESS(rv, MAPI_E_LOGIN_FAILURE);
    if (!account) return MAPI_E_LOGIN_FAILURE;

    nsCOMPtr<nsIMsgIdentity> identity;
    rv = account->GetDefaultIdentity(getter_AddRefs(identity));
    NS_ENSURE_SUCCESS(rv, MAPI_E_LOGIN_FAILURE);
    if (!identity) return MAPI_E_LOGIN_FAILURE;
    identity->GetKey(id_key);
  }

  // finally register(create) the session.
  uint32_t nSession_Id;
  int16_t nResult = 0;

  nsMAPIConfiguration* pConfig = nsMAPIConfiguration::GetMAPIConfiguration();
  if (pConfig != nullptr)
    nResult = pConfig->RegisterSession(
        aUIArg, aLogin ? nsDependentCString(aLogin) : EmptyCString(),
        aPassWord ? nsDependentCString(aPassWord) : EmptyCString(),
        (aFlags & MAPI_FORCE_DOWNLOAD), bNewSession, &nSession_Id,
        id_key.get());
  switch (nResult) {
    case -1: {
      *aSessionId = MAPI_E_TOO_MANY_SESSIONS;
      return hr;
    }
    case 0: {
      *aSessionId = MAPI_E_INSUFFICIENT_MEMORY;
      return hr;
    }
    default: {
      *aSessionId = nSession_Id;
      MOZ_LOG(MAPI, mozilla::LogLevel::Debug, ("CMapiImp::Login succeeded"));
      break;
    }
  }

  return S_OK;
}

STDMETHODIMP CMapiImp::SendMail(unsigned long aSession,
                                lpnsMapiMessage aMessage, unsigned long aFlags,
                                unsigned long aReserved) {
  MOZ_LOG(MAPI, mozilla::LogLevel::Debug,
          ("CMapiImp::SendMail flags=%lx subject: %s sender: %s", aFlags,
           (aMessage && aMessage->lpszSubject) ? aMessage->lpszSubject
                                               : "(no subject)",
           (aMessage && aMessage->lpOriginator &&
            aMessage->lpOriginator->lpszAddress)
               ? aMessage->lpOriginator->lpszAddress
               : "(no sender)"));

  /** create nsIMsgCompFields obj and populate it **/
  nsresult rv = NS_OK;
  nsCOMPtr<nsIMsgCompFields> pCompFields =
      do_CreateInstance("@mozilla.org/messengercompose/composefields;1", &rv);
  if (NS_FAILED(rv) || (!pCompFields)) return MAPI_E_INSUFFICIENT_MEMORY;

  if (aMessage)
    rv = nsMapiHook::PopulateCompFieldsWithConversion(aMessage, pCompFields);

  if (NS_SUCCEEDED(rv)) {
    // see flag to see if UI needs to be brought up
    if (!(aFlags & MAPI_DIALOG)) {
      rv = nsMapiHook::BlindSendMail(aSession, pCompFields);
    } else {
      rv = nsMapiHook::ShowComposerWindow(aSession, pCompFields);
    }
  }

  return nsMAPIConfiguration::GetMAPIErrorFromNSError(rv);
}

STDMETHODIMP CMapiImp::SendMailW(unsigned long aSession,
                                 lpnsMapiMessageW aMessage,
                                 unsigned long aFlags,
                                 unsigned long aReserved) {
  MOZ_LOG(
      MAPI, mozilla::LogLevel::Debug,
      ("CMapiImp::SendMailW flags=%lx subject: %s sender: %s", aFlags,
       (aMessage && aMessage->lpszSubject)
           ? NS_ConvertUTF16toUTF8(aMessage->lpszSubject).get()
           : "(no subject)",
       (aMessage && aMessage->lpOriginator &&
        aMessage->lpOriginator->lpszAddress)
           ? NS_ConvertUTF16toUTF8(aMessage->lpOriginator->lpszAddress).get()
           : "(no sender)"));

  // Create nsIMsgCompFields obj and populate it.
  nsresult rv = NS_OK;
  nsCOMPtr<nsIMsgCompFields> pCompFields =
      do_CreateInstance("@mozilla.org/messengercompose/composefields;1", &rv);
  if (NS_FAILED(rv) || !pCompFields) return MAPI_E_INSUFFICIENT_MEMORY;

  if (aMessage) rv = nsMapiHook::PopulateCompFieldsW(aMessage, pCompFields);

  if (NS_SUCCEEDED(rv)) {
    // Check flag to see if UI needs to be brought up.
    if (!(aFlags & MAPI_DIALOG)) {
      rv = nsMapiHook::BlindSendMail(aSession, pCompFields);
    } else {
      rv = nsMapiHook::ShowComposerWindow(aSession, pCompFields);
    }
  }

  return nsMAPIConfiguration::GetMAPIErrorFromNSError(rv);
}

STDMETHODIMP CMapiImp::SendDocuments(unsigned long aSession, LPSTR aDelimChar,
                                     LPSTR aFilePaths, LPSTR aFileNames,
                                     ULONG aFlags) {
  nsresult rv = NS_OK;

  MOZ_LOG(MAPI, mozilla::LogLevel::Debug,
          ("CMapiImp::SendDocument using flags %lu", aFlags));
  /** create nsIMsgCompFields obj and populate it **/
  nsCOMPtr<nsIMsgCompFields> pCompFields =
      do_CreateInstance("@mozilla.org/messengercompose/composefields;1", &rv);
  if (NS_FAILED(rv) || (!pCompFields)) return MAPI_E_INSUFFICIENT_MEMORY;

  if (aFilePaths) {
    rv = nsMapiHook::PopulateCompFieldsForSendDocs(pCompFields, aFlags,
                                                   aDelimChar, aFilePaths);
  }

  if (NS_SUCCEEDED(rv))
    rv = nsMapiHook::ShowComposerWindow(aSession, pCompFields);
  else {
    nsAutoCString name;
    mozilla::GetErrorName(rv, name);
    MOZ_LOG(MAPI, mozilla::LogLevel::Debug,
            ("CMapiImp::SendDocument error rv = %s, paths = %s names = %s",
             name.get(), aFilePaths, aFileNames));
  }

  return nsMAPIConfiguration::GetMAPIErrorFromNSError(rv);
}

nsresult CMapiImp::GetDefaultInbox(nsIMsgFolder** inboxFolder) {
  // get default account
  nsresult rv;
  nsCOMPtr<nsIMsgAccountManager> accountManager =
      mozilla::components::AccountManager::Service();
  nsCOMPtr<nsIMsgAccount> account;
  rv = accountManager->GetDefaultAccount(getter_AddRefs(account));
  NS_ENSURE_SUCCESS(rv, rv);
  if (!account) return NS_ERROR_FAILURE;

  // get incoming server
  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = account->GetIncomingServer(getter_AddRefs(server));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString type;
  rv = server->GetType(type);
  NS_ENSURE_SUCCESS(rv, rv);

  // we only care about imap and pop3
  if (type.EqualsLiteral("imap") || type.EqualsLiteral("pop3")) {
    // imap and pop3 account should have an Inbox
    nsCOMPtr<nsIMsgFolder> rootMsgFolder;
    rv = server->GetRootMsgFolder(getter_AddRefs(rootMsgFolder));
    NS_ENSURE_SUCCESS(rv, rv);

    if (!rootMsgFolder) return NS_ERROR_FAILURE;

    rootMsgFolder->GetFolderWithFlags(nsMsgFolderFlags::Inbox, inboxFolder);
    if (!*inboxFolder) return NS_ERROR_FAILURE;
  }
  return NS_OK;
}

//*****************************************************************************
// Encapsulate the XP DB stuff required to enumerate messages

class MsgMapiListContext {
 public:
  MsgMapiListContext() {}
  ~MsgMapiListContext();

  nsresult OpenDatabase(nsIMsgFolder* folder);

  nsMsgKey GetNext();
  nsresult MarkRead(nsMsgKey key, bool read);

  lpnsMapiMessage GetMessage(nsMsgKey, unsigned long flFlags);
  bool IsIMAPHost(void);
  bool DeleteMessage(nsMsgKey key);

 protected:
  char* ConvertDateToMapiFormat(time_t);
  char* ConvertBodyToMapiFormat(nsIMsgDBHdr* hdr);
  void ConvertRecipientsToMapiFormat(
      const nsCOMArray<msgIAddressObject>& ourRecips,
      lpnsMapiRecipDesc mapiRecips, int mapiRecipClass);

  nsCOMPtr<nsIMsgFolder> m_folder;
  nsCOMPtr<nsIMsgDatabase> m_db;
  nsCOMPtr<nsIMsgEnumerator> m_msgEnumerator;
};

LONG CMapiImp::InitContext(unsigned long session,
                           MsgMapiListContext** listContext) {
  nsMAPIConfiguration* pMapiConfig =
      nsMAPIConfiguration::GetMAPIConfiguration();
  if (!pMapiConfig) return MAPI_E_FAILURE;  // get the singleton obj
  *listContext = (MsgMapiListContext*)pMapiConfig->GetMapiListContext(session);
  // This is the first message
  if (!*listContext) {
    nsCOMPtr<nsIMsgFolder> inboxFolder;
    nsresult rv = GetDefaultInbox(getter_AddRefs(inboxFolder));
    if (NS_FAILED(rv)) {
      NS_ASSERTION(false, "in init context, no inbox");
      return (MAPI_E_NO_MESSAGES);
    }

    *listContext = new MsgMapiListContext;
    if (!*listContext) return MAPI_E_INSUFFICIENT_MEMORY;

    rv = (*listContext)->OpenDatabase(inboxFolder);
    if (NS_FAILED(rv)) {
      pMapiConfig->SetMapiListContext(session, NULL);
      delete *listContext;
      NS_ASSERTION(false, "in init context, unable to open db");
      return MAPI_E_NO_MESSAGES;
    } else
      pMapiConfig->SetMapiListContext(session, *listContext);
  }
  return SUCCESS_SUCCESS;
}

STDMETHODIMP CMapiImp::FindNext(unsigned long aSession, unsigned long ulUIParam,
                                LPSTR lpszMessageType, LPSTR lpszSeedMessageID,
                                unsigned long flFlags, unsigned long ulReserved,
                                unsigned char lpszMessageID[64])

{
  //
  // If this is true, then this is the first call to this FindNext function
  // and we should start the enumeration operation.
  //

  *lpszMessageID = '\0';
  nsMAPIConfiguration* pMapiConfig =
      nsMAPIConfiguration::GetMAPIConfiguration();
  if (!pMapiConfig) {
    NS_ASSERTION(false, "failed to get config in findnext");
    return MAPI_E_FAILURE;  // get the singleton obj
  }
  MsgMapiListContext* listContext;
  LONG ret = InitContext(aSession, &listContext);
  if (ret != SUCCESS_SUCCESS) {
    NS_ASSERTION(false, "init context failed");
    return ret;
  }
  NS_ASSERTION(listContext, "initContext returned null context");
  if (listContext) {
    //    NS_ASSERTION(false, "find next init context succeeded");
    nsMsgKey nextKey = listContext->GetNext();
    if (nextKey == nsMsgKey_None) {
      pMapiConfig->SetMapiListContext(aSession, NULL);
      delete listContext;
      return (MAPI_E_NO_MESSAGES);
    }

    //    TRACE("MAPI: ProcessMAPIFindNext() Found message id = %d\n", nextKey);

    sprintf((char*)lpszMessageID, "%d", nextKey);
  }

  MOZ_LOG(MAPI, mozilla::LogLevel::Debug,
          ("CMapiImp::FindNext returning key %s", (char*)lpszMessageID));
  return (SUCCESS_SUCCESS);
}

STDMETHODIMP CMapiImp::ReadMail(unsigned long aSession, unsigned long ulUIParam,
                                LPSTR lpszMessageID, unsigned long flFlags,
                                unsigned long ulReserved,
                                lpnsMapiMessage* lppMessage) {
  nsresult irv;
  nsAutoCString keyString((char*)lpszMessageID);
  MOZ_LOG(MAPI, mozilla::LogLevel::Debug,
          ("CMapiImp::ReadMail asking for key %s", (char*)lpszMessageID));
  nsMsgKey msgKey = keyString.ToInteger(&irv);
  if (NS_FAILED(irv)) {
    NS_ASSERTION(false, "invalid lpszMessageID");
    return MAPI_E_INVALID_MESSAGE;
  }
  MsgMapiListContext* listContext;
  LONG ret = InitContext(aSession, &listContext);
  if (ret != SUCCESS_SUCCESS) {
    NS_ASSERTION(false, "init context failed in ReadMail");
    return ret;
  }
  *lppMessage = listContext->GetMessage(msgKey, flFlags);
  NS_ASSERTION(*lppMessage, "get message failed");

  return (*lppMessage) ? SUCCESS_SUCCESS : E_FAIL;
}

STDMETHODIMP CMapiImp::DeleteMail(unsigned long aSession,
                                  unsigned long ulUIParam, LPSTR lpszMessageID,
                                  unsigned long flFlags,
                                  unsigned long ulReserved) {
  nsresult irv;
  nsAutoCString keyString((char*)lpszMessageID);
  nsMsgKey msgKey = keyString.ToInteger(&irv);
  // XXX Why do we return success on failure?
  if (NS_FAILED(irv)) return SUCCESS_SUCCESS;
  MsgMapiListContext* listContext;
  LONG ret = InitContext(aSession, &listContext);
  if (ret != SUCCESS_SUCCESS) return ret;
  return (listContext->DeleteMessage(msgKey)) ? SUCCESS_SUCCESS
                                              : MAPI_E_INVALID_MESSAGE;
}

STDMETHODIMP CMapiImp::SaveMail(unsigned long aSession, unsigned long ulUIParam,
                                lpnsMapiMessage lppMessage,
                                unsigned long flFlags, unsigned long ulReserved,
                                LPSTR lpszMessageID) {
  MsgMapiListContext* listContext;
  LONG ret = InitContext(aSession, &listContext);
  if (ret != SUCCESS_SUCCESS) return ret;
  return S_OK;
}

STDMETHODIMP CMapiImp::Logoff(unsigned long aSession) {
  nsMAPIConfiguration* pConfig = nsMAPIConfiguration::GetMAPIConfiguration();

  if (pConfig->UnRegisterSession((uint32_t)aSession)) return S_OK;

  return E_FAIL;
}

STDMETHODIMP CMapiImp::CleanUp() {
  nsMapiHook::CleanUp();
  return S_OK;
}

#define MAX_NAME_LEN 256

MsgMapiListContext::~MsgMapiListContext() {
  if (m_db) m_db->Close(false);
}

nsresult MsgMapiListContext::OpenDatabase(nsIMsgFolder* folder) {
  nsresult dbErr = NS_ERROR_FAILURE;
  if (folder) {
    m_folder = folder;
    dbErr = folder->GetMsgDatabase(getter_AddRefs(m_db));
    if (m_db) dbErr = m_db->EnumerateMessages(getter_AddRefs(m_msgEnumerator));
  }
  return dbErr;
}

bool MsgMapiListContext::IsIMAPHost(void) {
  if (!m_folder) return FALSE;
  nsCOMPtr<nsIMsgImapMailFolder> imapFolder = do_QueryInterface(m_folder);

  return imapFolder != nullptr;
}

nsMsgKey MsgMapiListContext::GetNext() {
  nsMsgKey key = nsMsgKey_None;
  bool keepTrying = TRUE;

  //  NS_ASSERTION (m_msgEnumerator && m_db, "need enumerator and db");
  if (m_msgEnumerator && m_db) {
    do {
      keepTrying = FALSE;
      nsCOMPtr<nsIMsgDBHdr> msgHdr;
      if (NS_SUCCEEDED(m_msgEnumerator->GetNext(getter_AddRefs(msgHdr))) &&
          msgHdr) {
        msgHdr->GetMessageKey(&key);

        // Check here for IMAP message...if not, just return...
        if (!IsIMAPHost()) return key;

        // If this is an IMAP message, we have to make sure we have a valid
        // body to work with.
        uint32_t flags = 0;

        (void)msgHdr->GetFlags(&flags);
        if (flags & nsMsgMessageFlags::Offline) return key;

        // Ok, if we get here, we have an IMAP message without a body!
        // We need to keep trying by calling the GetNext member recursively...
        keepTrying = TRUE;
      }
    } while (keepTrying);
  }

  return key;
}

nsresult MsgMapiListContext::MarkRead(nsMsgKey key, bool read) {
  nsresult err = NS_ERROR_FAILURE;
  NS_ASSERTION(m_db, "no db");
  if (m_db) err = m_db->MarkRead(key, read, nullptr);
  return err;
}

lpnsMapiMessage MsgMapiListContext::GetMessage(nsMsgKey key,
                                               unsigned long flFlags) {
  lpnsMapiMessage message =
      (lpnsMapiMessage)CoTaskMemAlloc(sizeof(nsMapiMessage));
  memset(message, 0, sizeof(nsMapiMessage));
  if (message) {
    nsCString subject;
    nsCString author;
    nsCOMPtr<nsIMsgDBHdr> msgHdr;

    m_db->GetMsgHdrForKey(key, getter_AddRefs(msgHdr));
    if (msgHdr) {
      msgHdr->GetSubject(subject);
      message->lpszSubject = (char*)CoTaskMemAlloc(subject.Length() + 1);
      strcpy((char*)message->lpszSubject, subject.get());
      uint32_t date;
      (void)msgHdr->GetDateInSeconds(&date);
      message->lpszDateReceived = ConvertDateToMapiFormat(date);

      // Pull out the flags info
      // anything to do with MAPI_SENT? Since we're only reading the Inbox, I
      // guess not
      uint32_t ourFlags;
      (void)msgHdr->GetFlags(&ourFlags);
      if (!(ourFlags & nsMsgMessageFlags::Read))
        message->flFlags |= MAPI_UNREAD;
      if (ourFlags & (nsMsgMessageFlags::MDNReportNeeded |
                      nsMsgMessageFlags::MDNReportSent))
        message->flFlags |= MAPI_RECEIPT_REQUESTED;

      // Pull out the author/originator info
      message->lpOriginator =
          (lpnsMapiRecipDesc)CoTaskMemAlloc(sizeof(nsMapiRecipDesc));
      memset(message->lpOriginator, 0, sizeof(nsMapiRecipDesc));
      if (message->lpOriginator) {
        msgHdr->GetAuthor(author);
        ConvertRecipientsToMapiFormat(EncodedHeader(author),
                                      message->lpOriginator, MAPI_ORIG);
      }
      // Pull out the To/CC info
      nsCString recipients, ccList;
      msgHdr->GetRecipients(recipients);
      msgHdr->GetCcList(ccList);

      nsCOMArray<msgIAddressObject> parsedToRecips = EncodedHeader(recipients);
      nsCOMArray<msgIAddressObject> parsedCCRecips = EncodedHeader(ccList);
      uint32_t numToRecips = parsedToRecips.Length();
      uint32_t numCCRecips = parsedCCRecips.Length();

      message->lpRecips = (lpnsMapiRecipDesc)CoTaskMemAlloc(
          (numToRecips + numCCRecips) * sizeof(MapiRecipDesc));
      memset(message->lpRecips, 0,
             (numToRecips + numCCRecips) * sizeof(MapiRecipDesc));
      if (message->lpRecips) {
        ConvertRecipientsToMapiFormat(parsedToRecips, message->lpRecips,
                                      MAPI_TO);
        ConvertRecipientsToMapiFormat(parsedCCRecips,
                                      &message->lpRecips[numToRecips], MAPI_CC);
      }

      MOZ_LOG(MAPI, mozilla::LogLevel::Debug,
              ("MsgMapiListContext::GetMessage flags=%lu subject %s date %s "
               "sender %s",
               flFlags, (char*)message->lpszSubject,
               (char*)message->lpszDateReceived, author.get()));

      // Convert any body text that we have locally
      if (!(flFlags & MAPI_ENVELOPE_ONLY))
        message->lpszNoteText = (char*)ConvertBodyToMapiFormat(msgHdr);
    }
    if (!(flFlags & (MAPI_PEEK | MAPI_ENVELOPE_ONLY)))
      m_db->MarkRead(key, true, nullptr);
  }
  return message;
}

char* MsgMapiListContext::ConvertDateToMapiFormat(time_t ourTime) {
  char* date = (char*)CoTaskMemAlloc(32);
  if (date) {
    // MAPI time format is YYYY/MM/DD HH:MM
    // Note that we're not using XP_StrfTime because that localizes the time
    // format, and the way I read the MAPI spec is that their format is
    // canonical, not localized.
    struct tm* local = localtime(&ourTime);
    if (local)
      strftime(date, 32, "%Y/%m/%d %I:%M",
               local);  // use %H if hours should be 24 hour format
  }
  return date;
}

void MsgMapiListContext::ConvertRecipientsToMapiFormat(
    const nsCOMArray<msgIAddressObject>& recipients,
    lpnsMapiRecipDesc mapiRecips, int mapiRecipClass) {
  nsTArray<nsCString> names, addresses;
  ExtractAllAddresses(recipients, UTF16ArrayAdapter<>(names),
                      UTF16ArrayAdapter<>(addresses));

  size_t numAddresses = names.Length();
  for (size_t i = 0; i < numAddresses; i++) {
    if (!names[i].IsEmpty()) {
      mapiRecips[i].lpszName = (char*)CoTaskMemAlloc(names[i].Length() + 1);
      if (mapiRecips[i].lpszName)
        strcpy((char*)mapiRecips[i].lpszName, names[i].get());
    }
    if (!addresses[i].IsEmpty()) {
      mapiRecips[i].lpszName = (char*)CoTaskMemAlloc(addresses[i].Length() + 1);
      if (mapiRecips[i].lpszName)
        strcpy((char*)mapiRecips[i].lpszName, addresses[i].get());
    }
    mapiRecips[i].ulRecipClass = mapiRecipClass;
  }
}

char* MsgMapiListContext::ConvertBodyToMapiFormat(nsIMsgDBHdr* hdr) {
  const int kBufLen =
      64000;  // I guess we only return the first 64K of a message.
#define EMPTY_MESSAGE_LINE(buf) \
  (buf[0] == '\r' || buf[0] == '\n' || buf[0] == '\0')

  nsCOMPtr<nsIMsgFolder> folder;
  hdr->GetFolder(getter_AddRefs(folder));
  if (!folder) return nullptr;

  nsCOMPtr<nsIFile> localFile;
  folder->GetFilePath(getter_AddRefs(localFile));

  nsresult rv;
  nsCOMPtr<nsIFileInputStream> fileStream =
      do_CreateInstance(NS_LOCALFILEINPUTSTREAM_CONTRACTID, &rv);
  NS_ENSURE_SUCCESS(rv, nullptr);

  rv = fileStream->Init(localFile, PR_RDONLY, 0664,
                        false);  // just have to read the messages
  NS_ENSURE_SUCCESS(rv, nullptr);

  nsCOMPtr<nsILineInputStream> fileLineStream = do_QueryInterface(fileStream);
  if (!fileLineStream) return nullptr;

  // ### really want to skip past headers...
  nsCString storeToken;
  uint64_t messageOffset;
  uint32_t lineCount;
  hdr->GetStoreToken(storeToken);
  messageOffset = storeToken.ToInteger64(&rv);
  hdr->GetLineCount(&lineCount);
  nsCOMPtr<nsISeekableStream> seekableStream = do_QueryInterface(fileStream);
  seekableStream->Seek(PR_SEEK_SET, messageOffset);
  bool hasMore = true;
  nsAutoCString curLine;

  while (hasMore)  // advance past message headers
  {
    nsresult rv = fileLineStream->ReadLine(curLine, &hasMore);
    if (NS_FAILED(rv) || EMPTY_MESSAGE_LINE(curLine)) break;
  }
  uint32_t msgSize;
  hdr->GetMessageSize(&msgSize);
  if (msgSize > kBufLen) msgSize = kBufLen - 1;
  // this is too big, since it includes the msg hdr size...oh well
  char* body = (char*)CoTaskMemAlloc(msgSize + 1);

  if (!body) return nullptr;
  int32_t bytesCopied = 0;
  for (hasMore = TRUE; lineCount > 0 && hasMore && NS_SUCCEEDED(rv);
       lineCount--) {
    rv = fileLineStream->ReadLine(curLine, &hasMore);
    if (NS_FAILED(rv)) break;
    curLine.Append(CRLF);
    // make sure we have room left
    if (bytesCopied + curLine.Length() < msgSize) {
      strcpy(body + bytesCopied, curLine.get());
      bytesCopied += curLine.Length();
    }
  }
  MOZ_LOG(MAPI, mozilla::LogLevel::Debug,
          ("ConvertBodyToMapiFormat size=%x allocated size %x body = %100.100s",
           bytesCopied, msgSize + 1, (char*)body));
  body[bytesCopied] = '\0';  // rhp - fix last line garbage...
  return body;
}

//*****************************************************************************
// MSGMAPI API implementation

static void msg_FreeMAPIFile(lpMapiFileDesc f) {
  if (f) {
    CoTaskMemFree(f->lpszPathName);
    CoTaskMemFree(f->lpszFileName);
  }
}

static void msg_FreeMAPIRecipient(lpMapiRecipDesc rd) {
  if (rd) {
    if (rd->lpszName) CoTaskMemFree(rd->lpszName);
    if (rd->lpszAddress) CoTaskMemFree(rd->lpszAddress);
    // CoTaskMemFree(rd->lpEntryID);
  }
}

extern "C" void MSG_FreeMapiMessage(lpMapiMessage msg) {
  ULONG i;

  if (msg) {
    CoTaskMemFree(msg->lpszSubject);
    CoTaskMemFree(msg->lpszNoteText);
    CoTaskMemFree(msg->lpszMessageType);
    CoTaskMemFree(msg->lpszDateReceived);
    CoTaskMemFree(msg->lpszConversationID);

    if (msg->lpOriginator) msg_FreeMAPIRecipient(msg->lpOriginator);

    for (i = 0; i < msg->nRecipCount; i++)
      if (&(msg->lpRecips[i]) != nullptr)
        msg_FreeMAPIRecipient(&(msg->lpRecips[i]));

    CoTaskMemFree(msg->lpRecips);

    for (i = 0; i < msg->nFileCount; i++)
      if (&(msg->lpFiles[i]) != nullptr) msg_FreeMAPIFile(&(msg->lpFiles[i]));

    CoTaskMemFree(msg->lpFiles);

    CoTaskMemFree(msg);
  }
}

extern "C" bool MsgMarkMapiMessageRead(nsIMsgFolder* folder, nsMsgKey key,
                                       bool read) {
  bool success = FALSE;
  MsgMapiListContext* context = new MsgMapiListContext();
  if (context) {
    if (NS_SUCCEEDED(context->OpenDatabase(folder))) {
      if (NS_SUCCEEDED(context->MarkRead(key, read))) success = TRUE;
    }
    delete context;
  }
  return success;
}

bool MsgMapiListContext::DeleteMessage(nsMsgKey key) {
  if (!m_db) return FALSE;

  if (!IsIMAPHost()) {
    nsTArray<nsMsgKey> doomed({key});
    return NS_SUCCEEDED((m_db->DeleteMessages(doomed, nullptr)));
  }
#if 0
  else if ( m_folder->GetIMAPFolderInfoMail() )
  {
    AutoTArray<nsMsgKey, 1> messageKeys;
    messageKeys.AppendElement(key);

    (m_folder->GetIMAPFolderInfoMail())->DeleteSpecifiedMessages(pane, messageKeys, nsMsgKey_None);
    m_db->DeleteMessage(key, nullptr, FALSE);
    return TRUE;
  }
#endif
  else {
    return FALSE;
  }
}

/* Return TRUE on success, FALSE on failure */
extern "C" bool MSG_DeleteMapiMessage(nsIMsgFolder* folder, nsMsgKey key) {
  bool success = FALSE;
  MsgMapiListContext* context = new MsgMapiListContext();
  if (context) {
    if (NS_SUCCEEDED(context->OpenDatabase(folder))) {
      success = context->DeleteMessage(key);
    }

    delete context;
  }

  return success;
}
