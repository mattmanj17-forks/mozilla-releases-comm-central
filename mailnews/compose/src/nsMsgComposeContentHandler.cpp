/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgComposeContentHandler.h"
#include "nsMsgComposeService.h"
#include "nsIChannel.h"
#include "nsIURI.h"
#include "plstr.h"
#include "nsServiceManagerUtils.h"
#include "nsCOMPtr.h"
#include "nsPIDOMWindow.h"
#include "mozIDOMWindow.h"
#include "mozilla/Components.h"
#include "mozilla/dom/Document.h"
#include "nsIInterfaceRequestor.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsIMsgMailNewsUrl.h"
#include "nsNetUtil.h"
#include "nsIMsgFolder.h"
#include "nsIMsgIncomingServer.h"
#include "nsIMsgAccountManager.h"

nsMsgComposeContentHandler::nsMsgComposeContentHandler() {}

// The following macro actually implement addref, release and query interface
// for our component.
NS_IMPL_ISUPPORTS(nsMsgComposeContentHandler, nsIContentHandler)

nsMsgComposeContentHandler::~nsMsgComposeContentHandler() {}

// Try to get an appropriate nsIMsgIdentity by going through the window, getting
// the document's URI, then the corresponding nsIMsgDBHdr. Then find the server
// associated with that header and get the first identity for it.
nsresult nsMsgComposeContentHandler::GetBestIdentity(
    nsIInterfaceRequestor* aWindowContext, nsIMsgIdentity** aIdentity) {
  nsresult rv;

  nsCOMPtr<mozIDOMWindowProxy> domWindow = do_GetInterface(aWindowContext);
  NS_ENSURE_TRUE(domWindow, NS_ERROR_FAILURE);
  nsCOMPtr<nsPIDOMWindowOuter> window = nsPIDOMWindowOuter::From(domWindow);

  nsAutoString documentURIString;
  rv = window->GetDoc()->GetDocumentURI(documentURIString);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIURI> documentURI;
  rv = NS_NewURI(getter_AddRefs(documentURI), documentURIString);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgMessageUrl> msgURI = do_QueryInterface(documentURI);
  if (!msgURI) return NS_ERROR_FAILURE;

  nsCOMPtr<nsIMsgDBHdr> msgHdr;
  rv = msgURI->GetMessageHeader(getter_AddRefs(msgHdr));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgFolder> folder;
  rv = msgHdr->GetFolder(getter_AddRefs(folder));
  NS_ENSURE_SUCCESS(rv, rv);

  // nsIMsgDBHdrs from .eml messages have a null folder, so bail out if that's
  // the case.
  if (!folder) return NS_ERROR_FAILURE;

  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = folder->GetServer(getter_AddRefs(server));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgAccountManager> accountManager =
      mozilla::components::AccountManager::Service();

  rv = accountManager->GetFirstIdentityForServer(server, aIdentity);
  NS_ENSURE_SUCCESS(rv, rv);

  return rv;
}

NS_IMETHODIMP nsMsgComposeContentHandler::HandleContent(
    const char* aContentType, nsIInterfaceRequestor* aWindowContext,
    nsIRequest* request) {
  nsresult rv = NS_OK;
  if (!request) return NS_ERROR_NULL_POINTER;

  // First of all, get the content type and make sure it is a content type we
  // know how to handle!
  if (PL_strcasecmp(aContentType, "application/x-mailto") == 0) {
    nsCOMPtr<nsIMsgIdentity> identity;

    if (aWindowContext)
      GetBestIdentity(aWindowContext, getter_AddRefs(identity));

    nsCOMPtr<nsIURI> aUri;
    nsCOMPtr<nsIChannel> aChannel = do_QueryInterface(request);
    if (!aChannel) return NS_ERROR_FAILURE;

    rv = aChannel->GetURI(getter_AddRefs(aUri));
    if (aUri) {
      nsCOMPtr<nsIMsgComposeService> composeService =
          mozilla::components::Compose::Service();
      rv = composeService->OpenComposeWindowWithURI(nullptr, aUri, identity);
    }
  } else {
    // The content-type was not application/x-mailto...
    return NS_ERROR_WONT_HANDLE_CONTENT;
  }

  return rv;
}
