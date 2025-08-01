/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsIMsgMailNewsUrl.h"
#include "nsIStreamListener.h"
#include "nsIStreamConverter.h"
#include "nsIStreamConverterService.h"
#include "nsIMimeStreamConverter.h"
#include "nsIURIMutator.h"
#include "prprf.h"
#include "nsMsgQuote.h"
#include "nsIMsgMessageService.h"
#include "nsMsgUtils.h"
#include "nsNetUtil.h"
#include "mozilla/Components.h"
#include "nsContentUtils.h"

NS_IMPL_ISUPPORTS(nsMsgQuoteListener, nsIMsgQuoteListener,
                  nsIMimeStreamConverterListener)

nsMsgQuoteListener::nsMsgQuoteListener() {}

nsMsgQuoteListener::~nsMsgQuoteListener() {}

NS_IMETHODIMP nsMsgQuoteListener::SetMsgQuote(nsIMsgQuote* msgQuote) {
  mMsgQuote = do_GetWeakReference(msgQuote);
  return NS_OK;
}

NS_IMETHODIMP nsMsgQuoteListener::GetMsgQuote(nsIMsgQuote** aMsgQuote) {
  nsresult rv = NS_OK;
  if (aMsgQuote) {
    nsCOMPtr<nsIMsgQuote> msgQuote = do_QueryReferent(mMsgQuote);
    msgQuote.forget(aMsgQuote);
  } else
    rv = NS_ERROR_NULL_POINTER;

  return rv;
}

nsresult nsMsgQuoteListener::OnHeadersReady(nsIMimeHeaders* headers) {
  nsCOMPtr<nsIMsgQuotingOutputStreamListener> quotingOutputStreamListener;
  nsCOMPtr<nsIMsgQuote> msgQuote = do_QueryReferent(mMsgQuote);

  if (msgQuote)
    msgQuote->GetStreamListener(getter_AddRefs(quotingOutputStreamListener));

  if (quotingOutputStreamListener)
    quotingOutputStreamListener->SetMimeHeaders(headers);
  return NS_OK;
}

//
// Implementation...
//
nsMsgQuote::nsMsgQuote() {
  mQuoteHeaders = false;
  mQuoteListener = nullptr;
}

nsMsgQuote::~nsMsgQuote() {}

NS_IMPL_ISUPPORTS(nsMsgQuote, nsIMsgQuote, nsISupportsWeakReference)

NS_IMETHODIMP nsMsgQuote::GetStreamListener(
    nsIMsgQuotingOutputStreamListener** aStreamListener) {
  if (!aStreamListener) {
    return NS_ERROR_NULL_POINTER;
  }
  nsCOMPtr<nsIMsgQuotingOutputStreamListener> streamListener =
      do_QueryReferent(mStreamListener);
  if (!streamListener) {
    return NS_ERROR_FAILURE;
  }
  NS_IF_ADDREF(*aStreamListener = streamListener);
  return NS_OK;
}

nsresult nsMsgQuote::QuoteMessage(
    const nsACString& msgURI, bool quoteHeaders,
    nsIMsgQuotingOutputStreamListener* aQuoteMsgStreamListener,
    bool aAutodetectCharset, bool headersOnly, nsIMsgDBHdr* aMsgHdr) {
  nsresult rv;

  mQuoteHeaders = quoteHeaders;
  mStreamListener = do_GetWeakReference(aQuoteMsgStreamListener);

  nsAutoCString msgUri(msgURI);
  bool fileUrl = StringBeginsWith(msgUri, "file:"_ns);
  bool forwardedMessage = msgUri.Find("&realtype=message/rfc822") >= 0;
  nsCOMPtr<nsIURI> newURI;
  if (fileUrl) {
    msgUri.Replace(0, 5, "mailbox:"_ns);
    msgUri.AppendLiteral("?number=0");
    rv = NS_NewURI(getter_AddRefs(newURI), msgUri);
  } else if (forwardedMessage)
    rv = NS_NewURI(getter_AddRefs(newURI), msgURI);
  else {
    nsCOMPtr<nsIMsgMessageService> msgService;
    rv = GetMessageServiceFromURI(msgURI, getter_AddRefs(msgService));
    if (NS_FAILED(rv)) return rv;
    rv = msgService->GetUrlForUri(msgURI, nullptr, getter_AddRefs(newURI));
  }
  if (NS_FAILED(rv)) return rv;

  nsAutoCString queryPart;
  rv = newURI->GetQuery(queryPart);
  if (!queryPart.IsEmpty()) queryPart.Append('&');

  if (headersOnly) /* We don't need to quote the message body but we still need
                      to extract the headers */
    queryPart.AppendLiteral("header=only");
  else if (quoteHeaders)
    queryPart.AppendLiteral("header=quote");
  else
    queryPart.AppendLiteral("header=quotebody");
  rv = NS_MutateURI(newURI).SetQuery(queryPart).Finalize(newURI);
  NS_ENSURE_SUCCESS(rv, rv);

  // if we were told to auto-detect the charset, pass that on.
  if (aAutodetectCharset) {
    nsCOMPtr<nsIMsgI18NUrl> i18nUrl(do_QueryInterface(newURI));
    if (i18nUrl) i18nUrl->SetAutodetectCharset(true);
  }

  mQuoteListener =
      do_CreateInstance("@mozilla.org/messengercompose/quotinglistener;1", &rv);
  if (NS_FAILED(rv)) return rv;
  mQuoteListener->SetMsgQuote(this);

  // funky magic go get the isupports for this class which inherits from
  // multiple interfaces.
  nsISupports* supports;
  QueryInterface(NS_GET_IID(nsISupports), (void**)&supports);
  nsCOMPtr<nsISupports> quoteSupport = supports;
  NS_IF_RELEASE(supports);

  // now we want to create a necko channel for this url and we want to open it
  mQuoteChannel = nullptr;
  nsCOMPtr<nsIIOService> netService = mozilla::components::IO::Service();
  NS_ENSURE_TRUE(netService, NS_ERROR_UNEXPECTED);
  rv = netService->NewChannelFromURI(
      newURI, nullptr, nsContentUtils::GetSystemPrincipal(), nullptr,
      nsILoadInfo::SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      nsIContentPolicy::TYPE_OTHER, getter_AddRefs(mQuoteChannel));

  if (NS_FAILED(rv)) return rv;

  nsCOMPtr<nsIStreamConverterService> streamConverterService =
      mozilla::components::StreamConverter::Service();
  nsCOMPtr<nsIStreamListener> convertedListener;
  nsCOMPtr<nsIMsgQuotingOutputStreamListener> streamListener =
      do_QueryReferent(mStreamListener);
  rv = streamConverterService->AsyncConvertData(
      "message/rfc822", "application/xhtml+xml", streamListener, quoteSupport,
      getter_AddRefs(convertedListener));
  if (NS_FAILED(rv)) return rv;

  //  now try to open the channel passing in our display consumer as the
  //  listener
  rv = mQuoteChannel->AsyncOpen(convertedListener);
  return rv;
}

NS_IMETHODIMP
nsMsgQuote::GetQuoteListener(nsIMimeStreamConverterListener** aQuoteListener) {
  if (!aQuoteListener || !mQuoteListener) return NS_ERROR_NULL_POINTER;
  NS_ADDREF(*aQuoteListener = mQuoteListener);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgQuote::GetQuoteChannel(nsIChannel** aQuoteChannel) {
  if (!aQuoteChannel || !mQuoteChannel) return NS_ERROR_NULL_POINTER;
  NS_ADDREF(*aQuoteChannel = mQuoteChannel);
  return NS_OK;
}
