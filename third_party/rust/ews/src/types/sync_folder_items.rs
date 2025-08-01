/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use ews_proc_macros::operation_response;
use serde::Deserialize;
use xml_struct::XmlSerialize;

use crate::{BaseFolderId, BaseItemId, ItemId, ItemShape, RealItem, MESSAGES_NS_URI};

/// A request for a list of items which have been created, updated, or deleted
/// server-side.
///
/// See <https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/syncfolderitems>
#[derive(Clone, Debug, XmlSerialize)]
#[xml_struct(default_ns = MESSAGES_NS_URI)]
#[operation_response(SyncFolderItemsResponseMessage)]
pub struct SyncFolderItems {
    /// A description of the information to be included in the response for each
    /// changed item.
    pub item_shape: ItemShape,

    /// The ID of the folder to sync.
    pub sync_folder_id: BaseFolderId,

    /// The synchronization state after which to list changes.
    ///
    /// If `None`, the response will include `Create` changes for each item
    /// which is contained in the requested folder.
    ///
    /// See <https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/syncstate-ex15websvcsotherref>
    pub sync_state: Option<String>,

    /// A list of item IDs for which changes should not be returned.
    ///
    /// See <https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/ignore>
    pub ignore: Option<ArrayOfBaseItemIds>,

    /// The maximum number of changes to return in the response.
    ///
    /// This value must be in the range `1..=512`.
    ///
    /// See <https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/maxchangesreturned>
    pub max_changes_returned: u16,

    pub sync_scope: Option<SyncScope>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct SyncFolderItemsResponseMessage {
    /// An identifier for the synchronization state following application of the
    /// changes included in this response.
    pub sync_state: String,

    /// Whether all relevant item changes have been synchronized following this
    /// response.
    pub includes_last_item_in_range: bool,

    /// The collection of changes between the prior synchronization state and
    /// the one represented by this response.
    pub changes: Changes,
}

/// An ordered collection of identifiers for Exchange items.
#[derive(Clone, Debug, XmlSerialize)]
pub struct ArrayOfBaseItemIds {
    item_id: Vec<BaseItemId>,
}

#[derive(Clone, Copy, Debug, XmlSerialize)]
pub enum SyncScope {
    NormalItems,
    NormalAndAssociatedItems,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Changes {
    #[serde(default, rename = "$value")]
    pub inner: Vec<Change>,
}

/// A server-side change to an item.
///
/// See <https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/changes-items>
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub enum Change {
    /// A creation of an item.
    ///
    /// See <https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/create-itemsync>
    Create {
        /// The state of the item upon creation.
        #[serde(rename = "$value")]
        item: RealItem,
    },

    /// An update to an item.
    ///
    /// See <https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/update-itemsync>
    Update {
        /// The updated state of the item.
        #[serde(rename = "$value")]
        item: RealItem,
    },

    /// A deletion of an item.
    ///
    /// See <https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/delete-itemsync>
    #[serde(rename_all = "PascalCase")]
    Delete {
        /// The EWS ID for the deleted item.
        item_id: ItemId,
    },

    #[serde(rename_all = "PascalCase")]
    ReadFlagChange { item_id: ItemId, is_read: bool },
}
