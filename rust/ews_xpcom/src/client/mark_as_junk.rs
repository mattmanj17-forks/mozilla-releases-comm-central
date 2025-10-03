/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use ews::{
    mark_as_junk::MarkAsJunk, move_item::MoveItem, server_version::ExchangeServerVersion,
    BaseItemId, Operation, OperationResponse,
};
use mailnews_ui_glue::UserInteractiveServer;
use nsstring::nsCString;
use thin_vec::ThinVec;
use xpcom::RefCounted;

use crate::{
    authentication::credentials::AuthenticationProvider,
    client::{
        copy_move_operations::move_generic::CopyMoveSuccess, process_response_message_class,
        validate_response_message_count, XpComEwsClient, XpComEwsError,
    },
    safe_xpcom::{handle_error, SafeEwsSimpleOperationListener, SafeListener},
};

impl<ServerT> XpComEwsClient<ServerT>
where
    ServerT: AuthenticationProvider + UserInteractiveServer + RefCounted,
{
    pub async fn mark_as_junk(
        self,
        listener: SafeEwsSimpleOperationListener,
        ews_ids: ThinVec<nsCString>,
        is_junk: bool,
        legacy_destination_folder_id: String,
    ) {
        // Call an inner function to perform the operation in order to allow us
        // to handle errors while letting the inner function simply propagate.
        match self
            .mark_as_junk_inner(ews_ids, is_junk, legacy_destination_folder_id)
            .await
        {
            Ok(ids) => {
                let use_legacy_fallback = ids.is_none();
                let _ = listener
                    .on_success((ids.unwrap_or(ThinVec::new()), use_legacy_fallback).into());
            }
            Err(err) => handle_error(&listener, MarkAsJunk::NAME, &err, ()),
        };
    }

    async fn mark_as_junk_inner(
        self,
        ews_ids: ThinVec<nsCString>,
        is_junk: bool,
        legacy_destination_folder_id: String,
    ) -> Result<Option<ThinVec<nsCString>>, XpComEwsError>
    where
        ServerT: AuthenticationProvider + UserInteractiveServer + RefCounted,
    {
        let server_version = self.server_version.get();

        // The `MarkAsJunk` operation was added in Exchange2013.
        let use_mark_as_junk = server_version >= ExchangeServerVersion::Exchange2013;

        let item_ids: Vec<BaseItemId> = ews_ids
            .iter()
            .map(|raw_id| BaseItemId::ItemId {
                id: raw_id.to_string(),
                change_key: None,
            })
            .collect();

        if use_mark_as_junk {
            let mark_as_junk = MarkAsJunk {
                is_junk,
                move_item: true,
                item_ids,
            };

            let response = self
                .make_operation_request(mark_as_junk, Default::default())
                .await?;

            let response_messages = response.into_response_messages();
            validate_response_message_count(&response_messages, ews_ids.len())?;

            let new_ids = response_messages
                .into_iter()
                .map(|response_message| {
                    process_response_message_class(MarkAsJunk::NAME, response_message)
                })
                .map(|response| response.map(|v| nsCString::from(v.moved_item_id.id)))
                .collect::<Result<ThinVec<nsCString>, _>>()?;

            Ok(Some(new_ids))
        } else if !legacy_destination_folder_id.is_empty() {
            // We have to move the items to the junk folder using a regular move operation.
            let CopyMoveSuccess {
                new_ids,
                requires_resync,
            } = self
                .copy_move_item_functional::<MoveItem>(
                    legacy_destination_folder_id.to_string(),
                    ews_ids.iter().map(|s| s.to_string()).collect(),
                )
                .await?;
            Ok(if requires_resync {
                None
            } else {
                Some(new_ids.iter().map(nsCString::from).collect())
            })
        } else {
            Err(XpComEwsError::Processing { message: "Unable to determine junk folder and Exchange version is too old for `MarkAsJunk` operation.".to_string() })
        }
    }
}
