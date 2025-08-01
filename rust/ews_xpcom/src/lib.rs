/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

extern crate xpcom;

use ews::copy_item::CopyItem;
use ews::move_item::MoveItem;
use mailnews_ui_glue::UserInteractiveServer;
use nserror::{
    nsresult, NS_ERROR_ALREADY_INITIALIZED, NS_ERROR_INVALID_ARG, NS_ERROR_NOT_INITIALIZED, NS_OK,
};
use nsstring::nsACString;
use nsstring::nsCString;
use std::ptr;
use std::{cell::OnceCell, ffi::c_void};
use thin_vec::ThinVec;
use url::Url;
use xpcom::get_service;
use xpcom::getter_addrefs;
use xpcom::interfaces::nsIIOService;
use xpcom::interfaces::IEwsSimpleOperationListener;
use xpcom::{
    interfaces::{
        nsIInputStream, nsIMsgIncomingServer, nsIURI, nsIUrlListener, IEwsFolderCallbacks,
        IEwsMessageCallbacks, IEwsMessageCreateCallbacks, IEwsMessageFetchCallbacks,
    },
    nsIID, xpcom_method, RefPtr,
};

use authentication::credentials::{AuthenticationProvider, Credentials};
use client::XpComEwsClient;
use safe_xpcom::SafeEwsFolderCallbacks;

mod authentication;
mod cancellable_request;
mod client;
mod headers;
mod outgoing;
mod safe_xpcom;
mod xpcom_io;

/// Creates a new instance of the XPCOM/EWS bridge interface [`XpcomEwsBridge`].
#[allow(non_snake_case)]
#[no_mangle]
pub unsafe extern "C" fn NS_CreateEwsClient(iid: &nsIID, result: *mut *mut c_void) -> nsresult {
    let instance = XpcomEwsBridge::allocate(InitXpcomEwsBridge {
        server: OnceCell::default(),
        details: OnceCell::default(),
    });

    instance.QueryInterface(iid, result)
}

/// `XpcomEwsBridge` provides an XPCOM interface implementation for mediating
/// between C++ consumers and an async Rust EWS client.
#[xpcom::xpcom(implement(IEwsClient), atomic)]
struct XpcomEwsBridge {
    server: OnceCell<Box<dyn UserInteractiveServer>>,
    details: OnceCell<EwsConnectionDetails>,
}

#[derive(Clone)]
struct EwsConnectionDetails {
    endpoint: Url,
    server: RefPtr<nsIMsgIncomingServer>,
    credentials: Credentials,
}

impl XpcomEwsBridge {
    xpcom_method!(initialize => Initialize(endpoint: *const nsACString, server: *const nsIMsgIncomingServer));
    fn initialize(
        &self,
        endpoint: &nsACString,
        server: &nsIMsgIncomingServer,
    ) -> Result<(), nsresult> {
        let endpoint = Url::parse(&endpoint.to_utf8()).map_err(|_| NS_ERROR_INVALID_ARG)?;

        let credentials = server.get_credentials()?;
        let server = RefPtr::new(server);

        self.details
            .set(EwsConnectionDetails {
                endpoint,
                server,
                credentials,
            })
            .map_err(|_| NS_ERROR_ALREADY_INITIALIZED)?;

        Ok(())
    }

    xpcom_method!(check_connectivity => CheckConnectivity(listener: *const nsIUrlListener) -> *const nsIURI);
    fn check_connectivity(&self, listener: &nsIUrlListener) -> Result<RefPtr<nsIURI>, nsresult> {
        // Extract the endpoint URL from the existing server details (or error
        // if these haven't been set yet).
        let uri = nsCString::from(
            self.details
                .get()
                .ok_or(nserror::NS_ERROR_NOT_INITIALIZED)?
                .endpoint
                .to_string(),
        );

        // Turn the string URI into an `nsIURI`.
        let io_service = get_service::<nsIIOService>(c"@mozilla.org/network/io-service;1")
            .ok_or(nserror::NS_ERROR_FAILURE)?;

        let uri =
            getter_addrefs(|p| unsafe { io_service.NewURI(&*uri, ptr::null(), ptr::null(), p) })?;

        // Get an EWS client and make a request to check connectivity to the EWS
        // server.
        let client = self.try_new_client()?;

        moz_task::spawn_local(
            "check_connectivity",
            client.check_connectivity(uri.clone(), RefPtr::new(listener)),
        )
        .detach();

        Ok(uri)
    }

    xpcom_method!(sync_folder_hierarchy => SyncFolderHierarchy(callbacks: *const IEwsFolderCallbacks, sync_state: *const nsACString));
    fn sync_folder_hierarchy(
        &self,
        callbacks: &IEwsFolderCallbacks,
        sync_state: &nsACString,
    ) -> Result<(), nsresult> {
        // We can't use `Option` across XPCOM, but we want to use one internally
        // so we don't send an empty string for sync state.
        let sync_state = if sync_state.is_empty() {
            None
        } else {
            Some(sync_state.to_utf8().into_owned())
        };

        let client = self.try_new_client()?;

        // The client operation is async and we want it to survive the end of
        // this scope, so spawn it as a detached `moz_task`.
        moz_task::spawn_local(
            "sync_folder_hierarchy",
            client.sync_folder_hierarchy(SafeEwsFolderCallbacks::new(callbacks), sync_state),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(create_folder => CreateFolder(listener: *const IEwsSimpleOperationListener, parent_id: *const nsACString, name: *const nsACString));
    fn create_folder(
        &self,
        listener: &IEwsSimpleOperationListener,
        parent_id: &nsACString,
        name: &nsACString,
    ) -> Result<(), nsresult> {
        if parent_id.is_empty() || name.is_empty() {
            return Err(nserror::NS_ERROR_INVALID_ARG);
        }

        let client = self.try_new_client()?;

        // The client operation is async and we want it to survive the end of
        // this scope, so spawn it as a detached `moz_task`.
        moz_task::spawn_local(
            "create_folder",
            client.create_folder(
                RefPtr::new(listener),
                parent_id.to_utf8().into(),
                name.to_utf8().into(),
            ),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(delete_folder => DeleteFolder(listener: *const IEwsSimpleOperationListener, folder_id: *const nsACString));
    fn delete_folder(
        &self,
        listener: &IEwsSimpleOperationListener,
        folder_id: &nsACString,
    ) -> Result<(), nsresult> {
        let client = self.try_new_client()?;

        // The client operation is async and we want it to survive the end of
        // this scope, so spawn it as a detached `moz_task`.
        moz_task::spawn_local(
            "delete_folder",
            client.delete_folder(RefPtr::new(listener), folder_id.to_utf8().into_owned()),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(update_folder => UpdateFolder(listener: *const IEwsSimpleOperationListener, folder_id: *const nsACString, folder_name: *const nsACString));
    fn update_folder(
        &self,
        listener: &IEwsSimpleOperationListener,
        folder_id: &nsACString,
        folder_name: &nsACString,
    ) -> Result<(), nsresult> {
        let client = self.try_new_client()?;

        // The client operation is async and we want it to survive the end of
        // this scope, so spawn it as a detached `moz_task`.
        moz_task::spawn_local(
            "update_folder",
            client.update_folder(
                RefPtr::new(listener),
                folder_id.to_utf8().into_owned(),
                folder_name.to_utf8().into_owned(),
            ),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(sync_messages_for_folder => SyncMessagesForFolder(callbacks: *const IEwsMessageCallbacks, folder_id: *const nsACString, sync_state: *const nsACString));
    fn sync_messages_for_folder(
        &self,
        callbacks: &IEwsMessageCallbacks,
        folder_id: &nsACString,
        sync_state: &nsACString,
    ) -> Result<(), nsresult> {
        // We can't use `Option` across XPCOM, but we want to use one internally
        // so we don't send an empty string for sync state.
        let sync_state = if sync_state.is_empty() {
            None
        } else {
            Some(sync_state.to_utf8().into_owned())
        };

        let client = self.try_new_client()?;

        // The client operation is async and we want it to survive the end of
        // this scope, so spawn it as a detached `moz_task`.
        moz_task::spawn_local(
            "sync_messages_for_folder",
            client.sync_messages_for_folder(
                RefPtr::new(callbacks),
                folder_id.to_utf8().into_owned(),
                sync_state,
            ),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(get_message => GetMessage(id: *const nsACString, callbacks: *const IEwsMessageFetchCallbacks));
    fn get_message(
        &self,
        id: &nsACString,
        callbacks: &IEwsMessageFetchCallbacks,
    ) -> Result<(), nsresult> {
        let client = self.try_new_client()?;

        // The client operation is async and we want it to survive the end of
        // this scope, so spawn it as a detached `moz_task`.
        moz_task::spawn_local(
            "get_message",
            client.get_message(id.to_utf8().into(), RefPtr::new(callbacks)),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(change_read_status => ChangeReadStatus(
        message_ids: *const ThinVec<nsCString>,
        is_read: bool
    ));
    fn change_read_status(
        &self,
        message_ids: &ThinVec<nsCString>,
        is_read: bool,
    ) -> Result<(), nsresult> {
        let message_ids: Vec<String> = message_ids
            .iter()
            .map(|message_id| message_id.to_string())
            .collect();

        let client = self.try_new_client()?;

        // The client operation is async and we want it to survive the end of
        // this scope, so spawn it as a detached `moz_task`.
        moz_task::spawn_local(
            "change_read_status",
            client.change_read_status(message_ids, is_read),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(create_message => CreateMessage(folder_id: *const nsACString, is_draft: bool, is_read: bool, message_stream: *const nsIInputStream, callbacks: *const IEwsMessageCreateCallbacks));
    fn create_message(
        &self,
        folder_id: &nsACString,
        is_draft: bool,
        is_read: bool,
        message_stream: &nsIInputStream,
        callbacks: &IEwsMessageCreateCallbacks,
    ) -> Result<(), nsresult> {
        let content = crate::xpcom_io::read_stream(message_stream)?;

        let client = self.try_new_client()?;

        // The client operation is async and we want it to survive the end of
        // this scope, so spawn it as a detached `moz_task`.
        moz_task::spawn_local(
            "save_message",
            client.create_message(
                folder_id.to_utf8().into(),
                is_draft,
                is_read,
                content,
                RefPtr::new(callbacks),
            ),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(move_items => MoveItems(listener: *const IEwsSimpleOperationListener, destination_folder_id: *const nsACString, item_ids: *const ThinVec<nsCString>));
    fn move_items(
        &self,
        listener: &IEwsSimpleOperationListener,
        destination_folder_id: &nsACString,
        item_ids: &ThinVec<nsCString>,
    ) -> Result<(), nsresult> {
        let client = self.try_new_client()?;

        moz_task::spawn_local(
            "move_items",
            client.copy_move_item::<MoveItem>(
                RefPtr::new(listener),
                destination_folder_id.to_string(),
                item_ids.iter().map(|id| id.to_string()).collect(),
            ),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(copy_items => CopyItems(listener: *const IEwsSimpleOperationListener, destination_folder_id: *const nsACString, item_ids: *const ThinVec<nsCString>));
    fn copy_items(
        &self,
        listener: &IEwsSimpleOperationListener,
        destination_folder_id: &nsACString,
        item_ids: &ThinVec<nsCString>,
    ) -> Result<(), nsresult> {
        let client = self.try_new_client()?;

        moz_task::spawn_local(
            "copy_items",
            client.copy_move_item::<CopyItem>(
                RefPtr::new(listener),
                destination_folder_id.to_string(),
                item_ids.iter().map(|id| id.to_string()).collect(),
            ),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(move_folders => MoveFolders(listener: *const IEwsSimpleOperationListener, destination_folder_id: *const nsACString, folder_ids: *const ThinVec<nsCString>));
    fn move_folders(
        &self,
        listener: &IEwsSimpleOperationListener,
        destination_folder_id: &nsACString,
        folder_ids: &ThinVec<nsCString>,
    ) -> Result<(), nsresult> {
        let client = self.try_new_client()?;

        moz_task::spawn_local(
            "move_folders",
            client.move_folder(
                RefPtr::new(listener),
                destination_folder_id.to_string(),
                folder_ids.iter().map(|id| id.to_string()).collect(),
            ),
        )
        .detach();

        Ok(())
    }

    xpcom_method!(delete_messages => DeleteMessages(listener: *const IEwsSimpleOperationListener, ews_ids: *const ThinVec<nsCString>));
    fn delete_messages(
        &self,
        listener: &IEwsSimpleOperationListener,
        ews_ids: &ThinVec<nsCString>,
    ) -> Result<(), nsresult> {
        let client = self.try_new_client()?;

        // The client operation is async and we want it to survive the end of
        // this scope, so spawn it as a detached `moz_task`.
        moz_task::spawn_local(
            "delete_messages",
            client.delete_messages(RefPtr::new(listener), ews_ids.clone()),
        )
        .detach();

        Ok(())
    }

    /// Gets a new EWS client if initialized.
    fn try_new_client(&self) -> Result<XpComEwsClient<nsIMsgIncomingServer>, nsresult> {
        // We only get a reference out of the cell, but we need ownership in
        // order for the `XpcomEwsClient` to be `Send`, so we're forced to
        // clone.
        let EwsConnectionDetails {
            endpoint,
            server,
            credentials,
        } = self.details.get().ok_or(NS_ERROR_NOT_INITIALIZED)?.clone();

        Ok(XpComEwsClient::new(endpoint, server, credentials)?)
    }
}
