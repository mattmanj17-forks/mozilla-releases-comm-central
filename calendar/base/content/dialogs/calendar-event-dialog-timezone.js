/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global addMenuItem */ // From  ../calendar-ui-utils.js

var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

window.addEventListener("load", onLoad);

/**
 * Sets up the timezone dialog from the window arguments, also setting up all
 * dialog controls from the window's dates.
 */
function onLoad() {
  const args = window.arguments[0];
  window.time = args.time;
  window.onAcceptCallback = args.onOk;

  let menulist = document.getElementById("timezone-menulist");
  const tzMenuPopup = document.getElementById("timezone-menupopup");

  // floating and UTC (if supported) at the top:
  if (args.calendar.getProperty("capabilities.timezones.floating.supported") !== false) {
    addMenuItem(tzMenuPopup, cal.dtz.floating.displayName, cal.dtz.floating.tzid);
  }
  if (args.calendar.getProperty("capabilities.timezones.UTC.supported") !== false) {
    addMenuItem(tzMenuPopup, cal.dtz.UTC.displayName, cal.dtz.UTC.tzid);
  }

  const tzids = {};
  const displayNames = [];
  for (const timezoneId of cal.timezoneService.timezoneIds) {
    const timezone = cal.timezoneService.getTimezone(timezoneId);
    if (timezone && !timezone.isFloating && !timezone.isUTC) {
      const displayName = timezone.displayName;
      displayNames.push(displayName);
      tzids[displayName] = timezone.tzid;
    }
  }
  // the display names need to be sorted
  displayNames.sort((a, b) => a.localeCompare(b));
  for (let i = 0; i < displayNames.length; ++i) {
    const displayName = displayNames[i];
    addMenuItem(tzMenuPopup, displayName, tzids[displayName]);
  }

  let index = findTimezone(window.time.timezone);
  if (index < 0) {
    index = findTimezone(cal.dtz.defaultTimezone);
    if (index < 0) {
      index = 0;
    }
  }

  menulist = document.getElementById("timezone-menulist");
  menulist.selectedIndex = index;

  updateTimezone();

  opener.setCursor("auto");
}

/**
 * Find the index of the timezone menuitem corresponding to the given timezone.
 *
 * @param {calITimezone} timezone - The calITimezone to look for.
 * @returns {integer} The index of the childnode below "timezone-menulist".
 */
function findTimezone(timezone) {
  const tzid = timezone.tzid;
  const menulist = document.getElementById("timezone-menulist");
  const numChilds = menulist.children[0].children.length;
  for (let i = 0; i < numChilds; i++) {
    const menuitem = menulist.children[0].children[i];
    if (menuitem.getAttribute("value") == tzid) {
      return i;
    }
  }
  return -1;
}

/**
 * Handler function to call when the timezone selection has changed. Updates the
 * timezone-time field and the timezone-stack.
 */
function updateTimezone() {
  const menulist = document.getElementById("timezone-menulist");
  const menuitem = menulist.selectedItem;
  const timezone = cal.timezoneService.getTimezone(menuitem.getAttribute("value"));

  // convert the date/time to the currently selected timezone
  // and display the result in the appropriate control.
  // before feeding the date/time value into the control we need
  // to set the timezone to 'floating' in order to avoid the
  // automatic conversion back into the OS timezone.
  const datetime = document.getElementById("timezone-time");
  const time = window.time.getInTimezone(timezone);
  time.timezone = cal.dtz.floating;
  datetime.value = cal.dtz.dateTimeToJsDate(time);

  // don't highlight any timezone in the map by default
  let standardTZOffset = "none";
  if (timezone.isUTC) {
    standardTZOffset = "+0000";
  } else if (!timezone.isFloating) {
    const standard = timezone.icalComponent.getFirstSubcomponent("STANDARD");
    // any reason why valueAsIcalString is used instead of plain value? xxx todo: ask mickey
    standardTZOffset = standard.getFirstProperty("TZOFFSETTO").valueAsIcalString;
  }

  const image = document.getElementById("highlighter");
  image.setAttribute("tzid", standardTZOffset);
}

/**
 * Handler function to be called when the accept button is pressed.
 */
document.addEventListener("dialogaccept", () => {
  const menulist = document.getElementById("timezone-menulist");
  const menuitem = menulist.selectedItem;
  const timezoneString = menuitem.getAttribute("value");
  const timezone = cal.timezoneService.getTimezone(timezoneString);
  const datetime = window.time.getInTimezone(timezone);
  window.onAcceptCallback(datetime);
});
