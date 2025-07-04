/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

window.onresize = function () {
  for (var i = 0; i < client.deck.childNodes.length; i++) {
    scrollDown(client.deck.childNodes[i], true);
  }
};

function onInputFocus() {}

function showErrorDlg(message) {
  const XUL_MIME = "application/vnd.mozilla.xul+xml";
  const XUL_KEY =
    "http://www.mozilla.org/keymaster/" + "gatekeeper/there.is.only.xul";

  const TITLE = "ChatZilla run-time error";
  const HEADER =
    "There was a run-time error with ChatZilla. " +
    "Please report the following information:";

  const OL_JS = "document.getElementById('tb').value = '%S';";
  const TB_STYLE =
    ' multiline="true" readonly="true"' + ' style="width: 60ex; height: 20em;"';

  const ERROR_DLG =
    '<?xml version="1.0"?>' +
    '<?xml-stylesheet href="chrome://global/skin/" type="text/css"?>' +
    '<dialog xmlns="' +
    XUL_KEY +
    '" buttons="accept" ' +
    'title="' +
    TITLE +
    '" onload="' +
    OL_JS +
    '">' +
    "<label>" +
    HEADER +
    "</label><textbox" +
    TB_STYLE +
    ' id="tb"/>' +
    "</dialog>";

  var content = message.replace(/\n/g, "\\n");
  content = content.replace(/'/g, "\\'").replace(/"/g, "&quot;");
  content = content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  content = ERROR_DLG.replace("%S", content);
  content = encodeURIComponent(content);
  content = "data:" + XUL_MIME + "," + content;

  setTimeout(function () {
    window.openDialog(content, "_blank", "chrome,modal");
  }, 100);
}

function onLoad() {
  dd("Initializing ChatZilla {");
  try {
    init();
  } catch (ex) {
    dd("caught exception while initializing:\n" + dumpObjectTree(ex));
    var exception = formatException(ex) + (ex.stack && "\n" + ex.stack);
    showErrorDlg(exception + "\n" + dumpObjectTree(ex));
  }

  dd("}");
  mainStep();
}

function initHandlers() {
  var node;
  node = document.getElementById("input");
  node.addEventListener("keypress", onInputKeyPress);
  node = document.getElementById("multiline-input");
  node.addEventListener("keypress", onMultilineInputKeyPress);
  node.active = false;

  window.onkeypress = onWindowKeyPress;

  window.isFocused = false;
  window.addEventListener("focus", onWindowFocus, true);
  window.addEventListener("blur", onWindowBlue, true);

  client.inputPopup = null;

  var singleInput = document.getElementById("input");
  singleInput.addEventListener("paste", onPaste);

  client.list.controllers.appendController(gUserListController);
}

var gUserListController = {
  supportsCommand(aCommand) {
    switch (aCommand) {
      case "cmd_selectAll":
        return true;
      default:
        return false;
    }
  },

  isCommandEnabled(aCommand) {
    switch (aCommand) {
      case "cmd_selectAll":
        return true;
      default:
        return false;
    }
  },

  doCommand(aCommand) {
    switch (aCommand) {
      case "cmd_selectAll":
        client.list.selectAll();
        break;
      default:
    }
  },

  onEvent(event) {},
};

function onPaste(event) {
  let startPos = client.input.selectionStart;
  if (startPos == undefined) {
    return;
  }
  let endPos = client.input.selectionEnd;
  let clipboard = event.clipboardData.getData("text/plain");
  clipboard = clipboard.replace(/(^\s*[\r\n]+|[\r\n]+\s*$)/g, "");

  if (!clipboard.includes("\n")) {
    // If, after stripping leading/trailing empty lines, the string is a
    // single line, return.
    return;
  }

  var str =
    client.input.value.substr(0, startPos) +
    clipboard +
    client.input.value.substr(endPos);
  client.prefs.multiline = true;
  // We want to auto-collapse after send, so the user is not thrown off by the
  // "strange" input box if they didn't specifically ask for it:
  client.multiLineForPaste = true;
  client.input.value = str;
}

function onClose() {
  // Assume close needs authorization from user.
  var close = false;

  // Close has already been authorized.
  if ("userClose" in client && client.userClose) {
    close = true;
  }

  // Not connected, no need for authorization.
  if (!("getConnectionCount" in client) || client.getConnectionCount() == 0) {
    close = true;
  }

  if (!close) {
    // Authorization needed from user.
    client.wantToQuit();
    return false;
  }

  return true;
}

function onUnload() {
  dd("Shutting down ChatZilla.");

  /* Disable every loaded & enabled plugin to give them all a chance to
   * clean up anything beyond the ChatZilla window (e.g. libraries). All
   * errors are disregarded as there's nothing we can do at this point.
   * Wipe the plugin list afterwards for safety.
   */
  for (var k in client.plugins) {
    if (client.plugins[k].API > 0 && client.plugins[k].enabled) {
      try {
        client.plugins[k].disable();
      } catch (ex) {}
    }
  }
  client.plugins = {};

  // Close all dialogs.
  if ("joinDialog" in client) {
    client.joinDialog.close();
  }
  if ("configWindow" in client) {
    client.configWindow.close();
  }
  if ("installPluginDialog" in client) {
    client.installPluginDialog.close();
  }
  if ("aboutDialog" in client) {
    client.aboutDialog.close();
  }

  client.list.controllers.removeController(gUserListController);

  // We don't trust anybody.
  client.hiddenDocument = null;
  uninitOfflineIcon();
  uninitIdleAutoAway(client.prefs.awayIdleTime);
  destroy();
}

/* tab click */
function onTabClick(e, id) {
  if (e.which != 2) {
    return;
  }

  var tbi = document.getElementById(id);
  var view = client.viewsArray[tbi.getAttribute("viewKey")];

  if (e.which == 2) {
    dispatch("hide", { view: view.source, source: "mouse" });
  }
}

function onTabSelect(e) {
  var tabs = e.target;

  /* Hackaround, bug 314230. XBL likes focusing a tab before onload has fired.
   * That means the tab we're trying to select here will be the hidden one,
   * which doesn't have a viewKey. We catch that case.
   */
  if (!tabs.selectedItem.hasAttribute("viewKey")) {
    return;
  }

  var key = tabs.selectedItem.getAttribute("viewKey");
  var view = client.viewsArray[key];
  dispatch("set-current-view", { view: view.source });
}

function onMessageViewClick(e) {
  if (e.which != 1 && e.which != 2) {
    return true;
  }

  var cx = getMessagesContext(null, e.target);
  cx.source = "mouse";
  cx.shiftKey = e.shiftKey;
  let command = "goto-url";
  let where = Services.prefs.getIntPref("browser.link.open_newwindow");
  if (
    where != 3 &&
    (e.which == 2 || e.ctrlKey) &&
    Services.prefs.getBoolPref("browser.tabs.opentabfor.middleclick", true)
  ) {
    where = 3;
  }

  if (where == 2) {
    command = "goto-url-newwin";
  } else if (where == 3) {
    command = "goto-url-newtab";
  }

  if (!client.commandManager.isCommandSatisfied(cx, command)) {
    return false;
  }

  dispatch(command, cx);
  dispatch("focus-input");
  e.preventDefault();
  return true;
}

function onMouseOver(e) {
  var i = 0;
  var target = e.target;
  var status = "";
  while (!status && target && i < 5) {
    if ("getAttribute" in target) {
      status = target.getAttribute("href");
      if (!status) {
        status = target.getAttribute("status-text");
      }
    }
    ++i;
    target = target.parentNode;
  }

  // Setting client.status to "" will revert it to the default automatically.
  client.status = status;
}

function onMultilineInputKeyPress(e) {
  if ((e.ctrlKey || e.metaKey) && e.keyCode == 13) {
    /* meta-enter, execute buffer */
    onMultilineSend(e);
  } else if ((e.ctrlKey || e.metaKey) && e.keyCode == 40) {
    /* ctrl/meta-down, switch to single line mode */
    dispatch("pref multiline false");
  }
}

function onMultilineSend(e) {
  var multiline = document.getElementById("multiline-input");
  e.line = multiline.value;
  if (e.line.search(/\S/) == -1) {
    return;
  }
  onInputCompleteLine(e);
  multiline.value = "";
  if ("multiLineForPaste" in client && client.multiLineForPaste) {
    client.prefs.multiline = false;
  }
}

function onInputKeyPress(e) {
  if (client.prefs["outgoing.colorCodes"]) {
    setTimeout(onInputKeyPressCallback, 100, e.target);
  }

  switch (e.keyCode) {
    case 9 /* tab */:
      if (!e.ctrlKey && !e.metaKey) {
        onTabCompleteRequest(e);
        e.preventDefault();
      }
      return;

    case 77:
      /* Hackaround for carbon on mac sending us this instead of 13
       * for ctrl+enter. 77 = "M", and ctrl+M was originally used
       * to send a CR in a terminal. */

      // Fallthrough if ctrl was pressed, otherwise break out to default:
      if (!e.ctrlKey) {
        break;
      }

    case 13 /* CR */:
      e.line = e.target.value;
      e.target.value = "";
      if (e.line.search(/\S/) == -1) {
        return;
      }
      if (e.ctrlKey) {
        e.line = client.COMMAND_CHAR + "say " + e.line;
      }
      onInputCompleteLine(e);
      return;

    case 37 /* left */:
      if (e.altKey && e.metaKey) {
        cycleView(-1);
      }
      return;

    case 38 /* up */:
      if (e.ctrlKey || e.metaKey) {
        /* ctrl/meta-up, switch to multi line mode */
        dispatch("pref multiline true");
      } else if (client.lastHistoryReferenced == -2) {
        client.lastHistoryReferenced = -1;
        e.target.value = client.incompleteLine;
      } else if (
        client.lastHistoryReferenced <
        client.inputHistory.length - 1
      ) {
        e.target.value = client.inputHistory[++client.lastHistoryReferenced];
      }
      e.preventDefault();
      return;

    case 39 /* right */:
      if (e.altKey && e.metaKey) {
        cycleView(+1);
      }
      return;

    case 40 /* down */:
      if (client.lastHistoryReferenced > 0) {
        e.target.value = client.inputHistory[--client.lastHistoryReferenced];
      } else if (client.lastHistoryReferenced == -1) {
        e.target.value = "";
        client.lastHistoryReferenced = -2;
      } else {
        client.lastHistoryReferenced = -1;
        e.target.value = client.incompleteLine;
      }
      e.preventDefault();
      return;
  }
  client.lastHistoryReferenced = -1;
  client.incompleteLine = e.target.value;
}

function onTabCompleteRequest(e) {
  function getCommonPfx(list, lcFn) {
    let pfx = list[0];

    for (let item of list) {
      for (let c = 0; c < pfx.length; ++c) {
        if (c >= item.length) {
          pfx = pfx.substr(0, c);
          break;
        } else if (lcFn(pfx[c]) != lcFn(item[c])) {
          pfx = pfx.substr(0, c);
        }
      }
    }

    return pfx;
  }

  var elem = document.commandDispatcher.focusedElement;
  var singleInput = document.getElementById("input");
  if (document.getBindingParent(elem) != singleInput) {
    return;
  }

  var selStart = singleInput.selectionStart;
  var selEnd = singleInput.selectionEnd;
  var line = singleInput.value;

  if (!line) {
    if ("defaultCompletion" in client.currentObject) {
      singleInput.value = client.currentObject.defaultCompletion;
    }
    // If there was nothing to complete, help the user:
    if (!singleInput.value) {
      display(MSG_LEAVE_INPUTBOX, MT_INFO);
    }
    return;
  }

  if (selStart != selEnd) {
    /* text is highlighted, just move caret to end and exit */
    singleInput.selectionStart = singleInput.selectionEnd = line.length;
    return;
  }

  var wordStart = line.substr(0, selStart).search(/\s\S*$/);
  if (wordStart == -1) {
    wordStart = 0;
  } else {
    ++wordStart;
  }

  var wordEnd = line.substr(selStart).search(/\s/);
  if (wordEnd == -1) {
    wordEnd = line.length;
  } else {
    wordEnd += selStart;
  }

  // Double tab on nothing, inform user how to get out of the input box
  if (wordEnd == wordStart) {
    display(MSG_LEAVE_INPUTBOX, MT_INFO);
    return;
  }

  if ("performTabMatch" in client.currentObject) {
    var word = line.substring(wordStart, wordEnd);
    var wordLower = word.toLowerCase();
    var d = getObjectDetails(client.currentObject);
    if (d.server) {
      wordLower = d.server.toLowerCase(word);
    }

    var co = client.currentObject;

    // We need some special knowledge of how to lower-case strings.
    var lcFn;
    if ("getLCFunction" in co) {
      lcFn = co.getLCFunction();
    } else {
      lcFn = function (text) {
        return text.toLowerCase();
      };
    }

    var matches = co.performTabMatch(
      line,
      wordStart,
      wordEnd,
      wordLower,
      selStart,
      lcFn
    );
    /* if we get null back, we're supposed to fail silently */
    if (!matches) {
      return;
    }

    var doubleTab = false;
    var date = new Date();
    if (date - client.lastTabUp <= client.DOUBLETAB_TIME) {
      doubleTab = true;
    } else {
      client.lastTabUp = date;
    }

    if (doubleTab) {
      /* if the user hit tab twice quickly, */
      if (matches.length > 0) {
        /* then list possible completions, */
        display(
          getMsg(MSG_FMT_MATCHLIST, [
            matches.length,
            word,
            matches.sort().join(", "),
          ])
        );
      } else {
        /* or display an error if there are none. */
        display(getMsg(MSG_ERR_NO_MATCH, word), MT_ERROR);
      }
    } else if (matches.length >= 1) {
      var match;
      if (matches.length == 1) {
        match = matches[0];
      } else {
        match = getCommonPfx(matches, lcFn);
      }
      singleInput.value =
        line.substr(0, wordStart) + match + line.substr(wordEnd);
      if (wordEnd < line.length) {
        /* if the word we completed was in the middle if the line
         * then move the cursor to the end of the completed word. */
        var newpos = wordStart + match.length;
        if (matches.length == 1) {
          /* word was fully completed, move one additional space */
          ++newpos;
        }
        singleInput.selectionEnd = e.target.selectionStart = newpos;
      }
    }
  }
}

function onWindowKeyPress(e) {
  var code = Number(e.keyCode);
  var w;
  var newOfs;
  var userList = document.getElementById("user-list");
  var elemFocused = document.commandDispatcher.focusedElement;

  const isMac = client.platform == "Mac";
  const isLinux = client.platform == "Linux";
  const isWindows = client.platform == "Windows";
  const isOS2 = client.platform == "OS/2";
  const isUnknown = !(isMac || isLinux || isWindows || isOS2);

  switch (code) {
    case 9 /* Tab */:
      // Control-Tab => next tab (all platforms)
      // Control-Shift-Tab => previous tab (all platforms)
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        cycleView(e.shiftKey ? -1 : 1);
        e.preventDefault();
      }
      break;

    case 33: /* Page Up */
    case 34 /* Page Down */:
      // Control-Page Up => previous tab (all platforms)
      // Control-Page Down => next tab (all platforms)
      if (
        (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) ||
        (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey)
      ) {
        cycleView(2 * code - 67);
        e.preventDefault();
        break;
      }

      if (
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.shiftKey &&
        elemFocused != userList
      ) {
        w = client.currentFrame;
        newOfs = w.pageYOffset + w.innerHeight * 0.75 * (2 * code - 67);
        if (newOfs > 0) {
          w.scrollTo(w.pageXOffset, newOfs);
        } else {
          w.scrollTo(w.pageXOffset, 0);
        }
        e.preventDefault();
      }
      break;

    case 37: /* Left Arrow */
    case 39 /* Right Arrow */:
      // Command-Alt-Left Arrow => previous tab (Mac only)
      // Command-Alt-Right Arrow => next tab (Mac only)
      if (isMac && e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey) {
        cycleView(code - 38);
        e.preventDefault();
      }
      break;

    case 219: /* [ */
    case 221 /* ] */:
      // Command-Shift-[ => previous tab (Mac only)
      // Command-Shift-] => next tab (Mac only)
      if (isMac && e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey) {
        cycleView(code - 220);
        e.preventDefault();
      }
      break;

    case 117 /* F6 */:
      // F6 => focus next (all platforms)
      // Shift-F6 => focus previous (all platforms)
      if (!e.altKey && !e.ctrlKey && !e.metaKey) {
        advanceKeyboardFocus(e.shiftKey ? -1 : 1);
        e.preventDefault();
      }
      break;
  }

  // Code is zero if we have a typeable character triggering the event.
  if (code != 0) {
    return;
  }

  // OS X only: Command-{ and Command-}
  // Newer geckos seem to only provide these keys in charCode, not keyCode
  if (isMac && e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey) {
    if (e.charCode == 123 || e.charCode == 125) {
      cycleView(e.charCode - 124);
      e.preventDefault();
      return;
    }
  }

  // Numeric shortcuts

  // The following code is copied from:
  //   /mozilla/browser/base/content/browser.js
  //   Revision: 1.748
  //   Lines: 1397-1421

  // \d in a RegExp will find any Unicode character with the "decimal digit"
  // property (Nd)
  var regExp = /\d/;
  if (!regExp.test(String.fromCharCode(e.charCode))) {
    return;
  }

  // Some Unicode decimal digits are in the range U+xxx0 - U+xxx9 and some are
  // in the range U+xxx6 - U+xxxF. Find the digit 1 corresponding to our
  // character.
  var digit1 = (e.charCode & 0xfff0) | 1;
  if (!regExp.test(String.fromCharCode(digit1))) {
    digit1 += 6;
  }

  var idx = e.charCode - digit1;

  if (0 <= idx && idx <= 8) {
    var modifier =
      (e.altKey ? 0x1 : 0) |
      (e.ctrlKey ? 0x2 : 0) |
      (e.shiftKey ? 0x4 : 0) |
      (e.metaKey ? 0x8 : 0);

    var modifierMask;
    if (client.prefs.tabGotoKeyModifiers) {
      modifierMask = client.prefs.tabGotoKeyModifiers;
    } else {
      modifierMask = 0x1;
    } // alt

    if ((modifier & modifierMask) == modifierMask) {
      // Pressing 1-8 takes you to that tab, while pressing 9 takes you
      // to the last tab always.
      if (idx == 8) {
        idx = client.viewsArray.length - 1;
      }

      if (idx in client.viewsArray && client.viewsArray[idx].source) {
        var newView = client.viewsArray[idx].source;
        dispatch("set-current-view", { view: newView });
      }
      e.preventDefault();
    }
  }
}

function onWindowFocus(e) {
  window.isFocused = true;
}

function onWindowBlue(e) {
  window.isFocused = false;

  // If we're tracking last read lines, set a mark on the current view
  // when losing focus.
  if (client.currentObject && client.currentObject.prefs.autoMarker) {
    client.currentObject.dispatch("marker-set");
  }
}

function onInputCompleteLine(e) {
  if (!client.inputHistory.length || client.inputHistory[0] != e.line) {
    client.inputHistory.unshift(e.line);
    if (client.inputHistoryLogger) {
      client.inputHistoryLogger.append(e.line);
    }
  }

  if (client.inputHistory.length > client.MAX_HISTORY) {
    client.inputHistory.pop();
  }

  client.lastHistoryReferenced = -1;
  client.incompleteLine = "";

  if (e.line[0] == client.COMMAND_CHAR) {
    if (client.prefs["outgoing.colorCodes"]) {
      e.line = replaceColorCodes(e.line);
    }
    dispatch(e.line.substr(1), null, true);
  } /* plain text */ else {
    /* color codes */
    if (client.prefs["outgoing.colorCodes"]) {
      e.line = replaceColorCodes(e.line);
    }
    client.sayToCurrentTarget(e.line, true);
  }
}

function onNotifyTimeout() {
  for (var n in client.networks) {
    var net = client.networks[n];
    if (net.isConnected()) {
      if (net.prefs.notifyList.length > 0 && !net.primServ.supports.monitor) {
        let isonList = net.prefs.notifyList;
        net.primServ.sendData("ISON " + isonList.join(" ") + "\n");
      } else {
        /* Just send a ping to see if we're alive. */
        net.primServ.sendData("PING :ALIVECHECK\n");
      }
    }
  }
}

function onWhoTimeout() {
  function checkWho() {
    var checkNext = net.lastWhoCheckChannel == null;
    for (var c in net.primServ.channels) {
      var chan = net.primServ.channels[c];

      if (
        checkNext &&
        chan.active &&
        chan.getUsersLength() < client.prefs.autoAwayCap
      ) {
        net.primServ.LIGHTWEIGHT_WHO = true;
        net.primServ.who(chan.unicodeName);
        net.lastWhoCheckChannel = chan;
        net.lastWhoCheckTime = Number(new Date());
        return;
      }

      if (chan == net.lastWhoCheckChannel) {
        checkNext = true;
      }
    }
    if (net.lastWhoCheckChannel) {
      net.lastWhoCheckChannel = null;
      checkWho();
    }
  }

  for (var n in client.networks) {
    var net = client.networks[n];
    var period = net.prefs.autoAwayPeriod;
    // The time since the last check, with a 5s error margin to
    // stop us from not checking because the timer fired a tad early:
    var waited = Number(new Date()) - net.lastWhoCheckTime + 5000;
    if (
      net.isConnected() &&
      period != 0 &&
      period * 60000 < waited &&
      !net.primServ.caps["away-notify"]
    ) {
      checkWho();
    }
  }
}

function onInputKeyPressCallback(el) {
  function doPopup(popup) {
    if (client.inputPopup && client.inputPopup != popup) {
      client.inputPopup.hidePopup();
    }

    client.inputPopup = popup;
    if (popup) {
      if (el.nodeName == "textbox") {
        popup.showPopup(el, -1, -1, "tooltip", "topleft", "bottomleft");
      } else {
        var box = el.ownerDocument.getBoxObjectFor(el);
        var pos = {
          x: client.mainWindow.screenX + box.screenX + 5,
          y: client.mainWindow.screenY + box.screenY + box.height + 25,
        };
        popup.moveTo(pos.x, pos.y);
        popup.showPopup(el, 0, 0, "tooltip");
      }
    }
  }

  var text = " " + el.value.substr(0, el.selectionStart);
  if (el.selectionStart != el.selectionEnd) {
    text = "";
  }

  if (text.match(/[^%]%C[0-9]{0,2},?[0-9]{0,2}$/)) {
    doPopup(document.getElementById("colorTooltip"));
  } else if (text.match(/[^%]%$/)) {
    doPopup(document.getElementById("percentTooltip"));
  } else {
    doPopup(null);
  }
}

function onUserDoubleClick(event) {
  if (
    event.button != 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return;
  }
  let nickname = getNicknameForUserlistRow(event.target);
  dispatch("query", { nickname, source: "mouse" });
}

function onUserDragStart(event) {
  let nickname = getNicknameForUserlistRow(event.target);
  event.dataTransfer.setData("text/unicode", nickname);
  event.dataTransfer.setData("text/plain", nickname);
}

/* the offset should be in seconds, it will be rounded to 2 decimal places */
function formatDateOffset(offset) {
  let seconds = offset % 60;
  seconds = Math.round((seconds + Number.EPSILON) * 100) / 100;
  let minutes = Math.floor(offset / 60);
  let hours = Math.floor(minutes / 60);
  minutes = minutes % 60;
  let days = Math.floor(hours / 24);
  hours = hours % 24;

  let ary = [];

  if (days == 1) {
    ary.push(MSG_DAY);
  } else if (days > 0) {
    ary.push(getMsg(MSG_DAYS, days));
  }

  if (hours == 1) {
    ary.push(MSG_HOUR);
  } else if (hours > 0) {
    ary.push(getMsg(MSG_HOURS, hours));
  }

  if (minutes == 1) {
    ary.push(MSG_MINUTE);
  } else if (minutes > 0) {
    ary.push(getMsg(MSG_MINUTES, minutes));
  }

  if (seconds == 1) {
    ary.push(MSG_SECOND);
  } else if (seconds > 0 || offset == 0) {
    ary.push(getMsg(MSG_SECONDS, seconds));
  }

  return ary.join(", ");
}

client.onFindEnd =
  CIRCNetwork.prototype.onFindEnd =
  CIRCChannel.prototype.onFindEnd =
  CIRCUser.prototype.onFindEnd =
  CIRCDCCChat.prototype.onFindEnd =
  CIRCDCCFileTransfer.prototype.onFindEnd =
    function (e) {
      this.scrollToElement("selection", "inview");
    };

CIRCChannel.prototype._updateConferenceMode = function () {
  const minDiff = client.CONFERENCE_LOW_PASS;

  var enabled = this.prefs["conference.enabled"];
  var userLimit = this.prefs["conference.limit"];
  var userCount = this.getUsersLength();

  if (userLimit == 0) {
    // userLimit == 0 --> always off.
    if (enabled) {
      this.prefs["conference.enabled"] = false;
    }
  } else if (userLimit == 1) {
    // userLimit == 1 --> always on.
    if (!enabled) {
      this.prefs["conference.enabled"] = true;
    }
  } else if (enabled && userCount < userLimit - minDiff) {
    this.prefs["conference.enabled"] = false;
  } else if (!enabled && userCount > userLimit + minDiff) {
    this.prefs["conference.enabled"] = true;
  }
};

CIRCServer.prototype.CTCPHelpClientinfo = function () {
  return MSG_CTCPHELP_CLIENTINFO;
};

CIRCServer.prototype.CTCPHelpAction = function () {
  return MSG_CTCPHELP_ACTION;
};

CIRCServer.prototype.CTCPHelpTime = function () {
  return MSG_CTCPHELP_TIME;
};

CIRCServer.prototype.CTCPHelpVersion = function () {
  return MSG_CTCPHELP_VERSION;
};

CIRCServer.prototype.CTCPHelpSource = function () {
  return MSG_CTCPHELP_SOURCE;
};

CIRCServer.prototype.CTCPHelpOs = function () {
  return MSG_CTCPHELP_OS;
};

CIRCServer.prototype.CTCPHelpHost = function () {
  return MSG_CTCPHELP_HOST;
};

CIRCServer.prototype.CTCPHelpPing = function () {
  return MSG_CTCPHELP_PING;
};

CIRCServer.prototype.CTCPHelpDcc = function () {
  return MSG_CTCPHELP_DCC;
};

/**
 * Calculates delay before the next automatic connection attempt.
 *
 * If the number of connection attempts is limited, use fixed interval
 * MIN_RECONNECT_MS. For unlimited attempts (-1), use exponential backoff: the
 * interval between connection attempts to the network (not individual
 * servers) is doubled after each attempt, up to MAX_RECONNECT_MS.
 */
CIRCNetwork.prototype.getReconnectDelayMs = function () {
  var nServers = this.serverList.length;

  if (
    -1 != this.MAX_CONNECT_ATTEMPTS ||
    0 != this.connectCandidate % nServers
  ) {
    return this.MIN_RECONNECT_MS;
  }

  var networkRound = Math.ceil(this.connectCandidate / nServers);

  var rv = this.MIN_RECONNECT_MS * Math.pow(2, networkRound - 1);

  // clamp rv between MIN/MAX_RECONNECT_MS
  rv = Math.min(Math.max(rv, this.MIN_RECONNECT_MS), this.MAX_RECONNECT_MS);

  return rv;
};

CIRCNetwork.prototype.onInit = function () {
  this.logFile = null;
  this.lastServer = null;
};

CIRCNetwork.prototype.onInfo = function (e) {
  this.display(e.msg, "INFO", undefined, undefined, e.tags);
};

CIRCNetwork.prototype.onUnknown = function (e) {
  if ("pendingWhoisLines" in e.server) {
    /* whois lines always have the nick in param 2 */
    e.user = new CIRCUser(e.server, null, e.params[2]);

    e.destMethod = "onUnknownWhois";
    e.destObject = this;
    return;
  }

  e.params.shift(); /* remove the code */
  e.params.shift(); /* and the dest. nick (always me) */

  // Handle random IRC numerics automatically.
  var msg = getMsg("msg.irc." + e.code, null, "");
  if (msg) {
    if (e.server.channelTypes.includes(e.params[0][0])) {
      // Message about a channel (e.g. join failed).
      e.channel = new CIRCChannel(e.server, null, e.params[0]);
    }

    var targetDisplayObj = this;
    if (e.channel && "messages" in e.channel) {
      targetDisplayObj = e.channel;
    }

    // Check for /knock support for the +i message.
    if (
      (e.code == 471 || e.code == 473 || e.code == 475) &&
      "knock" in e.server.servCmds
    ) {
      var args = [msg, e.channel.unicodeName, "knock " + e.channel.unicodeName];
      msg = getMsg("msg.irc." + e.code + ".knock", args, "");
      client.munger.getRule(".inline-buttons").enabled = true;
      targetDisplayObj.display(msg, undefined, undefined, undefined, e.tags);
      client.munger.getRule(".inline-buttons").enabled = false;
    } else {
      targetDisplayObj.display(msg, undefined, undefined, undefined, e.tags);
    }

    if (e.channel) {
      if (e.channel.busy) {
        e.channel.busy = false;
        updateProgress();
      }
    } else {
      // Network type error?
      if (this.busy) {
        this.busy = false;
        updateProgress();
      }
    }
    return;
  }

  /* if it looks like some kind of "end of foo" code, and we don't
   * already have a mapping for it, make one up */
  var length = e.params.length;
  if (
    !(e.code in client.responseCodeMap) &&
    e.params[length - 1].search(/^end of/i) != -1
  ) {
    client.responseCodeMap[e.code] = "---";
  }

  this.display(
    toUnicode(e.params.join(" "), this),
    e.code.toUpperCase(),
    undefined,
    undefined,
    e.tags
  );
};

CIRCNetwork.prototype.lastWhoCheckChannel = null;
CIRCNetwork.prototype.lastWhoCheckTime = 0;
/* Welcome! */
CIRCNetwork.prototype.on001 =
  /* your host is */
  CIRCNetwork.prototype.on002 =
  /* server born-on date */
  CIRCNetwork.prototype.on003 =
  /* server id */
  CIRCNetwork.prototype.on004 =
  /* server features */
  CIRCNetwork.prototype.on005 =
  /* highest connection count */
  CIRCNetwork.prototype.on250 =
  /* users */
  CIRCNetwork.prototype.on251 =
  /* opers online (in params[2]) */
  CIRCNetwork.prototype.on252 =
  /* channels found (in params[2]) */
  CIRCNetwork.prototype.on254 =
  /* link info */
  CIRCNetwork.prototype.on255 =
  /* local user details */
  CIRCNetwork.prototype.on265 =
  /* global user details */
  CIRCNetwork.prototype.on266 =
  /* start of MOTD */
  CIRCNetwork.prototype.on375 =
  /* MOTD line */
  CIRCNetwork.prototype.on372 =
  /* end of MOTD */
  CIRCNetwork.prototype.on376 =
  /* no MOTD */
  CIRCNetwork.prototype.on422 =
  /* STARTTLS Success */
  CIRCNetwork.prototype.on670 =
  /* STARTTLS Failure */
  CIRCNetwork.prototype.on691 =
  /* SASL Nick locked */
  CIRCNetwork.prototype.on902 =
  /* SASL Auth success */
  CIRCNetwork.prototype.on903 =
  /* SASL Auth failed */
  CIRCNetwork.prototype.on904 =
  /* SASL Command too long */
  CIRCNetwork.prototype.on905 =
  /* SASL Aborted */
  CIRCNetwork.prototype.on906 =
  /* SASL Already authenticated */
  CIRCNetwork.prototype.on907 =
  /* SASL Mechanisms */
  CIRCNetwork.prototype.on908 =
    function (e) {
      var p = 3 in e.params ? e.params[2] + " " : "";
      var str = "";

      switch (e.code) {
        case "004":
        case "005":
          str = e.params.slice(3).join(" ");
          break;

        case "001":
          // Code moved to lower down to speed this bit up. :)
          var c, u;
          // If we've switched servers, *first* we must rehome our objects.
          if (this.lastServer && this.lastServer != this.primServ) {
            for (c in this.lastServer.channels) {
              this.lastServer.channels[c].rehome(this.primServ);
            }
            for (u in this.lastServer.users) {
              this.lastServer.users[u].rehome(this.primServ);
            }

            // This makes sure we have the *right* me object.
            this.primServ.me.rehome(this.primServ);
          }

          // Update the list of ignored users from the prefs:
          var ignoreAry = this.prefs.ignoreList;
          for (var j = 0; j < ignoreAry.length; ++j) {
            this.ignoreList[ignoreAry[j]] = getHostmaskParts(ignoreAry[j]);
          }

          // Update everything.
          // Welcome to history.
          addURLToHistory(this.getURL());
          updateTitle(this);
          this.updateHeader();
          client.updateHeader();
          updateSecurityIcon();
          updateStalkExpression(this);

          client.ident.removeNetwork(this);

          // Figure out what nick we *really* want:
          if (this.prefs.away && this.prefs.awayNick) {
            this.preferredNick = this.prefs.awayNick;
          } else {
            this.preferredNick = this.prefs.nickname;
          }

          // Pretend this never happened.
          delete this.pendingNickChange;

          str = e.decodeParam(2);

          break;

        case "251" /* users */:
          this.doAutoPerform();

          // Set our initial monitor list
          if (
            this.primServ.supports.monitor &&
            this.prefs.notifyList.length > 0
          ) {
            this.primServ.sendMonitorList(this.prefs.notifyList, true);
          }

          this.isIdleAway = client.isIdleAway;
          if (this.prefs.away) {
            this.dispatch("away", { reason: this.prefs.away });
          }

          if (this.lastServer) {
            // Re-join channels from previous connection.
            for (c in this.primServ.channels) {
              var chan = this.primServ.channels[c];
              if (chan.joined) {
                chan.join(chan.mode.key);
              }
            }
          }
          this.lastServer = this.primServ;

          if ("pendingURLs" in this) {
            var target = this.pendingURLs.pop();
            while (target) {
              gotoIRCURL(target.url, target.e);
              target = this.pendingURLs.pop();
            }
            delete this.pendingURLs;
          }

          // Do this after the JOINs, so they are quicker.
          // This is not time-critical code.
          if (client.prefs["dcc.enabled"] && this.prefs["dcc.useServerIP"]) {
            var delayFn = function (t) {
              // This is the quickest way to get out host/IP.
              t.pendingUserhostReply = true;
              t.primServ.sendData(
                "USERHOST " + t.primServ.me.encodedName + "\n"
              );
            };
            setTimeout(delayFn, 1000 * Math.random(), this);
          }

          // Had some collision during connect.
          if (this.primServ.me.unicodeName != this.preferredNick) {
            this.reclaimLeft = this.RECLAIM_TIMEOUT;
            this.reclaimName();
          }

          if ("onLogin" in this) {
            ev = new CEvent("network", "login", this, "onLogin");
            client.eventPump.addEvent(ev);
          }

          str = e.decodeParam(e.params.length - 1);
          break;

        case "376": /* end of MOTD */
        case "422" /* no MOTD */:
          this.busy = false;
          updateProgress();

          /* Some servers (wrongly) dont send 251, so try
               auto-perform after the MOTD as well */
          this.doAutoPerform();
        /* no break */

        case "372":
        case "375":
        case "376":
          if (this.IGNORE_MOTD) {
            return;
          }
        /* no break */

        default:
          str = e.decodeParam(e.params.length - 1);
          break;
      }

      this.displayHere(
        p + str,
        e.code.toUpperCase(),
        undefined,
        undefined,
        e.tags
      );
    };

CIRCNetwork.prototype.onUnknownCTCPReply = function (e) {
  this.display(
    getMsg(MSG_FMT_CTCPREPLY, [
      toUnicode(e.CTCPCode, this),
      toUnicode(e.CTCPData, this),
      e.user.unicodeName,
    ]),
    "CTCP_REPLY",
    e.user,
    e.server.me,
    e.tags
  );
};

CIRCNetwork.prototype.onNotice = function (e) {
  client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
  this.display(e.decodeParam(2), "NOTICE", this, e.server.me, e.tags);
  client.munger.getRule(".mailto").enabled = false;
};

CIRCNetwork.prototype.onPrivmsg = function (e) {
  client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
  this.display(e.decodeParam(2), "PRIVMSG", this, e.server.me, e.tags);
  client.munger.getRule(".mailto").enabled = false;
};

/* userhost reply */
CIRCNetwork.prototype.on302 = function (e) {
  if (
    client.prefs["dcc.enabled"] &&
    this.prefs["dcc.useServerIP"] &&
    "pendingUserhostReply" in this
  ) {
    var me = new RegExp("^" + this.primServ.me.encodedName + "\\*?=", "i");
    if (e.params[2].match(me)) {
      client.dcc.addHost(this.primServ.me.host, true);
    }

    delete this.pendingUserhostReply;
    return true;
  }

  e.destMethod = "onUnknown";
  e.destObject = this;

  return true;
};

/* ISON (aka notify) reply */
CIRCNetwork.prototype.on303 = function (e) {
  function lower(text) {
    return e.server.toLowerCase(text);
  }

  var onList = [];
  // split() gives an array of one item ("") when splitting "", which we
  // don't want, so only do the split if there's something to split.
  if (e.params[2]) {
    onList = e.server.toLowerCase(e.params[2]).trim().split(/\s+/);
  }
  var offList = [];
  var newArrivals = [];
  var newDepartures = [];
  var o = getObjectDetails(client.currentObject);
  var displayTab;
  var i;

  if ("network" in o && o.network == this && client.currentObject != this) {
    displayTab = client.currentObject;
  }

  for (i = 0; i < this.prefs.notifyList.length; i++) {
    if (!onList.includes(lower(this.prefs.notifyList[i]))) {
      /* user is not on */
      offList.push(lower(this.prefs.notifyList[i]));
    }
  }

  if ("onList" in this) {
    for (i in onList) {
      if (!this.onList.includes(onList[i])) {
        /* we didn't know this person was on */
        newArrivals.push(onList[i]);
      }
    }
  } else {
    this.onList = newArrivals = onList;
  }

  if ("offList" in this) {
    for (i in offList) {
      if (!this.offList.includes(offList[i])) {
        /* we didn't know this person was off */
        newDepartures.push(offList[i]);
      }
    }
  } else {
    this.offList = newDepartures = offList;
  }

  if (newArrivals.length > 0) {
    this.displayHere(
      arraySpeak(newArrivals, "is", "are") + " online.",
      "NOTIFY-ON",
      undefined,
      undefined,
      e.tags
    );
    if (displayTab) {
      displayTab.displayHere(
        arraySpeak(newArrivals, "is", "are") + " online.",
        "NOTIFY-ON",
        undefined,
        undefined,
        e.tags
      );
    }
  }

  if (newDepartures.length > 0) {
    this.displayHere(
      arraySpeak(newDepartures, "is", "are") + " offline.",
      "NOTIFY-OFF",
      undefined,
      undefined,
      e.tags
    );
    if (displayTab) {
      displayTab.displayHere(
        arraySpeak(newDepartures, "is", "are") + " offline.",
        "NOTIFY-OFF",
        undefined,
        undefined,
        e.tags
      );
    }
  }

  this.onList = onList;
  this.offList = offList;
};

/* RPL_MONONLINE  */
CIRCNetwork.prototype.on730 =
  /* RPL_MONOFFLINE */
  CIRCNetwork.prototype.on731 = function (e) {
    var userList = e.params[2].split(",");
    var nickList = [];
    var o = getObjectDetails(client.currentObject);
    var displayTab;
    var i;
    var msg;

    if ("network" in o && o.network == this && client.currentObject != this) {
      displayTab = client.currentObject;
    }

    for (i = 0; i < userList.length; i++) {
      var nick = e.server.toLowerCase(userList[i].split("!")[0]);

      // Make sure this nick is in the notify list.
      if (!this.prefs.notifyList.includes(nick)) {
        this.prefs.notifyList.push(nick);
        this.prefs.notifyList.update();
      }
      nickList.push(nick);
    }

    if (e.code == "730") {
      // RPL_MONONLINE
      msg = arraySpeak(nickList, "is", "are") + " online.";
    } // RPL_MONOFFLINE
    else {
      msg = arraySpeak(nickList, "is", "are") + " offline.";
    }
    this.displayHere(msg, e.code, undefined, undefined, e.tags);
    if (displayTab) {
      displayTab.displayHere(msg, e.code, undefined, undefined, e.tags);
    }
  };

/* RPL_MONLIST */
CIRCNetwork.prototype.on732 = function (e) {
  if (!this.pendingNotifyList) {
    this.pendingNotifyList = [];
  }
  var nickList = e.server.toLowerCase(e.params[2]).split(",");
  this.pendingNotifyList = this.pendingNotifyList.concat(nickList);
};

/* RPL_ENDOFMONLIST */
CIRCNetwork.prototype.on733 = function (e) {
  if (this.pendingNotifyList) {
    this.prefs.notifyList = this.pendingNotifyList;
    this.prefs.notifyList.update();
    this.display(getMsg(MSG_NOTIFY_LIST, arraySpeak(this.pendingNotifyList)));
    delete this.pendingNotifyList;
    if (e.params[2]) {
      this.display(e.params[2], e.code, undefined, undefined, e.tags);
    }
  } else {
    this.prefs.notifyList = [];
    this.prefs.notifyList.update();
    display(MSG_NO_NOTIFY_LIST, e.code, undefined, undefined, e.tags);
  }
};

/* ERR_MONLISTFULL */
CIRCNetwork.prototype.on734 = function (e) {
  var nickList = e.server.toLowerCase(e.params[3]).split(",");
  var i;
  var msgname;

  for (i = 0; i < nickList.length; i++) {
    var j = this.prefs.notifyList.indexOf(nickList[i]);
    if (j >= 0) {
      this.prefs.notifyList.splice(j, 1);
    }
  }
  this.prefs.notifyList.update();

  if (e.params[4]) {
    this.display(e.params[4], e.code, undefined, undefined, e.tags);
  } else {
    this.display(MSG_NOTIFY_FULL);
  }

  msgname = nickList.length == 1 ? MSG_NOTIFY_DELONE : MSG_NOTIFY_DELSOME;
  this.display(getMsg(msgname, arraySpeak(nickList)));
};

/* away off reply */
CIRCNetwork.prototype.on305 = function (e) {
  this.display(MSG_AWAY_OFF, e.code, undefined, undefined, e.tags);

  return true;
};

/* away on reply */
CIRCNetwork.prototype.on306 = function (e) {
  var idleMsgParams = [this.prefs.away, client.prefs.awayIdleTime];
  if (!this.isIdleAway) {
    this.display(
      getMsg(MSG_AWAY_ON, this.prefs.away),
      e.code,
      undefined,
      undefined,
      e.tags
    );
  } else {
    this.display(
      getMsg(MSG_IDLE_AWAY_ON, idleMsgParams),
      e.code,
      undefined,
      undefined,
      e.tags
    );
  }

  return true;
};

/* 'try again' */
CIRCNetwork.prototype.on263 = function (e) {
  /* Urgh, this one's a pain. We need to abort whatever we tried, and start
   * it again if appropriate.
   *
   * Known causes of this message:
   *   - LIST, with or without a parameter.
   */

  if ("_list" in this && !this._list.done && this._list.count == 0) {
    // We attempted a LIST, and we think it failed. :)
    this._list.done = true;
    this._list.error = e.decodeParam(2);
    // Return early for this one if we're saving it.
    if ("file" in this._list) {
      return true;
    }
  }

  e.destMethod = "onUnknown";
  e.destObject = this;
  return true;
};

CIRCNetwork.prototype.isRunningList = function () {
  /* The list is considered "running" when a cancel is effective. This means
   * that even if _list.done is true (finished recieving data), we will still
   * be "running" whilst we have undisplayed items.
   */
  return (
    "_list" in this &&
    (!this._list.done || this._list.length > this._list.displayed) &&
    !this._list.cancelled
  );
};

CIRCNetwork.prototype.list = function (word, file) {
  if ("_list" in this && !this._list.done) {
    return false;
  }

  this._list = [];
  this._list.string = word;
  this._list.regexp = null;
  this._list.done = false;
  this._list.count = 0;
  if (file) {
    var lfile = new LocalFile(file);
    if (!lfile.localFile.exists()) {
      // futils.umask may be 0022. Result is 0644.
      lfile.localFile.create(
        Ci.nsIFile.NORMAL_FILE_TYPE,
        0o666 & ~futils.umask
      );
    }
    this._list.file = new LocalFile(lfile.localFile, ">");
  }

  if (isinstance(word, RegExp)) {
    this._list.regexp = word;
    this._list.string = "";
    word = "";
  }

  if (word) {
    this.primServ.sendData("LIST " + fromUnicode(word, this) + "\n");
  } else {
    this.primServ.sendData("LIST\n");
  }

  return true;
};

CIRCNetwork.prototype.listInit = function () {
  function checkEndList(network) {
    if (network._list.count == network._list.lastLength) {
      network.on323();
    } else {
      network._list.lastLength = network._list.count;
      network._list.endTimeout = setTimeout(checkEndList, 5000, network);
    }
  }

  function outputList(network) {
    const CHUNK_SIZE = 5;
    var list = network._list;
    if (list.cancelled) {
      if (list.done) {
        /* The server is no longer throwing stuff at us, so now
         * we can safely kill the list.
         */
        network.display(getMsg(MSG_LIST_END, [list.displayed, list.count]));
        delete network._list;
      } else {
        /* We cancelled the list, but we're still getting data.
         * Handle that data, but don't display, and do it more
         * slowly, so we cause less lag.
         */
        setTimeout(outputList, 1000, network);
      }
      return;
    }
    if (list.length > list.displayed) {
      var start = list.displayed;
      var end = list.length;
      if (end - start > CHUNK_SIZE) {
        end = start + CHUNK_SIZE;
      }
      for (var i = start; i < end; ++i) {
        network.displayHere(
          getMsg(MSG_FMT_CHANLIST, list[i]),
          "322",
          undefined,
          undefined,
          list[i][3]
        );
      }
      list.displayed = end;
    }
    if (list.done && list.displayed == list.length) {
      if (list.event323) {
        var length = list.event323.params.length;
        network.displayHere(
          list.event323.params[length - 1],
          "323",
          undefined,
          undefined,
          list.event323.tags
        );
      }
      network.displayHere(getMsg(MSG_LIST_END, [list.displayed, list.count]));
    } else {
      setTimeout(outputList, 250, network);
    }
  }

  if (!("_list" in this)) {
    this._list = [];
    this._list.string = MSG_UNKNOWN;
    this._list.regexp = null;
    this._list.done = false;
    this._list.count = 0;
  }

  if (!("file" in this._list)) {
    this._list.displayed = 0;
    if (client.currentObject != this) {
      display(getMsg(MSG_LIST_REROUTED, this.unicodeName));
    }
    setTimeout(outputList, 250, this);
  }
  this._list.lastLength = 0;
  this._list.endTimeout = setTimeout(checkEndList, 5000, this);
};

CIRCNetwork.prototype.abortList = function () {
  this._list.cancelled = true;
};

/* LIST reply header */
CIRCNetwork.prototype.on321 = function (e) {
  this.listInit();

  if (!("file" in this._list)) {
    this.displayHere(e.params[2] + " " + e.params[3], "321");
  }
};

/* end of LIST reply */
CIRCNetwork.prototype.on323 = function (e) {
  if (this._list.endTimeout) {
    clearTimeout(this._list.endTimeout);
    delete this._list.endTimeout;
  }
  if ("file" in this._list) {
    this._list.file.close();
  }

  this._list.done = true;
  this._list.event323 = e;
};

/* LIST reply */
CIRCNetwork.prototype.on322 = function (e) {
  if (!("_list" in this) || !("lastLength" in this._list)) {
    this.listInit();
  }

  ++this._list.count;

  /* If the list has been cancelled, don't bother adding all this info
   * anymore. Do increase the count (above), otherwise we never truly notice
   * the list being finished.
   */
  if (this._list.cancelled) {
    return;
  }

  var chanName = e.decodeParam(2);
  var topic = e.decodeParam(4);
  if (
    !this._list.regexp ||
    chanName.match(this._list.regexp) ||
    topic.match(this._list.regexp)
  ) {
    if (!("file" in this._list)) {
      this._list.push([chanName, e.params[3], topic, e.tags]);
    } else {
      this._list.file.write(
        fromUnicode(chanName, "UTF-8") +
          " " +
          e.params[3] +
          " " +
          fromUnicode(topic, "UTF-8") +
          "\n"
      );
    }
  }
};

/* ERR_NOSUCHNICK */
CIRCNetwork.prototype.on401 =
  /* ERR_NOSUCHSERVER */
  CIRCNetwork.prototype.on402 =
  /* ERR_NOSUCHCHANNEL */
  CIRCNetwork.prototype.on403 =
    function (e) {
      var server, channel, user;

      /* Note that servers generally only send 401 and 402, sharing the former
       * between nicknames and channels, but we're ready for anything.
       */
      if (e.code == 402) {
        server = e.decodeParam(2);
      } else if (e.server.channelTypes.includes(e.params[2][0])) {
        channel = new CIRCChannel(e.server, null, e.params[2]);
      } else {
        user = new CIRCUser(e.server, null, e.params[2]);
      }

      if (user && this.whoisList && user.collectionKey in this.whoisList) {
        // If this is from a /whois, send a /whowas and don't display anything.
        this.primServ.whowas(user.unicodeName, 1);
        this.whoisList[user.collectionKey] = false;
        return;
      }

      if (user) {
        user.display(
          getMsg(MSG_IRC_401, [user.unicodeName]),
          e.code,
          undefined,
          undefined,
          e.tags
        );
      } else if (server) {
        this.display(
          getMsg(MSG_IRC_402, [server]),
          e.code,
          undefined,
          undefined,
          e.tags
        );
      } else if (channel) {
        channel.display(
          getMsg(MSG_IRC_403, [channel.unicodeName]),
          e.code,
          undefined,
          undefined,
          e.tags
        );
      } else {
        dd("on401: unreachable code.");
      }
    };

/* 464; "invalid or missing password", occurs as a reply to both OPER and
 * sometimes initially during user registration. */
CIRCNetwork.prototype.on464 = function (e) {
  if (this.state == NET_CONNECTING) {
    // If we are in the process of connecting we are needing a login
    // password, subtly different from after user registration.
    this.display(MSG_IRC_464_LOGIN, e.code, undefined, undefined, e.tags);
  } else {
    e.destMethod = "onUnknown";
    e.destObject = this;
  }
};

/* end of WHO */
CIRCNetwork.prototype.on315 = function (e) {
  var matches;
  if ("whoMatches" in this) {
    matches = this.whoMatches;
  } else {
    matches = 0;
  }

  if ("pendingWhoReply" in this) {
    this.display(
      getMsg(MSG_WHO_END, [e.params[2], matches]),
      e.code,
      undefined,
      undefined,
      e.tags
    );
  }

  if ("whoUpdates" in this) {
    for (var c in this.whoUpdates) {
      this.primServ.channels[c].updateUsers(this.whoUpdates[c]);
    }
    delete this.whoUpdates;
  }

  delete this.pendingWhoReply;
  delete this.whoMatches;
};

CIRCNetwork.prototype.on352 = function (e) {
  //0-352 1-sender 2-channel 3-ident 4-host
  //5-server 6-nick 7-H/G 8-hops and realname
  if ("pendingWhoReply" in this) {
    var status;
    if (e.user.isAway) {
      status = MSG_GONE;
    } else {
      status = MSG_HERE;
    }

    this.display(
      getMsg(MSG_WHO_MATCH, [
        e.params[6],
        e.params[3],
        e.params[4],
        e.user.desc,
        status,
        e.decodeParam(2),
        e.params[5],
        e.user.hops,
      ]),
      e.code,
      e.user,
      undefined,
      e.tags
    );
  }

  updateTitle(e.user);
  if ("whoMatches" in this) {
    ++this.whoMatches;
  } else {
    this.whoMatches = 1;
  }

  if (!("whoUpdates" in this)) {
    this.whoUpdates = {};
  }

  if (e.userHasChanges) {
    for (var c in e.server.channels) {
      var chan = e.server.channels[c];
      if (chan.active && e.user.collectionKey in chan.users) {
        if (!(c in this.whoUpdates)) {
          this.whoUpdates[c] = [];
        }
        this.whoUpdates[c].push(chan.users[e.user.collectionKey]);
      }
    }
  }
};

CIRCNetwork.prototype.on354 = function (e) {
  //0-352 1-sender 2-type 3-channel 4-ident 5-host
  //6-server 7-nick 8-H/G 9-hops 10-account 11-realname
  if ("pendingWhoReply" in this) {
    var status;
    if (e.user.isAway) {
      status = MSG_GONE;
    } else {
      status = MSG_HERE;
    }

    this.display(
      getMsg(MSG_WHO_MATCH, [
        e.params[7],
        e.params[4],
        e.params[5],
        e.user.desc,
        status,
        e.decodeParam(3),
        e.params[6],
        e.user.hops,
      ]),
      e.code,
      e.user,
      undefined,
      e.tags
    );
  }

  updateTitle(e.user);
  if ("whoMatches" in this) {
    ++this.whoMatches;
  } else {
    this.whoMatches = 1;
  }

  if (!("whoUpdates" in this)) {
    this.whoUpdates = {};
  }

  if (e.userHasChanges) {
    for (var c in e.server.channels) {
      var chan = e.server.channels[c];
      if (chan.active && e.user.collectionKey in chan.users) {
        if (!(c in this.whoUpdates)) {
          this.whoUpdates[c] = [];
        }
        this.whoUpdates[c].push(chan.users[e.user.collectionKey]);
      }
    }
  }
};

/* user away message */
CIRCNetwork.prototype.on301 = function (e) {
  if (e.user.awayMessage != e.user.lastShownAwayMessage) {
    var params = [e.user.unicodeName, e.user.awayMessage];
    e.user.display(
      getMsg(MSG_WHOIS_AWAY, params),
      e.code,
      undefined,
      undefined,
      e.tags
    );
    e.user.lastShownAwayMessage = e.user.awayMessage;
  }
};

/* whois name */
CIRCNetwork.prototype.on311 =
  /* whois channels */
  CIRCNetwork.prototype.on319 =
  /* whois server */
  CIRCNetwork.prototype.on312 =
  /* whois idle time */
  CIRCNetwork.prototype.on317 =
  /* whois end of whois*/
  CIRCNetwork.prototype.on318 =
  /* ircu's 330 numeric ("X is logged in as Y") */
  CIRCNetwork.prototype.on330 =
  /* misc whois line */
  CIRCNetwork.prototype.onUnknownWhois =
    function (e) {
      var text = "egads!";
      var nick = e.params[2];
      var lowerNick = this.primServ.toLowerCase(nick);
      var user;

      if (this.whoisList && e.code != 318 && lowerNick in this.whoisList) {
        this.whoisList[lowerNick] = true;
      }

      if (e.user) {
        user = e.user;
        nick = user.unicodeName;
      }

      switch (Number(e.code)) {
        case 311:
          // Clear saved away message so it appears and can be reset.
          if (e.user) {
            e.user.lastShownAwayMessage = "";
          }

          text = getMsg(MSG_WHOIS_NAME, [
            nick,
            e.params[3],
            e.params[4],
            e.decodeParam(6),
          ]);
          break;

        case 319:
          var ary = e.decodeParam(3).trim().split(" ");
          text = getMsg(MSG_WHOIS_CHANNELS, [nick, arraySpeak(ary)]);
          break;

        case 312:
          text = getMsg(MSG_WHOIS_SERVER, [nick, e.params[3], e.params[4]]);
          break;

        case 317:
          text = getMsg(MSG_WHOIS_IDLE, [
            nick,
            formatDateOffset(Number(e.params[3])),
            new Date(Number(e.params[4]) * 1000),
          ]);
          break;

        case 318:
          // If the user isn't here, then we sent a whowas in on401.
          // Don't display the "end of whois" message.
          if (
            this.whoisList &&
            lowerNick in this.whoisList &&
            !this.whoisList[lowerNick]
          ) {
            delete this.whoisList[lowerNick];
            return;
          }
          if (this.whoisList) {
            delete this.whoisList[lowerNick];
          }

          text = getMsg(MSG_WHOIS_END, nick);
          if (user) {
            user.updateHeader();
          }
          break;

        case 330:
          text = getMsg(MSG_FMT_LOGGED_ON, [e.decodeParam(2), e.params[3]]);
          break;

        default:
          text = toUnicode(e.params.splice(2, e.params.length).join(" "), this);
      }

      if (e.user) {
        e.user.display(text, e.code, undefined, undefined, e.tags);
      } else {
        this.display(text, e.code, undefined, undefined, e.tags);
      }
    };

/* invite reply */
CIRCNetwork.prototype.on341 = function (e) {
  this.display(
    getMsg(MSG_YOU_INVITE, [e.decodeParam(2), e.decodeParam(3)]),
    "341",
    undefined,
    undefined,
    e.tags
  );
};

/* invite message */
CIRCNetwork.prototype.onInvite = function (e) {
  var invitee = e.params[1];
  if (invitee == e.server.me.unicodeName) {
    client.munger.getRule(".inline-buttons").enabled = true;
    this.display(
      getMsg(MSG_INVITE_YOU, [
        e.user.unicodeName,
        e.user.name,
        e.user.host,
        e.channel.unicodeName,
        e.channel.unicodeName,
        e.channel.getURL(),
      ]),
      "INVITE",
      undefined,
      undefined,
      e.tags
    );
    client.munger.getRule(".inline-buttons").enabled = false;

    if ("messages" in e.channel) {
      e.channel.join();
    }
  } else {
    this.display(
      getMsg(MSG_INVITE_SOMEONE, [
        e.user.unicodeName,
        invitee,
        e.channel.unicodeName,
      ]),
      "INVITE",
      undefined,
      undefined,
      e.tags
    );
  }
};

/* nickname in use */
CIRCNetwork.prototype.on433 = function (e) {
  var nick = toUnicode(e.params[2], this);

  if ("pendingReclaimCheck" in this) {
    delete this.pendingReclaimCheck;
    return;
  }

  if (this.state == NET_CONNECTING) {
    var nickIndex = this.prefs.nicknameList.indexOf(nick);
    var newnick = null;

    dd("433: failed with " + nick + " (" + nickIndex + ")");

    var tryList = true;

    if (
      ("_firstNick" in this && this._firstNick == -1) ||
      this.prefs.nicknameList.length == 0 ||
      (nickIndex != -1 && this.prefs.nicknameList.length < 2)
    ) {
      tryList = false;
    }

    if (tryList) {
      nickIndex = (nickIndex + 1) % this.prefs.nicknameList.length;

      if ("_firstNick" in this && this._firstNick == nickIndex) {
        // We're back where we started. Give up with this method.
        this._firstNick = -1;
        tryList = false;
      }
    }

    if (tryList) {
      newnick = this.prefs.nicknameList[nickIndex];
      dd("     trying " + newnick + " (" + nickIndex + ")");

      // Save first index we've tried.
      if (!("_firstNick" in this)) {
        this._firstNick = nickIndex;
      }
    } else if (this.NICK_RETRIES > 0) {
      newnick = this.INITIAL_NICK + "_";
      this.NICK_RETRIES--;
      dd("     trying " + newnick);
    }

    if (newnick) {
      this.INITIAL_NICK = newnick;
      this.display(
        getMsg(MSG_RETRY_NICK, [nick, newnick]),
        "433",
        undefined,
        undefined,
        e.tags
      );
      this.primServ.changeNick(newnick);
    } else {
      this.display(
        getMsg(MSG_NICK_IN_USE, nick),
        "433",
        undefined,
        undefined,
        e.tags
      );
    }
  } else {
    this.display(
      getMsg(MSG_NICK_IN_USE, nick),
      "433",
      undefined,
      undefined,
      e.tags
    );
  }
};

CIRCNetwork.prototype.onStartConnect = function (e) {
  this.busy = true;
  updateProgress();
  if ("_firstNick" in this) {
    delete this._firstNick;
  }

  client.munger.getRule(".inline-buttons").enabled = true;
  this.display(
    getMsg(MSG_CONNECTION_ATTEMPT, [
      this.getURL(),
      e.server.getURL(),
      this.unicodeName,
      "cancel",
    ]),
    "INFO"
  );
  client.munger.getRule(".inline-buttons").enabled = false;

  if (this.prefs["identd.enabled"]) {
    try {
      client.ident.addNetwork(this, e.server);
    } catch (ex) {
      display(getMsg(MSG_IDENT_ERROR, formatException(ex)), MT_ERROR);
    }
  }

  this.NICK_RETRIES = this.prefs.nicknameList.length + 3;

  // When connection begins, autoperform has not been sent
  this.autoPerformSent = false;
};

CIRCNetwork.prototype.onError = function (e) {
  var msg;
  var type = MT_ERROR;

  if (typeof e.errorCode != "undefined") {
    switch (e.errorCode) {
      case JSIRC_ERR_NO_SOCKET:
        msg = MSG_ERR_NO_SOCKET;
        break;

      case JSIRC_ERR_EXHAUSTED:
        // error already displayed in onDisconnect
        break;

      case JSIRC_ERR_OFFLINE:
        msg = MSG_ERR_OFFLINE;
        break;

      case JSIRC_ERR_NO_SECURE:
        msg = getMsg(MSG_ERR_NO_SECURE, this.unicodeName);
        break;

      case JSIRC_ERR_CANCELLED:
        msg = MSG_ERR_CANCELLED;
        type = MT_INFO;
        break;

      case JSIRC_ERR_PAC_LOADING:
        msg = MSG_WARN_PAC_LOADING;
        type = MT_WARN;
        break;
    }
  } else {
    msg = e.params[e.params.length - 1];
  }

  dispatch("sync-header");
  updateTitle();

  if (this.state == NET_OFFLINE) {
    this.busy = false;
    updateProgress();
  }

  client.ident.removeNetwork(this);

  if (msg) {
    this.display(msg, type);
  }

  if (e.errorCode == JSIRC_ERR_PAC_LOADING) {
    return;
  }

  if (this.deleteWhenDone) {
    this.dispatch("delete-view");
  }

  delete this.deleteWhenDone;
};

CIRCNetwork.prototype.onDisconnect = function (e) {
  var msg, msgNetwork;
  var msgType = MT_ERROR;
  var retrying = true;

  if (typeof e.disconnectStatus != "undefined") {
    switch (e.disconnectStatus) {
      case 0:
        msg = getMsg(MSG_CONNECTION_CLOSED, [this.getURL(), e.server.getURL()]);
        break;

      case NS_ERROR_CONNECTION_REFUSED:
        msg = getMsg(MSG_CONNECTION_REFUSED, [
          this.getURL(),
          e.server.getURL(),
        ]);
        break;

      case NS_ERROR_NET_TIMEOUT:
        msg = getMsg(MSG_CONNECTION_TIMEOUT, [
          this.getURL(),
          e.server.getURL(),
        ]);
        break;

      case NS_ERROR_NET_RESET:
        msg = getMsg(MSG_CONNECTION_RESET, [this.getURL(), e.server.getURL()]);
        break;

      case NS_ERROR_NET_INTERRUPT:
        msg = getMsg(MSG_CONNECTION_INTERRUPT, [
          this.getURL(),
          e.server.getURL(),
        ]);
        break;

      case NS_ERROR_UNKNOWN_HOST:
        msg = getMsg(MSG_UNKNOWN_HOST, [
          e.server.hostname,
          this.getURL(),
          e.server.getURL(),
        ]);
        break;

      case NS_ERROR_UNKNOWN_PROXY_HOST:
        msg = getMsg(MSG_UNKNOWN_PROXY_HOST, [
          this.getURL(),
          e.server.getURL(),
        ]);
        break;

      case NS_ERROR_PROXY_CONNECTION_REFUSED:
        msg = MSG_PROXY_CONNECTION_REFUSED;
        break;

      case NS_ERROR_OFFLINE:
        msg = MSG_ERR_OFFLINE;
        retrying = false;
        break;

      case NS_ERROR_ABORT:
        if (Services.io.offline) {
          msg = getMsg(MSG_CONNECTION_ABORT_OFFLINE, [
            this.getURL(),
            e.server.getURL(),
          ]);
        } else {
          msg = getMsg(MSG_CONNECTION_ABORT_UNKNOWN, [
            this.getURL(),
            e.server.getURL(),
            formatException(e.exception),
          ]);
        }
        retrying = false;
        break;

      default:
        let nssErrSvc = Cc["@mozilla.org/nss_errors_service;1"].getService(
          Ci.nsINSSErrorsService
        );
        let errClass = 0;
        // Check if e.disconnectStatus is within the valid range for
        // NSS Errors.
        if (e.disconnectStatus >= 8192 && e.disconnectStatus < 20480) {
          errClass = nssErrSvc.getErrorClass(e.disconnectStatus);
        }
        // Check here if it's a cert error.
        // The exception adding dialog will explain the reasons.
        if (errClass == Ci.nsINSSErrorsService.ERROR_CLASS_BAD_CERT) {
          var cmd = "ssl-exception";
          cmd += " " + e.server.hostname + " " + e.server.port;
          cmd += " true";
          msg = getMsg(MSG_INVALID_CERT, [this.getURL(), cmd]);
          retrying = false;
          break;
        }

        // If it's a protocol error, we can still display a useful message.
        var statusMsg = e.disconnectStatus;
        if (errClass == Ci.nsINSSErrorsService.ERROR_CLASS_SSL_PROTOCOL) {
          var errMsg = nssErrSvc.getErrorMessage(e.disconnectStatus);
          errMsg = errMsg.replace(/\.$/, "");
          statusMsg += " (" + errMsg + ")";
        }

        msg = getMsg(MSG_CLOSE_STATUS, [
          this.getURL(),
          e.server.getURL(),
          statusMsg,
        ]);
        break;
    }
  } else {
    msg = getMsg(MSG_CONNECTION_CLOSED, [this.getURL(), e.server.getURL()]);
  }

  // e.quitting signals the disconnect was intended: don't use "ERROR".
  if (e.quitting) {
    msgType = "DISCONNECT";
    msg = getMsg(MSG_CONNECTION_QUIT, [
      this.getURL(),
      e.server.getURL(),
      this.unicodeName,
      "reconnect",
    ]);
    msgNetwork = msg;
  }
  // We won't reconnect if the error was really bad, or if the user doesn't
  // want us to do so.
  else if (!retrying || !this.stayingPower) {
    msgNetwork = msg;
  } else {
    var delayStr = formatDateOffset(this.getReconnectDelayMs() / 1000);
    if (this.MAX_CONNECT_ATTEMPTS == -1) {
      msgNetwork = getMsg(MSG_RECONNECTING_IN, [
        msg,
        delayStr,
        this.unicodeName,
        "cancel",
      ]);
    } else if (this.connectAttempt < this.MAX_CONNECT_ATTEMPTS) {
      var left = this.MAX_CONNECT_ATTEMPTS - this.connectAttempt;
      if (left == 1) {
        msgNetwork = getMsg(MSG_RECONNECTING_IN_LEFT1, [
          msg,
          delayStr,
          this.unicodeName,
          "cancel",
        ]);
      } else {
        msgNetwork = getMsg(MSG_RECONNECTING_IN_LEFT, [
          msg,
          left,
          delayStr,
          this.unicodeName,
          "cancel",
        ]);
      }
    } else {
      msgNetwork = getMsg(MSG_CONNECTION_EXHAUSTED, msg);
    }
  }

  /* If we were connected ok, put an error on all tabs. If we were only
   * /trying/ to connect, and failed, just put it on the network tab.
   */
  client.munger.getRule(".inline-buttons").enabled = true;
  if (this.state == NET_ONLINE) {
    for (var v in client.viewsArray) {
      var obj = client.viewsArray[v].source;
      if (obj == this) {
        obj.displayHere(msgNetwork, msgType);
      } else if (obj != client) {
        var details = getObjectDetails(obj);
        if ("server" in details && details.server == e.server) {
          obj.displayHere(msg, msgType);
        }
      }
    }
  } else {
    this.busy = false;
    updateProgress();

    // Don't do anything if we're cancelling.
    if (this.state != NET_CANCELLING) {
      this.displayHere(msgNetwork, msgType);
    }
  }
  client.munger.getRule(".inline-buttons").enabled = false;

  for (var c in this.primServ.channels) {
    var channel = this.primServ.channels[c];
    channel._clearUserList();
  }

  dispatch("sync-header");
  updateTitle();
  updateProgress();
  updateSecurityIcon();

  client.ident.removeNetwork(this);

  if (
    "userClose" in client &&
    client.userClose &&
    client.getConnectionCount() == 0
  ) {
    window.close();
  }

  // Renew the STS policy.
  if (e.server.isSecure && "sts" in e.server.caps && client.sts.ENABLED) {
    var policy = client.sts.parseParameters(e.server.capvals.sts);
    client.sts.setPolicy(e.server.hostname, e.server.port, policy.duration);
  }

  if ("reconnect" in this && this.reconnect) {
    if ("stsUpgradePort" in this) {
      e.server.port = this.stsUpgradePort;
      e.server.isSecure = true;
      delete this.stsUpgradePort;
    }
    this.connect(this.requireSecurity);
    delete this.reconnect;
  }
};

CIRCNetwork.prototype.onCTCPReplyPing = function (e) {
  // see bug 326523
  if (e.CTCPData.trim().length != 13) {
    this.display(
      getMsg(MSG_PING_REPLY_INVALID, e.user.unicodeName),
      "INFO",
      e.user,
      "ME!",
      e.tags
    );
    return;
  }

  var delay = formatDateOffset(
    (new Date() - new Date(Number(e.CTCPData))) / 1000
  );
  this.display(
    getMsg(MSG_PING_REPLY, [e.user.unicodeName, delay]),
    "INFO",
    e.user,
    "ME!",
    e.tags
  );
};

CIRCNetwork.prototype.on221 = CIRCNetwork.prototype.onUserMode = function (e) {
  if ("user" in e && e.user) {
    e.user.updateHeader();
    this.display(
      getMsg(MSG_USER_MODE, [e.user.unicodeName, e.params[2]]),
      MT_MODE,
      undefined,
      undefined,
      e.tags
    );
  } else {
    this.display(
      getMsg(MSG_USER_MODE, [e.params[1], e.params[2]]),
      MT_MODE,
      undefined,
      undefined,
      e.tags
    );
  }
};

CIRCNetwork.prototype.onNick = function (e) {
  if (!ASSERT(userIsMe(e.user), "network nick event for third party")) {
    return;
  }

  if (
    "pendingNickChange" in this &&
    this.pendingNickChange == e.user.unicodeName
  ) {
    this.prefs.nickname = e.user.unicodeName;
    this.preferredNick = e.user.unicodeName;
    delete this.pendingNickChange;
  }

  if (getTabForObject(this)) {
    this.displayHere(
      getMsg(MSG_NEWNICK_YOU, e.user.unicodeName),
      "NICK",
      "ME!",
      e.user,
      e.tags
    );
  }

  this.updateHeader();
  updateStalkExpression(this);
};

CIRCNetwork.prototype.onPing = function (e) {
  this.updateHeader(this);
};

CIRCNetwork.prototype.onPong = function (e) {
  this.updateHeader(this);
};

CIRCNetwork.prototype.onWallops = function (e) {
  client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
  if (e.user) {
    this.display(e.msg, "WALLOPS/WALLOPS", e.user, this, e.tags);
  } else {
    this.display(e.msg, "WALLOPS/WALLOPS", undefined, this, e.tags);
  }
  client.munger.getRule(".mailto").enabled = false;
};

/* unknown command reply */
CIRCNetwork.prototype.on421 = function (e) {
  this.display(
    getMsg(MSG_IRC_421, e.decodeParam(2)),
    MT_ERROR,
    undefined,
    undefined,
    e.tags
  );
  return true;
};

/* cap reply */
CIRCNetwork.prototype.onCap = function (e) {
  if (e.params[2] == "LS") {
    // Handle the STS upgrade policy if we have one.
    if (e.server.pendingCapNegotiation && e.stsUpgradePort) {
      this.display(getMsg(MSG_STS_UPGRADE, e.stsUpgradePort));
      this.reconnect = true;
      this.stsUpgradePort = e.stsUpgradePort;
      this.quit(MSG_RECONNECTING);
      return true;
    }

    // Don't show the raw message until we've registered.
    if (this.state == NET_ONLINE) {
      var listCaps = [];
      for (var cap in e.server.caps) {
        var value = e.server.capvals[cap];
        if (value) {
          cap += "=" + value;
        }
        listCaps.push(cap);
      }
      if (listCaps.length > 0) {
        listCaps.sort();
        this.display(getMsg(MSG_SUPPORTS_CAPS, listCaps.join(", ")));
      }
    }

    // Update the STS duration policy.
    if (e.server.isSecure && "sts" in e.server.caps && client.sts.ENABLED) {
      var policy = client.sts.parseParameters(e.server.capvals.sts);
      client.sts.setPolicy(e.server.hostname, e.server.port, policy.duration);
    }
  } else if (e.params[2] == "LIST") {
    var listCapsEnabled = [];
    for (var cap in e.server.caps) {
      if (e.server.caps[cap]) {
        listCapsEnabled.push(cap);
      }
    }
    if (listCapsEnabled.length > 0) {
      listCapsEnabled.sort();
      this.display(getMsg(MSG_SUPPORTS_CAPSON, listCapsEnabled.join(", ")));
    }
  } else if (e.params[2] == "ACK") {
    if (e.capsOn.length) {
      this.display(getMsg(MSG_CAPS_ON, e.capsOn.join(", ")));
    }
    if (e.capsOff.length) {
      this.display(getMsg(MSG_CAPS_OFF, e.capsOff.join(", ")));
    }
  } else if (e.params[2] == "NAK") {
    this.display(getMsg(MSG_CAPS_ERROR, e.caps.join(", ")));
  } else if (e.params[2] == "NEW") {
    // Handle a new STS policy
    if (client.sts.ENABLED && e.newcaps.includes("sts")) {
      var policy = client.sts.parseParameters(e.server.capvals.sts);
      if (!e.server.isSecure && policy.port) {
        // Inform the user of the new upgrade policy and
        // offer an option to reconnect.
        client.munger.getRule(".inline-buttons").enabled = true;
        this.display(
          getMsg(MSG_STS_UPGRADE_NEW, [this.unicodeName, "reconnect"])
        );
        client.munger.getRule(".inline-buttons").enabled = false;
      } else if (e.server.isSecure && policy.duration) {
        // Renew the policy's duration.
        client.sts.setPolicy(e.server.hostname, e.server.port, policy.duration);
      }
    }
  }
  return true;
};

// Notify the user of received CTCP requests.
CIRCNetwork.prototype.onReceiveCTCP = function (e) {
  // Do nothing if we receive these.
  if (e.type == "ctcp-action" || e.type == "ctcp-dcc" || e.type == "unk-ctcp") {
    return true;
  }

  this.display(
    getMsg(MSG_FMT_CTCPRECV, [
      toUnicode(e.CTCPCode, this),
      toUnicode(e.CTCPData, this),
      e.user.unicodeName,
    ]),
    "CTCP_REQUEST",
    e.user,
    e.server.me,
    e.tags
  );

  return true;
};

/* SASL authentication start */
CIRCNetwork.prototype.onSASLStart = function (e) {
  if (!e.mechs || e.mechs.includes("plain")) {
    e.server.sendData("AUTHENTICATE PLAIN\n");
  }
};

/* SASL authentication response */
CIRCNetwork.prototype.onAuthenticate = function (e) {
  if (e.params[1] !== "+") {
    return;
  }

  var username = e.server.me.encodedName;
  var password = client.tryToGetLogin(
    e.server.parent.getURL(),
    "sasl",
    e.server.me.name,
    null,
    true,
    getMsg(MSG_SASL_PASSWORD, username)
  );
  if (!password) {
    // Abort authentication.
    e.server.sendAuthAbort();
    return;
  }

  var auth = username + "\0" + username + "\0" + password;
  e.server.sendAuthResponse(auth);
};

CIRCNetwork.prototype.onNetsplitBatch = function (e) {
  for (var c in this.primServ.channels) {
    if (e.starting) {
      this.startMsgGroup(
        e.reftag,
        getMsg(MSG_BATCH_NETSPLIT_START, [e.params[3], e.params[4]]),
        e.batchtype
      );
    } else {
      this.display(MSG_BATCH_NETSPLIT_END, e.batchtype);
      this.endMsgGroup();
    }
  }
};

CIRCNetwork.prototype.onNetjoinBatch = function (e) {
  for (var c in this.primServ.channels) {
    if (e.starting) {
      this.startMsgGroup(
        e.reftag,
        getMsg(MSG_BATCH_NETJOIN_START, [e.params[3], e.params[4]]),
        e.batchtype
      );
    } else {
      this.display(MSG_BATCH_NETJOIN_END, e.batchtype);
      this.endMsgGroup();
    }
  }
};

CIRCChannel.prototype.onChathistoryBatch = function (e) {
  if (e.starting) {
    this.startMsgGroup(
      e.reftag,
      getMsg(MSG_BATCH_CHATHISTORY_START, [e.params[3]]),
      e.batchtype
    );
  } else {
    this.display(MSG_BATCH_CHATHISTORY_END, e.batchtype);
    this.endMsgGroup();
  }
};

CIRCNetwork.prototype.onUnknownBatch =
  CIRCChannel.prototype.onUnknownBatch =
  CIRCUser.prototype.onUnknownBatch =
    function (e) {
      if (e.starting) {
        this.startMsgGroup(
          e.reftag,
          getMsg(MSG_BATCH_UNKNOWN, [e.batchtype, e.params.slice(3)]),
          "BATCH"
        );
      } else {
        this.display(MSG_BATCH_UNKNOWN_END, e.batchtype);
        this.endMsgGroup();
      }
    };

/* user away status */
CIRCNetwork.prototype.onAway = function (e) {
  this.updateUser(e, e.user);
};

/* user host changed */
CIRCNetwork.prototype.onChghost = function (e) {
  e.user.updateHeader();
};

CIRCNetwork.prototype.updateUser = function (e, user) {
  for (let c in e.server.channels) {
    let chan = e.server.channels[c];
    if (chan.active && user.collectionKey in chan.users) {
      let chanUser = chan.users[user.collectionKey];
      chan.updateUsers([chanUser]);
    }
  }
};

CIRCNetwork.prototype.reclaimName = function () {
  var network = this;

  function callback() {
    network.reclaimName();
  }

  if ("pendingReclaimCheck" in this) {
    delete this.pendingReclaimCheck;
  }

  // Function to attempt to get back the nickname the user wants.
  if (this.state != NET_ONLINE || !this.primServ) {
    return false;
  }

  if (this.primServ.me.unicodeName == this.preferredNick) {
    return false;
  }

  this.reclaimLeft -= this.RECLAIM_WAIT;

  if (this.reclaimLeft <= 0) {
    return false;
  }

  this.pendingReclaimCheck = true;
  this.INITIAL_NICK = this.preferredNick;
  this.primServ.changeNick(this.preferredNick);

  setTimeout(callback, this.RECLAIM_WAIT);

  return true;
};

CIRCNetwork.prototype.doAutoPerform = function () {
  if ("autoPerformSent" in this && this.autoPerformSent == false) {
    var cmdary = client.prefs["autoperform.network"].concat(
      this.prefs.autoperform
    );
    for (var i = 0; i < cmdary.length; ++i) {
      if (cmdary[i][0] == "/") {
        this.dispatch(cmdary[i].substr(1));
      } else {
        this.dispatch(cmdary[i]);
      }
    }
    this.autoPerformSent = true;
  }
};

/* We want to override the base implementations. */
CIRCChannel.prototype._join = CIRCChannel.prototype.join;
CIRCChannel.prototype._part = CIRCChannel.prototype.part;

CIRCChannel.prototype.join = function (key) {
  var joinFailedFn = function (t) {
    delete t.joinTimer;
    t.busy = false;
    updateProgress();
  };
  if (!this.joined) {
    this.joinTimer = setTimeout(joinFailedFn, 30000, this);
    this.busy = true;
    updateProgress();
  }
  this._join(key);
};

CIRCChannel.prototype.part = function (reason) {
  var partFailedFn = function (t) {
    delete t.partTimer;
    t.busy = false;
    updateProgress();
  };
  this.partTimer = setTimeout(partFailedFn, 30000, this);
  this.busy = true;
  updateProgress();
  this._part(reason);
};

client.setActivityMarker =
  CIRCNetwork.prototype.setActivityMarker =
  CIRCChannel.prototype.setActivityMarker =
  CIRCUser.prototype.setActivityMarker =
  CIRCDCCChat.prototype.setActivityMarker =
  CIRCDCCFileTransfer.prototype.setActivityMarker =
    function (state) {
      if (!client.initialized) {
        return;
      }

      // Always clear the activity marker first.
      var markedRow = this.getActivityMarker();
      if (markedRow) {
        markedRow.classList.remove("chatzilla-line-marker");
      }

      if (state) {
        // Mark the last row.
        var target = this.messages.firstChild.lastChild;
        if (!target) {
          return;
        }
        target.classList.add("chatzilla-line-marker");
      }
    };

client.getActivityMarker =
  CIRCNetwork.prototype.getActivityMarker =
  CIRCChannel.prototype.getActivityMarker =
  CIRCUser.prototype.getActivityMarker =
  CIRCDCCChat.prototype.getActivityMarker =
  CIRCDCCFileTransfer.prototype.getActivityMarker =
    function () {
      return this.messages.querySelector(".chatzilla-line-marker");
    };

CIRCChannel.prototype.onInit = function () {
  this.logFile = null;
  this.pendingNamesReply = false;
  this.importantMessages = 0;
};

CIRCChannel.prototype.onPrivmsg = function (e) {
  var msg = e.decodeParam(2);
  var msgtype = "PRIVMSG";
  if ("msgPrefix" in e) {
    msgtype += "/" + e.msgPrefix.symbol;
  }

  client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
  this.display(msg, msgtype, e.user, this, e.tags);
  client.munger.getRule(".mailto").enabled = false;
};

/* end of names */
CIRCChannel.prototype.on366 = function (e) {
  // First clear up old users:
  this._clearUserList();

  this.addUsers(Object.values(this.users));

  if (this.pendingNamesReply) {
    this.parent.parent.display(
      e.channel.unicodeName + ": " + e.params[3],
      "366",
      undefined,
      undefined,
      e.tags
    );
  }
  this.pendingNamesReply = false;

  // Update conference mode now we have a complete user list.
  this._updateConferenceMode();
};

/* user changed topic */
CIRCChannel.prototype.onTopic =
  /* TOPIC reply */
  CIRCChannel.prototype.on332 = function (e) {
    client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
    if (e.code == "TOPIC") {
      this.display(
        getMsg(MSG_TOPIC_CHANGED, [this.topicBy, this.topic]),
        "TOPIC",
        undefined,
        undefined,
        e.tags
      );
    }

    if (e.code == "332") {
      if (this.topic) {
        this.display(
          getMsg(MSG_TOPIC, [this.unicodeName, this.topic]),
          "TOPIC",
          undefined,
          undefined,
          e.tags
        );
      } else {
        this.display(
          getMsg(MSG_NO_TOPIC, this.unicodeName),
          "TOPIC",
          undefined,
          undefined,
          e.tags
        );
      }
    }

    this.updateHeader();
    updateTitle(this);
    client.munger.getRule(".mailto").enabled = false;
  };

/* Topic setter information */
CIRCChannel.prototype.on333 = function (e) {
  this.display(
    getMsg(MSG_TOPIC_DATE, [this.unicodeName, this.topicBy, this.topicDate]),
    "TOPIC",
    undefined,
    undefined,
    e.tags
  );
};

/* names reply */
CIRCChannel.prototype.on353 = function (e) {
  if (this.pendingNamesReply) {
    this.parent.parent.display(
      e.channel.unicodeName + ": " + e.params[4],
      "NAMES",
      undefined,
      undefined,
      e.tags
    );
  }
};

/* channel ban stuff */
CIRCChannel.prototype.on367 = function (e) {
  if ("pendingBanList" in this) {
    return;
  }

  var msg = getMsg(MSG_BANLIST_ITEM, [
    e.user.unicodeName,
    e.ban,
    this.unicodeName,
    e.banTime,
  ]);
  if (this.iAmHalfOp() || this.iAmOp()) {
    msg += " " + getMsg(MSG_BANLIST_BUTTON, "mode -b " + e.ban);
  }

  client.munger.getRule(".inline-buttons").enabled = true;
  this.display(msg, "BAN", undefined, undefined, e.tags);
  client.munger.getRule(".inline-buttons").enabled = false;
};

CIRCChannel.prototype.on368 = function (e) {
  if ("pendingBanList" in this) {
    return;
  }

  this.display(
    getMsg(MSG_BANLIST_END, this.unicodeName),
    "BAN",
    undefined,
    undefined,
    e.tags
  );
};

/* channel except stuff */
CIRCChannel.prototype.on348 = function (e) {
  if ("pendingExceptList" in this) {
    return;
  }

  var msg = getMsg(MSG_EXCEPTLIST_ITEM, [
    e.user.unicodeName,
    e.except,
    this.unicodeName,
    e.exceptTime,
  ]);
  if (this.iAmHalfOp() || this.iAmOp()) {
    msg += " " + getMsg(MSG_EXCEPTLIST_BUTTON, "mode -e " + e.except);
  }

  client.munger.getRule(".inline-buttons").enabled = true;
  this.display(msg, "EXCEPT", undefined, undefined, e.tags);
  client.munger.getRule(".inline-buttons").enabled = false;
};

CIRCChannel.prototype.on349 = function (e) {
  if ("pendingExceptList" in this) {
    return;
  }

  this.display(
    getMsg(MSG_EXCEPTLIST_END, this.unicodeName),
    "EXCEPT",
    undefined,
    undefined,
    e.tags
  );
};

CIRCChannel.prototype.on482 = function (e) {
  if ("pendingExceptList" in this) {
    return;
  }

  this.display(
    getMsg(MSG_CHANNEL_NEEDOPS, this.unicodeName),
    MT_ERROR,
    undefined,
    undefined,
    e.tags
  );
};

CIRCChannel.prototype.onNotice = function (e) {
  var msgtype = "NOTICE";
  if ("msgPrefix" in e) {
    msgtype += "/" + e.msgPrefix.symbol;
  }

  client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
  this.display(e.decodeParam(2), msgtype, e.user, this, e.tags);
  client.munger.getRule(".mailto").enabled = false;
};

CIRCChannel.prototype.onCTCPAction = function (e) {
  client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
  this.display(e.CTCPData, "ACTION", e.user, this, e.tags);
  client.munger.getRule(".mailto").enabled = false;
};

CIRCChannel.prototype.onUnknownCTCP = function (e) {
  this.display(
    getMsg(MSG_UNKNOWN_CTCP, [e.CTCPCode, e.CTCPData, e.user.unicodeName]),
    "BAD-CTCP",
    e.user,
    this,
    e.tags
  );
};

CIRCChannel.prototype.onJoin = function (e) {
  dispatch("create-tab-for-view", { view: e.channel });

  if (userIsMe(e.user)) {
    var params = [e.user.unicodeName, e.channel.unicodeName];
    this.display(
      getMsg(MSG_YOU_JOINED, params),
      "JOIN",
      e.server.me,
      this,
      e.tags
    );
    /* Tell the user that conference mode is on, lest they forget (if it
     * subsequently turns itself off, they'll get a message anyway).
     */
    if (this.prefs["conference.enabled"]) {
      this.display(MSG_CONF_MODE_STAYON);
    }
    addURLToHistory(this.getURL());

    if ("joinTimer" in this) {
      clearTimeout(this.joinTimer);
      delete this.joinTimer;
      this.busy = false;
      updateProgress();
    }

    /* !-channels are "safe" channels, and get a server-generated prefix.
     * For this reason, creating the channel is delayed until this point.
     */
    if (e.channel.unicodeName[0] == "!") {
      dispatch("set-current-view", { view: e.channel });
    }

    this.doAutoPerform();
  } else {
    if (!this.prefs["conference.enabled"]) {
      this.display(
        getMsg(MSG_SOMEONE_JOINED, [
          e.user.unicodeName,
          e.user.name,
          e.user.host,
          e.channel.unicodeName,
        ]),
        "JOIN",
        e.user,
        this,
        e.tags
      );
    }

    /* Only do this for non-me joins so us joining doesn't reset it (when
     * we join the usercount is always 1). Also, do this after displaying
     * the join message so we don't get cryptic effects such as a user
     * joining causes *only* a "Conference mode enabled" message.
     */
    this._updateConferenceMode();
  }

  /* We don't want to add ourself here, since the names reply we'll be
   * getting right after the join will include us as well! (FIXME)
   */
  if (!userIsMe(e.user)) {
    this.addUsers([e.user]);
  }
  this.updateHeader();
};

CIRCChannel.prototype.onPart = function (e) {
  this.removeUsers([e.user]);
  this.updateHeader();

  if (userIsMe(e.user)) {
    var msg = e.reason ? MSG_YOU_LEFT_REASON : MSG_YOU_LEFT;
    var params = [e.user.unicodeName, e.channel.unicodeName, e.reason];
    this.display(getMsg(msg, params), "PART", e.user, this, e.tags);
    this._clearUserList();

    if ("partTimer" in this) {
      clearTimeout(this.partTimer);
      delete this.partTimer;
      this.busy = false;
      updateProgress();
    }

    if (this.deleteWhenDone) {
      this.dispatch("delete-view");
    }

    delete this.deleteWhenDone;
  } else {
    /* We're ok to update this before the message, because the only thing
     * that can happen is *disabling* of conference mode.
     */
    this._updateConferenceMode();

    if (!this.prefs["conference.enabled"]) {
      var msg = e.reason ? MSG_SOMEONE_LEFT_REASON : MSG_SOMEONE_LEFT;
      var params = [e.user.unicodeName, e.channel.unicodeName, e.reason];
      this.display(getMsg(msg, params), "PART", e.user, this, e.tags);
    }

    this.removeFromList(e.user);
  }
};

CIRCChannel.prototype.onKick = function (e) {
  if (userIsMe(e.lamer)) {
    if (e.user) {
      this.display(
        getMsg(MSG_YOURE_GONE, [
          e.lamer.unicodeName,
          e.channel.unicodeName,
          e.user.unicodeName,
          e.reason,
        ]),
        "KICK",
        e.user,
        this,
        e.tags
      );
    } else {
      this.display(
        getMsg(MSG_YOURE_GONE, [
          e.lamer.unicodeName,
          e.channel.unicodeName,
          MSG_SERVER,
          e.reason,
        ]),
        "KICK",
        void 0,
        this,
        e.tags
      );
    }

    this._clearUserList();
    /* Try 1 re-join attempt if allowed. */
    if (this.prefs.autoRejoin) {
      this.join(this.mode.key);
    }
  } else {
    var enforcerProper, enforcerNick;
    if (e.user && userIsMe(e.user)) {
      enforcerProper = "YOU";
      enforcerNick = "ME!";
    } else if (e.user) {
      enforcerProper = e.user.unicodeName;
      enforcerNick = e.user.encodedName;
    } else {
      enforcerProper = MSG_SERVER;
      enforcerNick = MSG_SERVER;
    }

    this.display(
      getMsg(MSG_SOMEONE_GONE, [
        e.lamer.unicodeName,
        e.channel.unicodeName,
        enforcerProper,
        e.reason,
      ]),
      "KICK",
      e.user,
      this,
      e.tags
    );

    this.removeFromList(e.lamer);
  }

  this.removeUsers([e.lamer]);
  this.updateHeader();
};

CIRCChannel.prototype.addUsers = function (updates) {
  let updateListBox = client.currentObject == this;
  let entries = updates.map(item => new UserEntry(item));
  for (let entry of entries) {
    this.userList.push(entry);
    if (updateListBox) {
      client.list.appendChild(entry);
    }
  }
  this.updateUserList(updateListBox);
};

CIRCChannel.prototype.updateUsers = function (updates) {
  for (let update of updates) {
    if (update && update.chanListEntry) {
      let idx = this.userList.indexOf(update.chanListEntry);
      this.userList[idx] = updateListItem(update.chanListEntry, update);
    }
  }
};

CIRCChannel.prototype.updateUser = function (user) {
  this.updateUsers([this.getUser(user)]);
  this.updateUserList(true);
};

CIRCChannel.prototype.removeFromList = function (user) {
  // Remove the user from the list and 'disconnect' the user from their entry:
  var idx = client.list.getIndexOfItem(user.chanListEntry);
  client.list.removeItemAt(idx);
  idx = this.userList.indexOf(user.chanListEntry);
  if (idx > -1) {
    this.userList.splice(idx, 1);
  }

  delete user.chanListEntry._userObj;
  delete user.chanListEntry;
};

CIRCChannel.prototype.updateUserList = function (updateListBox) {
  if (client.prefs.sortUsersByMode) {
    this.userList.sort(ule_sortByMode);
  } else {
    this.userList.sort(ule_sortByName);
  }
  if (updateListBox) {
    this.userList.forEach(item => client.list.appendChild(item));
  }
};

CIRCChannel.prototype.onChanMode = function (e) {
  if (e.code == "MODE") {
    var msg = e.decodeParam(1);
    for (var i = 2; i < e.params.length; i++) {
      msg += " " + e.decodeParam(i);
    }

    var source = e.user ? e.user.unicodeName : e.source;
    this.display(
      getMsg(MSG_MODE_CHANGED, [msg, source]),
      "MODE",
      e.user || null,
      this,
      e.tags
    );
  } else if ("pendingModeReply" in this) {
    var msg = e.decodeParam(3);
    for (var i = 4; i < e.params.length; i++) {
      msg += " " + e.decodeParam(i);
    }

    var view = "messages" in this && this.messages ? this : e.network;
    view.display(
      getMsg(MSG_MODE_ALL, [this.unicodeName, msg]),
      "MODE",
      undefined,
      undefined,
      e.tags
    );
    delete this.pendingModeReply;
  }
  this.updateUsers(Object.values(e.usersAffected));

  this.updateHeader();
  updateTitle(this);
  if (client.currentObject == this) {
    this.updateUserList(true);
  }
};

CIRCChannel.prototype.onNick = function (e) {
  if (userIsMe(e.user)) {
    if (getTabForObject(this)) {
      this.displayHere(
        getMsg(MSG_NEWNICK_YOU, e.user.unicodeName),
        "NICK",
        "ME!",
        e.user,
        e.tags
      );
    }
    this.parent.parent.updateHeader();
  } else if (!this.prefs["conference.enabled"]) {
    this.display(
      getMsg(MSG_NEWNICK_NOTYOU, [e.oldNick, e.user.unicodeName]),
      "NICK",
      e.user,
      this,
      e.tags
    );
  }

  this.updateUsers([e.user]);
  if (client.currentObject == this) {
    this.updateUserList(true);
  }
};

CIRCChannel.prototype.onQuit = function (e) {
  if (userIsMe(e.user)) {
    /* I dont think this can happen */
    var pms = [e.user.unicodeName, e.server.parent.unicodeName, e.reason];
    this.display(getMsg(MSG_YOU_QUIT, pms), "QUIT", e.user, this, e.tags);
    this._clearUserList();
  } else {
    // See onPart for why this is ok before the message.
    this._updateConferenceMode();

    if (!this.prefs["conference.enabled"]) {
      this.display(
        getMsg(MSG_SOMEONE_QUIT, [
          e.user.unicodeName,
          e.server.parent.unicodeName,
          e.reason,
        ]),
        "QUIT",
        e.user,
        this,
        e.tags
      );
    }
    this.removeFromList(e.user);
  }

  this.removeUsers([e.user]);
  this.updateHeader();
};

CIRCChannel.prototype.doAutoPerform = function () {
  var cmdary = client.prefs["autoperform.channel"].concat(
    this.prefs.autoperform
  );
  for (var i = 0; i < cmdary.length; ++i) {
    if (cmdary[i][0] == "/") {
      this.dispatch(cmdary[i].substr(1));
    } else {
      this.dispatch(cmdary[i]);
    }
  }
};

CIRCChannel.prototype._clearUserList = function () {
  if (client.currentObject == this) {
    while (
      client.list.firstChild &&
      client.list.firstChild.localName == "listitem"
    ) {
      delete client.list.firstChild._userObj.chanListEntry;
      delete client.list.firstChild._userObj;
      client.list.firstChild.remove();
    }
  }
  this.userList = [];
};

CIRCUser.prototype.onInit = function () {
  this.logFile = null;
  this.lastShownAwayMessage = "";
};

CIRCUser.prototype.onPrivmsg = function (e) {
  var sourceObj = e.user;
  var destObj = e.server.me;
  var displayObj = this;

  if (!("messages" in this)) {
    var limit = client.prefs.newTabLimit;
    if (limit == 0 || client.viewsArray.length < limit) {
      if (e.user != e.server.me) {
        openQueryTab(e.server, e.user.unicodeName);
      } else {
        // This is a self-message, i.e. we received a message that
        // looks like it came from us. Display it accordingly.
        sourceObj = e.server.me;
        destObj = openQueryTab(e.server, e.params[1]);
        displayObj = destObj;
      }
    }
  }

  client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
  displayObj.display(e.decodeParam(2), "PRIVMSG", sourceObj, destObj, e.tags);
  client.munger.getRule(".mailto").enabled = false;
};

CIRCUser.prototype.onNick = function (e) {
  if (userIsMe(e.user)) {
    this.parent.parent.updateHeader();
    updateTitle();
  } else if ("messages" in this && this.messages) {
    this.display(
      getMsg(MSG_NEWNICK_NOTYOU, [e.oldNick, e.user.unicodeName]),
      "NICK",
      e.user,
      this,
      e.tags
    );
  }

  this.updateHeader();
  var tab = getTabForObject(this);
  if (tab) {
    tab.setAttribute("label", this.unicodeName);
  }
};

CIRCUser.prototype.onNotice = function (e) {
  var msg = e.decodeParam(2);
  var displayMailto = client.prefs["munger.mailto"];

  var ary = msg.match(/^\[([^ ]+)\]\s+/);
  if (ary) {
    var channel = e.server.getChannel(ary[1]);
    if (channel) {
      client.munger.getRule(".mailto").enabled = displayMailto;
      channel.display(msg, "NOTICE", this, e.server.me, e.tags);
      client.munger.getRule(".mailto").enabled = false;
      return;
    }
  }

  var sourceObj = this;
  var destObj = e.server.me;
  var displayObj = this;

  if (e.user == e.server.me) {
    // This is a self-message, i.e. we received a message that
    // looks like it came from us. Display it accordingly.
    var sourceObj = e.server.me;
    var destObj = e.server.addTarget(e.params[1]);
    var displayObj = e.server.parent;
  }

  client.munger.getRule(".mailto").enabled = displayMailto;
  displayObj.display(msg, "NOTICE", sourceObj, destObj, e.tags);
  client.munger.getRule(".mailto").enabled = false;
};

CIRCUser.prototype.onCTCPAction = function (e) {
  if (!("messages" in this)) {
    var limit = client.prefs.newTabLimit;
    if (limit == 0 || client.viewsArray.length < limit) {
      openQueryTab(e.server, e.user.unicodeName);
    }
  }

  client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
  this.display(e.CTCPData, "ACTION", this, e.server.me, e.tags);
  client.munger.getRule(".mailto").enabled = false;
};

CIRCUser.prototype.onUnknownCTCP = function (e) {
  this.parent.parent.display(
    getMsg(MSG_UNKNOWN_CTCP, [e.CTCPCode, e.CTCPData, e.user.unicodeName]),
    "BAD-CTCP",
    this,
    e.server.me,
    e.tags
  );
};

function onDCCAutoAcceptTimeout(o, folder) {
  // user may have already accepted or declined
  if (o.state.state != DCC_STATE_REQUESTED) {
    return;
  }

  if (o.TYPE == "IRCDCCChat") {
    o.accept();
    display(getMsg(MSG_DCCCHAT_ACCEPTED, o._getParams()), "DCC-CHAT");
  } else {
    var dest,
      leaf,
      tries = 0;
    while (true) {
      leaf = encodeURIComponent(o.filename).toLowerCase();
      if (++tries > 1) {
        // A file with the same name as the offered file already exists
        // in the user's download folder. Add [x] before the extension.
        // The extension is the last dot to the end of the string,
        // unless it is one of the special-cased compression extensions,
        // in which case the second to last dot is used. The second
        // extension can only contain letters, to avoid mistakes like
        // "patch-version1[2].0.gz". If no file extension is present,
        // the [x] is just appended to the filename.
        leaf = leaf.replace(
          /(\.[a-z]*\.(gz|bz2|z)|\.[^\.]*|)$/i,
          "[" + tries + "]$&"
        );
      }

      dest = getFileFromURLSpec(folder);
      dest.append(leaf);
      if (!dest.exists()) {
        break;
      }
    }
    o.accept(dest);
    display(getMsg(MSG_DCCFILE_ACCEPTED, o._getParams()), "DCC-FILE");
  }
}

CIRCUser.prototype.onDCCChat = function (e) {
  if (!client.prefs["dcc.enabled"]) {
    return;
  }

  var u = client.dcc.addUser(e.user, e.host);
  var c = client.dcc.addChat(u, e.port);

  var str = MSG_DCCCHAT_GOT_REQUEST;
  var cmds =
    getMsg(MSG_DCC_COMMAND_ACCEPT, "dcc-accept " + c.id) +
    " " +
    getMsg(MSG_DCC_COMMAND_DECLINE, "dcc-decline " + c.id);

  var allowList = this.parent.parent.prefs["dcc.autoAccept.list"];
  for (var m = 0; m < allowList.length; ++m) {
    if (hostmaskMatches(e.user, getHostmaskParts(allowList[m]))) {
      var acceptDelay = client.prefs["dcc.autoAccept.delay"];
      if (acceptDelay == 0) {
        str = MSG_DCCCHAT_ACCEPTING_NOW;
      } else {
        str = MSG_DCCCHAT_ACCEPTING;
        cmds = [acceptDelay / 1000, cmds];
      }
      setTimeout(onDCCAutoAcceptTimeout, acceptDelay, c);
      break;
    }
  }

  client.munger.getRule(".inline-buttons").enabled = true;
  this.parent.parent.display(
    getMsg(str, c._getParams().concat(cmds)),
    "DCC-CHAT",
    undefined,
    undefined,
    e.tags
  );
  client.munger.getRule(".inline-buttons").enabled = false;

  // Pass the event over to the DCC Chat object.
  e.set = "dcc-chat";
  e.destObject = c;
  e.destMethod = "onGotRequest";
};

CIRCUser.prototype.onDCCSend = function (e) {
  if (!client.prefs["dcc.enabled"]) {
    return;
  }

  var u = client.dcc.addUser(e.user, e.host);
  var f = client.dcc.addFileTransfer(u, e.port, e.file, e.size);

  var str = MSG_DCCFILE_GOT_REQUEST;
  var cmds =
    getMsg(MSG_DCC_COMMAND_ACCEPT, "dcc-accept " + f.id) +
    " " +
    getMsg(MSG_DCC_COMMAND_DECLINE, "dcc-decline " + f.id);

  var allowList = this.parent.parent.prefs["dcc.autoAccept.list"];
  for (var m = 0; m < allowList.length; ++m) {
    if (hostmaskMatches(e.user, getHostmaskParts(allowList[m]), this.parent)) {
      var acceptDelay = client.prefs["dcc.autoAccept.delay"];
      if (acceptDelay == 0) {
        str = MSG_DCCFILE_ACCEPTING_NOW;
      } else {
        str = MSG_DCCFILE_ACCEPTING;
        cmds = [acceptDelay / 1000, cmds];
      }
      setTimeout(
        onDCCAutoAcceptTimeout,
        acceptDelay,
        f,
        this.parent.parent.prefs["dcc.downloadsFolder"]
      );
      break;
    }
  }

  client.munger.getRule(".inline-buttons").enabled = true;
  this.parent.parent.display(
    getMsg(
      str,
      [e.user.unicodeName, e.host, e.port, e.file, getSISize(e.size)].concat(
        cmds
      )
    ),
    "DCC-FILE",
    undefined,
    undefined,
    e.tags
  );
  client.munger.getRule(".inline-buttons").enabled = false;

  // Pass the event over to the DCC File object.
  e.set = "dcc-file";
  e.destObject = f;
  e.destMethod = "onGotRequest";
};

CIRCUser.prototype.onDCCReject = function (e) {
  if (!client.prefs["dcc.enabled"]) {
  }

  //FIXME: Uh... cope. //

  // Pass the event over to the DCC Chat object.
  //e.set = "dcc-file";
  //e.destObject = f;
  //e.destMethod = "onGotReject";
};

CIRCUser.prototype.doAutoPerform = function () {
  var cmdary = client.prefs["autoperform.user"].concat(this.prefs.autoperform);
  for (var i = 0; i < cmdary.length; ++i) {
    if (cmdary[i][0] == "/") {
      this.dispatch(cmdary[i].substr(1));
    } else {
      this.dispatch(cmdary[i]);
    }
  }
};

CIRCDCCChat.prototype.onInit = function (e) {};

CIRCDCCChat.prototype._getParams = function () {
  return [this.unicodeName, this.remoteIP, this.port];
};

CIRCDCCChat.prototype.onPrivmsg = function (e) {
  client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
  this.displayHere(toUnicode(e.line, this), "PRIVMSG", e.user, "ME!");
  client.munger.getRule(".mailto").enabled = false;
};

CIRCDCCChat.prototype.onCTCPAction = function (e) {
  client.munger.getRule(".mailto").enabled = client.prefs["munger.mailto"];
  this.displayHere(e.CTCPData, "ACTION", e.user, "ME!");
  client.munger.getRule(".mailto").enabled = false;
};

CIRCDCCChat.prototype.onUnknownCTCP = function (e) {
  this.displayHere(
    getMsg(MSG_UNKNOWN_CTCP, [e.CTCPCode, e.CTCPData, e.user.unicodeName]),
    "BAD-CTCP",
    e.user,
    "ME!"
  );
};

CIRCDCCChat.prototype.onConnect = function (e) {
  playEventSounds("dccchat", "connect");
  this.displayHere(getMsg(MSG_DCCCHAT_OPENED, this._getParams()), "DCC-CHAT");
};

CIRCDCCChat.prototype.onAbort = function (e) {
  this.display(getMsg(MSG_DCCCHAT_ABORTED, this._getParams()), "DCC-CHAT");
};

CIRCDCCChat.prototype.onFail = function (e) {
  this.display(getMsg(MSG_DCCCHAT_FAILED, this._getParams()), "DCC-CHAT");
};

CIRCDCCChat.prototype.onDisconnect = function (e) {
  playEventSounds("dccchat", "disconnect");
  this.display(getMsg(MSG_DCCCHAT_CLOSED, this._getParams()), "DCC-CHAT");
};

CIRCDCCFileTransfer.prototype.onInit = function (e) {
  this.busy = false;
  updateProgress();
};

CIRCDCCFileTransfer.prototype._getParams = function () {
  var dir = MSG_UNKNOWN;

  if (this.state.dir == DCC_DIR_GETTING) {
    dir = MSG_DCCLIST_FROM;
  }

  if (this.state.dir == DCC_DIR_SENDING) {
    dir = MSG_DCCLIST_TO;
  }

  return [this.filename, dir, this.unicodeName, this.remoteIP, this.port];
};

CIRCDCCFileTransfer.prototype.onConnect = function (e) {
  this.displayHere(getMsg(MSG_DCCFILE_OPENED, this._getParams()), "DCC-FILE");
  this.busy = true;
  this.speed = 0;
  updateProgress();
  this._lastUpdate = new Date();
  this._lastPosition = 0;
  this._lastSpeedTime = new Date();
};

CIRCDCCFileTransfer.prototype.onProgress = function (e) {
  var now = new Date();
  var pcent = this.progress;

  var tab = getTabForObject(this);

  // If we've moved 100KiB or waited 10s, update the progress bar.
  if (
    this.position > this._lastPosition + 102400 ||
    now - this._lastUpdate > 10000
  ) {
    updateProgress();
    updateTitle();

    if (tab) {
      tab.setAttribute("label", this.viewName + " (" + pcent + "%)");
    }

    var change = this.position - this._lastPosition;
    var speed = change / ((now - this._lastSpeedTime) / 1000); // B/s
    this._lastSpeedTime = now;

    /* Use an average of the last speed, and this speed, so we get a little
     * smoothing to it.
     */
    this.speed = (this.speed + speed) / 2;
    this.updateHeader();
    this._lastPosition = this.position;
  }

  // If it's also been 10s or more since we last displayed a msg...
  if (now - this._lastUpdate > 10000) {
    this._lastUpdate = now;

    var args = [
      pcent,
      getSISize(this.position),
      getSISize(this.size),
      getSISpeed(this.speed),
    ];

    // We supress this message if the view is hidden.
    if (tab) {
      this.displayHere(getMsg(MSG_DCCFILE_PROGRESS, args), "DCC-FILE");
    }
  }
};

CIRCDCCFileTransfer.prototype.onAbort = function (e) {
  this.busy = false;
  updateProgress();
  updateTitle();
  this.display(getMsg(MSG_DCCFILE_ABORTED, this._getParams()), "DCC-FILE");
};

CIRCDCCFileTransfer.prototype.onFail = function (e) {
  this.busy = false;
  updateProgress();
  updateTitle();
  this.display(getMsg(MSG_DCCFILE_FAILED, this._getParams()), "DCC-FILE");
};

CIRCDCCFileTransfer.prototype.onDisconnect = function (e) {
  this.busy = false;
  updateProgress();
  this.updateHeader();
  updateTitle();

  var msg,
    tab = getTabForObject(this);
  if (tab) {
    tab.setAttribute("label", this.viewName + " (DONE)");
  }

  if (this.state.dir == DCC_DIR_GETTING) {
    var localURL = getURLSpecFromFile(this.localPath);
    var cmd = "dcc-show-file " + localURL;
    var msgId =
      client.platform == "Mac"
        ? MSG_DCCFILE_CLOSED_SAVED_MAC
        : MSG_DCCFILE_CLOSED_SAVED;
    msg = getMsg(msgId, this._getParams().concat(localURL, cmd));
  } else {
    msg = getMsg(MSG_DCCFILE_CLOSED_SENT, this._getParams());
  }
  client.munger.getRule(".inline-buttons").enabled = true;
  this.display(msg, "DCC-FILE");
  client.munger.getRule(".inline-buttons").enabled = false;
};

function updateListItem(item, userObj) {
  item.setAttribute("label", userObj.unicodeName);
  item.setAttribute("value", userObj.unicodeName.toLowerCase());
  item.setAttribute("sortName", userObj.sortName.toLowerCase());
  item.setAttribute("voice", userObj.isVoice);
  item.setAttribute("op", userObj.isOp);
  item.setAttribute("halfop", userObj.isHalfOp);
  item.setAttribute("admin", userObj.isAdmin);
  item.setAttribute("founder", userObj.isFounder);
  item.setAttribute("away", userObj.isAway);
  return item;
}

function UserEntry(userObj) {
  let item = document.createElement("listitem");
  item.setAttribute("class", "listitem-iconic");
  item = updateListItem(item, userObj);

  // We need this for sorting by mode (op, hop, voice, etc.)
  item._userObj = userObj;

  // When the user leaves, we need to have the entry so we can remove it:
  userObj.chanListEntry = item;

  return item;
}

function ule_sortByName(a, b) {
  let aName = a.getAttribute("value");
  let bName = b.getAttribute("value");
  return aName.localeCompare(bName);
}

function ule_sortByMode(a, b) {
  let aName = a.getAttribute("sortName");
  let bName = b.getAttribute("sortName");
  return aName.localeCompare(bName);
}
