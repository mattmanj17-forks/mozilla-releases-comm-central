/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <mapidefs.h>
#include <mapi.h>

#include "msgCore.h"
#include "msgMapiMain.h"
#include "nsCOMPtr.h"

nsMAPIConfiguration* nsMAPIConfiguration::m_pSelfRef = nullptr;
uint32_t nsMAPIConfiguration::session_generator = 0;
uint32_t nsMAPIConfiguration::sessionCount = 0;

nsMAPIConfiguration* nsMAPIConfiguration::GetMAPIConfiguration() {
  if (m_pSelfRef == nullptr) m_pSelfRef = new nsMAPIConfiguration();

  return m_pSelfRef;
}

nsMAPIConfiguration::nsMAPIConfiguration() : m_nMaxSessions(MAX_SESSIONS) {
  m_Lock = PR_NewLock();
}

nsMAPIConfiguration::~nsMAPIConfiguration() {
  if (m_Lock) PR_DestroyLock(m_Lock);
}

void nsMAPIConfiguration::OpenConfiguration() {
  // No. of max. sessions is set to MAX_SESSIONS.  In future
  // if it is decided to have configuration (registry)
  // parameter, this function can be used to set the
  // max sessions;

  return;
}

int16_t nsMAPIConfiguration::RegisterSession(
    uint32_t aHwnd, const nsCString& aUserName, const nsCString& aPassword,
    bool aForceDownLoad, bool aNewSession, uint32_t* aSession,
    const char* aIdKey) {
  int16_t nResult = 0;
  uint32_t n_SessionId = 0;

  PR_Lock(m_Lock);

  // Check whether max sessions is exceeded

  if (sessionCount >= m_nMaxSessions) {
    PR_Unlock(m_Lock);
    return -1;
  }

  if (!aUserName.IsEmpty()) n_SessionId = m_ProfileMap.Get(aUserName);

  // try to share a session; if not create a session
  if (n_SessionId > 0) {
    nsMAPISession* pTemp = nullptr;
    m_SessionMap.Get(n_SessionId, &pTemp);
    if (pTemp != nullptr) {
      pTemp->IncrementSession();
      *aSession = n_SessionId;
      nResult = 1;
    }
  } else if (aNewSession ||
             n_SessionId == 0)  // checking for n_SessionId is a concession
  {
    // create a new session; if new session is specified OR there is no session
    session_generator++;

    // I don't think there will be (2 power 32) sessions alive
    // in a cycle. This is an assumption.
    if (session_generator == 0) session_generator++;
    m_SessionMap.InsertOrUpdate(
        session_generator,
        mozilla::MakeUnique<nsMAPISession>(aHwnd, aUserName, aPassword,
                                           aForceDownLoad, aIdKey));
    if (!aUserName.IsEmpty())
      m_ProfileMap.InsertOrUpdate(aUserName, session_generator);
    *aSession = session_generator;
    sessionCount++;
    nResult = 1;
  }

  PR_Unlock(m_Lock);
  return nResult;
}

bool nsMAPIConfiguration::UnRegisterSession(uint32_t aSessionID) {
  bool bResult = false;

  PR_Lock(m_Lock);

  if (aSessionID != 0) {
    nsMAPISession* pTemp = nullptr;
    m_SessionMap.Get(aSessionID, &pTemp);

    if (pTemp != nullptr) {
      if (pTemp->DecrementSession() == 0) {
        if (pTemp->m_pProfileName.get() != nullptr)
          m_ProfileMap.Remove(pTemp->m_pProfileName);
        m_SessionMap.Remove(aSessionID);
        sessionCount--;
        bResult = true;
      }
    }
  }

  PR_Unlock(m_Lock);
  return bResult;
}

bool nsMAPIConfiguration::IsSessionValid(uint32_t aSessionID) {
  if (aSessionID == 0) return false;
  bool retValue = false;
  PR_Lock(m_Lock);
  retValue = m_SessionMap.Get(aSessionID, NULL);
  PR_Unlock(m_Lock);
  return retValue;
}

char16_t* nsMAPIConfiguration::GetPassword(uint32_t aSessionID) {
  char16_t* pResult = nullptr;

  PR_Lock(m_Lock);

  if (aSessionID != 0) {
    nsMAPISession* pTemp = nullptr;
    m_SessionMap.Get(aSessionID, &pTemp);

    if (pTemp) pResult = pTemp->GetPassword();
  }
  PR_Unlock(m_Lock);
  return pResult;
}

void* nsMAPIConfiguration::GetMapiListContext(uint32_t aSessionID) {
  void* pResult = nullptr;

  PR_Lock(m_Lock);

  if (aSessionID != 0) {
    nsMAPISession* pTemp = nullptr;
    m_SessionMap.Get(aSessionID, &pTemp);
    if (pTemp) pResult = pTemp->GetMapiListContext();
  }

  PR_Unlock(m_Lock);
  return pResult;
}

void nsMAPIConfiguration::SetMapiListContext(uint32_t aSessionID,
                                             void* mapiListContext) {
  PR_Lock(m_Lock);

  if (aSessionID != 0) {
    nsMAPISession* pTemp = nullptr;
    m_SessionMap.Get(aSessionID, &pTemp);
    if (pTemp) pTemp->SetMapiListContext(mapiListContext);
  }

  PR_Unlock(m_Lock);
}

void nsMAPIConfiguration::GetIdKey(uint32_t aSessionID, nsCString& aKey) {
  PR_Lock(m_Lock);
  if (aSessionID != 0) {
    nsMAPISession* pTemp = nullptr;
    m_SessionMap.Get(aSessionID, &pTemp);
    if (pTemp) pTemp->GetIdKey(aKey);
  }
  PR_Unlock(m_Lock);
  return;
}

// util func
HRESULT nsMAPIConfiguration::GetMAPIErrorFromNSError(nsresult res) {
  HRESULT hr = SUCCESS_SUCCESS;

  if (NS_SUCCEEDED(res)) return hr;

  // if failure return the related MAPI failure code
  switch (res) {
    case NS_ERROR_FILE_INVALID_PATH:
      hr = MAPI_E_ATTACHMENT_OPEN_FAILURE;
      break;
    case NS_ERROR_FILE_NOT_FOUND:
      hr = MAPI_E_ATTACHMENT_NOT_FOUND;
      break;
    default:
      hr = MAPI_E_FAILURE;
      break;
  }

  return hr;
}

nsMAPISession::nsMAPISession(uint32_t aHwnd, const nsCString& aUserName,
                             const nsCString& aPassword, bool aForceDownLoad,
                             const char* aKey)
    : m_nShared(1), m_pIdKey(aKey) {
  m_listContext = NULL;
  m_pProfileName = aUserName;
  m_pPassword = aPassword;
}

nsMAPISession::~nsMAPISession() {}

uint32_t nsMAPISession::IncrementSession() { return ++m_nShared; }

uint32_t nsMAPISession::DecrementSession() { return --m_nShared; }

uint32_t nsMAPISession::GetSessionCount() { return m_nShared; }

char16_t* nsMAPISession::GetPassword() { return (char16_t*)m_pPassword.get(); }

void nsMAPISession::GetIdKey(nsCString& aKey) {
  aKey = m_pIdKey;
  return;
}
