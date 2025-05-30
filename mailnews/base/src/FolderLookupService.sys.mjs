/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This module implements the folder lookup service (nsIFolderLookupService).
 */

// This ensures that the service is only created once.
var gCreated = false;

/**
 * FolderLookupService maintains an index of folders and provides
 * lookup by folder URI.
 *
 * @class
 */
export function FolderLookupService() {
  if (gCreated) {
    throw Components.Exception("", Cr.NS_ERROR_ALREADY_INITIALIZED);
  }
  this._map = new Map();
  gCreated = true;
}

FolderLookupService.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIFolderLookupService"]),

  /**
   * Fetch the folder corresponding to the given URI.
   * Will only return folders which already exist and have a parent. If this
   * not the case then null is returned.
   *
   * @param {string} uri - URI of folder to get.
   * @returns {nsIMsgFolder|null}
   */
  getFolderForURL(uri) {
    let folder = this._getExisting(uri);

    if (folder && !this._isValidFolder(folder)) {
      folder = null; // no dangling folders!
    }
    return folder;
  },

  /**
   * Internal helper to create a new folder given a URL and place it
   * in the cache. The newly created folder will be dangling and
   * needs to be parented by a calling function.
   *
   * @param {string} uri - The URI of the folder to create.
   */
  _createDangling(uri) {
    if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      throw new Error("refusing to create a folder object for " + uri);
    }

    // Create new folder.

    // Check that uri has an active scheme, in case this folder is from
    // an extension that is currently disabled or hasn't started up yet.
    const schemeMatch = uri.match(/^([-+.\w]+):/);
    if (!schemeMatch) {
      return null;
    }
    const scheme = schemeMatch[1];
    const contractID = "@mozilla.org/mail/folder-factory;1?name=" + scheme;
    if (!(contractID in Cc)) {
      console.error(
        "getOrCreateFolderForURL: factory not registered for " + uri
      );
      return null;
    }

    const factory = Components.manager.getClassObject(
      Cc[contractID],
      Ci.nsIFactory
    );
    if (!factory) {
      console.error(
        "getOrCreateFolderForURL: failed to get factory for " + uri
      );
      return null;
    }

    const folder = factory.createInstance(Ci.nsIMsgFolder);
    if (folder) {
      folder.Init(uri);
      // Add the new folder to our map. Store a weak reference instead, so that
      // the folder can be closed when necessary.
      const weakRef = folder
        .QueryInterface(Ci.nsISupportsWeakReference)
        .GetWeakReference();
      this._map.set(uri, weakRef);
    }

    return folder;
  },

  /**
   * Return a newly created folder as a subfolder of the given parent folder.
   *
   * @param {nsIMsgFolder} parentFolder - The parent folder.
   * @param {string} name - The URL encoded name of the folder to create.
   *
   * @returns {nsIMsgFolder} The newly created folder.
   */
  createFolderAndCache(parentFolder, name) {
    if (!parentFolder) {
      throw new Components.Exception(
        "invalid parent folder",
        Cr.NS_ERROR_INVALID_ARG
      );
    }

    // Make sure the parent folder is already cached.
    if (!this._getExisting(parentFolder.URI)) {
      throw new Components.Exception(
        "invalid parent folder",
        Cr.NS_ERROR_INVALID_ARG
      );
    }

    // Construct the URI for the new folder given the parent folder's URI.
    const uri = parentFolder.URI + "/" + name;

    // If we already have a folder in the cache for this URI, then return it.
    // NOTE: The proper thing to do here is to fail if we're trying to create a
    // folder that already exists and force management of the cache. However,
    // the cache currently also has the side effect of enforcing identity
    // equality by pointer for folders with the same URI, which is relied upon
    // throughout the codebase. This function is still an improvement over
    // `getOrCreateFromURL` because it enforces that folders all have a valid
    // parent folder, so they can't dangle. This also has the side effect of
    // maintaining any previously existing flags, but again, the code relies on
    // that maintenance.
    const folder = this._getExisting(uri) ?? this._createDangling(uri);

    // If there is no folder at this point, that means we failed to create
    // the dangling folder, return an error.
    if (!folder) {
      throw new Components.Exception(
        "Failed to create folder.",
        Cr.NS_ERROR_FAILURE
      );
    }

    // If the existing folder object has a parent, make sure it's the same parent.
    if (folder.parent && folder.parent != parentFolder) {
      throw new Components.Exception(
        `Folder ${name} cached parent is not the same as the provided parent`,
        Cr.NS_ERROR_INVALID_ARG
      );
    }

    // Either the folder existed and had the correct parent or was dangling, or
    // we created a dangling folder.  Either way, it needs its parent assigned.
    folder.parent = parentFolder;

    return folder;
  },

  /**
   * Fetch the folder corresponding to the given URI, creating it if it does
   * not exist. If the folder is created, it will be a "dangling" folder,
   * without a parent and not part of a normal folder hierarchy.
   * A lot of code relies on this behaviour, but for new code this
   * call should be avoided.
   *
   * @param {string} uri - URI of folder to get.
   * @returns {nsIMsgFolder}
   */
  getOrCreateFolderForURL(uri) {
    const folder = this._getExisting(uri);

    if (folder?.server?.type) {
      // The folder object exists and it has a server with a type,
      // indicating that the server hasn't been removed.
      return folder;
    }

    return this._createDangling(uri);
  },

  /**
   * Store a folder in the service's cache. This is used by the new database
   * because creating a new folder by URI is not allowed.
   *
   * Only for use when mail.panorama.enabled is true!
   *
   * @param {string} url - The folder URL.
   * @param {nsIMsgFolder} folder - The folder to cache.
   */
  cache(url, folder) {
    if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      throw new Components.Exception(
        "nsIFolderLookupService.cache must not be used when Panorama is not enabled.",
        Cr.NS_ERROR_FAILURE
      );
    }
    const weakRef = folder
      .QueryInterface(Ci.nsISupportsWeakReference)
      .GetWeakReference();
    this._map.set(url, weakRef);
  },

  // "private" stuff starts here.

  /**
   * Internal helper to find a folder (which may or may not be dangling).
   *
   * @param {string} uri - URI of folder to look up.
   *
   * @returns {nsIMsgFolder|null} The folder, if in the index, else null.
   */
  _getExisting(uri) {
    let folder = null;
    // already created?
    if (this._map.has(uri)) {
      try {
        folder = this._map.get(uri).QueryReferent(Ci.nsIMsgFolder);
      } catch (e) {
        // The object was deleted, so we can drop it.
        this._map.delete(uri);
      }
    }
    return folder;
  },

  /**
   * Internal helper function to test if a folder is dangling or parented.
   * Because we can return folders that don't exist, and we may be working
   * with a deleted folder but we're still holding on to the reference. For
   * valid folders, one of two scenarios is true: either the folder has a parent
   * (the deletion code clears the parent to indicate its nonvalidity), or the
   * folder is a root folder of some server. Getting the root folder may throw
   * an exception if we attempted to create a server that doesn't exist, so we
   * need to guard for that error.
   *
   * @returns {boolean} true if folder valid (and parented).
   */
  _isValidFolder(folder) {
    try {
      return folder.parent != null || folder.rootFolder == folder;
    } catch (e) {
      return false;
    }
  },
};
