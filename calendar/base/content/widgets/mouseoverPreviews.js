/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Code which generates event and task (todo) preview tooltips/titletips
 *  when the mouse hovers over either the event list, the task list, or
 *  an event or task box in one of the grid views.
 *
 *   (Portions of this code were previously in calendar.js and unifinder.js,
 *   some of it duplicated.)
 */

/* exported onMouseOverItem, showToolTip, getPreviewForItem,
            getEventStatusString, getToDoStatusString */

/* import-globals-from ../calendar-ui-utils.js */

/**
 * PUBLIC: This changes the mouseover preview based on the start and end dates
 * of an occurrence of a (one-time or recurring) calEvent or calToDo.
 * Used by all grid views.
 */

var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
var lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["calendar/calendar.ftl"], true));

/**
 * PUBLIC: Displays a tooltip with details when hovering over an item in the views
 *
 * @param   {DOMEvent} occurrenceBoxMouseEvent  the triggering event
 * @returns {boolean} true, if the tooltip is displayed
 */
function onMouseOverItem(occurrenceBoxMouseEvent) {
  if ("occurrence" in occurrenceBoxMouseEvent.currentTarget) {
    // occurrence of repeating event or todo
    const occurrence = occurrenceBoxMouseEvent.currentTarget.occurrence;
    const toolTip = document.getElementById("itemTooltip");
    return showToolTip(toolTip, occurrence);
  }
  return false;
}

/**
 * Displays a tooltip for a given item.
 *
 * @param {Node} aToolTip - The node to hold the tooltip
 * @param {calIEvent|calIToDo} aItem - he item to create the tooltip for
 * @returns {boolean} true, if the tooltip is displayed
 */
function showToolTip(aToolTip, aItem) {
  if (aItem) {
    const holderBox = getPreviewForItem(aItem);
    if (holderBox) {
      while (aToolTip.lastChild) {
        aToolTip.lastChild.remove();
      }
      aToolTip.appendChild(holderBox);
      return true;
    }
  }
  return false;
}

/**
 * PUBLIC:  Called when a user hovers over a todo element and the text for the
 * mouse over is changed.
 *
 * @param {calIToDo} aItem - The item to create the preview for.
 * @param {boolean} [aIsTooltip=true] - Enabled if used for tooltip composition.
 */
function getPreviewForItem(aItem, aIsTooltip = true) {
  if (aItem.isEvent()) {
    return getPreviewForEvent(aItem, aIsTooltip);
  } else if (aItem.isTodo()) {
    return getPreviewForTask(aItem, aIsTooltip);
  }
  return null;
}

/**
 * PUBLIC: Returns the string for status (none), Tentative, Confirmed, or
 * Cancelled for a given event
 *
 * @param {calIEvent} aEvent - The event
 * @returns {string} The string for the status property of the event.
 */
function getEventStatusString(aEvent) {
  switch (aEvent.status) {
    // Event status value keywords are specified in RFC2445sec4.8.1.11
    case "TENTATIVE":
      return lazy.l10n.formatValueSync("status-tentative");
    case "CONFIRMED":
      return lazy.l10n.formatValueSync("status-confirmed");
    case "CANCELLED":
      return lazy.l10n.formatValueSync("event-status-cancelled");
    default:
      return "";
  }
}

/**
 * Returns the string for status (none), NeedsAction, InProcess,
 * Cancelled, orCompleted for a given ToDo
 *
 * @param {calIToDo} aToDo - The ToDo
 * @returns {string} The string for the status property of the event.
 */
function getToDoStatusString(aToDo) {
  switch (aToDo.status) {
    // Todo status keywords are specified in RFC2445sec4.8.1.11
    case "NEEDS-ACTION":
      return lazy.l10n.formatValueSync("status-needs-action");
    case "IN-PROCESS":
      return lazy.l10n.formatValueSync("status-in-process");
    case "CANCELLED":
      return lazy.l10n.formatValueSync("todo-status-cancelled");
    case "COMPLETED":
      return lazy.l10n.formatValueSync("status-completed");
    default:
      return "";
  }
}

/**
 * PRIVATE: Called when a user hovers over a todo element and the text for the
 * mouse overis changed.
 *
 * @param {calIToDo} toDoItem - The item to create the preview for.
 * @param {boolean} [aIsTooltip=true] - Enable if used for tooltip composition.
 */
function getPreviewForTask(toDoItem, aIsTooltip = true) {
  if (toDoItem) {
    const vbox = document.createXULElement("vbox");
    vbox.setAttribute("class", "tooltipBox");
    if (aIsTooltip) {
      // tooltip appears above or below pointer, so may have as little as
      // one half the screen height available (avoid top going off screen).
      vbox.style.maxHeight = Math.floor(screen.height / 2);
    } else {
      vbox.setAttribute("flex", "1");
    }
    boxInitializeHeaderTable(vbox);

    let hasHeader = false;

    if (toDoItem.title) {
      boxAppendLabeledText(vbox, "tooltip-title", toDoItem.title);
      hasHeader = true;
    }

    const location = toDoItem.getProperty("LOCATION");
    if (location) {
      boxAppendLabeledText(vbox, "tooltip-location", location);
      hasHeader = true;
    }

    // First try to get calendar name appearing in tooltip
    if (toDoItem.calendar.name) {
      const calendarNameString = toDoItem.calendar.name;
      boxAppendLabeledText(vbox, "tooltip-cal-name", calendarNameString);
    }

    if (toDoItem.entryDate && toDoItem.entryDate.isValid) {
      boxAppendLabeledDateTime(vbox, "tooltip-start", toDoItem.entryDate);
      hasHeader = true;
    }

    if (toDoItem.dueDate && toDoItem.dueDate.isValid) {
      boxAppendLabeledDateTime(vbox, "tooltip-due", toDoItem.dueDate);
      hasHeader = true;
    }

    if (toDoItem.priority && toDoItem.priority != 0) {
      const priorityInteger = parseInt(toDoItem.priority, 10);
      let priorityString;

      // These cut-offs should match calendar-event-dialog.js
      if (priorityInteger >= 1 && priorityInteger <= 4) {
        priorityString = lazy.l10n.formatValueSync("high-priority");
      } else if (priorityInteger == 5) {
        priorityString = lazy.l10n.formatValueSync("normal-priority");
      } else {
        priorityString = lazy.l10n.formatValueSync("low-priority");
      }
      boxAppendLabeledText(vbox, "tooltip-priority", priorityString);
      hasHeader = true;
    }

    if (toDoItem.status && toDoItem.status != "NONE") {
      const status = getToDoStatusString(toDoItem);
      boxAppendLabeledText(vbox, "tooltip-status", status);
      hasHeader = true;
    }

    if (
      toDoItem.status != null &&
      toDoItem.percentComplete != 0 &&
      toDoItem.percentComplete != 100
    ) {
      boxAppendLabeledText(vbox, "tooltip-percent", String(toDoItem.percentComplete) + "%");
      hasHeader = true;
    } else if (toDoItem.percentComplete == 100) {
      if (toDoItem.completedDate == null) {
        boxAppendLabeledText(vbox, "tooltip-percent", "100%");
      } else {
        boxAppendLabeledDateTime(vbox, "tooltip-completed", toDoItem.completedDate);
      }
      hasHeader = true;
    }

    const description = toDoItem.descriptionText;
    if (description) {
      // display wrapped description lines like body of message below headers
      if (hasHeader) {
        boxAppendBodySeparator(vbox);
      }
      boxAppendBody(vbox, description, aIsTooltip);
    }

    return vbox;
  }
  return null;
}

/**
 * PRIVATE: Called when mouse moves over a different, or  when mouse moves over
 * event in event list. The instStartDate is date of instance displayed at event
 * box (recurring or multiday events may be displayed by more than one event box
 * for different days), or null if should compute next instance from now.
 *
 * @param {calIEvent} aEvent - The item to create the preview for.
 * @param {boolean} [aIsTooltip=true] - Enable if used for tooltip composition.
 */
function getPreviewForEvent(aEvent, aIsTooltip = true) {
  let event = aEvent;
  const vbox = document.createXULElement("vbox");
  vbox.setAttribute("class", "tooltipBox");
  if (aIsTooltip) {
    // tooltip appears above or below pointer, so may have as little as
    // one half the screen height available (avoid top going off screen).
    vbox.maxHeight = Math.floor(screen.height / 2);
  } else {
    vbox.setAttribute("flex", "1");
  }
  boxInitializeHeaderTable(vbox);

  if (event) {
    if (event.title) {
      boxAppendLabeledText(vbox, "tooltip-title", aEvent.title);
    }

    const location = event.getProperty("LOCATION");
    if (location) {
      boxAppendLabeledText(vbox, "tooltip-location", location);
    }
    if (!(event.startDate && event.endDate)) {
      // Event may be recurrent event.   If no displayed instance specified,
      // use next instance, or previous instance if no next instance.
      event = getCurrentNextOrPreviousRecurrence(event);
    }
    boxAppendLabeledDateTimeInterval(vbox, "tooltip-date", event);

    // First try to get calendar name appearing in tooltip
    if (event.calendar.name) {
      const calendarNameString = event.calendar.name;
      boxAppendLabeledText(vbox, "tooltip-cal-name", calendarNameString);
    }

    if (event.status && event.status != "NONE") {
      const statusString = getEventStatusString(event);
      boxAppendLabeledText(vbox, "tooltip-status", statusString);
    }

    if (event.organizer && event.getAttendees().length > 0) {
      const organizer = event.organizer;
      boxAppendLabeledText(vbox, "tooltip-organizer", organizer);
    }

    const description = event.descriptionText;
    if (description) {
      boxAppendBodySeparator(vbox);
      // display wrapped description lines, like body of message below headers
      boxAppendBody(vbox, description, aIsTooltip);
    }
    return vbox;
  }
  return null;
}

/**
 * Append a separator, a thin space between header and body.
 *
 * @param {Node} vbox - Box to which to append separator.
 */
function boxAppendBodySeparator(vbox) {
  const separator = document.createXULElement("separator");
  separator.setAttribute("class", "tooltipBodySeparator");
  vbox.appendChild(separator);
}

/**
 * PRIVATE: Append description to box for body text. Rendered as HTML.
 * Indentation and line breaks are preserved.
 *
 * @param {Node} box - Box to which to append the body.
 * @param {string} textString - Text of the body.
 * @param {boolean} aIsTooltip - True for "tooltip" and false for "conflict-dialog" case.
 */
function boxAppendBody(box, textString, aIsTooltip) {
  const type = aIsTooltip ? "description" : "vbox";
  const elem = document.createXULElement(type);
  elem.classList.add("tooltipBody");
  elem.classList.toggle("notTooltip", !aIsTooltip);
  const docFragment = cal.view.textToHtmlDocumentFragment(textString, document);
  elem.appendChild(docFragment);
  box.appendChild(elem);
}

/**
 * PRIVATE: Use dateFormatter to format date and time,
 * and to header table append a row containing localized Label: date.
 *
 * @param {Node} box - The node to add the date label to.
 * @param {string} labelProperty - The label.
 * @param {calIDateTime} date - The datetime object to format and add.
 */
function boxAppendLabeledDateTime(box, labelProperty, date) {
  date = date.getInTimezone(cal.dtz.defaultTimezone);
  const formattedDateTime = cal.dtz.formatter.formatDateTime(date);
  boxAppendLabeledText(box, labelProperty, formattedDateTime);
}

/**
 * PRIVATE: Use dateFormatter to format date and time interval,
 * and to header table append a row containing localized Label: interval.
 *
 * @param {Node} box - Contains header table.
 * @param {string} labelProperty - Name of property for localized field label.
 * @param {calIItemBase} item - The event or task.
 */
function boxAppendLabeledDateTimeInterval(box, labelProperty, item) {
  const dateString = cal.dtz.formatter.formatItemInterval(item);
  boxAppendLabeledText(box, labelProperty, dateString);
}

/**
 * PRIVATE: create empty 2-column table for header fields, and append it to box.
 *
 * @param {Node} box - The node to create a column table for
 */
function boxInitializeHeaderTable(box) {
  const table = document.createElement("table");
  table.setAttribute("class", "tooltipHeaderTable");
  box.appendChild(table);
}

/**
 * PRIVATE: To headers table, append a row containing Label: value, where label
 * is localized text for labelProperty.
 *
 * @param {Node} box - Box containing headers table.
 * @param {string} labelProperty - Name of property for localized name of header.
 * @param {string} textString - Value of header field.
 */
function boxAppendLabeledText(box, labelProperty, textString) {
  const table = box.querySelector("table");
  const row = document.createElement("tr");

  row.appendChild(createTooltipHeaderLabel(labelProperty));
  row.appendChild(createTooltipHeaderDescription(textString));

  table.appendChild(row);
}

/**
 * PRIVATE: Creates an element for field label (for header table)
 *
 * @param {string} text - The string ID for the text to display in the node.
 * @returns {Node} The node
 */
function createTooltipHeaderLabel(text) {
  const labelCell = document.createElement("th");
  labelCell.setAttribute("class", "tooltipHeaderLabel");
  document.l10n.setAttributes(labelCell, text);
  return labelCell;
}

/**
 * PRIVATE: Creates an element for field value (for header table)
 *
 * @param {string} text - The text to display in the node
 * @returns {Node} The node
 */
function createTooltipHeaderDescription(text) {
  const descriptionCell = document.createElementNS("http://www.w3.org/1999/xhtml", "td");
  descriptionCell.setAttribute("class", "tooltipHeaderDescription");
  descriptionCell.textContent = text;
  return descriptionCell;
}

/**
 * PRIVATE: If now is during an occurrence, return the occurrence. If now is
 * before an occurrence, return the next occurrence or otherwise the previous
 * occurrence.
 *
 * @param {calIEvent} calendarEvent - The text to display in the node
 * @returns {mixed} Returns a calIDateTime for the detected
 *   occurrence or calIEvent, if this is a non-recurring event
 */
function getCurrentNextOrPreviousRecurrence(calendarEvent) {
  if (!calendarEvent.recurrenceInfo) {
    return calendarEvent;
  }

  const dur = calendarEvent.duration.clone();
  dur.isNegative = true;

  // To find current event when now is during event, look for occurrence
  // starting duration ago.
  const probeTime = cal.dtz.now();
  probeTime.addDuration(dur);

  let occ = calendarEvent.recurrenceInfo.getNextOccurrence(probeTime);

  if (!occ) {
    const occs = calendarEvent.recurrenceInfo.getOccurrences(
      calendarEvent.startDate,
      probeTime,
      0,
      {}
    );
    occ = occs[occs.length - 1];
  }
  return occ;
}
