/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["chat/matrix-properties.ftl"], true)
);

// See https://matrix.org/docs/spec/client_server/r0.5.0#m-room-power-levels
export var MatrixPowerLevels = {
  user: 0,
  voice: 10,
  moderator: 50,
  admin: 100,
  /**
   * Turns a power level into a human readable string.
   * Only exactly matching level names are returned, except for restricted
   * power levels.
   *
   * @param {number} powerLevel - Power level to format.
   * @param {number} [defaultLevel=0] - The default power level in the room.
   * @returns {string} Representation of the power level including the raw level.
   */
  toText(powerLevel, defaultLevel = MatrixPowerLevels.user) {
    let levelName = lazy.l10n.formatValueSync("power-level-custom");
    if (powerLevel == MatrixPowerLevels.admin) {
      levelName = lazy.l10n.formatValueSync("power-level-admin");
    } else if (powerLevel == MatrixPowerLevels.moderator) {
      levelName = lazy.l10n.formatValueSync("power-level-moderator");
    } else if (powerLevel < defaultLevel) {
      levelName = lazy.l10n.formatValueSync("power-level-restricted");
    } else if (powerLevel == defaultLevel) {
      levelName = lazy.l10n.formatValueSync("power-level-default");
    }
    return lazy.l10n.formatValueSync("power-level-detailed", {
      powerLevelName: levelName,
      powerLevelNumber: powerLevel,
    });
  },
  /**
   * @param {object} powerLevels - m.room.power_levels event contents.
   * @param {string} key - Power level key to get.
   * @returns {number} The power level if given in the event, else 0.
   */
  _getDefaultLevel(powerLevels, key) {
    const fullKey = `${key}_default`;
    if (Number.isSafeInteger(powerLevels?.[fullKey])) {
      return powerLevels[fullKey];
    }
    return 0;
  },
  /**
   * @param {object} powerLevels - m.room.power_levels event contents.
   * @returns {number} The default power level of users in the room.
   */
  getUserDefaultLevel(powerLevels) {
    return this._getDefaultLevel(powerLevels, "users");
  },
  /**
   *
   * @param {object} powerLevels - m.room.power_levels event contents.
   * @returns {number} The default power level required to send events in the
   *  room.
   */
  getEventDefaultLevel(powerLevels) {
    return this._getDefaultLevel(powerLevels, "events");
  },
  /**
   *
   * @param {object} powerLevels - m.room.power_levels event contents.
   * @param {string} event - Event ID to get the required power level for.
   * @returns {number} The power level required to send this event in the room.
   */
  getEventLevel(powerLevels, event) {
    if (Number.isSafeInteger(powerLevels?.events?.[event])) {
      return powerLevels.events[event];
    }
    return this.getEventDefaultLevel(powerLevels);
  },
};
