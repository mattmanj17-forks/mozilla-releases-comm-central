/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

/**
 * Remove an account with the address from the current profile.
 *
 * @param {string} address - The email address to try to remove.
 */
export function remove_email_account(address) {
  for (const account of MailServices.accounts.accounts) {
    if (account.defaultIdentity && account.defaultIdentity.email == address) {
      MailServices.accounts.removeAccount(account);
      break;
    }
  }
}
