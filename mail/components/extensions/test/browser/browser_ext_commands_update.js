/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// There is an eslint miss-configuration. It claims these two modules being
// redeclared, but the modules are not available if not imported. ¯\_(ツ)_/¯

/* eslint-disable mozilla/no-redeclare-with-import-autofix */
var { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
/* eslint-disable mozilla/no-redeclare-with-import-autofix */
var { ExtensionSettingsStore } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionSettingsStore.sys.mjs"
);

let gUpdatedExtension;

function enableAddon(addon) {
  return new Promise(resolve => {
    AddonManager.addAddonListener({
      onEnabled(enabledAddon) {
        if (enabledAddon.id == addon.id) {
          resolve();
          AddonManager.removeAddonListener(this);
        }
      },
    });
    addon.enable();
  });
}

function disableAddon(addon) {
  return new Promise(resolve => {
    AddonManager.addAddonListener({
      onDisabled(disabledAddon) {
        if (disabledAddon.id == addon.id) {
          resolve();
          AddonManager.removeAddonListener(this);
        }
      },
    });
    addon.disable();
  });
}

add_task(async function test_update_defined_command() {
  registerCleanupFunction(async () => {
    await extension.unload();

    // gUpdatedExtension might not have started up if we didn't make it that far.
    if (gUpdatedExtension) {
      await gUpdatedExtension.unload();
    }

    // Check that ESS is cleaned up on uninstall.
    const storedCommands = ExtensionSettingsStore.getAllForExtension(
      extension.id,
      "commands"
    );
    is(storedCommands.length, 0, "There are no stored commands after unload");
  });

  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "permanent",
    manifest: {
      version: "1.0",
      applications: { gecko: { id: "commands_update@mochi.test" } },
      commands: {
        foo: {
          suggested_key: {
            default: "Ctrl+Shift+I",
          },
          description: "The foo command",
        },
      },
    },
    background() {
      browser.test.onMessage.addListener(async (msg, data) => {
        if (msg == "update") {
          await browser.commands.update(data);
          browser.test.sendMessage("updateDone");
          return;
        } else if (msg == "reset") {
          await browser.commands.reset(data);
          browser.test.sendMessage("resetDone");
          return;
        } else if (msg != "run") {
          return;
        }
        // Test initial manifest command.
        let commands = await browser.commands.getAll();
        browser.test.assertEq(1, commands.length, "There is 1 command");
        let command = commands[0];
        browser.test.assertEq("foo", command.name, "The name is right");
        browser.test.assertEq(
          "The foo command",
          command.description,
          "The description is right"
        );
        browser.test.assertEq(
          "Ctrl+Shift+I",
          command.shortcut,
          "The shortcut is right"
        );

        // Update the shortcut.
        await browser.commands.update({
          name: "foo",
          shortcut: "Ctrl+Shift+L",
        });

        // Test the updated shortcut.
        commands = await browser.commands.getAll();
        browser.test.assertEq(1, commands.length, "There is still 1 command");
        command = commands[0];
        browser.test.assertEq("foo", command.name, "The name is unchanged");
        browser.test.assertEq(
          "The foo command",
          command.description,
          "The description is unchanged"
        );
        browser.test.assertEq(
          "Ctrl+Shift+L",
          command.shortcut,
          "The shortcut is updated"
        );

        // Update the description.
        await browser.commands.update({
          name: "foo",
          description: "The only command",
        });

        // Test the updated shortcut.
        commands = await browser.commands.getAll();
        browser.test.assertEq(1, commands.length, "There is still 1 command");
        command = commands[0];
        browser.test.assertEq("foo", command.name, "The name is unchanged");
        browser.test.assertEq(
          "The only command",
          command.description,
          "The description is updated"
        );
        browser.test.assertEq(
          "Ctrl+Shift+L",
          command.shortcut,
          "The shortcut is unchanged"
        );

        // Clear the shortcut.
        await browser.commands.update({
          name: "foo",
          shortcut: "",
        });
        commands = await browser.commands.getAll();
        browser.test.assertEq(1, commands.length, "There is still 1 command");
        command = commands[0];
        browser.test.assertEq("foo", command.name, "The name is unchanged");
        browser.test.assertEq(
          "The only command",
          command.description,
          "The description is unchanged"
        );
        browser.test.assertEq("", command.shortcut, "The shortcut is empty");

        // Update the description and shortcut.
        await browser.commands.update({
          name: "foo",
          description: "The new command",
          shortcut: "   Alt+  Shift +9",
        });

        // Test the updated shortcut.
        commands = await browser.commands.getAll();
        browser.test.assertEq(1, commands.length, "There is still 1 command");
        command = commands[0];
        browser.test.assertEq("foo", command.name, "The name is unchanged");
        browser.test.assertEq(
          "The new command",
          command.description,
          "The description is updated"
        );
        browser.test.assertEq(
          "Alt+Shift+9",
          command.shortcut,
          "The shortcut is updated"
        );

        // Test a bad shortcut update.
        browser.test.assertThrows(
          () =>
            browser.commands.update({ name: "foo", shortcut: "Ctl+Shift+L" }),
          /Type error for parameter detail .+ primary modifier and a key/,
          "It rejects for a bad shortcut"
        );

        // Try to update a command that doesn't exist.
        await browser.test.assertRejects(
          browser.commands.update({ name: "bar", shortcut: "Ctrl+Shift+L" }),
          'Unknown command "bar"',
          "It rejects for an unknown command"
        );

        browser.test.notifyPass("commands");
      });
      browser.test.sendMessage("ready");
    },
  });

  await extension.startup();

  function extensionKeyset(extensionId) {
    return document.getElementById(
      makeWidgetId(`ext-keyset-id-${extensionId}`)
    );
  }

  function checkKey(extensionId, shortcutKey, modifiers) {
    const keyset = extensionKeyset(extensionId);
    is(keyset.children.length, 1, "There is 1 key in the keyset");
    const key = keyset.children[0];
    is(key.getAttribute("key"), shortcutKey, "The key is correct");
    is(key.getAttribute("modifiers"), modifiers, "The modifiers are correct");
  }

  function checkNumericKey(extensionId, key, modifiers) {
    const keyset = extensionKeyset(extensionId);
    is(
      keyset.children.length,
      2,
      "There are 2 keys in the keyset now, 1 of which contains a keycode."
    );
    const numpadKey = keyset.children[0];
    is(
      numpadKey.getAttribute("keycode"),
      `VK_NUMPAD${key}`,
      "The numpad keycode is correct."
    );
    is(
      numpadKey.getAttribute("modifiers"),
      modifiers,
      "The modifiers are correct"
    );

    const originalNumericKey = keyset.children[1];
    is(
      originalNumericKey.getAttribute("keycode"),
      `VK_${key}`,
      "The original key is correct."
    );
    is(
      originalNumericKey.getAttribute("modifiers"),
      modifiers,
      "The modifiers are correct"
    );
  }

  // Check that the <key> is set for the original shortcut.
  checkKey(extension.id, "I", "accel,shift");

  await extension.awaitMessage("ready");
  extension.sendMessage("run");
  await extension.awaitFinish("commands");

  // Check that the <keycode> has been updated.
  checkNumericKey(extension.id, "9", "alt,shift");

  // Check that the updated command is stored in ExtensionSettingsStore.
  let storedCommands = ExtensionSettingsStore.getAllForExtension(
    extension.id,
    "commands"
  );
  is(storedCommands.length, 1, "There is only one stored command");
  const command = ExtensionSettingsStore.getSetting(
    "commands",
    "foo",
    extension.id
  ).value;
  is(command.description, "The new command", "The description is stored");
  is(command.shortcut, "Alt+Shift+9", "The shortcut is stored");

  // Check that the key is updated immediately.
  extension.sendMessage("update", { name: "foo", shortcut: "Ctrl+Shift+M" });
  await extension.awaitMessage("updateDone");
  checkKey(extension.id, "M", "accel,shift");

  // Ensure all successive updates are stored.
  // Force the command to only have a description saved.
  await ExtensionSettingsStore.addSetting(extension.id, "commands", "foo", {
    description: "description only",
  });
  // This command now only has a description set in storage, also update the shortcut.
  extension.sendMessage("update", { name: "foo", shortcut: "Alt+Shift+9" });
  await extension.awaitMessage("updateDone");
  const storedCommand = await ExtensionSettingsStore.getSetting(
    "commands",
    "foo",
    extension.id
  );
  is(
    storedCommand.value.shortcut,
    "Alt+Shift+9",
    "The shortcut is saved correctly"
  );
  is(
    storedCommand.value.description,
    "description only",
    "The description is saved correctly"
  );

  // Calling browser.commands.reset("foo") should reset to manifest version.
  extension.sendMessage("reset", "foo");
  await extension.awaitMessage("resetDone");

  checkKey(extension.id, "I", "accel,shift");

  // Check that enable/disable removes the keyset and reloads the saved command.
  const addon = await AddonManager.getAddonByID(extension.id);
  await disableAddon(addon);
  const keyset = extensionKeyset(extension.id);
  is(keyset, null, "The extension keyset is removed when disabled");
  // Add some commands to storage, only "foo" should get loaded.
  await ExtensionSettingsStore.addSetting(extension.id, "commands", "foo", {
    shortcut: "Alt+Shift+9",
  });
  await ExtensionSettingsStore.addSetting(extension.id, "commands", "unknown", {
    shortcut: "Ctrl+Shift+P",
  });
  storedCommands = ExtensionSettingsStore.getAllForExtension(
    extension.id,
    "commands"
  );
  is(storedCommands.length, 2, "There are now 2 commands stored");
  await enableAddon(addon);
  // Wait for the keyset to appear (it's async on enable).
  await TestUtils.waitForCondition(() => extensionKeyset(extension.id));
  // The keyset is back with the value from ExtensionSettingsStore.
  checkNumericKey(extension.id, "9", "alt,shift");

  // Check that an update to a shortcut in the manifest is mapped correctly.
  gUpdatedExtension = ExtensionTestUtils.loadExtension({
    useAddonManager: "permanent",
    manifest: {
      version: "1.0",
      applications: { gecko: { id: "commands_update@mochi.test" } },
      commands: {
        foo: {
          suggested_key: {
            default: "Ctrl+Shift+L",
          },
          description: "The foo command",
        },
      },
    },
  });
  await gUpdatedExtension.startup();

  await TestUtils.waitForCondition(() => extensionKeyset(extension.id));
  // Shortcut is unchanged since it was previously updated.
  checkNumericKey(extension.id, "9", "alt,shift");
});
