/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// See browser/components/extensions/ExtensionBrowsingData.sys.mjs

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "makeRange", () => {
  const { ExtensionParent } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionParent.sys.mjs"
  );
  // Defined in ext-browsingData.js
  return ExtensionParent.apiManager.global.makeRange;
});

ChromeUtils.defineESModuleGetters(lazy, {
  // TODO: Sanitizer.sys.mjs doesn't exist for Thunderbird.
  // If we start using BrowsingDataDelegate we need this too.
  Sanitizer: "resource:///modules/Sanitizer.sys.mjs",
});

export class BrowsingDataDelegate {
  // Unused for now
  constructor() {}

  // This method returns undefined for all data types that are _not_ handled by
  // this delegate.
  handleRemoval(dataType, options) {
    switch (dataType) {
      case "downloads":
        return lazy.Sanitizer.items.downloads.clear(lazy.makeRange(options));
      case "formData":
        return lazy.Sanitizer.items.formdata.clear(lazy.makeRange(options));
      case "history":
        return lazy.Sanitizer.items.history.clear(lazy.makeRange(options));

      default:
        return undefined;
    }
  }

  settings() {
    const PREF_DOMAIN = "privacy.cpd.";
    // The following prefs are the only ones in Firefox that match corresponding
    // values used by Chrome when rerturning settings.
    const PREF_LIST = ["cache", "cookies", "history", "formdata", "downloads"];

    // since will be the start of what is returned by Sanitizer.getClearRange
    // divided by 1000 to convert to ms.
    // If Sanitizer.getClearRange returns undefined that means the range is
    // currently "Everything", so we should set since to 0.
    const clearRange = lazy.Sanitizer.getClearRange();
    const since = clearRange ? clearRange[0] / 1000 : 0;
    const options = { since };

    const dataToRemove = {};
    const dataRemovalPermitted = {};

    for (const item of PREF_LIST) {
      // The property formData needs a different case than the
      // formdata preference.
      const name = item === "formdata" ? "formData" : item;
      dataToRemove[name] = Services.prefs.getBoolPref(`${PREF_DOMAIN}${item}`);
      // Firefox doesn't have the same concept of dataRemovalPermitted
      // as Chrome, so it will always be true.
      dataRemovalPermitted[name] = true;
    }

    return Promise.resolve({
      options,
      dataToRemove,
      dataRemovalPermitted,
    });
  }
}
