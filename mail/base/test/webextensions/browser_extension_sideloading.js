/* eslint-disable mozilla/no-arbitrary-setTimeout */
const { AddonManagerPrivate } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);

var { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);

AddonTestUtils.initMochitest(this);

AddonTestUtils.hookAMTelemetryEvents();

const kSideloaded = true;

async function createWebExtension(details) {
  const options = {
    manifest: {
      applications: { gecko: { id: details.id } },

      name: details.name,

      permissions: details.permissions,
    },
  };

  if (details.iconURL) {
    options.manifest.icons = { 64: details.iconURL };
  }

  const xpi = AddonTestUtils.createTempWebExtensionFile(options);

  await AddonTestUtils.manuallyInstall(xpi);
}

function promiseEvent(eventEmitter, event) {
  return new Promise(resolve => {
    eventEmitter.once(event, resolve);
  });
}

function getAddonElement(managerWindow, addonId) {
  return BrowserTestUtils.waitForCondition(
    () =>
      managerWindow.document.querySelector(`addon-card[addon-id="${addonId}"]`),
    `Found entry for sideload extension addon "${addonId}" in HTML about:addons`
  );
}

function assertSideloadedAddonElementState(addonElement, pressed) {
  const enableBtn = addonElement.querySelector('[action="toggle-disabled"]');
  is(
    enableBtn.pressed,
    pressed,
    `The enable button is ${!pressed ? " not " : ""} pressed`
  );
  is(enableBtn.localName, "moz-toggle", "The enable button is a toggle");
}

function clickEnableExtension(addonElement) {
  addonElement.querySelector('[action="toggle-disabled"]').click();
}

add_task(async function test_sideloading() {
  const DEFAULT_ICON_URL =
    "chrome://mozapps/skin/extensions/extensionGeneric.svg";

  await SpecialPowers.pushPrefEnv({
    set: [
      ["xpinstall.signatures.required", false],
      ["extensions.autoDisableScopes", 15],
      ["extensions.ui.ignoreUnsigned", true],
      ["extensions.allowPrivateBrowsingByDefault", false],
    ],
  });

  const ID1 = "addon1@tests.mozilla.org";
  await createWebExtension({
    id: ID1,
    name: "Test 1",
    userDisabled: true,
    permissions: ["accountsRead", "https://*/*"],
    iconURL: "foo-icon.png",
  });

  const ID2 = "addon2@tests.mozilla.org";
  await createWebExtension({
    id: ID2,
    name: "Test 2",
    permissions: ["<all_urls>"],
  });

  const ID3 = "addon3@tests.mozilla.org";
  await createWebExtension({
    id: ID3,
    name: "Test 3",
    permissions: ["<all_urls>"],
  });

  testCleanup = async function () {
    // clear out ExtensionsUI state about sideloaded extensions so
    // subsequent tests don't get confused.
    ExtensionsUI.sideloaded.clear();
    ExtensionsUI.emit("change");
  };

  const changePromise = new Promise(resolve => {
    ExtensionsUI.on("change", function listener() {
      ExtensionsUI.off("change", listener);
      resolve();
    });
  });
  ExtensionsUI._checkForSideloaded();
  await changePromise;

  // Check for the addons badge on the hamburger menu
  const menuButton = document.getElementById("button-appmenu");
  is(
    menuButton.getAttribute("badge-status"),
    "addon-alert",
    "Should have addon alert badge"
  );

  // Find the menu entries for sideloaded extensions
  await gCUITestUtils.openMainMenu();

  let addons = PanelUI.addonNotificationContainer;
  is(
    addons.children.length,
    3,
    "Have 3 menu entries for sideloaded extensions"
  );

  info(
    "Test disabling sideloaded addon 1 using the permission prompt secondary button"
  );

  // Click the first sideloaded extension
  let popupPromise = promisePopupNotificationShown("addon-webext-permissions");
  addons.children[0].click();

  // The click should hide the main menu. This is currently synchronous.
  Assert.notEqual(
    PanelUI.panel.state,
    "open",
    "Main menu is closed or closing."
  );

  let panel = await popupPromise;

  // Check the contents of the notification, then choose "Cancel"
  await checkNotification(
    panel,
    /\/foo-icon\.png$/,
    [
      ["webext-perms-host-description-all-urls"],
      ["webext-perms-description-accountsRead"],
    ],
    kSideloaded
  );

  panel.secondaryButton.click();

  let [addon1, addon2, addon3] = await AddonManager.getAddonsByIDs([
    ID1,
    ID2,
    ID3,
  ]);
  ok(addon1.seen, "Addon should be marked as seen");
  is(addon1.userDisabled, true, "Addon 1 should still be disabled");
  is(addon2.userDisabled, true, "Addon 2 should still be disabled");
  is(addon3.userDisabled, true, "Addon 3 should still be disabled");

  // Should still have 2 entries in the hamburger menu
  await gCUITestUtils.openMainMenu();

  addons = PanelUI.addonNotificationContainer;
  is(
    addons.children.length,
    2,
    "Have 2 menu entries for sideloaded extensions"
  );

  // Close the hamburger menu and go directly to the addons manager
  await gCUITestUtils.hideMainMenu();

  const VIEW = "addons://list/extension";
  let win = await openAddonsMgr(VIEW);

  await waitAboutAddonsViewLoaded(win.document);

  // about:addons addon entry element.
  const addonElement = await getAddonElement(win, ID2);

  assertSideloadedAddonElementState(addonElement, false);

  info("Test enabling sideloaded addon 2 from about:addons enable button");

  // When clicking enable we should see the permissions notification
  popupPromise = promisePopupNotificationShown("addon-webext-permissions");
  clickEnableExtension(addonElement);
  panel = await popupPromise;
  await checkNotification(
    panel,
    DEFAULT_ICON_URL,
    [["webext-perms-host-description-all-urls"]],
    kSideloaded
  );

  // Setup async test for post install notification on addon 2
  popupPromise = promisePopupNotificationShown("addon-installed");

  // Accept the permissions
  panel.button.click();
  await promiseEvent(ExtensionsUI, "change");

  addon2 = await AddonManager.getAddonByID(ID2);
  is(addon2.userDisabled, false, "Addon 2 should be enabled");
  assertSideloadedAddonElementState(addonElement, true);

  // Test post install notification on addon 2.
  panel = await popupPromise;
  panel.button.click();

  const tabmail = document.getElementById("tabmail");
  tabmail.closeTab(tabmail.currentTabInfo);

  // Should still have 1 entry in the hamburger menu
  await gCUITestUtils.openMainMenu();

  addons = PanelUI.addonNotificationContainer;
  is(addons.children.length, 1, "Have 1 menu entry for sideloaded extensions");

  PanelUI.hide();

  // Open the Add-Ons Manager
  win = await openAddonsMgr(`addons://detail/${encodeURIComponent(ID3)}`);

  info("Test enabling sideloaded addon 3 from app menu");
  // Trigger addon 3 install as triggered from the app menu, to be able to cover the
  // post install notification that should be triggered when the permission
  // dialog is accepted from that flow.
  popupPromise = promisePopupNotificationShown("addon-webext-permissions");
  ExtensionsUI.showSideloaded(tabmail, addon3);

  panel = await popupPromise;
  await checkNotification(
    panel,
    DEFAULT_ICON_URL,
    [["webext-perms-host-description-all-urls"]],
    kSideloaded
  );

  // Setup async test for post install notification on addon 3
  popupPromise = promisePopupNotificationShown("addon-installed");

  // Accept the permissions
  panel.button.click();
  await promiseEvent(ExtensionsUI, "change");

  addon3 = await AddonManager.getAddonByID(ID3);
  is(addon3.userDisabled, false, "Addon 3 should be enabled");

  // Test post install notification on addon 3.
  panel = await popupPromise;
  panel.button.click();

  isnot(
    menuButton.getAttribute("badge-status"),
    "addon-alert",
    "Should no longer have addon alert badge"
  );

  await new Promise(resolve => setTimeout(resolve, 100));

  for (const addon of [addon1, addon2, addon3]) {
    await addon.uninstall();
  }

  tabmail.closeTab(tabmail.currentTabInfo);

  // Assert that the expected AddonManager telemetry are being recorded.
  const expectedExtra = { source: "app-profile", method: "sideload" };

  const baseEvent = { object: "extension", extra: expectedExtra };
  const createBaseEventAddon = n => ({
    ...baseEvent,
    value: `addon${n}@tests.mozilla.org`,
  });
  const getEventsForAddonId = (events, addonId) =>
    events.filter(ev => ev.value === addonId);

  const amEvents = AddonTestUtils.getAMTelemetryEvents();

  // Test telemetry events for addon1 (1 permission and 1 origin).
  info("Test telemetry events collected for addon1");

  const baseEventAddon1 = createBaseEventAddon(1);

  const blocklist_state = `${Ci.nsIBlocklistService.STATE_NOT_BLOCKED}`;

  const collectedEventsAddon1 = getEventsForAddonId(
    amEvents,
    baseEventAddon1.value
  );
  const expectedEventsAddon1 = [
    {
      ...baseEventAddon1,
      method: "sideload_prompt",
      extra: { ...expectedExtra, num_strings: "2", blocklist_state },
    },
    {
      ...baseEventAddon1,
      method: "uninstall",
      extra: { ...expectedExtra, blocklist_state },
    },
  ];

  let i = 0;
  for (const event of collectedEventsAddon1) {
    Assert.deepEqual(
      event,
      expectedEventsAddon1[i++],
      "Got the expected telemetry event"
    );
  }

  is(
    collectedEventsAddon1.length,
    expectedEventsAddon1.length,
    "Got the expected number of telemetry events for addon1"
  );

  const baseEventAddon2 = createBaseEventAddon(2);
  const collectedEventsAddon2 = getEventsForAddonId(
    amEvents,
    baseEventAddon2.value
  );
  const expectedEventsAddon2 = [
    {
      ...baseEventAddon2,
      method: "sideload_prompt",
      extra: { ...expectedExtra, num_strings: "1", blocklist_state },
    },
    {
      ...baseEventAddon2,
      method: "enable",
      extra: { ...expectedExtra, blocklist_state },
    },
    {
      ...baseEventAddon2,
      method: "uninstall",
      extra: { ...expectedExtra, blocklist_state },
    },
  ];

  i = 0;
  for (const event of collectedEventsAddon2) {
    Assert.deepEqual(
      event,
      expectedEventsAddon2[i++],
      "Got the expected telemetry event"
    );
  }

  is(
    collectedEventsAddon2.length,
    expectedEventsAddon2.length,
    "Got the expected number of telemetry events for addon2"
  );
});
