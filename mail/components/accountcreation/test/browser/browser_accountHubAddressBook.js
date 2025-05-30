/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const tabmail = document.getElementById("tabmail");
let browser;
let abView;

add_setup(async function () {
  const tab = tabmail.openTab("contentTab", {
    url: "chrome://mochitests/content/browser/comm/mail/components/accountcreation/test/browser/files/accountHubAddressBook.xhtml",
  });

  await BrowserTestUtils.browserLoaded(tab.browser);
  tab.browser.focus();
  browser = tab.browser;
  abView = tab.browser.contentWindow.document.querySelector(
    "account-hub-address-book"
  );

  registerCleanupFunction(() => {
    tabmail.closeOtherTabs(tabmail.tabInfo[0]);
  });
});

add_task(async function test_initialization() {
  const optionSelectSubview = abView.querySelector(
    "#addressBookOptionSelectSubview"
  );
  // The first subview of the address book view should be visible.
  Assert.ok(
    BrowserTestUtils.isVisible(optionSelectSubview),
    "The option select subview should be visible"
  );

  Assert.ok(
    BrowserTestUtils.isHidden(
      abView.querySelector("#addressBookAccountSelectSubview")
    ),
    "The account select subview should be hidden"
  );

  // Making the address book view visible, the init function should run.
  const spy = sinon.spy(abView, "init");
  abView.hidden = true;

  // Check that init() isn't called when the view is hidden.
  Assert.equal(
    spy.callCount,
    0,
    "Address book view should not have called init() once"
  );

  abView.hidden = false;

  // Check that init has been called when the view is visible.
  Assert.equal(spy.callCount, 1, "Address book view should have called init()");
});

add_task(async function test_reset() {
  // Change the subview and footer buttons manually.
  abView.querySelector("#addressBookOptionSelectSubview").hidden = true;
  abView.querySelector("#addressBookAccountSelectSubview").hidden = false;
  const footer = abView.querySelector("#addressBookFooter");
  footer.canBack(true);
  footer.canForward(true);

  // Create a test state and add a resetState stub to a subview object.
  const testState = {
    subview: { resetState: sinon.stub() },
  };
  testState.subview.resetState.returns(true);

  // Insert the state into the address book state.
  abView.insertTestState("resetState", testState);

  // Call reset on the address book view, making the address book option select
  // subview visible, and reseting the footer buttons (this subview has both
  // hidden).
  await abView.reset();
  Assert.ok(
    BrowserTestUtils.isVisible(
      abView.querySelector("#addressBookOptionSelectSubview")
    ),
    "The option select subview should be visible"
  );
  Assert.ok(
    BrowserTestUtils.isHidden(
      abView.querySelector("#addressBookAccountSelectSubview")
    ),
    "The account select subview should be hidden"
  );

  Assert.ok(
    BrowserTestUtils.isHidden(footer.querySelector("#forward")),
    "The footer forward button should be hidden"
  );
  Assert.ok(
    BrowserTestUtils.isHidden(footer.querySelector("#back")),
    "The footer back button should be hidden"
  );

  // Check if resetState has been called on the test state subview object.
  Assert.equal(
    testState.subview.resetState.callCount,
    1,
    "Test state subview should have called resetState"
  );
});
