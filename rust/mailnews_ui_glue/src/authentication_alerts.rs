/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::ptr;

use thin_vec::thin_vec;

use nserror::nsresult;
use nsstring::nsString;
use xpcom::interfaces::{nsIMsgIncomingServer, nsIPrompt, nsIPromptService, nsMsgAuthMethod};
use xpcom::{get_service, RefCounted, RefPtr};

use crate::user_interactive_server::UserInteractiveServer;
use crate::{
    get_formatted_string, get_string, get_string_bundle, register_alert, IMAP_MSG_STRING_BUNDLE,
    MESSENGER_STRING_BUNDLE,
};

/// The outcome of the handling of an authentication error, and the action that
/// should be taken next.
#[repr(C)]
pub enum AuthErrorOutcome {
    /// The authentication problem might have been resolved (e.g. the user has
    /// set a new password), so the request should be retried.
    RETRY,

    /// The authentication error could not be recovered from, so the request
    /// should be aborted.
    ABORT,
}

/// Handle an authentication failure that came from the given
/// [`nsIMsgIncomingServer`].
///
/// Note the actual error is not included here, because all we need to know here
/// is that we failed to authenticate against the remote server.
///
/// # Safety
///
/// The arguments must point to valid objects or be the null pointer. In the
/// latter case, this function will return [`nserror::NS_ERROR_NULL_POINTER`].
#[no_mangle]
pub unsafe extern "C" fn handle_auth_failure_from_incoming_server(
    incoming_server: *const nsIMsgIncomingServer,
    action: *mut AuthErrorOutcome,
) -> nsresult {
    if incoming_server.is_null() || action.is_null() {
        return nserror::NS_ERROR_NULL_POINTER;
    }

    // SAFETY: We have already ensured the provided pointer isn't null, and the
    // function's call contract implies consumers should ensure it's valid.
    // `RefPtr::from_raw` only returns `None` if the pointer is null, and we
    // have already ensured all of our pointers are non-null, so unwrapping
    // shouldn't panic here.
    let incoming_server = RefPtr::from_raw(incoming_server).unwrap();

    match handle_auth_failure(incoming_server) {
        Ok(outcome) => {
            // SAFETY: We have already ensured the provided pointer is not null,
            // and the function's call contract implies consumers should ensure
            // it's valid.
            *action = outcome;
            nserror::NS_OK
        }
        Err(err) => err,
    }
}

/// Handle an authentication error that came from the given server, as per its
/// preferred authentication method.
///
/// Note the actual error is not included here, because all we need to know here
/// is that we failed to authenticate against the remote server.
pub fn handle_auth_failure<ServerT>(server: RefPtr<ServerT>) -> Result<AuthErrorOutcome, nsresult>
where
    ServerT: UserInteractiveServer + RefCounted,
{
    match server.auth_method()? {
        nsMsgAuthMethod::OAuth2 => notify_oauth_failure(server),
        nsMsgAuthMethod::passwordCleartext => notify_password_failure(server),
        _ => Err(nserror::NS_ERROR_NOT_IMPLEMENTED),
    }
}

/// Notify the user about a failure to authenticate against the given server
/// using OAuth2.
///
/// This function always returns [`AuthErrorOutcome::ABORT`] (unless an error
/// occurs while notifying).
fn notify_oauth_failure<ServerT>(server: RefPtr<ServerT>) -> Result<AuthErrorOutcome, nsresult>
where
    ServerT: UserInteractiveServer + RefCounted,
{
    let host_name = server.host_name()?;
    let uri = server.uri()?;
    let bundle = get_string_bundle(IMAP_MSG_STRING_BUNDLE)?;
    let message = get_formatted_string(&bundle, c"imapOAuth2Error", thin_vec![host_name])?;
    register_alert(message, uri)?;
    Ok(AuthErrorOutcome::ABORT)
}

/// Notify the user about a failure to authenticate against the given server
/// using a password.
///
/// The user is shown a modal with three options which define what further
/// action needs to be taken:
///  * retry: [`AuthErrorOutcome::RETRY`] is returned immediately.
///  * enter a new password: the user is shown a prompt to enter a new password,
///    after validating which [`AuthErrorOutcome::RETRY`] is returned to let the
///    server it should try again with the new password.
///  * cancel: [`AuthErrorOutcome::ABORT`] is returned immediately.
fn notify_password_failure<ServerT>(server: RefPtr<ServerT>) -> Result<AuthErrorOutcome, nsresult>
where
    ServerT: UserInteractiveServer + RefCounted,
{
    // If there isn't a password set on the server, there's no point asking the
    // user if they want to retry, so we skip straight to prompting for a new
    // one.
    let password = server.password()?;
    if password.is_empty() {
        prompt_for_password(server, String::new())?;
        return Ok(AuthErrorOutcome::RETRY);
    }

    let host_name = server.host_name()?;
    let username = server.username()?;
    let display_name = server.display_name()?;
    let bundle = get_string_bundle(MESSENGER_STRING_BUNDLE)?;

    let message = get_formatted_string(
        &bundle,
        c"mailServerLoginFailed2",
        thin_vec![host_name, username],
    )?;
    // We need to make this (and all related strings) `nsString`s rather than
    // `CString`s because `ConfirmEx` expects them to be UTF-16 (`*const u16`,
    // rather than `*const c_char`).
    let message = nsString::from(&message);

    let title = get_formatted_string(
        &bundle,
        c"mailServerLoginFailedTitleWithAccount",
        thin_vec![display_name],
    )?;
    let title = nsString::from(&title);

    let retry_button = get_string(&bundle, c"mailServerLoginFailedRetryButton")?;
    let retry_button = nsString::from(&retry_button);

    let new_password_button = get_string(&bundle, c"mailServerLoginFailedEnterNewPasswordButton")?;
    let new_password_button = nsString::from(&new_password_button);

    let prompt_service = get_service::<nsIPromptService>(c"@mozilla.org/prompter;1")
        .ok_or(nserror::NS_ERROR_UNEXPECTED)?;

    let button_flags = (nsIPrompt::BUTTON_TITLE_IS_STRING * nsIPrompt::BUTTON_POS_0)
        + (nsIPrompt::BUTTON_TITLE_CANCEL * nsIPrompt::BUTTON_POS_1)
        + (nsIPrompt::BUTTON_TITLE_IS_STRING * nsIPrompt::BUTTON_POS_2);

    let mut pressed_button_index: i32 = 0;
    let mut checkbox_check_state = false;

    // SAFETY: `aParent` is always allowed to be null, `aButton1Title` is unused
    // because `BUTTON_TITLE_IS_STRING` was not set for button 1, `aCheckMsg` is
    // null to avoid a checkbox, and the remaining values were safely
    // constructed above.
    unsafe {
        prompt_service.ConfirmEx(
            ptr::null(),                  // aParent
            title.as_ptr(),               // aDialogTitle
            message.as_ptr(),             // aText
            button_flags,                 // aButtonFlags
            retry_button.as_ptr(),        // aButton0Title
            ptr::null(),                  // aButton1Title
            new_password_button.as_ptr(), // aButton2Title
            ptr::null(),                  // aCheckMsg
            &mut checkbox_check_state,    // aCheckState
            &mut pressed_button_index,    // retval
        )
    }
    .to_result()?;

    // Figure out what to do next based on the user's input.
    let action = match pressed_button_index {
        // Retry button.
        0 => AuthErrorOutcome::RETRY,
        // New password button.
        2 => {
            let password = server.password()?;
            server.forget_password()?;
            prompt_for_password(server, password)?;
            AuthErrorOutcome::RETRY
        }
        // Anything else, including the Cancel button.
        _ => AuthErrorOutcome::ABORT,
    };

    Ok(action)
}

/// Prompt the user to enter a new password.
///
/// This ends up calling `GetPasswordWithUI` on the relevant `nsIMsg[...]Server`
/// interface, which is expected to handle the storage of the password once the
/// user validates the prompt.
fn prompt_for_password<ServerT>(
    server: RefPtr<ServerT>,
    old_password: String,
) -> Result<(), nsresult>
where
    ServerT: UserInteractiveServer + RefCounted,
{
    let host_name = server.host_name()?;
    let username = server.username()?;
    let bundle = get_string_bundle(IMAP_MSG_STRING_BUNDLE)?;

    let title = get_formatted_string(
        &bundle,
        c"imapEnterPasswordPromptTitleWithUsername",
        thin_vec![username.clone()],
    )?;

    let message = get_formatted_string(
        &bundle,
        c"imapEnterServerPasswordPrompt",
        thin_vec![username, host_name],
    )?;

    server.prompt_for_password(message, title, old_password)
}
