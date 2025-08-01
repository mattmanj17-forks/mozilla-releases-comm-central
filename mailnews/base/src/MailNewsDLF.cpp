/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MailNewsDLF.h"

#include "mozilla/Components.h"
#include "nsCOMPtr.h"
#include "nsIChannel.h"
#include "plstr.h"
#include "nsString.h"
#include "nsICategoryManager.h"
#include "nsIStreamConverterService.h"
#include "nsIStreamListener.h"
#include "nsNetCID.h"
#include "nsMsgUtils.h"

namespace mozilla {
namespace mailnews {
NS_IMPL_ISUPPORTS(MailNewsDLF, nsIDocumentLoaderFactory)

MailNewsDLF::MailNewsDLF() {}

MailNewsDLF::~MailNewsDLF() {}

NS_IMETHODIMP
MailNewsDLF::CreateInstance(const char* aCommand, nsIChannel* aChannel,
                            nsILoadGroup* aLoadGroup,
                            const nsACString& aContentType,
                            nsIDocShell* aContainer, nsISupports* aExtraInfo,
                            nsIStreamListener** aDocListener,
                            nsIDocumentViewer** aDocViewer) {
  nsresult rv;

  bool viewSource =
      (PL_strstr(PromiseFlatCString(aContentType).get(), "view-source") != 0);

  aChannel->SetContentType(nsLiteralCString(TEXT_HTML));

  // Get the HTML category
  nsCOMPtr<nsICategoryManager> catMan =
      mozilla::components::CategoryManager::Service();

  nsAutoCString contractID;
  rv = catMan->GetCategoryEntry("Gecko-Content-Viewers", TEXT_HTML, contractID);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIDocumentLoaderFactory> factory(
      do_GetService(contractID.get(), &rv));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIStreamListener> listener;

  if (viewSource) {
    rv = factory->CreateInstance(
        "view-source", aChannel, aLoadGroup,
        nsLiteralCString(TEXT_HTML "; x-view-type=view-source"), aContainer,
        aExtraInfo, getter_AddRefs(listener), aDocViewer);
  } else {
    rv = factory->CreateInstance(
        "view", aChannel, aLoadGroup, nsLiteralCString(TEXT_HTML), aContainer,
        aExtraInfo, getter_AddRefs(listener), aDocViewer);
  }
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIStreamConverterService> scs =
      mozilla::components::StreamConverter::Service();
  return scs->AsyncConvertData(MESSAGE_RFC822, TEXT_HTML, listener, aChannel,
                               aDocListener);
}

NS_IMETHODIMP
MailNewsDLF::CreateInstanceForDocument(nsISupports* aContainer,
                                       mozilla::dom::Document* aDocument,
                                       const char* aCommand,
                                       nsIDocumentViewer** aDocViewer) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

}  // namespace mailnews
}  // namespace mozilla
