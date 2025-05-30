/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

registerCleanupFunction(() => {
  Services.logins.removeAllLogins();
});

/**
 * Test password is migrated when changing hostname/username.
 */
add_task(async function testMigratePasswordOnChangeUsernameHostname() {
  // Add two logins.
  const loginItems = [
    ["news://news.localhost", "user-nntp", "password-nntp"],
    ["mailbox://pop3.localhost", "user-pop", "password-pop"],
  ];
  for (const [uri, username, password] of loginItems) {
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
      Ci.nsILoginInfo
    );
    login.init(uri, null, uri, username, password, "", "");
    await Services.logins.addLoginAsync(login);
  }

  // Create a nntp server, check the password can be found correctly.
  const nntpIncomingServer = MailServices.accounts.createIncomingServer(
    "user-nntp",
    "news.localhost",
    "nntp"
  );
  nntpIncomingServer.getPasswordWithUI("", "");
  equal(nntpIncomingServer.password, "password-nntp");

  // Change the username, check password can be found using the new username.
  nntpIncomingServer.username = "nntp";
  let password;
  let serverUri = "news://news.localhost";
  for (const login of Services.logins.findLogins(serverUri, "", serverUri)) {
    if (login.username == "nntp") {
      password = login.password;
    }
  }
  equal(password, "password-nntp");

  // Create a pop3 server, check the password can be found correctly.
  const pop3IncomingServer = MailServices.accounts.createIncomingServer(
    "user-pop",
    "pop3.localhost",
    "pop3"
  );
  pop3IncomingServer.getPasswordWithUI("", "");
  equal(pop3IncomingServer.password, "password-pop");

  // Change the hostname, check password can be found using the new hostname.
  pop3IncomingServer.hostName = "localhost";
  serverUri = "mailbox://localhost";
  for (const login of Services.logins.findLogins(serverUri, "", serverUri)) {
    if (login.username == "user-pop") {
      password = login.password;
    }
  }
  equal(password, "password-pop");
});

/**
 * Test identity folders are migrated when changing hostname/username.
 */
add_task(function testMigrateIdentitiesOnChangeUsernameHostname() {
  // Create a pop server.
  const incomingServer1 = MailServices.accounts.createIncomingServer(
    "mike",
    "pop3.invalid",
    "pop3"
  );
  // Create another pop server.
  const incomingServer2 = MailServices.accounts.createIncomingServer(
    "oscar",
    "pop3.localhost",
    "pop3"
  );

  // Create an identity and point folders to incomingServer1.
  let identity1 = MailServices.accounts.createIdentity();
  identity1.fccFolderURI = incomingServer1.serverURI + "/Sent";
  identity1.draftsFolderURI = incomingServer1.serverURI + "/Drafts";
  identity1.archivesFolderURI = incomingServer1.serverURI + "/Archives";
  identity1.templatesFolderURI = incomingServer1.serverURI + "/Templates";
  const account1 = MailServices.accounts.createAccount();
  account1.addIdentity(identity1);

  // Create another identity and point folders to both servers.
  const identity2 = MailServices.accounts.createIdentity();
  identity2.fccFolderURI = incomingServer1.serverURI + "/Sent";
  identity2.draftsFolderURI = incomingServer2.serverURI + "/Drafts";
  const account2 = MailServices.accounts.createAccount();
  account2.addIdentity(identity2);

  // Check folders were correctly set.
  equal(identity1.fccFolderURI, "mailbox://mike@pop3.invalid/Sent");
  equal(identity1.draftsFolderURI, "mailbox://mike@pop3.invalid/Drafts");
  equal(identity1.archivesFolderURI, "mailbox://mike@pop3.invalid/Archives");
  equal(identity1.templatesFolderURI, "mailbox://mike@pop3.invalid/Templates");
  equal(identity2.fccFolderURI, "mailbox://mike@pop3.invalid/Sent");
  equal(identity2.draftsFolderURI, "mailbox://oscar@pop3.localhost/Drafts");

  // Change the hostname.
  incomingServer1.hostName = "localhost";

  // Check folders were correctly updated.
  identity1 = MailServices.accounts.getIdentity(identity1.key);
  equal(identity1.fccFolderURI, "mailbox://mike@localhost/Sent");
  equal(identity1.draftsFolderURI, "mailbox://mike@localhost/Drafts");
  equal(identity1.archivesFolderURI, "mailbox://mike@localhost/Archives");
  equal(identity1.templatesFolderURI, "mailbox://mike@localhost/Templates");
  equal(identity2.fccFolderURI, "mailbox://mike@localhost/Sent");
  equal(identity2.draftsFolderURI, "mailbox://oscar@pop3.localhost/Drafts");
});

/**
 * Test spam action prefs are migrated when changing hostname/username.
 */
add_task(function testMigrateSpamActionsOnChangeUsernameHostname() {
  // Create an pop3 server.
  const incomingServer1 = MailServices.accounts.createIncomingServer(
    "mike",
    "pop3.localhost",
    "pop3"
  );
  incomingServer1.setStringValue(
    "spamActionTargetFolder",
    incomingServer1.serverURI + "/Спам"
  );

  equal(
    incomingServer1.spamSettings.actionTargetAccount,
    "mailbox://mike@pop3.localhost"
  );
  equal(
    incomingServer1.spamSettings.actionTargetFolder,
    "mailbox://mike@pop3.localhost/Спам"
  );

  // Change the username.
  incomingServer1.username = "user";

  equal(
    incomingServer1.spamSettings.actionTargetAccount,
    "mailbox://user@pop3.localhost"
  );
  equal(
    incomingServer1.spamSettings.actionTargetFolder,
    "mailbox://user@pop3.localhost/Спам"
  );
});

/**
 * Test filters are migrated when changing hostname/username.
 */
add_task(function testMigrateFiltersOnChangeUsernameHostname() {
  // Create a nntp server.
  const nntpIncomingServer = MailServices.accounts.createIncomingServer(
    "user-nntp",
    "news.localhost",
    "nntp"
  );
  let filterList = nntpIncomingServer.getFilterList(null);

  // Insert a CopyToFolder filter.
  let filter = filterList.createFilter("filter1");
  let action = filter.createAction();
  action.type = Ci.nsMsgFilterAction.CopyToFolder;
  action.targetFolderUri = "news://user-nntp@news.localhost/dest1";
  filter.appendAction(action);
  filterList.insertFilterAt(filterList.filterCount, filter);

  // Insert a MarkRead filter.
  filter = filterList.createFilter("filter2");
  action = filter.createAction();
  action.type = Ci.nsMsgFilterAction.MarkRead;
  filter.appendAction(action);
  filterList.insertFilterAt(filterList.filterCount, filter);

  // Insert a MoveToFolder filter.
  filter = filterList.createFilter("filter3");
  action = filter.createAction();
  action.type = Ci.nsMsgFilterAction.MoveToFolder;
  action.targetFolderUri = "news://user-nntp@news.localhost/dest2";
  filter.appendAction(action);
  filterList.insertFilterAt(filterList.filterCount, filter);

  // Change the hostname, test targetFolderUri of filters are changed accordingly.
  nntpIncomingServer.hostName = "localhost";
  filterList = nntpIncomingServer.getFilterList(null);
  filter = filterList.getFilterAt(0);
  equal(
    filter.sortedActionList[0].targetFolderUri,
    "news://user-nntp@localhost/dest1"
  );
  filter = filterList.getFilterAt(2);
  equal(
    filter.sortedActionList[0].targetFolderUri,
    "news://user-nntp@localhost/dest2"
  );

  // Change the username, test targetFolderUri of filters are changed accordingly.
  nntpIncomingServer.username = "nntp";
  filterList = nntpIncomingServer.getFilterList(null);
  filter = filterList.getFilterAt(0);
  equal(
    filter.sortedActionList[0].targetFolderUri,
    "news://nntp@localhost/dest1"
  );
  filter = filterList.getFilterAt(2);
  equal(
    filter.sortedActionList[0].targetFolderUri,
    "news://nntp@localhost/dest2"
  );
});
