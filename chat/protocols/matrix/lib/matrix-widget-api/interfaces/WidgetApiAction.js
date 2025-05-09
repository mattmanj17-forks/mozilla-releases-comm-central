"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.WidgetApiToWidgetAction = exports.WidgetApiFromWidgetAction = void 0;
/*
 * Copyright 2020 The Matrix.org Foundation C.I.C.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var WidgetApiToWidgetAction = /*#__PURE__*/function (WidgetApiToWidgetAction) {
  WidgetApiToWidgetAction["SupportedApiVersions"] = "supported_api_versions";
  WidgetApiToWidgetAction["Capabilities"] = "capabilities";
  WidgetApiToWidgetAction["NotifyCapabilities"] = "notify_capabilities";
  WidgetApiToWidgetAction["TakeScreenshot"] = "screenshot";
  WidgetApiToWidgetAction["UpdateVisibility"] = "visibility";
  WidgetApiToWidgetAction["OpenIDCredentials"] = "openid_credentials";
  WidgetApiToWidgetAction["WidgetConfig"] = "widget_config";
  WidgetApiToWidgetAction["CloseModalWidget"] = "close_modal";
  WidgetApiToWidgetAction["ButtonClicked"] = "button_clicked";
  WidgetApiToWidgetAction["SendEvent"] = "send_event";
  WidgetApiToWidgetAction["SendToDevice"] = "send_to_device";
  WidgetApiToWidgetAction["UpdateTurnServers"] = "update_turn_servers";
  return WidgetApiToWidgetAction;
}({});
exports.WidgetApiToWidgetAction = WidgetApiToWidgetAction;
var WidgetApiFromWidgetAction = /*#__PURE__*/function (WidgetApiFromWidgetAction) {
  WidgetApiFromWidgetAction["SupportedApiVersions"] = "supported_api_versions";
  WidgetApiFromWidgetAction["ContentLoaded"] = "content_loaded";
  WidgetApiFromWidgetAction["SendSticker"] = "m.sticker";
  WidgetApiFromWidgetAction["UpdateAlwaysOnScreen"] = "set_always_on_screen";
  WidgetApiFromWidgetAction["GetOpenIDCredentials"] = "get_openid";
  WidgetApiFromWidgetAction["CloseModalWidget"] = "close_modal";
  WidgetApiFromWidgetAction["OpenModalWidget"] = "open_modal";
  WidgetApiFromWidgetAction["SetModalButtonEnabled"] = "set_button_enabled";
  WidgetApiFromWidgetAction["SendEvent"] = "send_event";
  WidgetApiFromWidgetAction["SendToDevice"] = "send_to_device";
  WidgetApiFromWidgetAction["WatchTurnServers"] = "watch_turn_servers";
  WidgetApiFromWidgetAction["UnwatchTurnServers"] = "unwatch_turn_servers";
  WidgetApiFromWidgetAction["BeeperReadRoomAccountData"] = "com.beeper.read_room_account_data";
  WidgetApiFromWidgetAction["MSC2876ReadEvents"] = "org.matrix.msc2876.read_events";
  WidgetApiFromWidgetAction["MSC2931Navigate"] = "org.matrix.msc2931.navigate";
  WidgetApiFromWidgetAction["MSC2974RenegotiateCapabilities"] = "org.matrix.msc2974.request_capabilities";
  WidgetApiFromWidgetAction["MSC3869ReadRelations"] = "org.matrix.msc3869.read_relations";
  WidgetApiFromWidgetAction["MSC3973UserDirectorySearch"] = "org.matrix.msc3973.user_directory_search";
  WidgetApiFromWidgetAction["MSC4039GetMediaConfigAction"] = "org.matrix.msc4039.get_media_config";
  WidgetApiFromWidgetAction["MSC4039UploadFileAction"] = "org.matrix.msc4039.upload_file";
  WidgetApiFromWidgetAction["MSC4039DownloadFileAction"] = "org.matrix.msc4039.download_file";
  WidgetApiFromWidgetAction["MSC4157UpdateDelayedEvent"] = "org.matrix.msc4157.update_delayed_event";
  return WidgetApiFromWidgetAction;
}({});
exports.WidgetApiFromWidgetAction = WidgetApiFromWidgetAction;
//# sourceMappingURL=WidgetApiAction.js.map