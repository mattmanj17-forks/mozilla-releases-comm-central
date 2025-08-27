/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "EwsListeners.h"

// Implementation of EwsSimpleListener

NS_IMPL_ISUPPORTS(EwsSimpleListener, IEwsSimpleOperationListener)

NS_IMETHODIMP EwsSimpleListener::OnOperationSuccess(
    const nsTArray<nsCString>& newIds, bool useLegacyFallback) {
  return mOnSuccess(std::move(newIds), useLegacyFallback);
};

// Implementation of EwsSimpleMessageListener

NS_IMPL_ISUPPORTS(EwsSimpleMessageListener, IEwsSimpleOperationListener)

NS_IMETHODIMP EwsSimpleMessageListener::OnOperationSuccess(
    const nsTArray<nsCString>& newIds, bool useLegacyFallback) {
  return mOnSuccess(mHeaders, std::move(newIds), useLegacyFallback);
};

// Implementation of EwsFallibleListener

NS_IMETHODIMP EwsFallibleListener::OnOperationFailure(nsresult status) {
  return mOnFailure(status);
};

// Implementation of EwsSimpleFailibleListener

NS_IMPL_ISUPPORTS_INHERITED(EwsSimpleFailibleListener, EwsSimpleListener,
                            EwsFallibleListener, IEwsSimpleOperationListener,
                            IEwsFallibleOperationListener)

// Implementation of EwsSimpleFailibleMessageListener

NS_IMPL_ISUPPORTS_INHERITED(EwsSimpleFailibleMessageListener,
                            EwsSimpleMessageListener, EwsFallibleListener,
                            IEwsSimpleOperationListener,
                            IEwsFallibleOperationListener)

// Implementation of EwsMessageCreateListener

NS_IMPL_ISUPPORTS(EwsMessageCreateListener, IEwsMessageCreateListener)

NS_IMETHODIMP EwsMessageCreateListener::OnHdrPopulated(nsIMsgDBHdr* hdr) {
  return mOnHdrPopulated(hdr);
}

NS_IMETHODIMP EwsMessageCreateListener::OnNewMessageKey(nsMsgKey msgKey) {
  return mOnNewMessageKey(msgKey);
}

NS_IMETHODIMP EwsMessageCreateListener::OnRemoteCreateSuccessful(
    const nsACString& ewsId, nsIMsgDBHdr** newHdr) {
  return mOnRemoteCreateSuccessful(ewsId, newHdr);
}

NS_IMETHODIMP EwsMessageCreateListener::OnStopCreate(nsresult status) {
  return mOnStopCreate(status);
}

// Implementation of EwsFolderSyncListener

NS_IMPL_ISUPPORTS(EwsFolderSyncListener, EwsFallibleListener,
                  IEwsFolderListener, IEwsFallibleOperationListener)

NS_IMETHODIMP EwsFolderSyncListener::OnNewRootFolder(const nsACString& id) {
  return mOnNewRootFolder(id);
}

NS_IMETHODIMP EwsFolderSyncListener::OnFolderCreated(const nsACString& id,
                                                     const nsACString& parentId,
                                                     const nsACString& name,
                                                     uint32_t flags) {
  return mOnFolderCreated(id, parentId, name, flags);
}

NS_IMETHODIMP EwsFolderSyncListener::OnFolderUpdated(const nsACString& id,
                                                     const nsACString& parentId,
                                                     const nsACString& name) {
  return mOnFolderUpdated(id, parentId, name);
}

NS_IMETHODIMP EwsFolderSyncListener::OnFolderDeleted(const nsACString& id) {
  return mOnFolderDeleted(id);
}

NS_IMETHODIMP EwsFolderSyncListener::OnSyncStateTokenChanged(
    const nsACString& syncStateToken) {
  return mOnSyncStateTokenChanged(syncStateToken);
}

NS_IMETHODIMP EwsFolderSyncListener::OnSuccess() { return mOnSuccess(); }

// Implementation of EwsMessageFetchListener

NS_IMPL_ISUPPORTS(EwsMessageFetchListener, IEwsMessageFetchListener)

NS_IMETHODIMP EwsMessageFetchListener::OnFetchStart() {
  return mOnFetchStart();
}

NS_IMETHODIMP EwsMessageFetchListener::OnFetchedDataAvailable(
    nsIInputStream* stream, uint32_t count) {
  uint64_t bytesFetched = 0;
  nsresult rv = mOnFetchedDataAvailable(stream, count, &bytesFetched);
  NS_ENSURE_SUCCESS(rv, rv);

  mTotalFetchedBytesCount += bytesFetched;

  return NS_OK;
}

NS_IMETHODIMP EwsMessageFetchListener::OnFetchStop(nsresult status) {
  return mOnFetchStop(status, mTotalFetchedBytesCount);
}

// Implementation of EwsMessageSyncListener

NS_IMPL_ISUPPORTS(EwsMessageSyncListener, IEwsMessageSyncListener)

NS_IMETHODIMP EwsMessageSyncListener::OnMessageCreated(const nsACString& ewsId,
                                                       nsIMsgDBHdr** newHdr) {
  return mOnMessageCreated(ewsId, newHdr);
}

NS_IMETHODIMP EwsMessageSyncListener::OnMessageUpdated(const nsACString& ewsId,
                                                       nsIMsgDBHdr** hdr) {
  return mOnMessageUpdated(ewsId, hdr);
}

NS_IMETHODIMP EwsMessageSyncListener::OnReadStatusChanged(
    const nsACString& ewsId, bool isRead) {
  return mOnReadStatusChanged(ewsId, isRead);
}

NS_IMETHODIMP EwsMessageSyncListener::OnMessageDeleted(
    const nsACString& ewsId) {
  return mOnMessageDeleted(ewsId);
}
NS_IMETHODIMP EwsMessageSyncListener::OnDetachedHdrPopulated(
    nsIMsgDBHdr* msgHdr) {
  return mOnDetachedHdrPopulated(msgHdr, mNewMessages);
}

NS_IMETHODIMP EwsMessageSyncListener::OnExistingHdrChanged() {
  return mOnExistingHdrChanged();
}

NS_IMETHODIMP EwsMessageSyncListener::OnSyncStateTokenChanged(
    const nsACString& syncStateToken) {
  return mOnSyncStateTokenChanged(syncStateToken);
}

NS_IMETHODIMP EwsMessageSyncListener::OnSyncComplete() {
  return mOnSyncComplete(mNewMessages);
}
