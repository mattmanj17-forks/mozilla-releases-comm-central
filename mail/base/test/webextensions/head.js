/* globals openAddonsMgr, openContentTab */

ChromeUtils.defineESModuleGetters(this, {
  AddonTestUtils: "resource://testing-common/AddonTestUtils.sys.mjs",
  Management: "resource://gre/modules/Extension.sys.mjs",
});

const BASE = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content/",
  "https://example.com/"
);

const l10n = new Localization([
  "toolkit/global/extensions.ftl",
  "toolkit/global/extensionPermissions.ftl",
  "messenger/extensionsUI.ftl",
  "messenger/extensionPermissions.ftl",
  "messenger/addonNotifications.ftl",
  "branding/brand.ftl",
]);

var { CustomizableUITestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/CustomizableUITestUtils.sys.mjs"
);
const gCUITestUtils = new CustomizableUITestUtils(window);

const { PermissionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PermissionTestUtils.sys.mjs"
);

/**
 * Wait for the given PopupNotification to display
 *
 * @param {string} name
 *        The name of the notification to wait for.
 *
 * @returns {Promise}
 *          Resolves with the notification window.
 */
function promisePopupNotificationShown(name) {
  return new Promise(resolve => {
    function popupshown() {
      const notification = PopupNotifications.getNotification(name);
      if (!notification) {
        return;
      }

      ok(notification, `${name} notification shown`);
      ok(PopupNotifications.isPanelOpen, "notification panel open");

      PopupNotifications.panel.removeEventListener("popupshown", popupshown);
      resolve(PopupNotifications.panel.firstElementChild);
    }

    PopupNotifications.panel.addEventListener("popupshown", popupshown);
  });
}

/**
 * Wait for a specific install event to fire for a given addon
 *
 * @param {AddonWrapper} addon - The addon to watch for an event on.
 * @param {string} event - The name of the event to watch for (e.g., onInstallEnded).
 * @returns {Promise} Resolves when the event triggers with the first argument
 *   to the event handler as the resolution value.
 */
function promiseInstallEvent(addon, event) {
  return new Promise(resolve => {
    const listener = {};
    listener[event] = (install, arg) => {
      if (install.addon.id == addon.id) {
        AddonManager.removeInstallListener(listener);
        resolve(arg);
      }
    };
    AddonManager.addInstallListener(listener);
  });
}

/**
 * Install an (xpi packaged) extension
 *
 * @param {string} url - URL of the .xpi file to install.
 * @param {?object} telemetryInfo - An optional object that contains
 *   additional details used by the telemetry events.
 * @returns {Promise<AddonWrapper>} Resolves when the extension has been
 *   installed with the Addon object as the resolution value.
 */
async function promiseInstallAddon(url, telemetryInfo) {
  const install = await AddonManager.getInstallForURL(url, { telemetryInfo });
  install.install();

  const addon = await new Promise(resolve => {
    install.addListener({
      onInstallEnded(_install, _addon) {
        resolve(_addon);
      },
    });
  });

  if (addon.isWebExtension) {
    await new Promise(resolve => {
      function listener(event, extension) {
        if (extension.id == addon.id) {
          Management.off("ready", listener);
          resolve();
        }
      }
      Management.on("ready", listener);
    });
  }

  return addon;
}

/**
 * Wait for an update to the given webextension to complete.
 * (This does not actually perform an update, it just watches for
 * the events that occur as a result of an update.)
 *
 * @param {AddonWrapper} addon - The addon to be updated.
 * @returns {Promise<AddonWrapper>} Resolves when the extension has ben updated.
 */
async function waitForUpdate(addon) {
  const installPromise = promiseInstallEvent(addon, "onInstallEnded");
  const readyPromise = new Promise(resolve => {
    function listener(event, extension) {
      if (extension.id == addon.id) {
        Management.off("ready", listener);
        resolve();
      }
    }
    Management.on("ready", listener);
  });

  const [newAddon] = await Promise.all([installPromise, readyPromise]);
  return newAddon;
}

function waitAboutAddonsViewLoaded(doc) {
  return BrowserTestUtils.waitForEvent(doc, "view-loaded");
}

/**
 * Trigger an action from the page options menu.
 */
function triggerPageOptionsAction(win, action) {
  win.document.querySelector(`#page-options [action="${action}"]`).click();
}

function isDefaultIcon(icon) {
  // These are basically the same icon, but code within webextensions
  // generates references to the former and generic add-ons manager code
  // generates referces to the latter.
  return (
    icon == "chrome://browser/content/extension.svg" ||
    icon == "chrome://mozapps/skin/extensions/extensionGeneric.svg"
  );
}

/**
 * Check the contents of a permission popup notification
 *
 * @param {Window} panel - The popup window.
 * @param {string|RegExp|Function} checkIcon - The icon expected to appear in
 *   the notification.  If this is a string, it must match the icon url exactly.
 *   If it is a regular expression it is tested against the icon url, and if
 *   it is a function, it is called with the icon url and returns
 *   true if the url is correct.
 * @param {object[]} permissions - The expected entries in the permissions list.
 *   Each element in this array is itself a 2-element array with the string key
 *   for the item (e.g., "webext-perms-description-foo") for permission foo
 *   and an optional formatting parameter.
 * @param {boolean} sideloaded - Whether the notification is for a sideloaded
 *   extenion.
 * @param {boolean} [warning=false] Whether the experiments warning should be
 *   visible.
 */
async function checkNotification(
  panel,
  checkIcon,
  permissions,
  sideloaded,
  warning = false
) {
  const icon = panel.getAttribute("icon");
  const permissionTitleEl = document.getElementById(
    "addon-webext-perm-title-required"
  );
  const permissionListEl = document.getElementById("addon-webext-perm-list");
  const experimentWarning = document.getElementById(
    "addon-webext-experiment-warning"
  );
  const learnMoreLink = document.getElementById("addon-webext-perm-info");

  if (checkIcon instanceof RegExp) {
    ok(
      checkIcon.test(icon),
      `Notification icon is correct ${JSON.stringify(icon)} ~= ${checkIcon}`
    );
  } else if (typeof checkIcon == "function") {
    ok(checkIcon(icon), "Notification icon is correct");
  } else {
    is(icon, checkIcon, "Notification icon is correct");
  }

  is(
    learnMoreLink.hidden,
    !permissions.length,
    "Permissions learn more is hidden if there are no permissions"
  );

  if (!permissions.length) {
    ok(permissionListEl.hidden, "Permissions list is hidden");
    ok(permissionTitleEl.hidden, "Permissions list title is hidden");
    ok(
      !permissionListEl.childElementCount,
      "Permission list and single permission element have no entries"
    );
  } else {
    ok(!permissionListEl.hidden, "Permissions list is not hidden");
    ok(!permissionTitleEl.hidden, "Permissions list title is not hidden");
    is(
      permissions.length,
      permissionListEl.childElementCount,
      "Permission list has the correct number of entries"
    );
    is(
      "Required permissions:",
      permissionTitleEl.textContent,
      "Permissions list title is correct"
    );
  }

  if (warning) {
    is(experimentWarning.hidden, false, "Experiments warning is visible");
  } else {
    is(experimentWarning.hidden, true, "Experiments warning is hidden");
  }
}

/**
 * Test that install-time permission prompts work for a given
 * installation method.
 *
 * @param {function(string):Promise} installFn - Callable that takes the name
 *   of an xpi file to install and starts to install it.
 *   Should return a Promise that resolves when the install is finished or
 *   rejects if the install is canceled.
 * @returns {Promise}
 */
async function testInstallMethod(installFn) {
  const PERMS_XPI = "addons/browser_webext_permissions.xpi";
  const NO_PERMS_XPI = "addons/browser_webext_nopermissions.xpi";
  const ID = "permissions@test.mozilla.org";

  await SpecialPowers.pushPrefEnv({
    set: [
      ["extensions.webapi.testing", true],
      ["extensions.install.requireBuiltInCerts", false],
    ],
  });

  const testURI = makeURI("https://example.com/");
  PermissionTestUtils.add(testURI, "install", Services.perms.ALLOW_ACTION);
  registerCleanupFunction(() => PermissionTestUtils.remove(testURI, "install"));

  async function runOnce(filename, cancel) {
    const tab = openContentTab("about:blank");
    if (tab.browser.webProgress.isLoadingDocument) {
      await BrowserTestUtils.browserLoaded(tab.browser);
    }

    const installPromise = new Promise(resolve => {
      const listener = {
        onDownloadCancelled() {
          AddonManager.removeInstallListener(listener);
          resolve(false);
        },

        onDownloadFailed() {
          AddonManager.removeInstallListener(listener);
          resolve(false);
        },

        onInstallCancelled() {
          AddonManager.removeInstallListener(listener);
          resolve(false);
        },

        onInstallEnded() {
          AddonManager.removeInstallListener(listener);
          resolve(true);
        },

        onInstallFailed() {
          AddonManager.removeInstallListener(listener);
          resolve(false);
        },
      };
      AddonManager.addInstallListener(listener);
    });

    const installMethodPromise = installFn(filename);

    let panel = await promisePopupNotificationShown("addon-webext-permissions");
    if (filename == PERMS_XPI) {
      // The icon should come from the extension, don't bother with the precise
      // path, just make sure we've got a jar url pointing to the right path
      // inside the jar.
      await checkNotification(panel, /^jar:file:\/\/.*\/icon\.png$/, [
        ["webext-perms-host-description-wildcard", "domain"],
        ["webext-perms-host-description-one-site", "domain"],
        ["webext-perms-description-nativeMessaging"],
        // The below permissions are deliberately in this order as permissions
        // are sorted alphabetically by the permission string to match AMO.
        ["webext-perms-description-accountsRead"],
        ["webext-perms-description-tabs"],
      ]);
    } else if (filename == NO_PERMS_XPI) {
      await checkNotification(panel, isDefaultIcon, []);
    }

    if (cancel) {
      panel.secondaryButton.click();
      try {
        await installMethodPromise;
        // eslint-disable-next-line no-unused-vars
      } catch (err) {}
    } else {
      // Look for post-install notification
      const postInstallPromise =
        promisePopupNotificationShown("addon-installed");
      panel.button.click();

      // Press OK on the post-install notification
      panel = await postInstallPromise;
      panel.button.click();

      await installMethodPromise;
    }

    const result = await installPromise;
    const addon = await AddonManager.getAddonByID(ID);
    if (cancel) {
      ok(!result, "Installation was cancelled");
      is(addon, null, "Extension is not installed");
    } else {
      ok(result, "Installation completed");
      isnot(addon, null, "Extension is installed");
      await addon.uninstall();
    }

    const tabmail = document.getElementById("tabmail");
    tabmail.closeOtherTabs(tabmail.tabInfo[0]);
  }

  // A few different tests for each installation method:
  // 1. Start installation of an extension that requests no permissions,
  //    verify the notification contents, then cancel the install
  await runOnce(NO_PERMS_XPI, true);

  // 2. Same as #1 but with an extension that requests some permissions.
  await runOnce(PERMS_XPI, true);

  // 3. Repeat with the same extension from step 2 but this time,
  //    accept the permissions to install the extension.  (Then uninstall
  //    the extension to clean up.)
  await runOnce(PERMS_XPI, false);

  await SpecialPowers.popPrefEnv();
}

// Helper function to test a specific scenario for interactive updates.
// `checkFn` is a callable that triggers a check for updates.
// `autoUpdate` specifies whether the test should be run with
// updates applied automatically or not.
async function interactiveUpdateTest(autoUpdate, checkFn) {
  AddonTestUtils.initMochitest(this);

  const ID = "update2@tests.mozilla.org";
  const FAKE_INSTALL_SOURCE = "fake-install-source";

  await SpecialPowers.pushPrefEnv({
    set: [
      // We don't have pre-pinned certificates for the local mochitest server
      ["extensions.install.requireBuiltInCerts", false],
      ["extensions.update.requireBuiltInCerts", false],

      ["extensions.update.autoUpdateDefault", autoUpdate],

      // Point updates to the local mochitest server
      ["extensions.update.url", `${BASE}/browser_webext_update.json`],
    ],
  });

  AddonTestUtils.hookAMTelemetryEvents();

  // Trigger an update check, manually applying the update if we're testing
  // without auto-update.
  async function triggerUpdate(win, addon) {
    let manualUpdatePromise;
    if (!autoUpdate) {
      manualUpdatePromise = new Promise(resolve => {
        const listener = {
          onNewInstall() {
            AddonManager.removeInstallListener(listener);
            resolve();
          },
        };
        AddonManager.addInstallListener(listener);
      });
    }

    const promise = checkFn(win, addon);

    if (manualUpdatePromise) {
      await manualUpdatePromise;

      const doc = win.document;
      if (win.gViewController.currentViewId !== "addons://updates/available") {
        const showUpdatesBtn = doc.querySelector(
          "addon-updates-message"
        ).button;
        await TestUtils.waitForCondition(() => {
          return !showUpdatesBtn.hidden;
        }, "Wait for show updates button");
        const viewChanged = waitAboutAddonsViewLoaded(doc);
        showUpdatesBtn.click();
        await viewChanged;
      }
      const card = await TestUtils.waitForCondition(() => {
        return doc.querySelector(`addon-card[addon-id="${ID}"]`);
      }, `Wait addon card for "${ID}"`);
      const updateBtn = card.querySelector(
        'panel-item[action="install-update"]'
      );
      ok(updateBtn, `Found update button for "${ID}"`);
      updateBtn.click();
    }

    return { promise };
  }

  // Install version 1.0 of the test extension
  let addon = await promiseInstallAddon(
    `${BASE}/addons/browser_webext_update1.xpi`,
    {
      source: FAKE_INSTALL_SOURCE,
    }
  );
  ok(addon, "Addon was installed");
  is(addon.version, "1.0", "Version 1 of the addon is installed");

  const win = await openAddonsMgr("addons://list/extension");

  await waitAboutAddonsViewLoaded(win.document);

  // Trigger an update check
  let popupPromise = promisePopupNotificationShown("addon-webext-permissions");
  let { promise: checkPromise } = await triggerUpdate(win, addon);
  let panel = await popupPromise;

  // Click the cancel button, wait to see the cancel event
  const cancelPromise = promiseInstallEvent(addon, "onInstallCancelled");
  panel.secondaryButton.click();
  await cancelPromise;

  addon = await AddonManager.getAddonByID(ID);
  is(addon.version, "1.0", "Should still be running the old version");

  // Make sure the update check is completely finished.
  await checkPromise;

  // Trigger a new update check
  popupPromise = promisePopupNotificationShown("addon-webext-permissions");
  checkPromise = (await triggerUpdate(win, addon)).promise;

  // This time, accept the upgrade
  const updatePromise = waitForUpdate(addon);
  panel = await popupPromise;
  panel.button.click();

  addon = await updatePromise;
  is(addon.version, "2.0", "Should have upgraded");

  await checkPromise;

  const tabmail = document.getElementById("tabmail");
  tabmail.closeTab(tabmail.currentTabInfo);
  await addon.uninstall();
  await SpecialPowers.popPrefEnv();

  const collectedUpdateEvents = AddonTestUtils.getAMTelemetryEvents().filter(
    evt => {
      return evt.method === "update";
    }
  );

  Assert.deepEqual(
    collectedUpdateEvents.map(evt => evt.extra.step),
    [
      // First update is cancelled on the permission prompt.
      "started",
      "download_started",
      "download_completed",
      "permissions_prompt",
      "cancelled",
      // Second update is expected to be completed.
      "started",
      "download_started",
      "download_completed",
      "permissions_prompt",
      "completed",
    ],
    "Got the expected sequence on update telemetry events"
  );

  ok(
    collectedUpdateEvents.every(evt => evt.extra.addon_id === ID),
    "Every update telemetry event should have the expected addon_id extra var"
  );

  ok(
    collectedUpdateEvents.every(
      evt => evt.extra.source === FAKE_INSTALL_SOURCE
    ),
    "Every update telemetry event should have the expected source extra var"
  );

  ok(
    collectedUpdateEvents.every(evt => evt.extra.updated_from === "user"),
    "Every update telemetry event should have the update_from extra var 'user'"
  );

  const hasPermissionsExtras = collectedUpdateEvents
    .filter(evt => {
      return evt.extra.step === "permissions_prompt";
    })
    .every(evt => {
      return Number.isInteger(parseInt(evt.extra.num_strings, 10));
    });

  ok(
    hasPermissionsExtras,
    "Every 'permissions_prompt' update telemetry event should have the permissions extra vars"
  );

  const hasDownloadTimeExtras = collectedUpdateEvents
    .filter(evt => {
      return evt.extra.step === "download_completed";
    })
    .every(evt => {
      const download_time = parseInt(evt.extra.download_time, 10);
      return !isNaN(download_time) && download_time > 0;
    });

  ok(
    hasDownloadTimeExtras,
    "Every 'download_completed' update telemetry event should have a download_time extra vars"
  );
}

// The tests in this directory install a bunch of extensions but they
// need to uninstall them before exiting, as a stray leftover extension
// after one test can foul up subsequent tests.
// So, add a task to run before any tests that grabs a list of all the
// add-ons that are pre-installed in the test environment and then checks
// the list of installed add-ons at the end of the test to make sure no
// new add-ons have been added.
// Individual tests can store a cleanup function in the testCleanup global
// to ensure it gets called before the final check is performed.
let testCleanup;
add_task(async function () {
  const addons = await AddonManager.getAllAddons();
  const existingAddons = new Set(addons.map(a => a.id));

  registerCleanupFunction(async function () {
    if (testCleanup) {
      await testCleanup();
      testCleanup = null;
    }

    for (const addon of await AddonManager.getAllAddons()) {
      // Builtin search extensions may have been installed by SearchService
      // during the test run, ignore those.
      if (
        !existingAddons.has(addon.id) &&
        !(addon.isBuiltin && addon.id.endsWith("@search.mozilla.org"))
      ) {
        ok(
          false,
          `Addon ${addon.id} was left installed at the end of the test`
        );
        await addon.uninstall();
      }
    }
  });
});

registerCleanupFunction(() => {
  // The appmenu should be closed by the end of the test.
  Assert.equal(PanelUI.panel.state, "closed", "Main menu is closed.");

  // Any opened tabs should be closed by the end of the test.
  const tabmail = document.getElementById("tabmail");
  is(tabmail.tabInfo.length, 1, "All tabs are closed.");
  tabmail.closeOtherTabs(0);
});

let collectedTelemetry = [];
function hookExtensionsTelemetry() {
  const originalHistogram = ExtensionsUI.histogram;
  ExtensionsUI.histogram = {
    add(value) {
      collectedTelemetry.push(value);
    },
  };
  registerCleanupFunction(() => {
    is(
      collectedTelemetry.length,
      0,
      "No unexamined telemetry after test is finished"
    );
    ExtensionsUI.histogram = originalHistogram;
  });
}

function expectTelemetry(values) {
  Assert.deepEqual(values, collectedTelemetry);
  collectedTelemetry = [];
}
