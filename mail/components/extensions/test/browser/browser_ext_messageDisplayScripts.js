/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let gAccount, gMessages;
let gDefaultTabmail, gDefaultAbout3Pane, gDefaultMessagePane;

add_setup(async () => {
  gAccount = createAccount();
  const rootFolder = gAccount.incomingServer.rootFolder;
  const folder = await createSubfolder(rootFolder, "messageDisplayScripts");
  await createMessages(folder, 11);
  gMessages = [...folder.messages];

  gDefaultTabmail = document.getElementById("tabmail");
  gDefaultAbout3Pane =
    gDefaultTabmail.currentTabInfo.chromeBrowser.contentWindow;
  gDefaultAbout3Pane.displayFolder(folder.URI);
  gDefaultMessagePane =
    gDefaultAbout3Pane.messageBrowser.contentDocument.getElementById(
      "messagepane"
    );
});

async function checkMessageBody(expected, message, browser) {
  if (message && "textContent" in expected) {
    let body = await new Promise(resolve => {
      window.MsgHdrToMimeMessage(message, null, (msgHdr, mimeMessage) => {
        resolve(mimeMessage.parts[0].body);
      });
    });
    // Ignore Windows line-endings, they're not important here.
    body = body.replace(/\r/g, "");
    expected.textContent = body + expected.textContent;
  }
  if (!browser) {
    browser = gDefaultMessagePane;
  }

  await checkContent(browser, expected);
}

/** Tests browser.tabs.insertCSS and browser.tabs.removeCSS. */
add_task(async function testInsertRemoveCSS() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [tab] = await browser.tabs.query({ mailTab: true });
        await window.sendMessage();

        await browser.tabs.insertCSS(tab.id, {
          code: "body { background-color: lime; }",
        });
        await window.sendMessage();

        await browser.tabs.removeCSS(tab.id, {
          code: "body { background-color: lime; }",
        });
        await window.sendMessage();

        await browser.tabs.insertCSS(tab.id, { file: "test.css" });
        await window.sendMessage();

        await browser.tabs.removeCSS(tab.id, { file: "test.css" });

        browser.test.notifyPass("finished");
      },
      "test.css": "body { background-color: green; }",
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["messagesModify"],
    },
  });

  gDefaultAbout3Pane.threadTree.selectedIndex = 0;
  await awaitBrowserLoaded(gDefaultMessagePane);

  await extension.startup();

  await extension.awaitMessage();
  await checkMessageBody(
    { backgroundColor: "rgba(0, 0, 0, 0)" },
    gMessages.at(-1)
  );
  extension.sendMessage();

  await extension.awaitMessage();
  await checkMessageBody(
    { backgroundColor: "rgb(0, 255, 0)" },
    gMessages.at(-1)
  );
  extension.sendMessage();

  await extension.awaitMessage();
  await checkMessageBody(
    { backgroundColor: "rgba(0, 0, 0, 0)" },
    gMessages.at(-1)
  );
  extension.sendMessage();

  await extension.awaitMessage();
  await checkMessageBody(
    { backgroundColor: "rgb(0, 128, 0)" },
    gMessages.at(-1)
  );
  extension.sendMessage();

  await extension.awaitFinish("finished");
  await checkMessageBody(
    { backgroundColor: "rgba(0, 0, 0, 0)" },
    gMessages.at(-1)
  );

  await extension.unload();
});

/** Tests browser.scripting.insertCSS and browser.scripting.removeCSS. */
add_task(async function testInsertRemoveCSSViaScriptingAPI() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [tab] = await browser.tabs.query({ mailTab: true });
        await window.sendMessage();

        await browser.scripting.insertCSS({
          target: { tabId: tab.id },
          css: "body { background-color: lime; }",
        });
        await window.sendMessage();

        await browser.scripting.removeCSS({
          target: { tabId: tab.id },
          css: "body { background-color: lime; }",
        });
        await window.sendMessage();

        await browser.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["test.css"],
        });
        await window.sendMessage();

        await browser.scripting.removeCSS({
          target: { tabId: tab.id },
          files: ["test.css"],
        });

        browser.test.notifyPass("finished");
      },
      "test.css": "body { background-color: green; }",
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["messagesModify", "scripting"],
    },
  });

  gDefaultAbout3Pane.threadTree.selectedIndex = 2;
  await awaitBrowserLoaded(gDefaultMessagePane);

  await extension.startup();

  await extension.awaitMessage();
  await checkMessageBody(
    { backgroundColor: "rgba(0, 0, 0, 0)" },
    gMessages.at(-3)
  );
  extension.sendMessage();

  await extension.awaitMessage();
  await checkMessageBody(
    { backgroundColor: "rgb(0, 255, 0)" },
    gMessages.at(-3)
  );
  extension.sendMessage();

  await extension.awaitMessage();
  await checkMessageBody(
    { backgroundColor: "rgba(0, 0, 0, 0)" },
    gMessages.at(-3)
  );
  extension.sendMessage();

  await extension.awaitMessage();
  await checkMessageBody(
    { backgroundColor: "rgb(0, 128, 0)" },
    gMessages.at(-3)
  );
  extension.sendMessage();

  await extension.awaitFinish("finished");
  await checkMessageBody(
    { backgroundColor: "rgba(0, 0, 0, 0)" },
    gMessages.at(-3)
  );

  await extension.unload();
});

/** Tests browser.tabs.insertCSS fails without the "messagesModify" permission. */
add_task(async function testInsertRemoveCSSNoPermissions() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [tab] = await browser.tabs.query({ mailTab: true });

        await browser.test.assertRejects(
          browser.tabs.insertCSS(tab.id, {
            code: "body { background-color: darkred; }",
          }),
          /Missing host permission for the tab/,
          "insertCSS without permission should throw"
        );

        await browser.test.assertRejects(
          browser.tabs.insertCSS(tab.id, { file: "test.css" }),
          /Missing host permission for the tab/,
          "insertCSS without permission should throw"
        );

        await browser.test.assertRejects(
          browser.tabs.insertCSS(tab.id, {
            file: "test.css",
            matchAboutBlank: true,
          }),
          /Missing host permission for the tab/,
          "insertCSS without permission should throw"
        );

        browser.test.notifyPass("finished");
      },
      "test.css": "body { background-color: red; }",
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: [],
    },
  });

  gDefaultAbout3Pane.threadTree.selectedIndex = 1;
  await awaitBrowserLoaded(gDefaultMessagePane);

  await extension.startup();

  await extension.awaitFinish("finished");
  await checkMessageBody(
    {
      backgroundColor: "rgba(0, 0, 0, 0)",
      textContent: "",
    },
    gMessages.at(-2)
  );

  await extension.unload();
});

/** Tests browser.tabs.executeScript. */
add_task(async function testExecuteScript() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [tab] = await browser.tabs.query({ mailTab: true });
        await window.sendMessage();

        await browser.tabs.executeScript(tab.id, {
          code: `document.body.setAttribute("foo", "bar");`,
        });
        await window.sendMessage();

        await browser.tabs.executeScript(tab.id, { file: "test.js" });

        browser.test.notifyPass("finished");
      },
      "test.js": () => {
        document.body.querySelector(".moz-text-flowed").textContent +=
          "Hey look, the script ran!";
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["messagesModify"],
    },
  });

  gDefaultAbout3Pane.threadTree.selectedIndex = 2;
  await awaitBrowserLoaded(gDefaultMessagePane);

  await extension.startup();

  await extension.awaitMessage();
  await checkMessageBody({ textContent: "" }, gMessages.at(-3));
  extension.sendMessage();

  await extension.awaitMessage();
  await checkMessageBody({ foo: "bar" }, gMessages.at(-3));
  extension.sendMessage();

  await extension.awaitFinish("finished");
  await checkMessageBody(
    {
      foo: "bar",
      textContent: "Hey look, the script ran!",
    },
    gMessages.at(-3)
  );

  await extension.unload();
});

/** Tests browser.scripting.executeScript. */
add_task(async function testExecuteScriptViaScriptingAPI() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [tab] = await browser.tabs.query({ mailTab: true });
        await window.sendMessage();

        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            document.body.setAttribute("foo", "bar");
          },
        });
        await window.sendMessage();

        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["test.js"],
        });

        browser.test.notifyPass("finished");
      },
      "test.js": () => {
        document.body.querySelector(".moz-text-flowed").textContent +=
          "Hey look, the script ran!";
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      manifest_version: 2,
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["messagesModify", "scripting"],
    },
  });

  gDefaultAbout3Pane.threadTree.selectedIndex = 1;
  await awaitBrowserLoaded(gDefaultMessagePane);

  await extension.startup();

  await extension.awaitMessage();
  await checkMessageBody({ textContent: "" }, gMessages.at(-2));
  extension.sendMessage();

  await extension.awaitMessage();
  await checkMessageBody({ foo: "bar" }, gMessages.at(-2));
  extension.sendMessage();

  await extension.awaitFinish("finished");
  await checkMessageBody(
    {
      foo: "bar",
      textContent: "Hey look, the script ran!",
    },
    gMessages.at(-2)
  );

  await extension.unload();
});

/** Tests browser.tabs.executeScript fails without the "messagesModify" permission. */
add_task(async function testExecuteScriptNoPermissions() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [tab] = await browser.tabs.query({ mailTab: true });

        await browser.test.assertRejects(
          browser.tabs.executeScript(tab.id, {
            code: `document.body.setAttribute("foo", "bar");`,
          }),
          /Missing host permission for the tab/,
          "executeScript without permission should throw"
        );

        await browser.test.assertRejects(
          browser.tabs.executeScript(tab.id, { file: "test.js" }),
          /Missing host permission for the tab/,
          "executeScript without permission should throw"
        );

        await browser.test.assertRejects(
          browser.tabs.executeScript(tab.id, {
            file: "test.js",
            matchAboutBlank: true,
          }),
          /Missing host permission for the tab/,
          "executeScript without permission should throw"
        );

        browser.test.notifyPass("finished");
      },
      "test.js": () => {
        document.body.querySelector(".moz-text-flowed").textContent +=
          "Hey look, the script ran!";
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: [],
    },
  });

  gDefaultAbout3Pane.threadTree.selectedIndex = 3;
  await awaitBrowserLoaded(gDefaultMessagePane);

  await extension.startup();

  await extension.awaitFinish("finished");
  await checkMessageBody({ foo: null, textContent: "" }, gMessages.at(-4));

  await extension.unload();
});

/**
 * Tests the messenger alias is available after browser.tabs.executeScript().
 */
add_task(async function testExecuteScriptAlias() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [tab] = await browser.tabs.query({ mailTab: true });
        await window.sendMessage();

        await browser.tabs.executeScript(tab.id, {
          code: `document.body.querySelector(".moz-text-flowed").textContent +=
                   messenger.runtime.getManifest().applications.gecko.id;`,
        });

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      applications: { gecko: { id: "message_display_scripts@mochitest" } },
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["messagesModify"],
    },
  });

  gDefaultAbout3Pane.threadTree.selectedIndex = 4;
  await awaitBrowserLoaded(gDefaultMessagePane);

  await extension.startup();

  await extension.awaitMessage();
  await checkMessageBody({ textContent: "" }, gMessages.at(-5));
  extension.sendMessage();

  await extension.awaitFinish("finished");
  await checkMessageBody(
    { textContent: "message_display_scripts@mochitest" },
    gMessages.at(-5)
  );

  await extension.unload();
});

/**
 * Tests messenger alias is available after browser.scripting.executeScript().
 */
add_task(async function testExecuteScriptAliasViaScriptingAPI() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        const [tab] = await browser.tabs.query({ type: ["mail"] });
        await window.sendMessage();

        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // eslint-disable-next-line no-undef
            const id = messenger.runtime.getManifest().applications.gecko.id;
            document.body.querySelector(".moz-text-flowed").textContent += id;
          },
        });

        browser.test.notifyPass("finished");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      manifest_version: 2,
      browser_specific_settings: {
        gecko: { id: "message_display_scripts@mochitest" },
      },
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["messagesModify", "scripting"],
    },
  });

  gDefaultAbout3Pane.threadTree.selectedIndex = 3;
  await awaitBrowserLoaded(gDefaultMessagePane);

  await extension.startup();

  await extension.awaitMessage();
  await checkMessageBody({ textContent: "" }, gMessages.at(-4));
  extension.sendMessage();

  await extension.awaitFinish("finished");
  await checkMessageBody(
    { textContent: "message_display_scripts@mochitest" },
    gMessages.at(-4)
  );

  await extension.unload();
});

/**
 * Tests browser.messageDisplayScripts.register correctly adds CSS and
 * JavaScript to message display windows. Also tests calling `unregister`
 * on the returned object.
 */
add_task(async function testRegister() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        // Keep track of registered scrips being executed and ready.
        browser.runtime.onMessage.addListener((message, sender) => {
          if (message == "LOADED") {
            window.sendMessage("ScriptLoaded", sender.tab.id);
          }
        });

        const registeredScript = await browser.messageDisplayScripts.register({
          css: [{ code: "body { color: white }" }, { file: "test.css" }],
          js: [
            { code: `document.body.setAttribute("foo", "bar");` },
            { file: "test.js" },
          ],
        });

        browser.test.onMessage.addListener(async (message, data) => {
          switch (message) {
            case "Unregister":
              await registeredScript.unregister();
              browser.test.notifyPass("finished");
              break;

            case "RuntimeMessageTest":
              try {
                browser.test.assertEq(
                  `Received: ${data.tabId}`,
                  await browser.tabs.sendMessage(data.tabId, data.tabId)
                );
              } catch (ex) {
                browser.test.fail(
                  `Failed to send message to messageDisplayScript: ${ex}`
                );
              }
              browser.test.sendMessage("RuntimeMessageTestDone");
              break;
          }
        });

        window.sendMessage("Ready");
      },
      "test.css": "body { background-color: green; }",
      "test.js": () => {
        document.body.querySelector(".moz-text-flowed").textContent +=
          "Hey look, the script ran!";
        browser.runtime.onMessage.addListener(async message => {
          return `Received: ${message}`;
        });
        browser.runtime.sendMessage("LOADED");
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["messagesModify", "<all_urls>"],
    },
  });

  gDefaultAbout3Pane.threadTree.selectedIndex = 5;
  await awaitBrowserLoaded(gDefaultMessagePane);

  extension.startup();
  await extension.awaitMessage("Ready");

  // Check a message that was already loaded. This tab has not loaded the
  // registered scripts.
  await checkMessageBody(
    {
      backgroundColor: "rgba(0, 0, 0, 0)",
      textContent: "",
    },
    gMessages.at(-6)
  );

  // Load a new message and check it is modified.
  let loadPromise = extension.awaitMessage("ScriptLoaded");
  gDefaultAbout3Pane.threadTree.selectedIndex = 6;
  const tabId = await loadPromise;

  await checkMessageBody(
    {
      backgroundColor: "rgb(0, 128, 0)",
      color: "rgb(255, 255, 255)",
      foo: "bar",
      textContent: "Hey look, the script ran!",
    },
    gMessages.at(-7)
  );
  // Check runtime messaging.
  let testDonePromise = extension.awaitMessage("RuntimeMessageTestDone");
  extension.sendMessage("RuntimeMessageTest", { tabId });
  await testDonePromise;

  // Open the message in a new tab.
  loadPromise = extension.awaitMessage("ScriptLoaded");
  const messageTab = await openMessageInTab(gMessages.at(-7));
  const messageTabId = await loadPromise;
  Assert.equal(gDefaultTabmail.tabInfo.length, 2);

  await checkMessageBody(
    {
      backgroundColor: "rgb(0, 128, 0)",
      color: "rgb(255, 255, 255)",
      foo: "bar",
      textContent: "Hey look, the script ran!",
    },
    gMessages.at(-7),
    messageTab.browser
  );
  // Check runtime messaging.
  testDonePromise = extension.awaitMessage("RuntimeMessageTestDone");
  extension.sendMessage("RuntimeMessageTest", { tabId: messageTabId });
  await testDonePromise;

  // Open a content tab. The CSS and script shouldn't apply.
  const contentTab = window.openContentTab("http://mochi.test:8888/");
  // Let's wait a while and see if anything happens:
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 1000));
  await checkMessageBody(
    {
      backgroundColor: "rgba(0, 0, 0, 0)",
      color: "rgb(0, 0, 0)",
      foo: null,
    },
    undefined,
    contentTab.browser
  );

  // Closing this tab should bring us back to the message in a tab.
  gDefaultTabmail.closeTab(contentTab);
  Assert.equal(gDefaultTabmail.currentTabInfo, messageTab);
  await checkMessageBody(
    {
      backgroundColor: "rgb(0, 128, 0)",
      color: "rgb(255, 255, 255)",
      foo: "bar",
      textContent: "Hey look, the script ran!",
    },
    gMessages.at(-7),
    messageTab.browser
  );
  // Check runtime messaging.
  testDonePromise = extension.awaitMessage("RuntimeMessageTestDone");
  extension.sendMessage("RuntimeMessageTest", { tabId: messageTabId });
  await testDonePromise;

  // Open the message in a new window.
  loadPromise = extension.awaitMessage("ScriptLoaded");
  const newWindow = await openMessageInWindow(gMessages.at(-8));
  const newWindowMessagePane = newWindow.getBrowser();
  const windowTabId = await loadPromise;

  await checkMessageBody(
    {
      backgroundColor: "rgb(0, 128, 0)",
      color: "rgb(255, 255, 255)",
      foo: "bar",
      textContent: "Hey look, the script ran!",
    },
    gMessages.at(-8),
    newWindowMessagePane
  );
  // Check runtime messaging.
  testDonePromise = extension.awaitMessage("RuntimeMessageTestDone");
  extension.sendMessage("RuntimeMessageTest", { tabId: windowTabId });
  await testDonePromise;

  // Unregister.
  extension.sendMessage("Unregister");
  await extension.awaitFinish("finished");
  await extension.unload();

  // Check the CSS is unloaded from the message in a tab.
  await checkMessageBody(
    {
      backgroundColor: "rgba(0, 0, 0, 0)",
      color: "rgb(0, 0, 0)",
      foo: "bar",
      textContent: "Hey look, the script ran!",
    },
    gMessages.at(-7),
    messageTab.browser
  );

  // Close the new tab.
  gDefaultTabmail.closeTab(messageTab);

  await checkMessageBody(
    {
      backgroundColor: "rgba(0, 0, 0, 0)",
      color: "rgb(0, 0, 0)",
      foo: "bar",
      textContent: "Hey look, the script ran!",
    },
    gMessages.at(-7)
  );

  // Check the CSS is unloaded from the message in a window.
  await checkMessageBody(
    {
      backgroundColor: "rgba(0, 0, 0, 0)",
      color: "rgb(0, 0, 0)",
      foo: "bar",
      textContent: "Hey look, the script ran!",
    },
    gMessages.at(-8),
    newWindowMessagePane
  );

  await BrowserTestUtils.closeWindow(newWindow);
});

/** Tests content_scripts in the manifest do not affect message display. */
async function subtestContentScriptManifest(message, ...permissions) {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "test.css": "body { background-color: red; }",
      "test.js": () => {
        document.body.textContent += "Hey look, the script ran!";
      },
    },
    manifest: {
      permissions,
      content_scripts: [
        {
          matches: ["<all_urls>"],
          css: ["test.css"],
          js: ["test.js"],
          match_about_blank: true,
          match_origin_as_fallback: true,
        },
      ],
    },
  });

  // match_origin_as_fallback is not implemented yet. Bug 1475831.
  ExtensionTestUtils.failOnSchemaWarnings(false);
  await extension.startup();
  ExtensionTestUtils.failOnSchemaWarnings(true);

  await checkMessageBody(
    {
      backgroundColor: "rgba(0, 0, 0, 0)",
      textContent: "",
    },
    message
  );

  await extension.unload();
}

add_task(async function testContentScriptManifestNoPermission() {
  gDefaultAbout3Pane.threadTree.selectedIndex = 7;
  await awaitBrowserLoaded(gDefaultMessagePane);
  await subtestContentScriptManifest(gMessages.at(-8));
});
add_task(async function testContentScriptManifest() {
  gDefaultAbout3Pane.threadTree.selectedIndex = 8;
  await awaitBrowserLoaded(gDefaultMessagePane);
  await subtestContentScriptManifest(gMessages.at(-9), "messagesModify");
});

/** Tests registered content scripts do not affect message display. */
async function subtestContentScriptRegister(message, ...permissions) {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        await browser.contentScripts.register({
          matches: ["<all_urls>"],
          css: [{ file: "test.css" }],
          js: [{ file: "test.js" }],
          matchAboutBlank: true,
        });

        browser.test.notifyPass("finished");
      },
      "test.css": "body { background-color: red; }",
      "test.js": () => {
        document.body.querySelector(".moz-text-flowed").textContent +=
          "Hey look, the script ran!";
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions,
    },
  });

  await extension.startup();

  await extension.awaitFinish("finished");
  await checkMessageBody(
    {
      backgroundColor: "rgba(0, 0, 0, 0)",
      textContent: "",
    },
    message
  );

  await extension.unload();
}

add_task(async function testContentScriptRegisterNoPermission() {
  gDefaultAbout3Pane.threadTree.selectedIndex = 9;
  await awaitBrowserLoaded(gDefaultMessagePane);
  await subtestContentScriptRegister(gMessages.at(-10), "<all_urls>");
});
add_task(async function testContentScriptRegister() {
  gDefaultAbout3Pane.threadTree.selectedIndex = 10;
  await awaitBrowserLoaded(gDefaultMessagePane);
  await subtestContentScriptRegister(
    gMessages.at(-11),
    "<all_urls>",
    "messagesModify"
  );
});

/**
 * Tests if scripts are correctly injected according to their runAt option.
 */
add_task(async function testRunAt() {
  const extension = ExtensionTestUtils.loadExtension({
    files: {
      "background.js": async () => {
        // Report script results.
        browser.runtime.onMessage.addListener((message, sender) => {
          if (message?.runAt) {
            window.sendMessage(`ScriptLoaded:${message.runAt}`, {
              senderTabId: sender.tab.id,
              ...message,
            });
          }
        });

        const registeredScripts = new Set();
        registeredScripts.add(
          await browser.messageDisplayScripts.register({
            runAt: "document_start",
            js: [{ file: "start.js" }],
          })
        );

        registeredScripts.add(
          await browser.messageDisplayScripts.register({
            runAt: "document_end",
            js: [{ file: "end.js" }],
          })
        );

        registeredScripts.add(
          await browser.messageDisplayScripts.register({
            runAt: "document_idle",
            js: [{ file: "idle.js" }],
          })
        );

        browser.test.onMessage.addListener(async message => {
          switch (message) {
            case "Unregister":
              for (const registeredScript of registeredScripts) {
                await registeredScript.unregister();
              }
              browser.test.notifyPass("finished");
              break;
          }
        });

        browser.test.sendMessage("Ready");
      },
      "start.js": () => {
        browser.runtime.sendMessage({
          runAt: "document_start",
          readyState: document?.readyState,
          document: !!document,
          body: !!document?.body,
          textContent:
            document.querySelector(".moz-text-flowed")?.textContent ?? "",
        });
      },
      "end.js": () => {
        browser.runtime.sendMessage({
          runAt: "document_end",
          readyState: document?.readyState,
          document: !!document,
          body: !!document?.body,
          textContent:
            document.querySelector(".moz-text-flowed")?.textContent ?? "",
        });
      },
      "idle.js": () => {
        browser.runtime.sendMessage({
          runAt: "document_idle",
          readyState: document?.readyState,
          document: !!document,
          body: !!document?.body,
          textContent:
            document.querySelector(".moz-text-flowed")?.textContent ?? "",
        });
      },
      "utils.js": await getUtilsJS(),
    },
    manifest: {
      background: { scripts: ["utils.js", "background.js"] },
      permissions: ["messagesModify", "<all_urls>"],
    },
  });

  gDefaultAbout3Pane.threadTree.selectedIndex = 2;
  await awaitBrowserLoaded(gDefaultMessagePane);

  extension.startup();
  await extension.awaitMessage("Ready");

  function verifyResult(result, expected_individual) {
    const expected_standard = [
      {
        runAt: "document_start",
        readyState: "loading",
        document: true,
        body: false,
      },
      {
        runAt: "document_end",
        readyState: "interactive",
        document: true,
        body: true,
      },
      {
        runAt: "document_idle",
        readyState: "complete",
        document: true,
        body: true,
      },
    ];
    for (let i = 0; i < result.length; i++) {
      Assert.equal(
        expected_standard[i].runAt,
        result[i].runAt,
        `The 'runAt' value for state #${i} should be correct`
      );
      Assert.equal(
        expected_standard[i].readyState,
        result[i].readyState,
        `The 'readyState' value at state #${i} should be correct`
      );
      Assert.equal(
        expected_standard[i].document,
        result[i].document,
        `The document element at state #${i} ${
          expected_standard[i].document ? "should" : "should not"
        } exist`
      );
      Assert.equal(
        expected_standard[i].body,
        result[i].body,
        `The body element at state #${i} ${
          expected_standard[i].body ? "should" : "should not"
        } exist`
      );
      Assert.equal(
        expected_individual[i].textContent.trim(),
        result[i].textContent.trim(),
        `The content at state #${i} should be correct`
      );
    }
  }

  // Select a new message.
  const firstLoadPromise = Promise.all([
    extension.awaitMessage("ScriptLoaded:document_start"),
    extension.awaitMessage("ScriptLoaded:document_end"),
    extension.awaitMessage("ScriptLoaded:document_idle"),
  ]);
  gDefaultAbout3Pane.threadTree.selectedIndex = 3;
  verifyResult(await firstLoadPromise, [
    { textContent: "" },
    { textContent: "Hello Pete Price!" },
    { textContent: "Hello Pete Price!" },
  ]);

  // Select a different message.
  const secondLoadPromise = Promise.all([
    extension.awaitMessage("ScriptLoaded:document_start"),
    extension.awaitMessage("ScriptLoaded:document_end"),
    extension.awaitMessage("ScriptLoaded:document_idle"),
  ]);
  gDefaultAbout3Pane.threadTree.selectedIndex = 4;
  verifyResult(await secondLoadPromise, [
    { textContent: "" },
    { textContent: "Hello Neil Nagel!" },
    { textContent: "Hello Neil Nagel!" },
  ]);

  // Open the message in a new tab.
  const thirdLoadPromise = Promise.all([
    extension.awaitMessage("ScriptLoaded:document_start"),
    extension.awaitMessage("ScriptLoaded:document_end"),
    extension.awaitMessage("ScriptLoaded:document_idle"),
  ]);
  const messageTab = await openMessageInTab(gMessages.at(-6));
  verifyResult(await thirdLoadPromise, [
    { textContent: "" },
    { textContent: "Hello Lilia Lowe!" },
    { textContent: "Hello Lilia Lowe!" },
  ]);
  Assert.equal(gDefaultTabmail.tabInfo.length, 2);

  // Open a content tab. The message display scripts should not be injected.
  // If they DO get injected, we will end up with 3 additional messages from the
  // extension and the test will fail.
  const contentTab = window.openContentTab("http://mochi.test:8888/");
  Assert.equal(gDefaultTabmail.tabInfo.length, 3);
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Closing this tab should bring us back to the message in a tab.
  gDefaultTabmail.closeTab(contentTab);
  Assert.equal(gDefaultTabmail.tabInfo.length, 2);
  Assert.equal(gDefaultTabmail.currentTabInfo, messageTab);

  // Open the message in a new window.
  const fourthLoadPromise = Promise.all([
    extension.awaitMessage("ScriptLoaded:document_start"),
    extension.awaitMessage("ScriptLoaded:document_end"),
    extension.awaitMessage("ScriptLoaded:document_idle"),
  ]);
  const newWindow = await openMessageInWindow(gMessages.at(-7));
  verifyResult(await fourthLoadPromise, [
    { textContent: "" },
    { textContent: "Hello Johnny Jones!" },
    { textContent: "Hello Johnny Jones!" },
  ]);

  // Unregister.
  extension.sendMessage("Unregister");
  await extension.awaitFinish("finished");
  await extension.unload();

  // Close the new tab.
  gDefaultTabmail.closeTab(messageTab);
  await BrowserTestUtils.closeWindow(newWindow);
});
