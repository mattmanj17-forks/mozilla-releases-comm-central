/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests sending mail with OAuth2 authentication, including the dialog
 * windows that uses.
 */

const { OAuth2Module } = ChromeUtils.importESModule(
  "resource:///modules/OAuth2Module.sys.mjs"
);
const { OAuth2TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/OAuth2TestUtils.sys.mjs"
);

let oAuth2Server;
let smtpServer, smtpOutgoingServer, smtpIdentity;
let ewsServer, ewsOutgoingServer, ewsIdentity;

add_setup(async function () {
  [smtpServer, ewsServer] = await ServerTestUtils.createServers([
    ServerTestUtils.serverDefs.smtp.oAuth,
    ServerTestUtils.serverDefs.ews.oAuth,
  ]);

  let smtpAccount;
  ({ smtpAccount, smtpIdentity, smtpOutgoingServer } = createSMTPAccount());
  smtpOutgoingServer.authMethod = Ci.nsMsgAuthMethod.OAuth2;
  await addLoginInfo("smtp://test.test", "user", "password");

  let ewsAccount;
  ({ ewsAccount, ewsIdentity, ewsOutgoingServer } = createEWSAccount());
  ewsOutgoingServer.authMethod = Ci.nsMsgAuthMethod.OAuth2;
  await addLoginInfo("ews://test.test", "user", "password");

  oAuth2Server = await OAuth2TestUtils.startServer();

  registerCleanupFunction(async function () {
    MailServices.accounts.removeAccount(smtpAccount, false);
    MailServices.accounts.removeAccount(ewsAccount, false);
  });
});

/**
 * Tests sending a message when there is no access token and no refresh token.
 */
async function subtestNoTokens(identity, outgoingServer, server) {
  const { composeWindow, subject } = await newComposeWindow(identity);

  const oAuthPromise = handleOAuthDialog();
  EventUtils.synthesizeMouseAtCenter(
    composeWindow.document.getElementById("button-send"),
    {},
    composeWindow
  );
  await oAuthPromise;

  await BrowserTestUtils.domWindowClosed(composeWindow);

  checkSavedPassword();
  Services.logins.removeAllLogins();
  OAuth2TestUtils.forgetObjects();

  Assert.stringContains(
    server.lastSentMessage,
    `Subject: ${subject}`,
    "server should have received message"
  );
}

add_task(async function testNoTokensSMTP() {
  await subtestNoTokens(smtpIdentity, smtpOutgoingServer, smtpServer);
  smtpOutgoingServer.closeCachedConnections();
});

add_task(async function testNoTokensEWS() {
  await subtestNoTokens(ewsIdentity, ewsOutgoingServer, ewsServer);
});

/**
 * Tests that with a saved refresh token, but no access token, a new access token is requested.
 */
async function subtestNoAccessToken(identity, outgoingServer, server) {
  const loginInfo = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
    Ci.nsILoginInfo
  );
  loginInfo.init(
    "oauth://test.test",
    null,
    "test_mail test_addressbook test_calendar",
    "user",
    "refresh_token",
    "",
    ""
  );
  await Services.logins.addLoginAsync(loginInfo);

  const { composeWindow, subject } = await newComposeWindow(identity);

  EventUtils.synthesizeMouseAtCenter(
    composeWindow.document.getElementById("button-send"),
    {},
    composeWindow
  );

  await BrowserTestUtils.domWindowClosed(composeWindow);

  checkSavedPassword();
  Services.logins.removeAllLogins();
  OAuth2TestUtils.forgetObjects();

  Assert.stringContains(
    server.lastSentMessage,
    `Subject: ${subject}`,
    "server should have received message"
  );
}

add_task(async function testNoAccessTokenSMTP() {
  await subtestNoAccessToken(smtpIdentity, smtpOutgoingServer, smtpServer);
  smtpOutgoingServer.closeCachedConnections();
});

add_task(async function testNoAccessTokenEWS() {
  await subtestNoAccessToken(ewsIdentity, ewsOutgoingServer, ewsServer);
});

/**
 * Tests that with an expired access token, a new access token is requested.
 */
async function subtestExpiredAccessToken(identity, outgoingServer, server) {
  const loginInfo = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
    Ci.nsILoginInfo
  );
  loginInfo.init(
    "oauth://test.test",
    null,
    "test_mail test_addressbook test_calendar",
    "user",
    "refresh_token",
    "",
    ""
  );
  await Services.logins.addLoginAsync(loginInfo);

  info("poisoning the cache with an expired access token");
  oAuth2Server.accessToken = "expired_access_token";
  oAuth2Server.expiry = -3600;

  const expiredModule = new OAuth2Module();
  expiredModule.initFromOutgoing(outgoingServer);
  await expiredModule._oauth.connect(false, false);

  oAuth2Server.accessToken = "access_token";
  oAuth2Server.expiry = null;

  const { composeWindow, subject } = await newComposeWindow(identity);

  EventUtils.synthesizeMouseAtCenter(
    composeWindow.document.getElementById("button-send"),
    {},
    composeWindow
  );

  await BrowserTestUtils.domWindowClosed(composeWindow);

  checkSavedPassword();
  Services.logins.removeAllLogins();
  OAuth2TestUtils.forgetObjects();

  Assert.stringContains(
    server.lastSentMessage,
    `Subject: ${subject}`,
    "server should have received message"
  );
}

add_task(async function testExpiredAccessTokenSMTP() {
  await subtestExpiredAccessToken(smtpIdentity, smtpOutgoingServer, smtpServer);
  smtpOutgoingServer.closeCachedConnections();
});

add_task(async function testExpiredAccessTokenEWS() {
  await subtestExpiredAccessToken(ewsIdentity, ewsOutgoingServer, ewsServer);
});

/**
 * Tests that with a bad access token. This simulates an authentication server
 * giving a token that the mail server is not expecting. Very little can be
 * done here, so we notify the user and give up.
 */
async function subtestBadAccessToken(identity, outgoingServer) {
  const loginInfo = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
    Ci.nsILoginInfo
  );
  loginInfo.init(
    "oauth://test.test",
    null,
    "test_mail test_addressbook test_calendar",
    "user",
    "refresh_token",
    "",
    ""
  );
  await Services.logins.addLoginAsync(loginInfo);
  oAuth2Server.accessToken = "bad_access_token";

  info("poisoning the cache with a bad access token");

  const expiredModule = new OAuth2Module();
  expiredModule.initFromOutgoing(outgoingServer);
  await expiredModule._oauth.connect(false, false);

  OAuth2TestUtils.revokeToken("bad_access_token");

  const { composeWindow } = await newComposeWindow(identity);

  const promptPromise = BrowserTestUtils.promiseAlertDialogOpen("cancel");
  EventUtils.synthesizeMouseAtCenter(
    composeWindow.document.getElementById("button-send"),
    {},
    composeWindow
  );
  // FIXME: The user is informed that sending failed, and asked if they want
  // to retry, cancel, or enter a new password. Both retrying and entering a
  // new password immediately send the same access token to the server, which
  // isn't going to work.
  await promptPromise;
  // FIXME: At this point, an alert appears and tells the user that sending
  // failed, which is true but redundant. I think the alert is meant to
  // happen before the exception dialog but this got broken somewhere.
  await BrowserTestUtils.promiseAlertDialog("accept");

  // Try to solve strange focus issues.
  composeWindow.document.getElementById("toAddrInput").focus();
  await SimpleTest.promiseFocus(composeWindow);

  await BrowserTestUtils.closeWindow(composeWindow);

  Services.logins.removeAllLogins();
  OAuth2TestUtils.forgetObjects();
  oAuth2Server.accessToken = "access_token";
}

add_task(async function testBadAccessTokenSMTP() {
  await subtestBadAccessToken(smtpIdentity, smtpOutgoingServer, smtpServer);
  smtpOutgoingServer.closeCachedConnections();
});

add_task(async function testBadAccessTokenEWS() {
  await subtestBadAccessToken(ewsIdentity, ewsOutgoingServer);
}).skip(); // Uses a system notification instead of a prompt.

/**
 * Tests that with a bad saved refresh token, new tokens are requested.
 */
async function subtestBadRefreshToken(identity, outgoingServer, server) {
  const loginInfo = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
    Ci.nsILoginInfo
  );
  loginInfo.init(
    "oauth://test.test",
    null,
    "test_mail test_addressbook test_calendar",
    "user",
    "old_refresh_token",
    "",
    ""
  );
  await Services.logins.addLoginAsync(loginInfo);

  const { composeWindow, subject } = await newComposeWindow(identity);

  const oAuthPromise = handleOAuthDialog();
  EventUtils.synthesizeMouseAtCenter(
    composeWindow.document.getElementById("button-send"),
    {},
    composeWindow
  );
  await oAuthPromise;

  await BrowserTestUtils.domWindowClosed(composeWindow);

  checkSavedPassword();
  Services.logins.removeAllLogins();
  OAuth2TestUtils.forgetObjects();

  Assert.stringContains(
    server.lastSentMessage,
    `Subject: ${subject}`,
    "server should have received message"
  );
}

add_task(async function testBadRefreshTokenSMTP() {
  await subtestBadRefreshToken(smtpIdentity, smtpOutgoingServer, smtpServer);
  smtpOutgoingServer.closeCachedConnections();
});

add_task(async function testBadRefreshTokenEWS() {
  await subtestBadRefreshToken(ewsIdentity, ewsOutgoingServer, ewsServer);
});

async function handleOAuthDialog() {
  const oAuthWindow = await OAuth2TestUtils.promiseOAuthWindow();
  info("oauth2 window shown");
  await SpecialPowers.spawn(
    oAuthWindow.getBrowser(),
    [{ expectedHint: "user", username: "user", password: "password" }],
    OAuth2TestUtils.submitOAuthLogin
  );
}

function checkSavedPassword() {
  const logins = Services.logins.findLogins("oauth://test.test", "", "");
  Assert.equal(
    logins.length,
    1,
    "there should be a saved password for this server"
  );
  Assert.equal(logins[0].origin, "oauth://test.test", "login origin");
  Assert.equal(logins[0].formActionOrigin, null, "login formActionOrigin");
  Assert.equal(
    logins[0].httpRealm,
    "test_mail test_addressbook test_calendar",
    "login httpRealm"
  );
  Assert.equal(logins[0].username, "user", "login username");
  Assert.equal(logins[0].password, "refresh_token", "login password");
  Assert.equal(logins[0].usernameField, "", "login usernameField");
  Assert.equal(logins[0].passwordField, "", "login passwordField");
}
