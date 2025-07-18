/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AccountConfig: "resource:///modules/accountcreation/AccountConfig.sys.mjs",
  AccountCreationUtils:
    "resource:///modules/accountcreation/AccountCreationUtils.sys.mjs",
});

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

/**
 * Takes an |AccountConfig| JS object and creates that account in the
 * Thunderbird backend (which also writes it to prefs).
 *
 * @param {AccountConfig} config - The account to create.
 * @returns {nsIMsgAccount} - The newly created account.
 */
async function createAccountInBackend(config) {
  // incoming server
  const inServer = MailServices.accounts.createIncomingServer(
    config.incoming.username,
    config.incoming.hostname,
    config.incoming.type
  );
  inServer.port = config.incoming.port;
  inServer.authMethod = config.incoming.auth;
  inServer.password = config.incoming.password;
  // This new CLIENTID is for the outgoing server, and will be applied to the
  // incoming only if the incoming username and hostname match the outgoing.
  // We must generate this unconditionally because we cannot determine whether
  // the outgoing server has clientid enabled yet or not, and we need to do it
  // here in order to populate the incoming server if the outgoing matches.
  const newOutgoingClientid = Services.uuid
    .generateUUID()
    .toString()
    .replace(/[{}]/g, "");
  // Grab the base domain of both incoming and outgoing hostname in order to
  // compare the two to detect if the base domain is the same.
  let incomingBaseDomain;
  let outgoingBaseDomain;
  try {
    incomingBaseDomain = Services.eTLD.getBaseDomainFromHost(
      config.incoming.hostname
    );
  } catch (e) {
    incomingBaseDomain = config.incoming.hostname;
  }
  try {
    outgoingBaseDomain = Services.eTLD.getBaseDomainFromHost(
      config.outgoing.hostname
    );
  } catch (e) {
    outgoingBaseDomain = config.outgoing.hostname;
  }
  if (
    config.incoming.username == config.outgoing.username &&
    incomingBaseDomain == outgoingBaseDomain
  ) {
    inServer.clientid = newOutgoingClientid;
  } else {
    // If the username/hostname are different then generate a new CLIENTID.
    inServer.clientid = Services.uuid
      .generateUUID()
      .toString()
      .replace(/[{}]/g, "");
  }

  if (config.rememberPassword && config.incoming.password) {
    await rememberPassword(inServer, config.incoming.password);
  }

  // SSL
  inServer.socketType = config.incoming.socketType;

  // If we already have an account with an identical name, generate a unique
  // name for the new account to avoid duplicates.
  inServer.prettyName = checkAccountNameAlreadyExists(
    config.identity.emailAddress
  )
    ? generateUniqueAccountName(config)
    : config.identity.emailAddress;

  inServer.doBiff = true;
  inServer.biffMinutes = config.incoming.checkInterval;
  inServer.setBoolValue("login_at_startup", config.incoming.loginAtStartup);
  if (config.incoming.type == "pop3") {
    inServer.setBoolValue(
      "leave_on_server",
      config.incoming.leaveMessagesOnServer
    );
    inServer.setIntValue(
      "num_days_to_leave_on_server",
      config.incoming.daysToLeaveMessagesOnServer
    );
    inServer.setBoolValue(
      "delete_mail_left_on_server",
      config.incoming.deleteOnServerWhenLocalDelete
    );
    inServer.setBoolValue(
      "delete_by_age_from_server",
      config.incoming.deleteByAgeFromServer
    );
    inServer.setBoolValue("download_on_biff", config.incoming.downloadOnBiff);
  }
  if (config.incoming.owaURL) {
    inServer.setStringValue("owa_url", config.incoming.owaURL);
  }
  if (config.incoming.ewsURL) {
    inServer.setStringValue("ews_url", config.incoming.ewsURL);
  }
  if (config.incoming.easURL) {
    inServer.setStringValue("eas_url", config.incoming.easURL);
  }
  inServer.valid = true;

  if (config.incoming.handlesOutgoing) {
    // If this type does not differentiate between incoming and outgoing
    // configuration, then use the incoming settings to configure the outgoing
    // server.
    config.outgoing = config.incoming;
    // This property does not exist on incoming configs.
    config.outgoing.addThisServer = true;
  }

  const username =
    config.outgoing.auth != Ci.nsMsgAuthMethod.none
      ? config.outgoing.username
      : null;
  let outServer = MailServices.outgoingServer.findServer(
    username,
    config.outgoing.hostname,
    config.outgoing.type
  );
  lazy.AccountCreationUtils.assert(
    config.outgoing.addThisServer ||
      config.outgoing.useGlobalPreferredServer ||
      config.outgoing.existingServerKey,
    "No outgoing server: inconsistent flags"
  );

  if (
    config.outgoing.addThisServer &&
    !outServer &&
    !(
      config.outgoing.useGlobalPreferredServer &&
      MailServices.outgoingServer.defaultServer
    )
  ) {
    // Create the server and define some protocol-specific settings.
    outServer = MailServices.outgoingServer.createServer(config.outgoing.type);
    if (config.outgoing.type == "smtp") {
      const smtpServer = outServer.QueryInterface(Ci.nsISmtpServer);
      smtpServer.hostname = config.outgoing.hostname;
      smtpServer.port = config.outgoing.port;

      // Note: The client ID will only be set on the server if either its own
      // `clientidEnabled` pref, or the default SMTP pref with the same name, is
      // set to true.
      smtpServer.clientid = newOutgoingClientid;

      // Setting the socket type only makes sense with SMTP, since for other
      // types (e.g. EWS) it is derived from the URL used to configure the
      // server.
      outServer.socketType = config.outgoing.socketType;
    } else if (config.outgoing.type == "ews") {
      const ewsServer = outServer.QueryInterface(Ci.nsIEwsServer);
      ewsServer.initialize(config.outgoing.ewsURL);
    } else {
      // Note: createServer should already have thrown if given a type we don't
      // support, so if we're able to reach this then something has gone very
      // wrong.
      throw new Error(
        `unexpected outgoing server type ${config.outgoing.type}`
      );
    }

    outServer.authMethod = config.outgoing.auth;
    if (config.outgoing.auth != Ci.nsMsgAuthMethod.none) {
      outServer.username = username;
      outServer.password = config.outgoing.password;
      if (config.rememberPassword && config.outgoing.password) {
        await rememberPassword(outServer, config.outgoing.password);
      }
    }

    outServer.description = config.displayName;

    // If this is the first SMTP server, set it as default
    if (
      !MailServices.outgoingServer.defaultServer ||
      !MailServices.outgoingServer.defaultServer.serverURI.host
    ) {
      MailServices.outgoingServer.defaultServer = outServer;
    }
  }

  // identity
  // TODO accounts without identity?
  const identity = MailServices.accounts.createIdentity();
  identity.fullName = config.identity.realname;
  identity.email = config.identity.emailAddress;

  // for new accounts, default to replies being positioned above the quote
  // if a default account is defined already, take its settings instead
  if (config.incoming.type == "imap" || config.incoming.type == "pop3") {
    identity.replyOnTop = 1;
    // identity.sigBottom = false; // don't set this until Bug 218346 is fixed

    if (
      MailServices.accounts.accounts.length &&
      MailServices.accounts.defaultAccount
    ) {
      const defAccount = MailServices.accounts.defaultAccount;
      const defIdentity = defAccount.defaultIdentity;
      if (
        defAccount.incomingServer.canBeDefaultServer &&
        defIdentity &&
        defIdentity.valid
      ) {
        identity.replyOnTop = defIdentity.replyOnTop;
        identity.sigBottom = defIdentity.sigBottom;
      }
    }
  }

  // due to accepted conventions, news accounts should default to plain text
  if (config.incoming.type == "nntp") {
    identity.composeHtml = false;
  }

  identity.valid = true;

  if (
    !config.outgoing.useGlobalPreferredServer &&
    !config.incoming.useGlobalPreferredServer
  ) {
    if (config.outgoing.existingServerKey) {
      identity.smtpServerKey = config.outgoing.existingServerKey;
    } else {
      identity.smtpServerKey = outServer.key;
    }
  }

  // account and hook up
  // Note: Setting incomingServer will cause the AccountManager to refresh
  // itself, which could be a problem if we came from it and we haven't set
  // the identity (see bug 521955), so make sure everything else on the
  // account is set up before you set the incomingServer.
  const account = MailServices.accounts.createAccount();
  account.addIdentity(identity);
  account.incomingServer = inServer;
  if (
    inServer.canBeDefaultServer &&
    (!MailServices.accounts.defaultAccount ||
      !MailServices.accounts.defaultAccount.incomingServer.canBeDefaultServer)
  ) {
    MailServices.accounts.defaultAccount = account;
  }

  verifyLocalFoldersAccount();

  // save
  MailServices.accounts.saveAccountInfo();
  try {
    Services.prefs.savePrefFile(null);
  } catch (ex) {
    lazy.AccountCreationUtils.ddump("Could not write out prefs: " + ex);
  }
  return account;
}

async function rememberPassword(server, password) {
  let passwordURI;
  if (server instanceof Ci.nsIMsgIncomingServer) {
    passwordURI = server.localStoreType + "://" + server.hostName;
  } else if (server instanceof Ci.nsIMsgOutgoingServer) {
    passwordURI = server.type + "://" + server.serverURI.host;
  } else {
    throw new lazy.AccountCreationUtils.NotReached("Server type not supported");
  }

  const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
    Ci.nsILoginInfo
  );
  login.init(passwordURI, null, passwordURI, server.username, password, "", "");
  try {
    await Services.logins.addLoginAsync(login);
  } catch (e) {
    if (e.message.includes("This login already exists")) {
      // TODO modify
    } else {
      throw e;
    }
  }
}

/**
 * Check whether the user's setup already has an incoming server
 * which matches (hostname, port, username) the primary one
 * in the config.
 * (We also check the email address as username.)
 *
 * @param {AccountConfig} config - AccountConfig filled in (no placeholders)
 * @returns {?nsIMsgIncomingServer} If it already exists, the server object is
 *   returned. If it's a new server, |null| is returned.
 */
function checkIncomingServerAlreadyExists(config) {
  lazy.AccountCreationUtils.assert(config instanceof lazy.AccountConfig);
  const incoming = config.incoming;
  let existing = MailServices.accounts.findServer(
    incoming.username,
    incoming.hostname,
    incoming.type,
    incoming.port
  );

  // if username does not have an '@', also check the e-mail
  // address form of the name.
  if (!existing && !incoming.username.includes("@")) {
    existing = MailServices.accounts.findServer(
      config.identity.emailAddress,
      incoming.hostname,
      incoming.type,
      incoming.port
    );
  }
  return existing;
}

/**
 * Check whether the user's setup already has an outgoing server
 * which matches (hostname, port, username) the primary one
 * in the config.
 *
 * @param {AccountConfig} config - AccountConfig filled in (no placeholders).
 * @returns {?nsIMsgOutgoingServer} If it already exists, the server object is
 *   returned. If it's a new server, |null| is returned.
 */
function checkOutgoingServerAlreadyExists(config) {
  lazy.AccountCreationUtils.assert(config instanceof lazy.AccountConfig);
  for (const existingServer of MailServices.outgoingServer.servers) {
    // TODO check username with full email address, too, like for incoming
    if (
      existingServer.type == config.outgoing.type &&
      existingServer.serverURI.host == config.outgoing.hostname &&
      existingServer.serverURI.port == config.outgoing.port &&
      existingServer.username == config.outgoing.username
    ) {
      return existingServer;
    }
  }
  return null;
}

/**
 * Check whether the user's setup already has an account with the same email
 * address. This might happen if the user uses the same email for different
 * protocols (eg. IMAP and POP3).
 *
 * @param {string} name - The name or email address of the new account.
 * @returns {boolean} true if an account with the same name is found.
 */
function checkAccountNameAlreadyExists(name) {
  return MailServices.accounts.accounts.some(
    a => a.incomingServer.prettyName == name
  );
}

/**
 * Generate a unique account name by appending the incoming protocol type, and
 * a counter if necessary.
 *
 * @param {AccountConfig} config - The config data of the account being created.
 * @returns {string} - The unique account name.
 */
function generateUniqueAccountName(config) {
  // Generate a potential unique name. e.g. "foo@bar.com (POP3)".
  let name = `${
    config.identity.emailAddress
  } (${config.incoming.type.toUpperCase()})`;

  // If this name already exists, append a counter until we find a unique name.
  if (checkAccountNameAlreadyExists(name)) {
    let counter = 2;
    while (checkAccountNameAlreadyExists(`${name}_${counter}`)) {
      counter++;
    }
    // e.g. "foo@bar.com (POP3)_1".
    name = `${name}_${counter}`;
  }

  return name;
}

/**
 * Check if there already is a "Local Folders". If not, create it.
 * Copied from AccountWizard.js with minor updates.
 */
function verifyLocalFoldersAccount() {
  let localMailServer;
  try {
    localMailServer = MailServices.accounts.localFoldersServer;
  } catch (ex) {
    localMailServer = null;
  }

  try {
    if (!localMailServer) {
      // creates a copy of the identity you pass in
      MailServices.accounts.createLocalMailAccount();
      try {
        localMailServer = MailServices.accounts.localFoldersServer;
      } catch (ex) {
        lazy.AccountCreationUtils.ddump(
          "Error! we should have found the local mail server " +
            "after we created it."
        );
      }
    }
  } catch (ex) {
    lazy.AccountCreationUtils.ddump("Error in verifyLocalFoldersAccount " + ex);
  }
}

export const CreateInBackend = {
  checkIncomingServerAlreadyExists,
  checkOutgoingServerAlreadyExists,
  createAccountInBackend,
};
