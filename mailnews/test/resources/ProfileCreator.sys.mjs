/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** @type {nsIFile} */
let profileDirectory;

/**
 * A tool for creating the files and folders of a profile without starting up
 * many of components (e.g. the account manager) that would otherwise be
 * necessary. This can be used to test that profile migration happens correctly.
 */
export class ProfileCreator {
  /**
   * The absolute file system path to this profile.
   *
   * @type {string}
   */
  path;

  /**
   * @param {nsIFile} directory - Pass `do_get_profile()` to this constructor.
   */
  constructor(directory) {
    profileDirectory = directory;
    this.path = directory.path;
  }

  /**
   * Set up the preferences for an account and server.
   * See `nsIMsgAccountManager.createIncomingServer`.
   *
   * @param {string} username
   * @param {string} hostname
   * @param {string} type
   * @returns {ProfileServer}
   */
  addServer(username, hostname, type) {
    return new ProfileServer(username, hostname, type);
  }

  /**
   * Set up the preferences for a local account.
   *
   * @returns {ProfileServer}
   */
  addLocalServer() {
    return this.addServer("nobody", "Local Folders", "none");
  }

  /**
   * Add a file to the profile.
   *
   * @param {string} relativePath - The file's path relative to the profile root.
   * @param {string} [content=""]
   */
  async addFile(relativePath, content = "") {
    await IOUtils.writeUTF8(PathUtils.join(this.path, relativePath), content);
  }
}

/**
 * Represents a server in the profile. In this code, accounts are tied to
 * servers for the sake of simplicity.
 */
class ProfileServer {
  /** @type {integer} */
  static #nextKey = 1;
  /** @type {ProfileMailFolder} */
  rootFolder;
  /** @type {nsIPrefBranch} */
  prefBranch;

  /**
   * Set up the preferences for an account and server.
   * See `nsIMsgAccountManager.createIncomingServer`.
   *
   * @param {string} username
   * @param {string} hostname
   * @param {string} type
   * @returns {ProfileServer}
   */
  constructor(username, hostname, type) {
    const key = ProfileServer.#nextKey++;
    Services.prefs.setStringPref(
      `mail.account.account${key}.server`,
      `server${key}`
    );
    let accounts = Services.prefs.getStringPref(
      "mail.accountmanager.accounts",
      ""
    );
    if (accounts) {
      accounts += ",";
    }
    Services.prefs.setStringPref(
      "mail.accountmanager.accounts",
      `${accounts}account${key}`
    );
    this.prefBranch = Services.prefs.getBranch(`mail.server.server${key}.`);
    this.prefBranch.setStringPref("userName", username);
    this.prefBranch.setStringPref("hostname", hostname);
    this.prefBranch.setStringPref("type", type);
    const mailFolderName = type == "imap" ? "ImapMail" : "Mail";
    this.prefBranch.setStringPref(
      "directory-rel",
      `[ProfD]${mailFolderName}/${hostname}`
    );
    const prefsFile = profileDirectory.clone();
    prefsFile.append("prefs.js");
    Services.prefs.savePrefFile(prefsFile);

    this.rootFolder = new ProfileMailFolder(
      this,
      Services.prefs.getComplexValue(
        `mail.server.server${key}.directory-rel`,
        Ci.nsIRelativeFilePref
      ).file.path
    );
  }

  /**
   * @type {boolean}
   */
  get isMaildirStore() {
    return (
      this.prefBranch.getStringPref("storeContractID", "") ==
      "@mozilla.org/msgstore/maildirstore;1"
    );
  }

  set isMaildirStore(value) {
    this.prefBranch.setStringPref(
      "storeContractID",
      value
        ? "@mozilla.org/msgstore/maildirstore;1"
        : "@mozilla.org/msgstore/berkeleystore;1"
    );
  }
}

/**
 * Represents a mail folder in the profile.
 */
class ProfileMailFolder {
  /** @type {ProfileServer} */
  server;
  /**
   * The absolute file system path to the directory (.sbd) for this folder in
   * the profile.
   *
   * @type {string}
   */
  path;
  /**
   * The absolute file system path to the mail summary file (.msf) for this
   * folder in the profile.
   *
   * @type {string}
   */
  summaryFilePath;
  /**
   * The absolute file system path to the mail (mbox file or maildir directory)
   * for this folder in the profile.
   *
   * @type {string}
   */
  mailFilePath;

  /**
   * @param {ProfileServer} server
   * @param {string} path - Absolute file system path.
   */
  constructor(server, path) {
    this.server = server;
    this.path = path;
    const dirName = PathUtils.parent(path);
    const leafName = PathUtils.filename(path).replace(/\.sbd$/, "");
    this.summaryFilePath = PathUtils.join(dirName, `${leafName}.msf`);
    this.mailFilePath = PathUtils.join(dirName, leafName);
  }

  /**
   * Adds a child folder to this folder.
   *
   * @param {string} name
   * @param {object} files
   * @param {nsIFile} [files.summary] - If given, a file to copy into the
   *   profile as the folder's summary.
   * @param {nsIFile} [files.mbox] - If given (and not in a maildir server),
   *   a file to copy into the profile as the folder's mbox.
   * @returns {ProfileMailFolder}
   */
  async addMailFolder(name, { summary, mbox } = {}) {
    await IOUtils.makeDirectory(this.path);

    const folder = new ProfileMailFolder(
      this.server,
      PathUtils.join(this.path, `${name}.sbd`)
    );

    if (summary instanceof Ci.nsIFile) {
      await IOUtils.copy(summary.path, folder.summaryFilePath);
    }

    if (this.server.isMaildirStore) {
      await IOUtils.makeDirectory(folder.mailFilePath);
    } else if (mbox instanceof Ci.nsIFile) {
      await IOUtils.copy(mbox.path, folder.mailFilePath);
    } else {
      await IOUtils.writeUTF8(folder.mailFilePath, "");
    }
    return folder;
  }
}
