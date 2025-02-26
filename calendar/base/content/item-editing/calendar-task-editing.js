/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from ../calendar-management.js */
/* import-globals-from ../calendar-ui-utils.js */
/* import-globals-from calendar-item-editing.js */

var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
var { XPCOMUtils } = ChromeUtils.importESModule("resource://gre/modules/XPCOMUtils.sys.mjs");

ChromeUtils.defineESModuleGetters(this, {
  CalTodo: "resource:///modules/CalTodo.sys.mjs",
});

/**
 * Used by the "quick add" feature for tasks, for example in the task view or
 * the uniinder-todo.
 *
 * NOTE: many of the following methods are called without taskEdit being the
 * |this| object.
 */

var taskEdit = {
  /**
   * Helper function to set readonly and aria-disabled states and the value
   * for a given target.
   *
   * @param {string|Node} aTarget - The ID or Node of which to set the value on
   * @param {boolean} aDisable - A boolean if the target should be disabled.
   * @param {string} aValue - The value that should be set on the target.
   */
  setupTaskField(aTarget, aDisable, aValue) {
    aTarget.value = aValue;
    aTarget.readOnly = aDisable;
    aTarget.ariaDisabled = aDisable;
  },

  /**
   * Handler function to call when the quick-add input gains focus.
   *
   * @param {Event} aEvent - The DOM focus event.
   */
  onFocus(aEvent) {
    const edit = aEvent.target;
    const calendar = getSelectedCalendar();
    edit.showsInstructions = true;

    if (calendar.getProperty("capabilities.tasks.supported") === false) {
      taskEdit.setupTaskField(
        edit,
        true,
        taskEdit.l10n.formatValueSync("task-edit-instructions-capability")
      );
    } else if (cal.acl.isCalendarWritable(calendar)) {
      edit.showsInstructions = false;
      taskEdit.setupTaskField(edit, false, edit.savedValue || "");
    } else {
      taskEdit.setupTaskField(
        edit,
        true,
        taskEdit.l10n.formatValueSync("task-edit-instructions-readonly")
      );
    }
  },

  /**
   * Handler function to call when the quick-add input loses focus.
   *
   * @param {Event} aEvent - The DOM blur event.
   */
  onBlur(aEvent) {
    const edit = aEvent.target;
    const calendar = getSelectedCalendar();
    if (!calendar) {
      // this must be a first run, we don't have a calendar yet
      return;
    }

    if (calendar.getProperty("capabilities.tasks.supported") === false) {
      taskEdit.setupTaskField(
        edit,
        true,
        taskEdit.l10n.formatValueSync("task-edit-instructions-capability")
      );
    } else if (cal.acl.isCalendarWritable(calendar)) {
      if (!edit.showsInstructions) {
        edit.savedValue = edit.value || "";
      }
      taskEdit.setupTaskField(edit, false, taskEdit.l10n.formatValueSync("task-edit-instructions"));
    } else {
      taskEdit.setupTaskField(
        edit,
        true,
        taskEdit.l10n.formatValueSync("task-edit-instructions-readonly")
      );
    }

    edit.showsInstructions = true;
  },

  /**
   * Handler function to call on keypress for the quick-add input.
   *
   * @param {Event} aEvent - The DOM keypress event.
   */
  onKeyPress(aEvent) {
    if (aEvent.key == "Enter") {
      const edit = aEvent.target;
      if (edit.value && edit.value.length > 0) {
        const item = new CalTodo();
        setDefaultItemValues(item);
        item.title = edit.value;

        edit.value = "";
        doTransaction("add", item, item.calendar, null, null);
      }
    }
  },

  /**
   * Helper function to call onBlur for all fields with class name
   * "task-edit-field".
   */
  callOnBlurForAllTaskFields() {
    const taskEditFields = document.getElementsByClassName("task-edit-field");
    for (let i = 0; i < taskEditFields.length; i++) {
      taskEdit.onBlur({ target: taskEditFields[i] });
    }
  },

  /**
   * Load function to set up all quick-add inputs. The input must
   * have the class "task-edit-field".
   */
  onLoad() {
    cal.view.getCompositeCalendar(window).addObserver(taskEdit.compositeObserver);
    taskEdit.callOnBlurForAllTaskFields();
  },

  /**
   * Window load function to clean up all quick-add fields.
   */
  onUnload() {
    cal.view.getCompositeCalendar(window).removeObserver(taskEdit.compositeObserver);
  },

  /**
   * Observer to watch for changes to the selected calendar.
   *
   * @implements {calIObserver}
   * @implements {calICompositeObserver}
   */
  compositeObserver: {
    QueryInterface: ChromeUtils.generateQI(["calIObserver", "calICompositeObserver"]),

    // calIObserver:
    onStartBatch() {},
    onEndBatch() {},
    onLoad() {},
    onAddItem() {},
    onModifyItem() {},
    onDeleteItem() {},
    onError() {},

    onPropertyChanged(aCalendar, aName) {
      if (aCalendar.id != getSelectedCalendar().id) {
        // Optimization: if the given calendar isn't the selected calendar,
        // then we don't need to change any readonly/disabled states.
        return;
      }

      switch (aName) {
        case "readOnly":
        case "disabled": {
          taskEdit.callOnBlurForAllTaskFields();
          break;
        }
      }
    },

    onPropertyDeleting(aCalendar, aName) {
      // Since the old value is not used directly in onPropertyChanged,
      // but should not be the same as the value, set it to a different
      // value.
      this.onPropertyChanged(aCalendar, aName, null, null);
    },

    // calICompositeObserver:
    onCalendarAdded() {},
    onCalendarRemoved() {},
    onDefaultCalendarChanged() {
      taskEdit.callOnBlurForAllTaskFields();
    },
  },
};

ChromeUtils.defineLazyGetter(
  taskEdit,
  "l10n",
  () => new Localization(["calendar/calendar.ftl"], true)
);
