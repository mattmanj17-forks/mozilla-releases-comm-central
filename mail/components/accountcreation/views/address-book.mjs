/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import "chrome://messenger/content/accountcreation/content/widgets/account-hub-step.mjs"; // eslint-disable-line import/no-unassigned-import
import "chrome://messenger/content/accountcreation/content/widgets/account-hub-footer.mjs"; // eslint-disable-line import/no-unassigned-import

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailServices: "resource:///modules/MailServices.sys.mjs",
  RemoteAddressBookUtils:
    "resource:///modules/accountcreation/RemoteAddressBookUtils.sys.mjs",
});

class AccountHubAddressBook extends HTMLElement {
  static get observedAttributes() {
    return ["hidden"];
  }

  /**
   * String of ID of current step in email flow.
   *
   * @type {string}
   */
  #currentState;

  /**
   * Address book footer.
   *
   * @type {HTMLElement}
   */
  #footer;

  /**
   * @typedef {object} AddressBookAccounts
   * @property {nsIMsgAccount} account - A user account.
   * @property {foundBook} addressBooks - An address book linked to the user account.
   * @property {number} existingAddressBookCount - Already synced address books
   *  count.
   */

  /**
   * @typedef {object} foundBook
   * @property {URL} url - The address for this address book.
   * @property {string} name - The name of this address book on the server.
   * @property {Function} create - A callback to add this address book locally.
   * @property {boolean} existing - Address book has already been synced.
   */

  /**
   * User accounts with address books.
   *
   * @type {AddressBookAccounts[]}
   */
  #accounts = [];

  /**
   * States of the email setup flow, based on the ID's of the steps in the
   * flow.
   *
   * @type {object}
   */
  #states = {
    optionSelectSubview: {
      id: "addressBookOptionSelectSubview",
      nextStep: "",
      previousStep: "",
      forwardEnabled: false,
      subview: {},
      templateId: "address-book-option-select",
    },
    accountSelectSubview: {
      id: "addressBookAccountSelectSubview",
      nextStep: false,
      previousStep: "optionSelectSubview",
      forwardEnabled: false,
      subview: {},
      templateId: "address-book-account-select",
    },
    remoteAccountSubview: {
      id: "addressBookRemoteAccountFormSubview",
      nextStep: true,
      previousStep: "optionSelectSubview",
      forwardEnabled: false,
      subview: {},
      templateId: "address-book-remote-account-form",
    },
    ldapAccountSubview: {
      id: "addressBookLdapAccountFormSubview",
      nextStep: true,
      previousStep: "optionSelectSubview",
      forwardEnabled: false,
      subview: {},
      templateId: "address-book-ldap-account-form",
    },
    syncAddressBooksSubview: {
      id: "addressBookSyncSubview",
      nextStep: true,
      previousStep: "accountSelectSubview",
      forwardEnabled: true,
      subview: {},
      templateId: "address-book-sync",
    },
    localAddressBookSubview: {
      id: "addressBookLocalSubview",
      nextStep: true,
      previousStep: "optionSelectSubview",
      forwardEnabled: true,
      subview: {},
      templateId: "address-book-local-form",
    },
    remotePasswordSubview: {
      id: "addressBookPasswordSubview",
      nextStep: "syncAddressBooksSubview",
      previousStep: "remoteAccountSubview",
      forwardEnabled: true,
      subview: {},
      templateId: "email-password-form",
    },
  };

  async connectedCallback() {
    if (this.hasConnected) {
      return;
    }

    this.hasConnected = true;

    this.classList.add("account-hub-view");

    const template = document.getElementById("accountHubAddressBookSetup");
    this.appendChild(template.content.cloneNode(true));

    for (const state in this.#states) {
      const subviewId = this.#states[state].id;
      this.#states[state].subview = this.querySelector(`#${subviewId}`);
    }

    this.#footer = this.querySelector("#addressBookFooter");
    this.#footer.addEventListener("back", this);
    this.#footer.addEventListener("forward", this);
    this.addEventListener("submit", this);
    this.addEventListener("config-updated", this);
    this.ready = this.#initUI("optionSelectSubview");
    await this.ready;
    await this.init();
  }

  attributeChangedCallback(attributeName, oldValue, newValue) {
    if (attributeName === "hidden" && newValue === null) {
      // If the template was already loaded and we're going back to it we should
      // trigger init() to ensure we're not showing stale data.
      this.init();
    }
  }

  /**
   * Called when address book view is visible, fetches fresh list of accounts
   * and address books.
   */
  async init() {
    await this.#fetchAccounts();
    this.#states.optionSelectSubview.subview.setState(this.#accounts);
  }

  /**
   * Returns the subview of the current state.
   *
   * @returns {HTMLElement} The current subview.
   */
  get #currentSubview() {
    return this.#states[this.#currentState].subview;
  }

  /**
   * Inject a state into the list of states (for unit testing).
   *
   * @param {string} stateName - Name of the state, always has "Test" added to the end.
   * @param {object} state - State data.
   */
  insertTestState(stateName, state) {
    this.#states[`${stateName}Test`] = state;
  }

  /**
   * Inject an account in the list of #accounts (for unit testing).
   *
   * @param {AddressBookAccounts} account - The test address book account.
   */
  insertTestAccount(account) {
    this.#accounts.push(account);
  }

  /**
   * Remove the test account from the list of #accounts (for unit testing).
   *
   * @param {AddressBookAccounts} account - The test address book account.
   */
  removeTestAccount(account) {
    this.#accounts = this.#accounts.filter(
      addressBookAccount =>
        addressBookAccount.account.incomingServer.username !=
        account.account.incomingServer.username
    );
  }

  /**
   * Handle the events from the subviews.
   *
   * @param {Event} event
   */
  async handleEvent(event) {
    const stateDetails = this.#states[this.#currentState];
    switch (event.type) {
      case "back":
        await this.#initUI(stateDetails.previousStep);
        break;
      case "submit":
        event.preventDefault();
        if (!event.target.checkValidity()) {
          // Do nothing.
          break;
        }

        if (this.#currentState === "optionSelectSubview") {
          await this.#initUI(event.submitter.value);
          this.#currentSubview.setState?.(this.#accounts);
          break;
        }

        if (this.#currentState === "accountSelectSubview") {
          await this.#initUI("syncAddressBooksSubview");
          const account = this.#accounts.find(
            addressBookAccount =>
              addressBookAccount.account.incomingServer.username ===
              event.submitter.value
          );
          this.#currentSubview.setState(account.addressBooks);
          break;
        }
      // Fall through to handle like forward event.
      case "forward":
        try {
          const stateData = this.#currentSubview.captureState?.();
          await this.#handleForwardAction(this.#currentState, stateData);
        } catch (error) {
          this.#currentSubview.showNotification({
            title: error.title || error.message,
            description: error.text,
            error,
            type: "error",
          });
        }
        break;
      case "config-updated":
        this.#footer.toggleForwardDisabled(!event.detail.completed);
        break;
      default:
        break;
    }
  }

  /**
   * Initialize the UI of one of the address book subviews.
   *
   * @param {string} subview - Subview for which the UI is being inititialized.
   */
  async #initUI(subview) {
    this.#hideSubviews();
    this.#currentState = subview;
    await this.#loadTemplateScript(this.#states[subview].templateId);
    this.#currentSubview.hidden = false;
    this.#setFooterButtons();
  }

  /**
   * Sets the footer buttons in the footer template.
   */
  #setFooterButtons() {
    const stateDetails = this.#states[this.#currentState];

    // TODO: Hide footer buttons row for space if neither forward or back is
    // an option.
    this.#footer.canBack(stateDetails.previousStep);
    this.#footer.canForward(stateDetails.nextStep);

    // The footer forward button is disabled by default.
    this.#footer.toggleForwardDisabled(!stateDetails.forwardEnabled);
  }

  /**
   * Load the template of a subview using the template ID.
   *
   * @param {string} templateId - ID of the template that needs to be loaded.
   */
  async #loadTemplateScript(templateId) {
    if (customElements.get(templateId)) {
      return Promise.resolve();
    }

    // eslint-disable-next-line no-unsanitized/method
    return import(
      `chrome://messenger/content/accountcreation/content/widgets/${templateId}.mjs`
    );
  }

  /**
   * Calls the appropriate method for the current state when the forward
   * button is pressed.
   *
   * @param {string} currentState - The current state of the address book flow.
   * @param {object} stateData - The current state data of the address book
   *  flow.
   */
  async #handleForwardAction(currentState, stateData) {
    switch (currentState) {
      case "localAddressBookSubview": {
        try {
          const dirPrefId = lazy.MailServices.ab.newAddressBook(
            stateData.name,
            "",
            Ci.nsIAbManager.JS_DIRECTORY_TYPE
          );

          const directory = lazy.MailServices.ab.getDirectoryFromId(dirPrefId);

          this.dispatchEvent(
            new CustomEvent("request-close", {
              bubbles: true,
            })
          );
          await window.toAddressBook(["cmd_displayAddressBook", directory.UID]);
          await this.reset();
        } catch (error) {
          throw new Error("Local address book creation failed", {
            cause: error,
          });
        }

        break;
      }
      case "syncAddressBooksSubview":
        // The state data returned from this subview is a list of available
        // address books that have a create function.
        for (const addressBook of stateData) {
          addressBook.create();
        }

        // Close account hub dialog.
        this.dispatchEvent(
          new CustomEvent("request-close", {
            bubbles: true,
          })
        );
        break;
      case "remoteAccountSubview":
        // TODO: Determine whether account needs OAuth, and if it doesn't show
        // remotePassword Subview.
        await this.#initUI(this.#states[this.currentState].nextStep);
        this.#currentSubview.setState();
        break;
      case "remotePasswordSubview":
        // TODO: Add remote address book account address book fetch logic to
        // grab address books.

        // Go to sync address books subview.
        // TODO: replace empty array with fetched address books.
        await this.#initUI("syncAddressBooksSubview");
        this.#currentSubview.setState([]);
        break;
      default:
        break;
    }
  }

  /**
   * Fetch existing accounts with their address books, and apply them to
   * #accounts.
   */
  async #fetchAccounts() {
    this.#accounts =
      await lazy.RemoteAddressBookUtils.getAddressBooksForExistingAccounts();
  }

  /**
   * Hide all of the subviews in the account hub address book flow.
   */
  #hideSubviews() {
    for (const subviewName of Object.keys(this.#states)) {
      this.#states[subviewName].subview.hidden = true;
    }
  }

  /**
   * Hide all subviews and reset all forms, and set the first step as the
   * current subview.
   *
   * @returns {boolean} - If the account hub can remove this view.
   */
  async reset() {
    this.#hideSubviews();
    await this.#initUI("optionSelectSubview");
    this.#setFooterButtons();
    // Reset all subviews that require a reset.
    for (const subviewName of Object.keys(this.#states)) {
      this.#states[subviewName].subview?.resetState?.();
    }

    return true;
  }
}

customElements.define("account-hub-address-book", AccountHubAddressBook);
