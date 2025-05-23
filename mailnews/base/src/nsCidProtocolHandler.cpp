/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsCidProtocolHandler.h"
#include "nsString.h"
#include "nsIURI.h"
#include "nsNetUtil.h"

nsCidProtocolHandler::nsCidProtocolHandler() {}

nsCidProtocolHandler::~nsCidProtocolHandler() {}

NS_IMPL_ISUPPORTS(nsCidProtocolHandler, nsIProtocolHandler)

NS_IMETHODIMP nsCidProtocolHandler::GetScheme(nsACString& aScheme) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

nsresult nsCidProtocolHandler::NewURI(const nsACString& aSpec,
                                      const char* aOriginCharset,
                                      nsIURI* aBaseURI, nsIURI** _retval) {
  // the right fix is to use the baseSpec (or aBaseUri)
  // and specify the cid, and then fix mime
  // to handle that, like it does with "...&part=1.2"
  // for now, do about blank to prevent spam
  // from popping up annoying alerts about not implementing the cid
  // protocol
  nsCOMPtr<nsIURI> url;
  nsresult rv = NS_NewURI(getter_AddRefs(url), "about:blank");
  NS_ENSURE_SUCCESS(rv, rv);

  url.forget(_retval);
  return NS_OK;
}

NS_IMETHODIMP nsCidProtocolHandler::NewChannel(nsIURI* aURI,
                                               nsILoadInfo* aLoadInfo,
                                               nsIChannel** _retval) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsCidProtocolHandler::AllowPort(int32_t port, const char* scheme,
                                              bool* _retval) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
