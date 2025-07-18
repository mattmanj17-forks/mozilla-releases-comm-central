/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

"use strict";

var { EnigmailDialog } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/dialog.sys.mjs"
);
var { EnigmailKey } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/key.sys.mjs"
);
var { EnigmailKeyRing } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/keyRing.sys.mjs"
);
var { EnigmailArmor } = ChromeUtils.importESModule(
  "chrome://openpgp/content/modules/armor.sys.mjs"
);
var { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);

var l10n = new Localization(["messenger/openpgp/openpgp.ftl"], true);

/**
 * opens a prompt, asking the user to enter passphrase for given key id
 * returns: the passphrase if entered (empty string is allowed)
 * resultFlags.canceled is set to true if the user clicked cancel
 */
function passphrasePromptCallback(win, promptString, resultFlags) {
  const password = { value: "" };
  if (!Services.prompt.promptPassword(win, "", promptString, password)) {
    resultFlags.canceled = true;
    return "";
  }

  resultFlags.canceled = false;
  return password.value;
}

/**
 * @param {nsIFile} file
 * @param {boolean} wantSecret - Find private key block if true, public if false.
 * @returns {string} The first block of the wanted type, or empty string.
 *   Skip blocks of wrong type.
 */
async function getKeyBlockFromFile(file, wantSecret) {
  const contents = await IOUtils.readUTF8(file.path).catch(() => "");
  return getKeyBlock(contents, wantSecret);
}

/**
 * @param {string} contents
 * @param {boolean} wantSecret - Find private key block if true, public if false.
 * @returns {string} The first block of the wanted type, or empty string.
 *   Skip blocks of wrong type.
 */
function getKeyBlock(contents, wantSecret) {
  let searchOffset = 0;

  while (searchOffset < contents.length) {
    const beginIndexObj = {};
    const endIndexObj = {};
    const blockType = EnigmailArmor.locateArmoredBlock(
      contents,
      searchOffset,
      "",
      beginIndexObj,
      endIndexObj,
      {}
    );
    if (!blockType) {
      return "";
    }

    if (
      (wantSecret && blockType.search(/^PRIVATE KEY BLOCK$/) !== 0) ||
      (!wantSecret && blockType.search(/^PUBLIC KEY BLOCK$/) !== 0)
    ) {
      searchOffset = endIndexObj.value;
      continue;
    }

    return contents.substr(
      beginIndexObj.value,
      endIndexObj.value - beginIndexObj.value + 1
    );
  }
  return "";
}

/**
 * import OpenPGP keys from file
 *
 * @param {string} what - "rev" for revocation, "pub" for public keys
 */
async function EnigmailCommon_importObjectFromFile(what) {
  if (what != "rev" && what != "pub") {
    throw new Error(`Can't import. Invalid argument: ${what}`);
  }

  const title = l10n.formatValueSync(
    what == "rev" ? "import-rev-file" : "import-key-file"
  );
  const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  fp.init(window.browsingContext, title, Ci.nsIFilePicker.modeOpenMultiple);
  fp.defaultExtension = "*.asc";
  fp.appendFilter(l10n.formatValueSync("gnupg-file"), "*.asc;*.gpg;*.pgp");
  fp.appendFilters(Ci.nsIFilePicker.filterAll);
  const rv = await new Promise(resolve => fp.open(resolve));
  if (rv != Ci.nsIFilePicker.returnOK || !fp.files) {
    return;
  }

  for (const file of fp.files) {
    if (file.fileSize > 5000000) {
      document.l10n.formatValue("file-to-big-to-import").then(value => {
        Services.prompt.alert(window, null, value);
      });
      continue;
    }

    if (what == "rev") {
      await EnigmailKeyRing.importRevFromFile(file);
      continue;
    }

    let importBinary = false;
    let keyBlock = await getKeyBlockFromFile(file, false);

    // if we don't find an ASCII block, try to import as binary.
    if (!keyBlock) {
      importBinary = true;
      const data = await IOUtils.read(file.path);
      keyBlock = MailStringUtils.uint8ArrayToByteString(data);
    }

    const errorMsgObj = {};
    // Generate a preview of the imported key.
    const preview = await EnigmailKey.getKeyListFromKeyBlock(
      keyBlock,
      errorMsgObj,
      true, // interactive
      true,
      false // not secret
    );

    if (!preview || !preview.length || errorMsgObj.value) {
      document.l10n.formatValue("import-keys-failed").then(value => {
        Services.prompt.alert(window, null, value + "\n\n" + errorMsgObj.value);
      });
      continue;
    }

    const acceptance = EnigmailDialog.confirmPubkeyImport(window, preview);
    if (!acceptance) {
      return;
    }

    const resultKeys = {};
    const importExitCode = await EnigmailKeyRing.importKeyAsync(
      window,
      false, // interactive, we already asked for confirmation
      keyBlock,
      importBinary,
      null, // expected keyId, ignored
      errorMsgObj,
      resultKeys,
      false, // minimize
      [], // filter
      acceptance
    );

    if (importExitCode !== 0) {
      document.l10n.formatValue("import-keys-failed").then(value => {
        Services.prompt.alert(window, null, value + "\n\n" + errorMsgObj.value);
      });
      continue;
    }

    EnigmailDialog.keyImportDlg(window, resultKeys.value);
  }
}
