/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use ews::{
    copy_folder::CopyFolder, move_folder::MoveFolder, BaseFolderId, CopyMoveFolderData, Folder,
    FolderResponseMessage, Operation, OperationResponse,
};
use mailnews_ui_glue::UserInteractiveServer;
use std::marker::PhantomData;
use xpcom::RefCounted;

use crate::authentication::credentials::AuthenticationProvider;
use crate::client::copy_move_operations::move_generic::CopyMoveOperation;
use crate::client::{DoOperation, XpComEwsClient, XpComEwsError};
use crate::safe_xpcom::{SafeEwsSimpleOperationListener, SafeListener};

use super::move_generic::{move_generic, CopyMoveSuccess};

struct DoCopyMoveFolder<RequestT> {
    destination_folder_id: String,
    folder_ids: Vec<String>,
    _request_type: PhantomData<RequestT>,
}

impl<RequestT> DoOperation for DoCopyMoveFolder<RequestT>
where
    RequestT: CopyMoveOperation + From<CopyMoveFolderData> + Into<CopyMoveFolderData>,
    <RequestT as Operation>::Response: OperationResponse<Message = FolderResponseMessage>,
{
    const NAME: &'static str = <RequestT as Operation>::NAME;
    type Okay = CopyMoveSuccess;
    type Listener = SafeEwsSimpleOperationListener;

    async fn do_operation<ServerT>(
        &mut self,
        client: &XpComEwsClient<ServerT>,
    ) -> Result<Self::Okay, XpComEwsError>
    where
        ServerT: AuthenticationProvider + UserInteractiveServer + RefCounted,
    {
        move_generic::<_, RequestT>(
            client,
            self.destination_folder_id.clone(),
            self.folder_ids.clone(),
        )
        .await
    }

    fn into_success_arg(self, ok: Self::Okay) -> <Self::Listener as SafeListener>::OnSuccessArg {
        ok.into()
    }

    fn into_failure_arg(self) {}
}

impl<ServerT> XpComEwsClient<ServerT>
where
    ServerT: AuthenticationProvider + UserInteractiveServer + RefCounted,
{
    /// Copy or move a collection of EWS folders.
    ///
    /// The `RequestT` generic parameter indicates which EWS operation to perform
    /// based on its request input type. The trait bounds on `RequestT` enforce
    /// the required available operations to be generic over copy or move
    /// operations.
    ///
    /// The `destination_folder_id` is the EWS ID of the destination folder for
    /// the move or copy operation. The `folder_ids` parameter contains the
    /// collection of EWS folder IDs to copy or move. The `callbacks` parameter
    /// contains the callbacks to execute upon success or failure.
    pub(crate) async fn copy_move_folder<RequestT>(
        self,
        listener: SafeEwsSimpleOperationListener,
        destination_folder_id: String,
        folder_ids: Vec<String>,
    ) where
        RequestT: CopyMoveOperation + From<CopyMoveFolderData> + Into<CopyMoveFolderData>,
        <RequestT as Operation>::Response: OperationResponse<Message = FolderResponseMessage>,
    {
        let operation = DoCopyMoveFolder::<RequestT> {
            destination_folder_id,
            folder_ids,
            _request_type: PhantomData,
        };
        operation.handle_operation(&self, &listener).await;
    }
}

fn construct_request<RequestT, ServerT>(
    _client: &XpComEwsClient<ServerT>,
    destination_folder_id: String,
    folder_ids: Vec<String>,
) -> RequestT
where
    RequestT: From<CopyMoveFolderData>,
    ServerT: RefCounted,
{
    CopyMoveFolderData {
        to_folder_id: BaseFolderId::FolderId {
            id: destination_folder_id,
            change_key: None,
        },
        folder_ids: folder_ids
            .into_iter()
            .map(|id| BaseFolderId::FolderId {
                id,
                change_key: None,
            })
            .collect(),
    }
    .into()
}

// Create our own trait that upstream can't implement, to avoid errors about
// "upstream crates may add a new impl of trait" when implementing
// CopyMoveOperation on other types that shouldn't use this implementation.
trait FolderOperation: From<CopyMoveFolderData> + Into<CopyMoveFolderData> + Operation + Clone {}
impl FolderOperation for MoveFolder {}
impl FolderOperation for CopyFolder {}

impl<FolderOp: FolderOperation> CopyMoveOperation for FolderOp
where
    <FolderOp as Operation>::Response: OperationResponse<Message = FolderResponseMessage>,
{
    fn requires_resync(&self) -> bool {
        // We don't expect folder IDs to change after a move, so we shouldn't
        // need to sync the folder hierarchy after that operation completes, and
        // while a `CopyFolder` operation always requires a resync to get the
        // newly copied folder and item ids, the resync path is different than
        // the item resync path, so we always return false here.
        false
    }

    fn operation_builder<ServerT>(
        client: &XpComEwsClient<ServerT>,
        destination_folder_id: String,
        ids: Vec<String>,
    ) -> Self
    where
        ServerT: AuthenticationProvider + UserInteractiveServer + RefCounted,
    {
        construct_request(client, destination_folder_id, ids)
    }

    fn response_to_ids(
        response: Vec<<Self::Response as OperationResponse>::Message>,
    ) -> Vec<String> {
        get_new_ews_ids_from_response(response)
    }
}

fn get_new_ews_ids_from_response(response: Vec<FolderResponseMessage>) -> Vec<String> {
    response
        .into_iter()
        .filter_map(|response_message| {
            response_message.folders.inner.first().map(|folder| {
                match folder {
                    Folder::Folder { folder_id, .. } => folder_id,
                    _ => &None,
                }
                .as_ref()
                .map(|x| x.id.clone())
            })
        })
        .flatten()
        .collect()
}
