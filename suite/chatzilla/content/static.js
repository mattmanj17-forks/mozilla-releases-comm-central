/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

ChromeUtils.defineModuleGetter(
  this,
  "AppConstants",
  "resource://gre/modules/AppConstants.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "PlacesUtils",
  "resource://gre/modules/PlacesUtils.jsm"
);

var warn;
var ASSERT;
var TEST;

if (DEBUG) {
  _dd_pfx = "cz: ";
  warn = function (msg) {
    dumpln("** WARNING " + msg + " **");
  };
  TEST = ASSERT = function (expr, msg) {
    if (!expr) {
      dd("** ASSERTION FAILED: " + msg + " **\n" + getStackTrace() + "\n");
      return false;
    }
    return true;
  };
} else {
  dd = warn = TEST = ASSERT = function () {};
}

var client = {};

#expand client.version = "__CHATZILLA_VERSION__";
client.TYPE = "IRCClient";
client.COMMAND_CHAR = "/";
client.STEP_TIMEOUT = 500;
client.MAX_MESSAGES = 200;
client.MAX_HISTORY = 50;
/* longest nick to show in display before forcing the message to a block level
 * element */
client.MAX_NICK_DISPLAY = 14;
/* longest word to show in display before abbreviating */
client.MAX_WORD_DISPLAY = 20;

client.NOTIFY_TIMEOUT = 5 * 60 * 1000; /* update notify list every 5 minutes */

// Check every minute which networks have away statuses that need an update.
client.AWAY_TIMEOUT = 60 * 1000;

client.SLOPPY_NETWORKS = true;
/* true if msgs from a network can be displayed
 * on the current object if it is related to
 * the network (ie, /whois results will appear
 * on the channel you're viewing, if that channel
 * is on the network that the results came from)
 */
client.DOUBLETAB_TIME = 500;
client.HIDE_CODES = true;
/* true if you'd prefer to show numeric response
 * codes as some default value (ie, "===") */
client.DEFAULT_RESPONSE_CODE = "===";

/* Maximum number of channels we'll try to list without complaining */
client.SAFE_LIST_COUNT = 500;

/* Minimum number of users above or below the conference limit the user count
 * must go, before it is changed. This allows the user count to fluctuate
 * around the limit without continously going on and off.
 */
client.CONFERENCE_LOW_PASS = 10;

client.viewsArray = [];
client.activityList = {};
client.hostCompat = {};
client.inputHistory = [];
client.lastHistoryReferenced = -1;
client.incompleteLine = "";
client.lastTabUp = new Date();
client.awayMsgs = [];
client.awayMsgCount = 5;
client.statusMessages = [];

CIRCNetwork.prototype.INITIAL_CHANNEL = "";
CIRCNetwork.prototype.STS_MODULE = new CIRCSTS();
CIRCNetwork.prototype.MAX_MESSAGES = 100;
CIRCNetwork.prototype.IGNORE_MOTD = false;
CIRCNetwork.prototype.RECLAIM_WAIT = 15000;
CIRCNetwork.prototype.RECLAIM_TIMEOUT = 400000;
CIRCNetwork.prototype.MIN_RECONNECT_MS = 15 * 1000; // 15s
CIRCNetwork.prototype.MAX_RECONNECT_MS = 2 * 60 * 60 * 1000; // 2h

CIRCServer.prototype.READ_TIMEOUT = 0;
CIRCServer.prototype.PRUNE_OLD_USERS = 0; // prune on user quit.

CIRCUser.prototype.MAX_MESSAGES = 200;

CIRCChannel.prototype.MAX_MESSAGES = 300;

function init() {
  if ("initialized" in client && client.initialized) {
    return;
  }

  client.initialized = false;

  client.networks = {};
  client.entities = {};
  client.eventPump = new CEventPump(200);

  if (DEBUG) {
    /* hook all events EXCEPT server.poll and *.event-end types
     * (the 4th param inverts the match) */
    client.debugHook = client.eventPump.addHook(
      [{ type: "poll", set: /^(server|dcc-chat)$/ }, { type: "event-end" }],
      event_tracer,
      "event-tracer",
      true /* negate */,
      false /* disable */
    );
  }

  initApplicationCompatibility();
  initMessages();

  client.bundle = document.getElementById("chatzillaBundle");
  client.list = document.getElementById("user-list");

  initCommands();
  initPrefs();
  initMunger();
  initNetworks();
  initStatic();
  initHandlers();

  // Create DCC handler.
  client.dcc = new CIRCDCC(client);

  client.ident = new IdentServer(client);

  // Initialize the STS module.
  var stsFile = new nsLocalFile(client.prefs.profilePath);
  stsFile.append("sts.json");

  client.sts = CIRCNetwork.prototype.STS_MODULE;
  client.sts.init(stsFile);
  client.sts.ENABLED = client.prefs["sts.enabled"];

  // Start log rotation checking first.  This will schedule the next check.
  checkLogFiles();
  // Start logging.  Nothing should call display() before this point.
  if (client.prefs.log) {
    client.openLogFile(client);
  }

  // Make sure the userlist is on the correct side.
  updateUserlistSide(client.prefs.userlistLeft);

  client.display(MSG_WELCOME, "HELLO");
  client.dispatch("set-current-view", { view: client });

  /*
   * Due to Firefox 44 changes regarding ES6 lexical scope, these 'const'
   * items are no longer accessible from the global object ('window') but
   * are required by the output window. The compromise is to copy them on
   * to the global object so they can be used.
   */
  window.NET_CONNECTING = NET_CONNECTING;

  importFromFrame("updateHeader");
  importFromFrame("setHeaderState");
  importFromFrame("changeCSS");
  importFromFrame("scrollToElement");
  importFromFrame("updateMotifSettings");
  importFromFrame("removeUsers");

  processStartupScripts();

  client.busy = false;
  updateProgress();
  initOfflineIcon();
  updateAlertIcon(false);
  client.isIdleAway = false;
  initIdleAutoAway(client.prefs.awayIdleTime);

  client.initialized = true;

  dispatch("help", { hello: true });
  dispatch("networks");

  setTimeout(function () {
    dispatch("focus-input");
  }, 0);
  setTimeout(processStartupAutoperform, 0);
  setTimeout(processStartupURLs, 0);
}

function initStatic() {
  client.mainWindow = window;

  try {
    client.sound = Cc["@mozilla.org/sound;1"].createInstance(Ci.nsISound);

    client.soundList = {};
  } catch (ex) {
    dd("Sound failed to initialize: " + ex);
  }

  try {
    client.alert = {};
    client.alert.service = Cc["@mozilla.org/alerts-service;1"].getService(
      Ci.nsIAlertsService
    );
    client.alert.alertList = {};
    client.alert.floodProtector = new FloodProtector(
      client.prefs["alert.floodDensity"],
      client.prefs["alert.floodDispersion"]
    );
  } catch (ex) {
    dd("Alert service failed to initialize: " + ex);
    client.alert = null;
  }

  try {
    // Mmmm, fun. This ONLY affects the ChatZilla window, don't worry!
    Date.prototype.toStringInt = Date.prototype.toString;
    Date.prototype.toString = function () {
      let dtf = new Services.intl.DateTimeFormat(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      });
      return dtf.format(this);
    };
  } catch (ex) {
    dd("Locale-correct date formatting failed to initialize: " + ex);
  }

  // XXX Bug 335998: See cmdHideView for usage of this.
  client.hiddenDocument = document.implementation.createDocument(
    null,
    null,
    null
  );

  multilineInputMode(client.prefs.multiline);
  updateSpellcheck(client.prefs.inputSpellcheck);

  // Initialize userlist stuff
  if (client.prefs.showModeSymbols) {
    setListMode("symbol");
  } else {
    setListMode("graphic");
  }

  setDebugMode(client.prefs.debugMode);

  client.versionString = getMsg("versionString", [client.version]);
  let nameVersion = Services.appinfo.name + " " + Services.appinfo.version;
  let ua = nameVersion + "/" + Services.appinfo.platformBuildID;
  client.userAgent = getMsg(MSG_VERSION_REPLY, [client.version, ua]);
  CIRCServer.prototype.VERSION_RPLY = client.userAgent;
  CIRCServer.prototype.HOST_RPLY =
    Services.appinfo.vendor + " " + nameVersion + ", " + client.platform;
  CIRCServer.prototype.SOURCE_RPLY = MSG_SOURCE_REPLY;

  client.localeAuthors = [];
  let localeAuthors = getMsg("locale.authors", null, "");
  if (localeAuthors && !localeAuthors.startsWith("XXX REPLACE")) {
    client.localeAuthors = localeAuthors.split(/\s*;\s*/);
  }

  client.statusBar = {};

  client.statusBar["server-nick"] = document.getElementById("server-nick");

  client.tabs = document.getElementById("views-tbar-inner");
  client.tabDragBar = document.getElementById("tabs-drop-indicator-bar");
  client.tabDragMarker = document.getElementById("tabs-drop-indicator");

  client.statusElement = document.getElementById("status-text");
  client.currentStatus = "";
  client.defaultStatus = MSG_DEFAULT_STATUS;

  client.progressPanel = document.getElementById("status-progress-panel");
  client.progressBar = document.getElementById("status-progress-bar");

  client.logFile = null;
  setInterval(onNotifyTimeout, client.NOTIFY_TIMEOUT);
  // Call every minute, will check only the networks necessary.
  setInterval(onWhoTimeout, client.AWAY_TIMEOUT);

  client.awayMsgs = [{ message: MSG_AWAY_DEFAULT }];
  let migrated = Services.prefs.getBoolPref(
    "extensions.irc.away_migrated",
    false
  );
  let awayFile = new nsLocalFile(client.prefs.profilePath);
  awayFile.append("awayMsgs." + (migrated ? "json" : "txt"));
  if (awayFile.exists()) {
    let awayLoader = migrated
      ? new JSONSerializer(awayFile)
      : new TextSerializer(awayFile);
    if (awayLoader.open("<")) {
      // Load the first item from the file.
      var item = awayLoader.deserialize();
      if (isinstance(item, Array)) {
        // If the first item is an array, it is the entire thing.
        client.awayMsgs = item;
      } else if (!migrated && item != null) {
        /* Not an array, so we have the old format of a single object
         * per entry.
         */
        client.awayMsgs = [item];
        while ((item = awayLoader.deserialize())) {
          client.awayMsgs.push(item);
        }
      }
      awayLoader.close();

      /* we have to close the file before we can move it,
       * hence the second if statement */
      if (item == null) {
        var invalidFile = new nsLocalFile(client.prefs.profilePath);
        invalidFile.append("awayMsgs.invalid");
        invalidFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
        var msg = getMsg(MSG_ERR_INVALID_FILE, [
          awayFile.leafName,
          invalidFile.leafName,
        ]);
        setTimeout(function () {
          client.display(msg, MT_WARN);
        }, 0);
        awayFile.moveTo(null, invalidFile.leafName);
      } else if (!migrated) {
        awayMsgsSave();
        Services.prefs.setBoolPref("extensions.irc.away_migrated", true);
      }
    }
  }

  // Get back input history from previous session:
  var inputHistoryFile = new nsLocalFile(client.prefs.profilePath);
  inputHistoryFile.append("inputHistory.txt");
  try {
    client.inputHistoryLogger = new TextLogger(
      inputHistoryFile.path,
      client.MAX_HISTORY
    );
  } catch (ex) {
    msg = getMsg(MSG_ERR_INPUTHISTORY_NOT_WRITABLE, inputHistoryFile.path);
    setTimeout(function () {
      client.display(msg, MT_ERROR);
    }, 0);
    dd(formatException(ex));
    client.inputHistoryLogger = null;
  }
  if (client.inputHistoryLogger) {
    client.inputHistory = client.inputHistoryLogger.read().reverse();
  }

  // Set up URL collector.
  var urlsFile = new nsLocalFile(client.prefs.profilePath);
  urlsFile.append("urls.txt");
  try {
    client.urlLogger = new TextLogger(
      urlsFile.path,
      client.prefs["urls.store.max"]
    );
  } catch (ex) {
    msg = getMsg(MSG_ERR_URLS_NOT_WRITABLE, urlsFile.path);
    setTimeout(function () {
      client.display(msg, MT_ERROR);
    }, 0);
    dd(formatException(ex));
    client.urlLogger = null;
  }

  // Migrate old list preference to file.
  if (client.urlLogger) {
    let urls = Services.prefs.getCharPref("extensions.irc.urls.list", "");
    // Add the old URLs to the new file.
    client.urlLogger.append(client.prefManager.stringToArray(urls));
    // Completely purge the old preference.
    Services.prefs.clearUserPref("extensions.irc.urls.list");
  }

  client.defaultCompletion = client.COMMAND_CHAR + "help ";

  client.deck = document.getElementById("output-deck");
}

function awayMsgsSave() {
  try {
    let awayFile = new nsLocalFile(client.prefs.profilePath);
    awayFile.append("awayMsgs.json");
    let awayLoader = new JSONSerializer(awayFile);
    if (awayLoader.open(">")) {
      awayLoader.serialize(client.awayMsgs);
      awayLoader.close();
    }
  } catch (ex) {
    display(getMsg(MSG_ERR_AWAY_SAVE, formatException(ex)), MT_ERROR);
  }
}

function initApplicationCompatibility() {
  // This function does nothing more than tweak the UI based on the platform.

  client.lineEnd = "\n";

  // Set up simple platform information.
  switch (AppConstants.platform) {
    case "linux":
      client.platform = "Linux";
      break;
    case "macosx":
      client.platform = "Mac";
      break;
    case "win":
      client.platform = "Windows";
      // Windows likes \r\n line endings, as notepad can't cope with just
      // \n logs.
      client.lineEnd = "\r\n";
      break;
    default:
      client.platform = "Unknown";
  }

  CIRCServer.prototype.OS_RPLY =
    navigator.oscpu + " (" + navigator.platform + ")";
}

function getFindData(e) {
  // findNext() wrapper to add our findStart/findEnd events.
  function _cz_findNext() {
    // Send start notification.
    var ev = new CEvent("find", "findStart", e.sourceObject, "onFindStart");
    client.eventPump.routeEvent(ev);

    // Call the original findNext() and keep the result for later.
    var rv = this.__proto__.findNext();

    // Send end notification with result code.
    var ev = new CEvent("find", "findEnd", e.sourceObject, "onFindEnd");
    ev.findResult = rv;
    client.eventPump.routeEvent(ev);

    // Return the original findNext()'s result to keep up appearances.
    return rv;
  }

  // Getter for webBrowserFind property.
  function _cz_webBrowserFind() {
    return this._cz_wbf;
  }

  var findData = new nsFindInstData();
  findData.browser = e.sourceObject.frame;
  findData.rootSearchWindow = getContentWindow(e.sourceObject.frame);
  findData.currentSearchWindow = getContentWindow(e.sourceObject.frame);

  /* Wrap up the webBrowserFind object so we get called for findNext(). Use
   * __proto__ so that everything else is exactly like the original object.
   */
  findData._cz_wbf = { findNext: _cz_findNext };
  findData._cz_wbf.__proto__ = findData.webBrowserFind;

  /* Replace the nsFindInstData getter for webBrowserFind to call our
   * function which in turn returns our object (_cz_wbf).
   */
  findData.__defineGetter__("webBrowserFind", _cz_webBrowserFind);

  /* Yay, evil hacks! findData.init doesn't care about the findService, it
   * gets option settings from webBrowserFind. As we want the wrap option *on*
   * when we use /find foo, we set it on the findService there. However,
   * restoring the original value afterwards doesn't help, because init() here
   * overrides that value. Unless we make .init do something else, of course:
   */
  findData._init = findData.init;
  findData.init = function () {
    this._init();
    let findService = Cc["@mozilla.org/find/find_service;1"].getService(
      Ci.nsIFindService
    );
    this.webBrowserFind.wrapFind = findService.wrapFind;
  };

  return findData;
}

function importFromFrame(method) {
  client.__defineGetter__(method, import_wrapper);
  CIRCNetwork.prototype.__defineGetter__(method, import_wrapper);
  CIRCChannel.prototype.__defineGetter__(method, import_wrapper);
  CIRCUser.prototype.__defineGetter__(method, import_wrapper);
  CIRCDCCChat.prototype.__defineGetter__(method, import_wrapper);
  CIRCDCCFileTransfer.prototype.__defineGetter__(method, import_wrapper);

  function import_wrapper() {
    var dummy = function () {};

    if (!("frame" in this)) {
      return dummy;
    }

    try {
      var window = getContentWindow(this.frame);
      if (
        window &&
        "initialized" in window &&
        window.initialized &&
        method in window
      ) {
        return function () {
          window[method].apply(this, arguments);
        };
      }
    } catch (ex) {
      ASSERT(0, "Caught exception calling: " + method + "\n" + ex);
    }

    return dummy;
  }
}

function processStartupScripts() {
  client.plugins = {};
  var scripts = client.prefs.initialScripts;
  var basePath = getURLSpecFromFile(client.prefs.profilePath);
  var baseURL = Services.io.newURI(basePath);
  for (var i = 0; i < scripts.length; ++i) {
    try {
      var url = Services.io.newURI(scripts[i], null, baseURL);
      var path = getFileFromURLSpec(url.spec);
    } catch (ex) {
      var params = ["initialScripts", scripts[i]];
      display(getMsg(MSG_ERR_INVALID_PREF, params), MT_ERROR);
      dd(formatException(ex));
      continue;
    }

    if (url.scheme != "file" && url.scheme != "chrome") {
      display(getMsg(MSG_ERR_INVALID_SCHEME, scripts[i]), MT_ERROR);
      continue;
    }

    if (!path.exists()) {
      display(getMsg(MSG_ERR_ITEM_NOT_FOUND, url.spec), MT_WARN);
      continue;
    }

    if (path.isDirectory()) {
      loadPluginDirectory(path);
    } else {
      loadLocalFile(path);
    }
  }
}

function loadPluginDirectory(localPath, recurse) {
  if (typeof recurse == "undefined") {
    recurse = 1;
  }

  var initPath = localPath.clone();
  initPath.append("init.js");
  if (initPath.exists()) {
    loadLocalFile(initPath);
  }

  if (recurse < 1) {
    return;
  }

  var enumer = localPath.directoryEntries;
  while (enumer.hasMoreElements()) {
    var entry = enumer.getNext();
    entry = entry.QueryInterface(Ci.nsIFile);
    if (entry.isDirectory()) {
      loadPluginDirectory(entry, recurse - 1);
    }
  }
}

function loadLocalFile(localFile) {
  var url = getURLSpecFromFile(localFile);
  var glob = {};
  dispatch("load", { url, scope: glob });
}

function getPluginById(id) {
  return client.plugins[id] || null;
}

function getPluginByURL(url) {
  for (var k in client.plugins) {
    if (client.plugins[k].url == url) {
      return client.plugins[k];
    }
  }

  return null;
}

function disablePlugin(plugin, destroy) {
  if (!plugin.enabled) {
    display(getMsg(MSG_IS_DISABLED, plugin.id));
    return true;
  }

  if (plugin.API > 0) {
    if (!plugin.disable()) {
      display(getMsg(MSG_CANT_DISABLE, plugin.id));
      return false;
    }

    if (destroy) {
      client.prefManager.removeObserver(plugin.prefManager);
      plugin.prefManager.destroy();
    } else {
      plugin.prefs.enabled = false;
    }
  } else if ("disablePlugin" in plugin.scope) {
    plugin.scope.disablePlugin();
  } else {
    display(getMsg(MSG_CANT_DISABLE, plugin.id));
    return false;
  }

  display(getMsg(MSG_PLUGIN_DISABLED, plugin.id));
  if (!destroy) {
    plugin.enabled = false;
  }
  return true;
}

function processStartupAutoperform() {
  var cmdary = client.prefs["autoperform.client"];
  for (var i = 0; i < cmdary.length; ++i) {
    if (cmdary[i][0] == "/") {
      client.dispatch(cmdary[i].substr(1));
    } else {
      client.dispatch(cmdary[i]);
    }
  }
}

function processStartupURLs() {
  var wentSomewhere = false;

  if (
    "arguments" in window &&
    0 in window.arguments &&
    typeof window.arguments[0] == "object" &&
    "url" in window.arguments[0]
  ) {
    var url = window.arguments[0].url;
    if (url.search(/^ircs?:\/?\/?\/?$/i) == -1) {
      /* if the url is not irc: irc:/, irc://, or ircs equiv then go to it. */
      gotoIRCURL(url);
      wentSomewhere = true;
    }
  } else if (
    /* check to see whether the URL has been passed via the command line
       instead. */
    "arguments" in window &&
    0 in window.arguments &&
    typeof window.arguments[0] == "string"
  ) {
    var url = window.arguments[0];
    var urlMatches = url.match(/^ircs?:\/\/\/?(.*)$/);
    if (urlMatches) {
      if (urlMatches[1]) {
        /* if the url is not "irc://", "irc:///" or an ircs equiv then
                   go to it. */
        gotoIRCURL(url);
        wentSomewhere = true;
      }
    } else if (url) {
      /* URL parameter is not blank, but does not not conform to the
               irc[s] scheme. */
      display(getMsg(MSG_ERR_INVALID_SCHEME, url), MT_ERROR);
    }
  }

  /* if we had nowhere else to go, connect to any default urls */
  if (!wentSomewhere) {
    openStartupURLs();
  }

  if (client.viewsArray.length > 1 && !isStartupURL("irc://")) {
    dispatch("delete-view", { view: client });
  }

  /* XXX: If we have the "stop XBL breaking" hidden tab, remove it, to
   * stop XBL breaking later. Oh, the irony.
   */
  if (client.tabs.firstChild.hidden) {
    client.tabs.firstChild.remove();
    updateTabAttributes();
  }
}

function openStartupURLs() {
  var ary = client.prefs.initialURLs;
  for (var i = 0; i < ary.length; ++i) {
    if (ary[i] && ary[i] == "irc:///") {
      // Clean out "default network" entries, which we don't
      // support any more; replace with the harmless irc:// URL.
      ary[i] = "irc://";
      client.prefs.initialURLs.update();
    }
    if (ary[i] && ary[i] != "irc://") {
      gotoIRCURL(ary[i]);
    }
  }
}

function destroy() {
  destroyPrefs();
}

function addURLToHistory(url) {
  url = Services.io.newURI(url, "UTF-8");
  PlacesUtils.history.insert({
    url,
    visits: [
      {
        date: new Date(),
        transition: PlacesUtils.history.TRANSITIONS.TYPED,
      },
    ],
  });
}

function addStatusMessage(message) {
  const DELAY_SCALE = 100;
  const DELAY_MINIMUM = 5000;

  var delay = message.length * DELAY_SCALE;
  if (delay < DELAY_MINIMUM) {
    delay = DELAY_MINIMUM;
  }

  client.statusMessages.push({ message, delay });
  updateStatusMessages();
}

function updateStatusMessages() {
  if (client.statusMessages.length == 0) {
    var status = client.currentStatus || client.defaultStatus;
    client.statusElement.setAttribute("label", status);
    client.statusElement.removeAttribute("notice");
    return;
  }

  var now = Number(new Date());
  var currentMsg = client.statusMessages[0];
  if ("expires" in currentMsg) {
    if (now >= currentMsg.expires) {
      client.statusMessages.shift();
      setTimeout(updateStatusMessages, 0);
    } else {
      setTimeout(updateStatusMessages, 1000);
    }
  } else {
    currentMsg.expires = now + currentMsg.delay;
    client.statusElement.setAttribute("label", currentMsg.message);
    client.statusElement.setAttribute("notice", "true");
    setTimeout(updateStatusMessages, currentMsg.delay);
  }
}

function setStatus(str) {
  client.currentStatus = str;
  updateStatusMessages();
  return str;
}

client.__defineSetter__("status", setStatus);

function getStatus() {
  return client.currentStatus;
}

client.__defineGetter__("status", getStatus);

client.getConnectedNetworks = function () {
  var rv = [];
  for (var n in client.networks) {
    if (client.networks[n].isConnected()) {
      rv.push(client.networks[n]);
    }
  }
  return rv;
};

function combineNicks(nickList, max) {
  if (!max) {
    max = 4;
  }

  var combinedList = [];

  for (var i = 0; i < nickList.length; i += max) {
    count = Math.min(max, nickList.length - i);
    var nicks = nickList.slice(i, i + count);
    var str = new String(nicks.join(" "));
    str.count = count;
    combinedList.push(str);
  }

  return combinedList;
}

function updateAllStalkExpressions() {
  var list = client.prefs.stalkWords;

  for (var name in client.networks) {
    if ("stalkExpression" in client.networks[name]) {
      updateStalkExpression(client.networks[name], list);
    }
  }
}

function updateStalkExpression(network) {
  function escapeChar(ch) {
    return "\\" + ch;
  }

  var list = client.prefs.stalkWords;

  var ary = [];

  ary.push(network.primServ.me.unicodeName.replace(/[^\w\d]/g, escapeChar));

  for (var i = 0; i < list.length; ++i) {
    ary.push(list[i].replace(/[^\w\d]/g, escapeChar));
  }

  var re;
  if (client.prefs.stalkWholeWords) {
    re = "(^|[\\W\\s])((" + ary.join(")|(") + "))([\\W\\s]|$)";
  } else {
    re = "(" + ary.join(")|(") + ")";
  }

  network.stalkExpression = new RegExp(re, "i");
}

function getDefaultFontSize() {
  // PX size pref: font.size.variable.x-western
  var pxSize = Services.prefs.getIntPref("font.size.variable.x-western", 16);

  var dpi = 96;
  try {
    // Get the DPI the fun way (make Mozilla do the work).
    var b = document.createElement("box");
    b.style.width = "1in";
    dpi = window.getComputedStyle(b).width.match(/^\d+/);
  } catch (ex) {
    try {
      // Get the DPI the fun way (make Mozilla do the work).
      b = document.createElementNS("box", XHTML_NS);
      b.style.width = "1in";
      dpi = window.getComputedStyle(b).width.match(/^\d+/);
    } catch (ex) {}
  }

  return Math.round((pxSize / dpi) * 72);
}

function getDefaultContext(aEvent) {
  let cx = {};
  if (aEvent) {
    cx.originalEvent = aEvent;
  }
  /* Use __proto__ here and in all other get*Context so that the command can
   * tell the difference between getObjectDetails and actual parameters. See
   * cmdJoin for more details.
   */
  cx.__proto__ = getObjectDetails(client.currentObject);
  return cx;
}

function getMessagesContext(cx, element) {
  if (!cx) {
    cx = {};
  }
  cx.__proto__ = getObjectDetails(client.currentObject);
  if (!element) {
    element = document.popupNode;
  }

  while (element) {
    switch (element.localName) {
      case "a":
        var href = element.getAttribute("href");
        cx.url = href;
        break;

      case "tr":
        // NOTE: msg-user is the canonicalName.
        cx.canonNick = element.getAttribute("msg-user");
        if (!cx.canonNick) {
          break;
        }

        // Strip out a potential ME! suffix.
        var ary = cx.canonNick.match(/([^ ]+)/);
        cx.canonNick = ary[1];

        if (!cx.network) {
          break;
        }

        if (cx.channel) {
          cx.user = cx.channel.getUser(cx.canonNick);
        } else {
          cx.user = cx.network.getUser(cx.canonNick);
        }

        if (cx.user) {
          cx.nickname = cx.user.unicodeName;
        } else {
          cx.nickname = toUnicode(cx.canonNick, cx.network);
        }
        break;
    }

    element = element.parentNode;
  }

  return cx;
}

function msgIsImportant(msg, sourceNick, network) {
  var plainMsg = removeColorCodes(msg);

  var re = network.stalkExpression;
  if (plainMsg.search(re) != -1 || (sourceNick && sourceNick.search(re) == 0)) {
    return true;
  }

  return false;
}

function ensureCachedCanonicalURLs(array) {
  if ("canonicalURLs" in array) {
    return;
  }

  /* Caching this on the array is safe because the PrefManager constructs
   * a new array if the preference changes, but otherwise keeps the same
   * one around.
   */
  array.canonicalURLs = [];
  for (var i = 0; i < array.length; i++) {
    array.canonicalURLs.push(makeCanonicalIRCURL(array[i]));
  }
}

function isStartupURL(url) {
  // We canonicalize all URLs before we do the (string) comparison.
  url = makeCanonicalIRCURL(url);
  var list = client.prefs.initialURLs;
  ensureCachedCanonicalURLs(list);
  return list.canonicalURLs.includes(url);
}

function cycleView(amount) {
  var len = client.viewsArray.length;
  if (len <= 1) {
    return;
  }

  var tb = getTabForObject(client.currentObject);
  if (!tb) {
    return;
  }

  var vk = Number(tb.getAttribute("viewKey"));
  var destKey = (vk + amount) % len; /* wrap around */
  if (destKey < 0) {
    destKey += len;
  }

  dispatch("set-current-view", { view: client.viewsArray[destKey].source });
}

// Plays the sound for a particular event on a type of object.
function playEventSounds(type, event, source) {
  if (!client.sound || !client.prefs["sound.enabled"]) {
    return;
  }

  // Converts .TYPE values into the event object names.
  // IRCChannel => channel, IRCUser => user, etc.
  if (type.match(/^IRC/)) {
    type = type.substr(3, type.length).toLowerCase();
  }

  // DCC Chat sessions should act just like user views.
  if (type == "dccchat") {
    type = "user";
  }

  var ev = type + "." + event;

  if (ev in client.soundList) {
    return;
  }

  var src = source ? source : client;

  if (!("sound." + ev in src.prefs)) {
    return;
  }

  var s = src.prefs["sound." + ev];

  if (!s) {
    return;
  }

  if (client.prefs["sound.overlapDelay"] > 0) {
    client.soundList[ev] = true;
    setTimeout(function () {
      delete client.soundList[ev];
    }, client.prefs["sound.overlapDelay"]);
  }

  if (event == "start") {
    blockEventSounds(type, "event");
    blockEventSounds(type, "chat");
    blockEventSounds(type, "stalk");
  }

  playSounds(s);
}

// Blocks a particular type of event sound occuring.
function blockEventSounds(type, event) {
  if (!client.sound || !client.prefs["sound.enabled"]) {
    return;
  }

  // Converts .TYPE values into the event object names.
  // IRCChannel => channel, IRCUser => user, etc.
  if (type.match(/^IRC/)) {
    type = type.substr(3, type.length).toLowerCase();
  }

  var ev = type + "." + event;

  if (client.prefs["sound.overlapDelay"] > 0) {
    client.soundList[ev] = true;
    setTimeout(function () {
      delete client.soundList[ev];
    }, client.prefs["sound.overlapDelay"]);
  }
}

function playSounds(list) {
  var ary = list.split(" ");
  if (ary.length == 0) {
    return;
  }

  playSound(ary[0]);
  for (var i = 1; i < ary.length; ++i) {
    setTimeout(playSound, 250 * i, ary[i]);
  }
}

function playSound(file) {
  if (!client.sound || !client.prefs["sound.enabled"] || !file) {
    return;
  }

  if (file == "beep") {
    client.sound.beep();
  } else {
    try {
      client.sound.play(Services.io.newURI(file));
    } catch (ex) {
      // ignore exceptions from this pile of code.
    }
  }
}

/* timer-based mainloop */
function mainStep() {
  try {
    var count = client.eventPump.stepEvents();
    if (count > 0) {
      setTimeout(mainStep, client.STEP_TIMEOUT);
    } else {
      setTimeout(mainStep, client.STEP_TIMEOUT / 5);
    }
  } catch (ex) {
    dd("Exception in mainStep!");
    dd(formatException(ex));
    setTimeout(mainStep, client.STEP_TIMEOUT);
  }
}

function openQueryTab(server, nick) {
  var user = server.addUser(nick);
  addURLToHistory(user.getURL());
  if (!("messages" in user)) {
    var value = "";
    var same = true;
    for (var c in server.channels) {
      var chan = server.channels[c];
      if (!(user.collectionKey in chan.users)) {
        continue;
      }
      /* This takes a boolean value for each channel (true - channel has
       * same value as first), and &&-s them all together. Thus, |same|
       * will tell us, at the end, if all the channels found have the
       * same value for charset.
       */
      if (value) {
        same = same && value == chan.prefs.charset;
      } else {
        value = chan.prefs.charset;
      }
    }
    /* If we've got a value, and it's the same accross all channels,
     * we use it as the *default* for the charset pref. If not, it'll
     * just keep the "defer" default which pulls it off the network.
     */
    if (value && same) {
      user.prefManager.prefRecords.charset.defaultValue = value;
    }

    dispatch("create-tab-for-view", { view: user });

    user.doAutoPerform();
  }
  return user;
}

function arraySpeak(ary, single, plural) {
  var rv = "";
  var and = MSG_AND;

  switch (ary.length) {
    case 0:
      break;

    case 1:
      rv = ary[0];
      if (single) {
        rv += " " + single;
      }
      break;

    case 2:
      rv = ary[0] + " " + and + " " + ary[1];
      if (plural) {
        rv += " " + plural;
      }
      break;

    default:
      for (var i = 0; i < ary.length - 1; ++i) {
        rv += ary[i] + ", ";
      }
      rv += and + " " + ary[ary.length - 1];
      if (plural) {
        rv += " " + plural;
      }
      break;
  }

  return rv;
}

function getObjectDetails(obj, rv) {
  if (!rv) {
    rv = {};
  }

  if (
    !ASSERT(
      obj && typeof obj == "object",
      "INVALID OBJECT passed to getObjectDetails (" + obj + "). **"
    )
  ) {
    return rv;
  }

  rv.sourceObject = obj;
  rv.TYPE = obj.TYPE;
  rv.parent = "parent" in obj ? obj.parent : null;
  rv.user = null;
  rv.channel = null;
  rv.server = null;
  rv.network = null;
  if (window && window.content && window.content.getSelection() != "") {
    rv.selectedText = window.content.getSelection();
  }

  switch (obj.TYPE) {
    case "IRCChannel":
      rv.viewType = MSG_CHANNEL;
      rv.channel = obj;
      rv.channelName = obj.unicodeName;
      rv.server = rv.channel.parent;
      rv.network = rv.server.parent;
      break;

    case "IRCUser":
      rv.viewType = MSG_USER;
      rv.user = obj;
      rv.userName = rv.nickname = obj.unicodeName;
      rv.server = rv.user.parent;
      rv.network = rv.server.parent;
      break;

    case "IRCChanUser":
      rv.viewType = MSG_USER;
      rv.user = obj;
      rv.userName = rv.nickname = obj.unicodeName;
      rv.channel = rv.user.parent;
      rv.server = rv.channel.parent;
      rv.network = rv.server.parent;
      break;

    case "IRCNetwork":
      rv.network = obj;
      rv.viewType = MSG_NETWORK;
      if ("primServ" in rv.network) {
        rv.server = rv.network.primServ;
      } else {
        rv.server = null;
      }
      break;

    case "IRCClient":
      rv.viewType = MSG_TAB;
      break;

    case "IRCDCCUser":
      //rv.viewType = MSG_USER;
      rv.user = obj;
      rv.userName = obj.unicodeName;
      break;

    case "IRCDCCChat":
      //rv.viewType = MSG_USER;
      rv.chat = obj;
      rv.user = obj.user;
      rv.userName = obj.unicodeName;
      break;

    case "IRCDCCFileTransfer":
      //rv.viewType = MSG_USER;
      rv.file = obj;
      rv.user = obj.user;
      rv.userName = obj.unicodeName;
      rv.fileName = obj.filename;
      break;

    default:
      /* no setup for unknown object */
      break;
  }

  if (rv.network) {
    rv.networkName = rv.network.unicodeName;
  }

  return rv;
}

function findDynamicRule(selector) {
  var rules = frames[0].document.styleSheets[1].cssRules;

  if (isinstance(selector, RegExp)) {
    fun = "search";
  } else {
    fun = "indexOf";
  }

  for (var i = 0; i < rules.length; ++i) {
    var rule = rules.item(i);
    if (rule.selectorText && rule.selectorText[fun](selector) == 0) {
      return { sheet: frames[0].document.styleSheets[1], rule, index: i };
    }
  }

  return null;
}

function addDynamicRule(rule) {
  var rules = frames[0].document.styleSheets[1];

  var pos = rules.cssRules.length;
  rules.insertRule(rule, pos);
}

function getCommandEnabled(command) {
  try {
    var dispatcher = document.commandDispatcher;
    var controller = dispatcher.getControllerForCommand(command);

    return controller.isCommandEnabled(command);
  } catch (e) {
    return false;
  }
}

function gotoIRCURL(url, e) {
  var urlspec = url;
  if (typeof url == "string") {
    url = parseIRCURL(url);
  }

  if (!url) {
    Services.prompt.alert(
      window,
      MSG_ALERT,
      getMsg(MSG_ERR_BAD_IRCURL, urlspec)
    );
    return;
  }

  if (!url.host) {
    /* focus the *client* view for irc:, irc:/, and irc:// (the only irc
     * urls that don't have a host.  (irc:/// implies a connect to the
     * default network.)
     */
    client.pendingViewContext = e;
    dispatch("client");
    delete client.pendingViewContext;
    return;
  }

  let isSecure = url.scheme == "ircs";
  let network;
  // Make sure host is in lower case.
  url.host = url.host.toLowerCase();

  // Convert a request for a server to a network if we know it.
  if (url.isserver) {
    for (var n in client.networks) {
      network = client.networks[n];
      for (var s in network.servers) {
        let server = network.servers[s];
        if (
          server.hostname == url.host &&
          server.isSecure == isSecure &&
          (!url.port || server.port == url.port)
        ) {
          url.isserver = false;
          url.host = network.canonicalName;
          if (!url.port) {
            url.port = server.port;
          }
          break;
        }
      }
      if (!url.isserver) {
        break;
      }
    }
  }

  let name = url.host;
  network = client.getNetwork(name);

  if (url.isserver) {
    let found = false;
    if (network) {
      for (let s in network.servers) {
        let server = network.servers[s];
        if (
          server.isSecure == isSecure &&
          (!url.port || server.port == url.port)
        ) {
          found = true;
          if (!url.port) {
            url.port = server.port;
          }
          break;
        }
      }
    }

    // If still no port set, use the default.
    if (!url.port) {
      url.port = isSecure ? 6697 : 6667;
    }

    if (!found) {
      name += ":" + url.port;

      // If there is no temporary network for this server:port, create one.
      if (!client.getNetwork(name)) {
        let server = { name: url.host, port: url.port, isSecure };
        client.addNetwork(name, [server], true);
      }
      network = client.getNetwork(name);
    }
  } else {
    // There is no network called this, sorry.
    if (!network) {
      display(getMsg(MSG_ERR_UNKNOWN_NETWORK, name));
      return;
    }
  }

  // We should only prompt for a password if we're not connected.
  if (network.state == NET_OFFLINE) {
    // Check for a network password.
    url.pass = client.tryToGetLogin(
      network.getURL(),
      "serv",
      "*",
      url.pass,
      url.needpass,
      getMsg(MSG_HOST_PASSWORD, network.getURL())
    );
  }

  // Adjust secure setting for temporary networks (so user can override).
  if (network.temporary) {
    network.serverList[0].isSecure = url.scheme == "ircs";
  }

  // Adjust password for all servers (so user can override).
  if (url.pass) {
    for (var s in network.servers) {
      network.servers[s].password = url.pass;
    }
  }

  // Start the connection and pend anything else if we're not ready.
  if (network.state != NET_ONLINE) {
    client.pendingViewContext = e;
    if (!network.isConnected()) {
      client.connectToNetwork(network, url.scheme == "ircs");
    } else {
      dispatch("create-tab-for-view", { view: network });
      dispatch("set-current-view", { view: network });
    }
    delete client.pendingViewContext;

    if (!url.target) {
      return;
    }

    // We're not completely online, so everything else is pending.
    if (!("pendingURLs" in network)) {
      network.pendingURLs = [];
    }
    network.pendingURLs.unshift({ url, e });
    return;
  }

  // We're connected now, process the target.
  if (url.target) {
    var targetObject;
    var ev;
    if (url.isnick) {
      /* url points to a person. */
      var nick = url.target;
      var ary = url.target.split("!");
      if (ary) {
        nick = ary[0];
      }

      client.pendingViewContext = e;
      targetObject = network.dispatch("query", { nickname: nick });
      delete client.pendingViewContext;
    } else {
      /* url points to a channel */
      var key;
      var serv = network.primServ;
      var target = url.target;
      if (url.charset) {
        var chan = new CIRCChannel(
          serv,
          target,
          fromUnicode(target, url.charset)
        );
        chan.prefs.charset = url.charset;
      } else {
        // Must do this the hard way... we have the server's format
        // for the channel name here, and all our commands only work
        // with the Unicode forms.

        /* If we don't have a valid prefix, stick a "#" on it.
         * NOTE: This is always a "#" so that URLs may be compared
         * properly without involving the server (e.g. off-line).
         */
        if (
          !["#", "&", "+", "!"].includes(target[0]) &&
          !serv.channelTypes.includes(target[0])
        ) {
          target = "#" + target;
        }

        var chan = new CIRCChannel(serv, null, target);
      }

      if (url.needkey && !chan.joined) {
        if (url.key) {
          key = url.key;
        } else {
          key = window.promptPassword(getMsg(MSG_URL_KEY, url.spec));
        }
      }
      client.pendingViewContext = e;
      let d = { channelToJoin: chan, key };
      targetObject = network.dispatch("join", d);
      delete client.pendingViewContext;

      if (!targetObject) {
        return;
      }
    }

    if (url.msg) {
      client.pendingViewContext = e;
      var msg;
      if (url.msg.startsWith("\01ACTION")) {
        msg = filterOutput(url.msg, "ACTION", targetObject);
        targetObject.display(msg, "ACTION", "ME!", client.currentObject);
      } else {
        msg = filterOutput(url.msg, "PRIVMSG", targetObject);
        targetObject.display(msg, "PRIVMSG", "ME!", client.currentObject);
      }
      targetObject.say(msg);
      dispatch("set-current-view", { view: targetObject });
      delete client.pendingViewContext;
    }
  } else {
    client.pendingViewContext = e;
    dispatch("create-tab-for-view", { view: network });
    dispatch("set-current-view", { view: network });
    delete client.pendingViewContext;
  }
}

function updateProgress() {
  var busy;
  var progress = -1;

  if ("busy" in client.currentObject) {
    busy = client.currentObject.busy;
  }

  if ("progress" in client.currentObject) {
    progress = client.currentObject.progress;
  }

  if (!busy) {
    progress = 0;
  }

  client.progressPanel.collapsed = !busy;
  client.progressBar.mode = progress < 0 ? "undetermined" : "determined";
  if (progress >= 0) {
    client.progressBar.value = progress;
  }
}

function updateSecurityIcon() {
  var o = getObjectDetails(client.currentObject);
  var securityButton = window.document.getElementById("security-button");
  securityButton.label = "";
  securityButton.removeAttribute("level");
  securityButton.removeAttribute("tooltiptext");
  if (!o.server || !o.server.isConnected) {
    // No server or connection?
    securityButton.setAttribute("tooltiptext", MSG_SECURITY_INFO);
    return;
  }

  let tooltiptext = MSG_SECURITY_INFO;
  switch (o.server.connection.getSecurityState()) {
    case STATE_IS_SECURE:
      securityButton.setAttribute("level", "high");

      // Update the tooltip.
      var issuer = o.server.connection.getCertificate().issuerOrganization;
      tooltiptext = getMsg(MSG_SECURE_CONNECTION, issuer);
      break;
    case STATE_IS_BROKEN:
      securityButton.setAttribute("level", "broken");
      break;
    case STATE_IS_INSECURE:
    default:
      securityButton.setAttribute("level", "none");
  }
  securityButton.label = o.server.hostname;
  securityButton.setAttribute("tooltiptext", tooltiptext);
}

function updateLoggingIcon() {
  var state = client.currentObject.prefs.log ? "on" : "off";
  var icon = window.document.getElementById("logging-status");
  icon.setAttribute("loggingstate", state);
  icon.setAttribute("tooltiptext", getMsg("msg.logging.icon." + state));
}

function updateAlertIcon(aToggle) {
  let alertState = client.prefs["alert.globalEnabled"];
  if (aToggle) {
    alertState = !alertState;
    client.prefs["alert.globalEnabled"] = alertState;
  }
  let state = alertState ? "on" : "off";
  let icon = window.document.getElementById("alert-status");
  icon.setAttribute("alertstate", state);
  icon.setAttribute("tooltiptext", getMsg("msg.alert.icon." + state));
}

function initOfflineIcon() {
  client.offlineObserver = {
    _element: document.getElementById("offline-status"),
    state() {
      return Services.io.offline ? "offline" : "online";
    },
    observe(subject, topic, state) {
      if (topic == "offline-requested" && client.getConnectionCount() > 0) {
        var buttonAry = [MSG_REALLY_GO_OFFLINE, MSG_DONT_GO_OFFLINE];
        var rv = confirmEx(MSG_GOING_OFFLINE, buttonAry);
        if (rv == 1) {
          // Don't go offline, please!
          subject.QueryInterface(Ci.nsISupportsPRBool);
          subject.data = true;
        }
      } else if (topic == "network:offline-status-changed") {
        this.updateOfflineUI();
      }
    },
    updateOfflineUI() {
      this._element.setAttribute("offline", Services.io.offline);
      var tooltipMsgId = "MSG_OFFLINESTATE_" + this.state().toUpperCase();
      this._element.setAttribute("tooltiptext", window[tooltipMsgId]);
    },
    toggleOffline() {
      // Check whether people are OK with us going offline:
      if (!Services.io.offline && !this.canGoOffline()) {
        return;
      }

      // Stop automatic management of the offline status, if existing.
      Services.io.manageOfflineStatus = false;

      // Actually change the offline state.
      Services.io.offline = !Services.io.offline;
    },
    canGoOffline() {
      try {
        var canGoOffline = Cc["@mozilla.org/supports-PRBool;1"].createInstance(
          Ci.nsISupportsPRBool
        );
        Services.obs.notifyObservers(canGoOffline, "offline-requested");
        // Someone called for a halt
        if (canGoOffline.data) {
          return false;
        }
      } catch (ex) {
        dd("Exception when trying to ask if we could go offline:" + ex);
      }
      return true;
    },
  };

  Services.obs.addObserver(client.offlineObserver, "offline-requested");
  Services.obs.addObserver(
    client.offlineObserver,
    "network:offline-status-changed"
  );
  client.offlineObserver.updateOfflineUI();
}

function uninitOfflineIcon() {
  Services.obs.removeObserver(client.offlineObserver, "offline-requested");
  Services.obs.removeObserver(
    client.offlineObserver,
    "network:offline-status-changed"
  );
}

client.idleObserver = {
  QueryInterface: ChromeUtils.generateQI([Ci.nsIObserver]),

  observe(subject, topic, data) {
    if (topic == "idle" && !client.prefs.away) {
      if (!client.prefs.awayIdleMsg) {
        client.prefs.awayIdleMsg = MSG_AWAY_IDLE_DEFAULT;
      }
      client.dispatch("idle-away", { reason: client.prefs.awayIdleMsg });
      client.isIdleAway = true;
    } else if ((topic == "back" || topic == "active") && client.isIdleAway) {
      client.dispatch("idle-back");
      client.isIdleAway = false;
    }
  },
};

function initIdleAutoAway(timeout) {
  // Don't try to do anything if we are disabled
  if (!timeout) {
    return;
  }

  let idleService = Cc["@mozilla.org/widget/idleservice;1"].getService(
    Ci.nsIIdleService
  );
  idleService.addIdleObserver(client.idleObserver, timeout * 60);
}

function uninitIdleAutoAway(timeout) {
  // Don't try to do anything if we were disabled before
  if (!timeout) {
    return;
  }

  let idleService = Cc["@mozilla.org/widget/idleservice;1"].getService(
    Ci.nsIIdleService
  );
  idleService.removeIdleObserver(client.idleObserver, timeout * 60);
}

function updateAppMotif(motifURL) {
  var node = document.firstChild;
  while (
    node &&
    (node.nodeType != node.PROCESSING_INSTRUCTION_NODE ||
      !/name="dyn-motif"/.test(node.data))
  ) {
    node = node.nextSibling;
  }

  motifURL = motifURL.replace(/"/g, "%22");
  var dataStr = 'href="' + motifURL + '" name="dyn-motif"';
  // No dynamic style node yet.
  if (!node) {
    node = document.createProcessingInstruction("xml-stylesheet", dataStr);
    document.insertBefore(node, document.firstChild);
  } else if (node.data != dataStr) {
    node.data = dataStr;
    document.insertBefore(node, node.nextSibling);
  }
}

function updateSpellcheck(value) {
  value = value.toString();
  document.getElementById("input").setAttribute("spellcheck", value);
  document.getElementById("multiline-input").setAttribute("spellcheck", value);
}

function updateNetwork() {
  var o = getObjectDetails(client.currentObject);

  var lag = MSG_UNKNOWN;
  var nick = "";
  if (o.server) {
    if (o.server.me) {
      nick = o.server.me.unicodeName;
    }
    lag = o.server.lag != -1 ? o.server.lag.toFixed(2) : MSG_UNKNOWN;
  }
  client.statusBar["header-url"].setAttribute(
    "value",
    client.currentObject.getURL()
  );
  client.statusBar["header-url"].setAttribute(
    "href",
    client.currentObject.getURL()
  );
  client.statusBar["header-url"].setAttribute(
    "name",
    client.currentObject.unicodeName
  );
}

function updateTitle(obj) {
  if (
    !("currentObject" in client && client.currentObject) ||
    (obj && obj != client.currentObject)
  ) {
    return;
  }

  var tstring = MSG_TITLE_UNKNOWN;
  var o = getObjectDetails(client.currentObject);
  var net = o.network ? o.network.unicodeName : "";
  var nick = "";
  client.statusBar["server-nick"].disabled = false;

  switch (client.currentObject.TYPE) {
    case "IRCNetwork":
      var serv = "",
        port = "";
      if (client.currentObject.isConnected()) {
        serv = o.server.hostname;
        port = o.server.port;
        if (o.server.me) {
          nick = o.server.me.unicodeName;
        }
        tstring = getMsg(MSG_TITLE_NET_ON, [nick, net, serv, port]);
      } else {
        nick = client.currentObject.INITIAL_NICK;
        tstring = getMsg(MSG_TITLE_NET_OFF, [nick, net]);
      }
      break;

    case "IRCChannel":
      var chan = "",
        mode = "",
        topic = "";
      if ("me" in o.parent) {
        nick = o.parent.me.unicodeName;
        if (o.parent.me.collectionKey in client.currentObject.users) {
          let cuser = client.currentObject.users[o.parent.me.collectionKey];
          if (cuser.isFounder) {
            nick = "~" + nick;
          } else if (cuser.isAdmin) {
            nick = "&" + nick;
          } else if (cuser.isOp) {
            nick = "@" + nick;
          } else if (cuser.isHalfOp) {
            nick = "%" + nick;
          } else if (cuser.isVoice) {
            nick = "+" + nick;
          }
        }
      } else {
        nick = MSG_TITLE_NONICK;
      }
      chan = o.channel.unicodeName;
      mode = o.channel.mode.getModeStr();
      if (!mode) {
        mode = MSG_TITLE_NO_MODE;
      }
      topic = o.channel.topic ? o.channel.topic : MSG_TITLE_NO_TOPIC;
      var re = /\x1f|\x02|\x0f|\x16|\x03([0-9]{1,2}(,[0-9]{1,2})?)?/g;
      topic = topic.replace(re, "");

      tstring = getMsg(MSG_TITLE_CHANNEL, [nick, chan, mode, topic]);
      break;

    case "IRCUser":
      nick = client.currentObject.unicodeName;
      var source = "";
      if (client.currentObject.name) {
        source =
          "<" +
          client.currentObject.name +
          "@" +
          client.currentObject.host +
          ">";
      }
      tstring = getMsg(MSG_TITLE_USER, [nick, source]);
      nick = "me" in o.parent ? o.parent.me.unicodeName : MSG_TITLE_NONICK;
      break;

    case "IRCClient":
      nick = client.prefs.nickname;
      break;

    case "IRCDCCChat":
      client.statusBar["server-nick"].disabled = true;
      nick = o.chat.me.unicodeName;
      tstring = getMsg(MSG_TITLE_DCCCHAT, o.userName);
      break;

    case "IRCDCCFileTransfer":
      client.statusBar["server-nick"].disabled = true;
      nick = o.file.me.unicodeName;
      var data = [o.file.progress, o.file.filename, o.userName];
      if (o.file.state.dir == 1) {
        tstring = getMsg(MSG_TITLE_DCCFILE_SEND, data);
      } else {
        tstring = getMsg(MSG_TITLE_DCCFILE_GET, data);
      }
      break;
  }

  if (0 && !client.uiState.tabstrip) {
    var actl = [];
    for (var i in client.activityList) {
      actl.push(
        client.activityList[i] == "!" ? Number(i) + 1 + "!" : Number(i) + 1
      );
    }
    if (actl.length > 0) {
      tstring = getMsg(MSG_TITLE_ACTIVITY, [tstring, actl.join(", ")]);
    }
  }

  document.title = tstring;
  client.statusBar["server-nick"].setAttribute("label", nick);
}

// Where 'right' is orientation, not wrong/right:
function updateUserlistSide(shouldBeLeft) {
  var listParent = document.getElementById("tabpanels-contents-box");
  var isLeft = listParent.childNodes[0].id == "user-list-box";
  if (isLeft == shouldBeLeft) {
    return;
  }
  if (shouldBeLeft) {
    // Move from right to left.
    listParent.insertBefore(listParent.childNodes[1], listParent.childNodes[0]);
    listParent.insertBefore(listParent.childNodes[2], listParent.childNodes[0]);
    listParent.childNodes[1].setAttribute("collapse", "before");
  } // Move from left to right.
  else {
    listParent.appendChild(listParent.childNodes[1]);
    listParent.appendChild(listParent.childNodes[0]);
    listParent.childNodes[1].setAttribute("collapse", "after");
  }
  if (client.currentObject && client.currentObject.TYPE == "IRCChannel") {
    client.currentObject.updateUserList(true);
  }
}

function multilineInputMode(state) {
  var multiInput = document.getElementById("multiline-input");
  var multiInputBox = document.getElementById("multiline-box");
  var singleInput = document.getElementById("input");
  var singleInputBox = document.getElementById("singleline-box");
  var splitter = document.getElementById("input-splitter");
  var iw = document.getElementById("input-widgets");
  var h;

  client._mlMode = state;

  if (state) {
    /* turn on multiline input mode */
    h = iw.getAttribute("lastHeight");
    if (h) {
      iw.setAttribute("height", h);
    } /* restore the slider position */

    singleInputBox.setAttribute("collapsed", "true");
    splitter.setAttribute("collapsed", "false");
    multiInputBox.setAttribute("collapsed", "false");
    // multiInput should have the same direction as singleInput
    multiInput.setAttribute("dir", singleInput.getAttribute("dir"));
    multiInput.value = client.input ? client.input.value : "";
    client.input = multiInput;
  } /* turn off multiline input mode */ else {
    h = iw.getAttribute("height");
    iw.setAttribute("lastHeight", h); /* save the slider position */
    iw.removeAttribute("height"); /* let the slider drop */

    splitter.setAttribute("collapsed", "true");
    multiInputBox.setAttribute("collapsed", "true");
    singleInputBox.setAttribute("collapsed", "false");
    // singleInput should have the same direction as multiInput
    singleInput.setAttribute("dir", multiInput.getAttribute("dir"));
    singleInput.value = client.input ? client.input.value : "";
    client.input = singleInput;
  }

  client.input.focus();
}

function displayCertificateInfo() {
  var o = getObjectDetails(client.currentObject);
  if (!o.server) {
    return;
  }

  if (!o.server.isSecure) {
    Services.prompt.alert(
      window,
      MSG_ALERT,
      getMsg(MSG_INSECURE_SERVER, o.server.hostname)
    );
    return;
  }

  let cd = Cc["@mozilla.org/nsCertificateDialogs;1"].getService(
    Ci.nsICertificateDialogs
  );
  cd.viewCert(window, o.server.connection.getCertificate());
}

function onLoggingIcon() {
  client.currentObject.dispatch("log", { state: "toggle" });
}

function newInlineText(data, className, tagName) {
  if (typeof tagName == "undefined") {
    tagName = "html:span";
  }

  var a = document.createElementNS(XHTML_NS, tagName);
  if (className) {
    a.setAttribute("class", className);
  }

  switch (typeof data) {
    case "string":
      a.appendChild(document.createTextNode(data));
      break;

    case "object":
      for (var p in data) {
        if (p != "data") {
          a.setAttribute(p, data[p]);
        } else {
          a.appendChild(document.createTextNode(data[p]));
        }
      }
      break;

    case "undefined":
      break;

    default:
      ASSERT(
        0,
        "INVALID TYPE ('" + typeof data + "') passed to " + "newInlineText."
      );
      break;
  }

  return a;
}

function stringToMsg(message, obj) {
  var ary = message.split("\n");
  var span = document.createElementNS(XHTML_NS, "html:span");
  var data = getObjectDetails(obj);

  if (ary.length == 1) {
    client.munger.munge(ary[0], span, data);
  } else {
    for (var l = 0; l < ary.length - 1; ++l) {
      client.munger.munge(ary[l], span, data);
      span.appendChild(document.createElementNS(XHTML_NS, "html:br"));
    }
    client.munger.munge(ary[l], span, data);
  }

  return span;
}

function getFrame() {
  if (client.deck.childNodes.length == 0) {
    return undefined;
  }
  var panel = client.deck.selectedPanel;
  return getContentWindow(panel);
}

client.__defineGetter__("currentFrame", getFrame);

function setCurrentObject(obj) {
  if (!ASSERT(obj.messages, "INVALID OBJECT passed to setCurrentObject **")) {
    return;
  }

  if ("currentObject" in client && client.currentObject == obj) {
    if (typeof client.pendingViewContext == "object") {
      dispatch("create-tab-for-view", { view: obj });
    }
    return;
  }

  // Set window.content to make screenreader apps find the chat content.
  if (obj.frame && getContentWindow(obj.frame)) {
    window.content = getContentWindow(obj.frame);
  }

  var tb;

  if ("currentObject" in client && client.currentObject) {
    tb = getTabForObject(client.currentObject);
  }
  if (tb) {
    tb.setAttribute("state", "normal");
  }

  // If we're tracking last read lines, set a mark on the current view
  // before switching to the new one.
  if (tb && client.currentObject.prefs.autoMarker) {
    client.currentObject.dispatch("marker-set");
  }

  client.currentObject = obj;

  // Update userlist:
  while (
    client.list.firstChild &&
    client.list.firstChild.localName == "listitem"
  ) {
    client.list.firstChild.remove();
  }
  if (obj.TYPE == "IRCChannel") {
    obj.updateUserList(true);
  }

  tb = dispatch("create-tab-for-view", { view: obj });
  if (tb) {
    tb.parentNode.selectedItem = tb;
    tb.setAttribute("state", "current");
  }

  var vk = Number(tb.getAttribute("viewKey"));
  delete client.activityList[vk];
  client.deck.selectedPanel = obj.frame;

  // Style userlist and the like:
  updateAppMotif(obj.prefs["motif.current"]);

  updateTitle();
  updateProgress();
  updateSecurityIcon();
  updateLoggingIcon();

  scrollDown(obj.frame, false);

  // Input area should have the same direction as the output area
  if (
    "frame" in client.currentObject &&
    client.currentObject.frame &&
    getContentDocument(client.currentObject.frame) &&
    "body" in getContentDocument(client.currentObject.frame) &&
    getContentDocument(client.currentObject.frame).body
  ) {
    var contentArea = getContentDocument(client.currentObject.frame).body;
    client.input.setAttribute("dir", contentArea.getAttribute("dir"));
  }
  client.input.focus();
}

function checkScroll(frame) {
  var window = getContentWindow(frame);
  if (!window || !window.document || !window.document.body) {
    return false;
  }

  return (
    window.document.body.clientHeight -
      window.innerHeight -
      window.pageYOffset <
    160
  );
}

function scrollDown(frame, force) {
  var window = getContentWindow(frame);
  if (!window || !window.document || !window.document.body) {
    return;
  }

  if (force || checkScroll(frame)) {
    window.scrollTo(0, window.document.body.clientHeight);
  }
}

function advanceKeyboardFocus(amount) {
  var contentWin = getContentWindow(client.currentObject.frame);
  var contentDoc = getContentDocument(client.currentObject.frame);

  // Focus userlist, inputbox and outputwindow in turn:
  var focusableElems = [client.list, client.input.inputField, contentWin];

  var elem = document.commandDispatcher.focusedElement;
  // Finding focus in the content window is "hard". It's going to be null
  // if the window itself is focused, and "some element" inside of it if the
  // user starts tabbing through.
  if (!elem || elem.ownerDocument == contentDoc) {
    elem = contentWin;
  }

  var newIndex = (focusableElems.indexOf(elem) + 3 + amount) % 3;
  focusableElems[newIndex].focus();

  // Make it obvious this element now has focus.
  var outlinedElem;
  if (focusableElems[newIndex] == client.input.inputField) {
    outlinedElem = client.input.parentNode.id;
  } else if (focusableElems[newIndex] == userList) {
    outlinedElem = "user-list-box";
  } else {
    outlinedElem = "browser-box";
  }

  // Do magic, and make sure it gets undone at the right time:
  if ("focusedElemTimeout" in client && client.focusedElemTimeout) {
    clearTimeout(client.focusedElemTimeout);
  }
  outlineFocusedElem(outlinedElem);
  client.focusedElemTimeout = setTimeout(outlineFocusedElem, 1000, "");
}

function outlineFocusedElem(id) {
  var outlinedElements = [
    "user-list-box",
    "browser-box",
    "multiline-hug-box",
    "singleline-hug-box",
  ];
  for (var i = 0; i < outlinedElements.length; i++) {
    var elem = document.getElementById(outlinedElements[i]);
    if (outlinedElements[i] == id) {
      elem.setAttribute("focusobvious", "true");
    } else {
      elem.removeAttribute("focusobvious");
    }
  }
  client.focusedElemTimeout = 0;
}

/* valid values for |what| are "superfluous", "activity", and "attention".
 * final value for state is dependant on priority of the current state, and the
 * new state. the priority is: normal < superfluous < activity < attention.
 */
function setTabState(source, what, callback) {
  if (typeof source != "object") {
    if (
      !ASSERT(
        source in client.viewsArray,
        "INVALID SOURCE passed to setTabState"
      )
    ) {
      return;
    }
    source = client.viewsArray[source].source;
  }

  callback = callback || false;

  var tb = source.dispatch("create-tab-for-view", { view: source });
  var vk = Number(tb.getAttribute("viewKey"));

  var current = "currentObject" in client && client.currentObject == source;

  /* We want to play sounds if they're from a non-current view, or we don't
   * have focus at all. Also make sure stalk matches always play sounds.
   * Also make sure we don't play on the 2nd half of the flash (Callback).
   */
  if (!callback && (!window.isFocused || !current || what == "attention")) {
    if (what == "attention") {
      playEventSounds(source.TYPE, "stalk", source);
    } else if (what == "activity") {
      playEventSounds(source.TYPE, "chat", source);
    } else if (what == "superfluous") {
      playEventSounds(source.TYPE, "event", source);
    }
  }

  // Only change the tab's colour if it's not the active view.
  if (!current) {
    var state = tb.getAttribute("state");
    if (state == what) {
      /* if the tab state has an equal priority to what we are setting
       * then blink it */
      if (client.prefs.activityFlashDelay > 0) {
        tb.setAttribute("state", "normal");
        setTimeout(
          setTabState,
          client.prefs.activityFlashDelay,
          vk,
          what,
          true
        );
      }
    } else if (
      state == "normal" ||
      state == "superfluous" ||
      (state == "activity" && what == "attention")
    ) {
      /* if the tab state has a lower priority than what we are
       * setting, change it to the new state */
      tb.setAttribute("state", what);
      /* we only change the activity list if priority has increased */
      if (what == "attention") {
        client.activityList[vk] = "!";
      } else if (what == "activity") {
        client.activityList[vk] = "+";
      } else {
        /* this is functionally equivalent to "+" for now */
        client.activityList[vk] = "-";
      }
      updateTitle();
    } else {
      /* the current state of the tab has a higher priority than the
       * new state.
       * blink the new lower state quickly, then back to the old */
      if (client.prefs.activityFlashDelay > 0) {
        tb.setAttribute("state", what);
        setTimeout(
          setTabState,
          client.prefs.activityFlashDelay,
          vk,
          state,
          true
        );
      }
    }
  }
}

function notifyAttention(source) {
  if (typeof source != "object") {
    source = client.viewsArray[source].source;
  }

  if (client.currentObject != source) {
    var tb = dispatch("create-tab-for-view", { view: source });
    var vk = Number(tb.getAttribute("viewKey"));

    tb.setAttribute("state", "attention");
    client.activityList[vk] = "!";
    updateTitle();
  }

  if (client.prefs["notify.aggressive"]) {
    window.getAttention();
  }
}

function setDebugMode(mode) {
  if (mode.includes("t")) {
    client.debugHook.enabled = true;
  } else {
    client.debugHook.enabled = false;
  }

  if (mode.includes("c")) {
    client.dbgContexts = true;
  } else {
    delete client.dbgContexts;
  }

  if (mode.includes("d")) {
    client.dbgDispatch = true;
  } else {
    delete client.dbgDispatch;
  }
}

function setListMode(mode) {
  if (mode) {
    client.list.setAttribute("mode", mode);
  } else {
    client.list.removeAttribute("mode");
  }
}

function getNicknameForUserlistRow(item) {
  return item.getAttribute("label");
}

function getFrameForDOMWindow(window) {
  var frame;
  for (var i = 0; i < client.deck.childNodes.length; i++) {
    frame = client.deck.childNodes[i];
    if (frame.contentWindow == window) {
      return frame;
    }
  }
  return undefined;
}

function replaceColorCodes(msg) {
  // Find things that look like URLs and escape the color code inside of those
  // to prevent munging the URLs resulting in broken links. Leave codes at
  // the start of the URL alone.
  msg = msg.replace(
    new RegExp(client.linkRE.source, "g"),
    function (url, _foo, scheme) {
      if (scheme && !client.checkURLScheme(scheme)) {
        return url;
      }
      return url.replace(/%[BC][0-9A-Fa-f]/g, function (hex, index) {
        // as JS does not support lookbehind and we don't want to consume the
        // preceding character, we test for an existing %% manually
        var needPercent = "%" == url.substr(index - 1, 1) || index == 0;
        return (needPercent ? "" : "%") + hex;
      });
    }
  );

  // mIRC codes: underline, bold, Original (reset), colors, reverse colors.
  msg = msg.replace(/(^|[^%])%U/g, "$1\x1f");
  msg = msg.replace(/(^|[^%])%B/g, "$1\x02");
  msg = msg.replace(/(^|[^%])%O/g, "$1\x0f");
  msg = msg.replace(/(^|[^%])%C/g, "$1\x03");
  msg = msg.replace(/(^|[^%])%R/g, "$1\x16");
  // %%[UBOCR] --> %[UBOCR].
  msg = msg.replace(/%(%[UBOCR])/g, "$1");

  return msg;
}

function decodeColorCodes(msg) {
  // %[UBOCR] --> %%[UBOCR].
  msg = msg.replace(/(%[UBOCR])/g, "%$1");
  // Put %-codes back in place of special character codes.
  msg = msg.replace(/\x1f/g, "%U");
  msg = msg.replace(/\x02/g, "%B");
  msg = msg.replace(/\x0f/g, "%O");
  msg = msg.replace(/\x03/g, "%C");
  msg = msg.replace(/\x16/g, "%R");

  return msg;
}

function removeColorCodes(msg) {
  msg = msg.replace(/[\x1f\x02\x0f\x16]/g, "");
  // We need this to be global:
  msg = msg.replace(new RegExp(client.colorRE.source, "g"), "");
  return msg;
}

client.progressListener = {};

client.progressListener.QueryInterface = ChromeUtils.generateQI([
  Ci.nsIWebProgressListener,
  Ci.nsISupportsWeakReference,
]);

client.progressListener.onStateChange = function (
  webProgress,
  request,
  stateFlags,
  status
) {
  const START = Ci.nsIWebProgressListener.STATE_START;
  const STOP = Ci.nsIWebProgressListener.STATE_STOP;
  const IS_NETWORK = Ci.nsIWebProgressListener.STATE_IS_NETWORK;
  const IS_DOCUMENT = Ci.nsIWebProgressListener.STATE_IS_DOCUMENT;
  const IS_REQUEST = Ci.nsIWebProgressListener.STATE_IS_REQUEST;

  var frame;
  //dd("progressListener.onStateChange(" + stateFlags.toString(16) + ")");

  // We only care about the initial start of loading, not the loading of
  // and page sub-components (IS_DOCUMENT, etc.).
  if (
    stateFlags & START &&
    stateFlags & IS_NETWORK &&
    stateFlags & IS_DOCUMENT
  ) {
    frame = getFrameForDOMWindow(webProgress.DOMWindow);
    if (!frame) {
      dd("can't find frame for window (start)");
      try {
        webProgress.removeProgressListener(this);
      } catch (ex) {
        dd("Exception removing progress listener (start): " + ex);
      }
    }
  }
  // We only want to know when the *network* stops, not the page's
  // individual components (STATE_IS_REQUEST/STATE_IS_DOCUMENT/somesuch).
  else if (stateFlags & STOP && stateFlags & IS_NETWORK) {
    frame = getFrameForDOMWindow(webProgress.DOMWindow);
    if (!frame) {
      dd("can't find frame for window (stop)");
      try {
        webProgress.removeProgressListener(this);
      } catch (ex) {
        dd("Exception removing progress listener (stop): " + ex);
      }
    } else {
      var cwin = getContentWindow(frame);
      if (cwin && "initOutputWindow" in cwin) {
        if (!("_called_initOutputWindow" in cwin)) {
          cwin._called_initOutputWindow = true;
          cwin.initOutputWindow(client, frame.source, onMessageViewClick);
          cwin.changeCSS(frame.source.getFontCSS("data"), "cz-fonts");
          scrollDown(frame, true);
          //dd("initOutputWindow(" + frame.source.getURL() + ")");
        }
      }
      // XXX: For about:blank it won't find initOutputWindow. Cope.
      else if (!cwin || !cwin.location || cwin.location.href != "about:blank") {
        // This should totally never ever happen. It will if we get in a
        // fight with xpcnativewrappers, though. Oops:
        dd(
          "Couldn't find a content window or its initOutputWindow " +
            "function. This is BAD!"
        );
      }
    }
  }
  // Requests stopping are either the page, or its components loading. We're
  // interested in its components.
  else if (stateFlags & STOP && stateFlags & IS_REQUEST) {
    frame = getFrameForDOMWindow(webProgress.DOMWindow);
    if (frame) {
      var cwin = getContentWindow(frame);
      if (cwin && "_called_initOutputWindow" in cwin) {
        scrollDown(frame, false);
        //dd("scrollDown(" + frame.source.getURL() + ")");
      }
    }
  }
};

client.progressListener.onProgressChange = function (
  webProgress,
  request,
  currentSelf,
  totalSelf,
  currentMax,
  selfMax
) {};

client.progressListener.onLocationChange = function (
  webProgress,
  request,
  uri
) {};

client.progressListener.onStatusChange = function (
  webProgress,
  request,
  status,
  message
) {};

client.progressListener.onSecurityChange = function (
  webProgress,
  request,
  state
) {};

client.installPlugin = function (name, source) {
  function checkPluginInstalled(name, path) {
    var installed = path.exists();
    installed |= name in client.plugins;

    if (installed) {
      display(MSG_INSTALL_PLUGIN_ERR_ALREADY_INST, MT_ERROR);
      throw Components.Exception(CZ_PI_ABORT, Cr.NS_ERROR_FAILURE);
    }
  }

  const CZ_PI_ABORT = "CZ_PI_ABORT";

  var dest;
  // Find a suitable location if there was none specified.
  var destList = client.prefs.initialScripts;
  if (
    destList.length == 0 ||
    (destList.length == 1 && /^\s*$/.test(destList[0]))
  ) {
    // Reset to default because it is empty.
    try {
      client.prefManager.clearPref("initialScripts");
    } catch (ex) {
      /* If this really fails, we're mostly screwed anyway */
    }
    destList = client.prefs.initialScripts;
  }

  // URLs for initialScripts can be relative (the default is):
  var profilePath = getURLSpecFromFile(client.prefs.profilePath);
  profilePath = Services.io.newURI(profilePath);
  for (var i = 0; i < destList.length; i++) {
    var destURL = Services.io.newURI(destList[i], null, profilePath);
    var file = new nsLocalFile(getFileFromURLSpec(destURL.spec).path);
    if (file.exists() && file.isDirectory()) {
      // A directory that exists! We'll take it!
      dest = file.clone();
      break;
    }
  }
  if (!dest) {
    display(MSG_INSTALL_PLUGIN_ERR_INSTALL_TO, MT_ERROR);
    return;
  }

  try {
    if (typeof source == "string") {
      source = getFileFromURLSpec(source);
    }
  } catch (ex) {
    display(getMsg(MSG_INSTALL_PLUGIN_ERR_CHECK_SD, ex), MT_ERROR);
    return;
  }

  display(
    getMsg(MSG_INSTALL_PLUGIN_INSTALLING, [source.path, dest.path]),
    MT_INFO
  );

  var ary;
  if (source.path.match(/\.(jar|zip)$/i)) {
    try {
      var zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
        Ci.nsIZipReader
      );
      zipReader.open(source);

      // This is set to the base path found on ALL items in the zip file.
      // when we extract, this WILL BE REMOVED from all paths.
      var zipPathBase = "";
      // This always points to init.js, even if we're messing with paths.
      var initPath = "init.js";

      // Look for init.js within a directory...
      var items = zipReader.findEntries("*/init.js");
      while (items.hasMore()) {
        var itemName = items.getNext();
        // Do we already have one?
        if (zipPathBase) {
          display(MSG_INSTALL_PLUGIN_ERR_MANY_INITJS, MT_WARN);
          throw Components.Exception(CZ_PI_ABORT, Cr.NS_ERROR_FAILURE);
        }
        zipPathBase = itemName.match(/^(.*\/)init.js$/)[1];
        initPath = itemName;
      }

      if (zipPathBase) {
        // We have a base for init.js, assert that all files are inside
        // it. If not, we drop the path and install exactly as-is
        // instead (which will probably cause it to not work because the
        // init.js isn't in the right place).
        items = zipReader.findEntries("*");
        while (items.hasMore()) {
          itemName = items.getNext();
          if (!itemName.startsWith(zipPathBase)) {
            display(MSG_INSTALL_PLUGIN_ERR_MIXED_BASE, MT_WARN);
            zipPathBase = "";
            break;
          }
        }
      }

      // Test init.js for a plugin ID.
      var initJSFile = getTempFile(
        client.prefs.profilePath,
        "install-plugin.temp"
      );
      zipReader.extract(initPath, initJSFile);
      initJSFile.permissions = 438; // 0666
      var initJSFileH = new LocalFile(initJSFile, "<");
      var initJSData = initJSFileH.read();
      initJSFileH.close();
      initJSFile.remove(false);

      //XXXgijs: this is fragile. Anyone got a better idea?
      ary = initJSData.match(/plugin\.id\s*=\s*(['"])(.*?)(\1)/);
      if (ary && name != ary[2]) {
        display(getMsg(MSG_INSTALL_PLUGIN_WARN_NAME, [name, ary[2]]), MT_WARN);
        name = ary[2];
      }

      dest.append(name);
      checkPluginInstalled(name, dest);

      dest.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);

      // Actually extract files...
      var destInit;
      items = zipReader.findEntries("*");
      while (items.hasMore()) {
        itemName = items.getNext();
        if (!itemName.match(/\/$/)) {
          var dirs = itemName;
          // Remove common path if there is one.
          if (zipPathBase) {
            dirs = dirs.substring(zipPathBase.length);
          }
          dirs = dirs.split("/");

          // Construct the full path for the extracted file...
          var zipFile = dest.clone();
          for (var i = 0; i < dirs.length - 1; i++) {
            zipFile.append(dirs[i]);
            if (!zipFile.exists()) {
              zipFile.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            }
          }
          zipFile.append(dirs[dirs.length - 1]);

          if (zipFile.leafName == "init.js") {
            destInit = zipFile;
          }

          zipReader.extract(itemName, zipFile);
          zipFile.permissions = 438; // 0666
        }
      }

      var rv = dispatch("load ", { url: getURLSpecFromFile(destInit) });
      if (rv) {
        display(getMsg(MSG_INSTALL_PLUGIN_DONE, name));
      } else {
        display(MSG_INSTALL_PLUGIN_ERR_REMOVING, MT_ERROR);
        dest.remove(true);
      }
    } catch (ex) {
      if (ex != CZ_PI_ABORT) {
        display(getMsg(MSG_INSTALL_PLUGIN_ERR_EXTRACT, ex), MT_ERROR);
      }
      zipReader.close();
      return;
    }
    try {
      zipReader.close();
    } catch (ex) {
      display(getMsg(MSG_INSTALL_PLUGIN_ERR_EXTRACT, ex), MT_ERROR);
    }
  } else if (source.path.match(/\.(js)$/i)) {
    try {
      // Test init.js for a plugin ID.
      var initJSFileH = new LocalFile(source, "<");
      var initJSData = initJSFileH.read();
      initJSFileH.close();

      ary = initJSData.match(/plugin\.id\s*=\s*(['"])(.*?)(\1)/);
      if (ary && name != ary[2]) {
        display(getMsg(MSG_INSTALL_PLUGIN_WARN_NAME, [name, ary[2]]), MT_WARN);
        name = ary[2];
      }

      dest.append(name);
      checkPluginInstalled(name, dest);

      dest.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);

      dest.append("init.js");

      var destFile = new LocalFile(dest, ">");
      destFile.write(initJSData);
      destFile.close();

      var rv = dispatch("load", { url: getURLSpecFromFile(dest) });
      if (rv) {
        display(getMsg(MSG_INSTALL_PLUGIN_DONE, name));
      } else {
        display(MSG_INSTALL_PLUGIN_ERR_REMOVING, MT_ERROR);
        // We've appended "init.js" before, so go back up one level:
        dest.parent.remove(true);
      }
    } catch (ex) {
      if (ex != CZ_PI_ABORT) {
        display(getMsg(MSG_INSTALL_PLUGIN_ERR_INSTALLING, ex), MT_ERROR);
      }
    }
  } else {
    display(MSG_INSTALL_PLUGIN_ERR_FORMAT, MT_ERROR);
  }
};

client.uninstallPlugin = function (plugin) {
  if (!disablePlugin(plugin, true)) {
    return;
  }
  delete client.plugins[plugin.id];
  let file = getFileFromURLSpec(plugin.cwd);
  if (file.exists() && file.isDirectory()) {
    // Delete the directory and contents.
    file.remove(true);
  }
  display(getMsg(MSG_PLUGIN_UNINSTALLED, plugin.id));
};

function syncOutputFrame(obj, nesting) {
  const ALL = Ci.nsIWebProgress.NOTIFY_ALL;

  var iframe = obj.frame;

  function tryAgain(nLevel) {
    syncOutputFrame(obj, nLevel);
  }

  if (typeof nesting != "number") {
    nesting = 0;
  }

  if (nesting > 10) {
    dd("Aborting syncOutputFrame, taken too many tries.");
    return;
  }

  /* We leave the progress listener attached so try to remove it first,
   * should we be called on an already-set-up view.
   */
  try {
    iframe.removeProgressListener(client.progressListener, ALL);
  } catch (ex) {}

  try {
    if (getContentDocument(iframe) && "webProgress" in iframe) {
      iframe.addProgressListener(client.progressListener, ALL);
      iframe.loadURI("chrome://chatzilla/content/output-window.xhtml");
    } else {
      setTimeout(tryAgain, 500, nesting + 1);
    }
  } catch (ex) {
    dd("caught exception showing session view, will try again later.");
    dd(dumpObjectTree(ex) + "\n");
    setTimeout(tryAgain, 500, nesting + 1);
  }
}

function createMessages(source) {
  playEventSounds(source.TYPE, "start", source);

  source.messages = document.createElementNS(XHTML_NS, "html:table");
  source.messages.setAttribute("class", "msg-table");
  source.messages.setAttribute("view-type", source.TYPE);
  source.messages.setAttribute("role", "log");
  source.messages.setAttribute("aria-live", "polite");

  var tbody = document.createElementNS(XHTML_NS, "html:tbody");
  source.messages.appendChild(tbody);
  source.messageCount = 0;
}

/* Gets the <tab> element associated with a view object.
 * If |create| is present, and true, tab is created if not found.
 */
function getTabForObject(source, create) {
  var name;

  if (!ASSERT(source, "UNDEFINED passed to getTabForObject")) {
    return null;
  }

  if (!ASSERT("viewName" in source, "INVALID OBJECT in getTabForObject")) {
    return null;
  }

  name = source.viewName;

  var tb,
    id = "tb[" + name + "]";
  var matches = 1;

  for (var i in client.viewsArray) {
    if (client.viewsArray[i].source == source) {
      tb = client.viewsArray[i].tb;
      break;
    } else if (client.viewsArray[i].tb.getAttribute("id") == id) {
      id = "tb[" + name + "<" + ++matches + ">]";
    }
  }

  /* If we found a <tab>, are allowed to create it, and have a pending view
   * context, then we're expected to move the existing tab according to said
   * context. We do that by removing the tab here, and below the creation
   * code (which is not run) we readd it in the correct location.
   */
  if (tb && create && typeof client.pendingViewContext == "object") {
    /* If we're supposed to insert before ourselves, or the next <tab>,
     * then bail out (since it's a no-op).
     */
    var tabBefore = client.pendingViewContext.tabInsertBefore;
    if (tabBefore) {
      var tbAfter = tb.nextSibling;
      while (tbAfter && tbAfter.collapsed && tbAfter.hidden) {
        tbAfter = tbAfter.nextSibling;
      }
      if (tabBefore == tb || tabBefore == tbAfter) {
        return tb;
      }
    }

    var viewKey = Number(tb.getAttribute("viewKey"));
    client.viewsArray.splice(viewKey, 1);
    for (i = viewKey; i < client.viewsArray.length; i++) {
      client.viewsArray[i].tb.setAttribute("viewKey", i);
    }
    tb.remove();
  } else if (tb || (!tb && !create)) {
    /* Either: we have a tab and don't want it moved, or didn't find one
     * and don't wish to create one.
     */
    return tb;
  }

  // Didn't found a <tab>, but we're allowed to create one.
  if (!tb && create) {
    if (!("messages" in source) || source.messages == null) {
      createMessages(source);
    }

    tb = document.createElement("tab");
    tb.setAttribute("ondragstart", "tabsDNDObserver.onDragStart(event);");
    tb.setAttribute("href", source.getURL());
    tb.setAttribute("name", source.unicodeName);
    tb.setAttribute("onclick", "onTabClick(event, this.id);");
    // This wouldn't be here if there was a supported CSS property for it.
    tb.setAttribute("crop", "center");
    tb.setAttribute("context", "chatZillaContextMenu");
    tb.setAttribute("class", "tab-bottom view-button");
    tb.setAttribute("id", id);
    tb.setAttribute("state", "normal");
    name = source.prefs.tabLabel || name;
    tb.setAttribute("label", name + (matches > 1 ? "<" + matches + ">" : ""));
    tb.setAttribute("tooltiptext", source.viewName);
    tb.view = source;

    var browser = document.createElement("browser");
    browser.setAttribute("class", "output-container");
    browser.setAttribute("type", "content");
    browser.setAttribute("flex", "1");
    browser.setAttribute("tooltip", "aHTMLTooltip");
    browser.setAttribute("onclick", "return onMessageViewClick(event)");
    browser.setAttribute("context", "chatZillaContextMenu");
    browser.setAttribute("ondragover", "contentDNDObserver.onDragOver(event);");
    browser.setAttribute("ondrop", "contentDNDObserver.onDrop(event);");
    browser.source = source;
    source.frame = browser;
    ASSERT(client.deck, "no deck?");
    client.deck.appendChild(browser);
    syncOutputFrame(source);

    if (!("userList" in source) && source.TYPE == "IRCChannel") {
      source.userList = [];
    }
  }

  var beforeTab = null;
  if (typeof client.pendingViewContext == "object") {
    var c = client.pendingViewContext;
    /* If we have a <tab> to insert before, and it is still in the tabs,
     * move the newly-created <tab> into the right place.
     */
    if (c.tabInsertBefore && c.tabInsertBefore.parentNode == client.tabs) {
      beforeTab = c.tabInsertBefore;
    }
  }

  if (beforeTab) {
    var viewKey = beforeTab.getAttribute("viewKey");
    client.viewsArray.splice(viewKey, 0, { source, tb });
    for (i = viewKey; i < client.viewsArray.length; i++) {
      client.viewsArray[i].tb.setAttribute("viewKey", i);
    }
    client.tabs.insertBefore(tb, beforeTab);
  } else {
    client.viewsArray.push({ source, tb });
    tb.setAttribute("viewKey", client.viewsArray.length - 1);
    client.tabs.appendChild(tb);
  }

  updateTabAttributes();

  return tb;
}

function updateTabAttributes() {
  /* XXX: Workaround for Gecko bugs 272646 and 261826. Note that this breaks
   * the location of the spacers before and after the tabs but, due to our
   * own <spacer>, their flex was not being utilised anyway.
   */
  var tabOrdinal = 0;
  for (var tab = client.tabs.firstChild; tab; tab = tab.nextSibling) {
    tab.ordinal = tabOrdinal++;
  }

  /* XXX: Workaround for tabbox.xml not coping with updating attributes when
   * tabs are moved. We correct the "first-tab", "last-tab", "beforeselected"
   * and "afterselected" attributes.
   *
   * "last-tab" and "beforeselected" are updated on each valid (non-collapsed
   * and non-hidden) tab found, to avoid having to work backwards as well as
   * forwards. "first-tab" and "afterselected" are just set the once each.
   * |foundSelected| tracks where we are in relation to the selected tab.
   */
  var tabAttrs = {
    "first-tab": null,
    "last-tab": null,
    beforeselected: null,
    afterselected: null,
  };
  var foundSelected = "before";
  for (tab = client.tabs.firstChild; tab; tab = tab.nextSibling) {
    if (tab.collapsed || tab.hidden) {
      continue;
    }

    if (!tabAttrs["first-tab"]) {
      tabAttrs["first-tab"] = tab;
    }
    tabAttrs["last-tab"] = tab;

    if (foundSelected == "before" && tab.selected) {
      foundSelected = "on";
    } else if (foundSelected == "on") {
      foundSelected = "after";
    }

    if (foundSelected == "before") {
      tabAttrs.beforeselected = tab;
    }
    if (foundSelected == "after" && !tabAttrs.afterselected) {
      tabAttrs.afterselected = tab;
    }
  }

  // After picking a tab for each attribute, apply them to the tabs.
  for (tab = client.tabs.firstChild; tab; tab = tab.nextSibling) {
    for (var attr in tabAttrs) {
      if (tabAttrs[attr] == tab) {
        tab.setAttribute(attr, "true");
      } else {
        tab.removeAttribute(attr);
      }
    }
  }
}

var contentDNDObserver = {
  onDragOver(aEvent) {
    if (aEvent.target == aEvent.dataTransfer.mozSourceNode) {
      return;
    }

    if (Services.droppedLinkHandler.canDropLink(aEvent, true)) {
      aEvent.preventDefault();
    }
  },

  onDrop(aEvent) {
    aEvent.stopPropagation();

    var url = Services.droppedLinkHandler.dropLink(aEvent, {});
    if (!url || url.search(client.linkRE) == -1) {
      return;
    }

    if (
      url.search(/\.css$/i) != -1 &&
      Services.prompt.confirm(window, MSG_CONFIRM, getMsg(MSG_TABDND_DROP, url))
    ) {
      dispatch("motif", { motif: url });
    } else if (url.search(/^ircs?:\/\//i) != -1) {
      dispatch("goto-url", { url });
    }
  },
};

var tabsDNDObserver = {
  onDragOver(aEvent) {
    if (aEvent.target == aEvent.dataTransfer.mozSourceNode) {
      return;
    }

    // If we're not accepting the drag, don't show the marker either.
    if (!Services.droppedLinkHandler.canDropLink(aEvent, true)) {
      client.tabDragBar.collapsed = true;
      return;
    }

    aEvent.preventDefault();

    /* Locate the tab we're about to drop onto. We split tabs in half, dropping
     * on the side closest to the mouse, or after the last tab if the mouse is
     * somewhere beyond all the tabs.
     */
    var ltr = window.getComputedStyle(client.tabs).direction == "ltr";
    var newPosition = client.tabs.firstChild.boxObject.x;
    for (
      var dropTab = client.tabs.firstChild;
      dropTab;
      dropTab = dropTab.nextSibling
    ) {
      if (dropTab.collapsed || dropTab.hidden) {
        continue;
      }
      var bo = dropTab.boxObject;
      if (
        (ltr && aEvent.screenX < bo.screenX + bo.width / 2) ||
        (!ltr && aEvent.screenX > bo.screenX + bo.width / 2)
      ) {
        break;
      }
      newPosition = bo.x + bo.width;
    }

    // Reposition the drop marker and show it. In that order.
    client.tabDragMarker.style.MozMarginStart = newPosition + "px";
    client.tabDragBar.collapsed = false;
  },

  onDragExit(aEvent) {
    aEvent.stopPropagation();

    /* We've either stopped being part of a drag operation, or the dragging is
     * somewhere away from us.
     */
    client.tabDragBar.collapsed = true;
  },

  onDrop(aEvent) {
    aEvent.stopPropagation();

    // Dragging has finished.
    client.tabDragBar.collapsed = true;

    // See comment above |var tabsDropObserver|.
    var url = Services.droppedLinkHandler.dropLink(aEvent, {});
    if (
      !url ||
      !(url.match(/^ircs?:/) || url.match(/^x-irc-dcc-(chat|file):/))
    ) {
      return;
    }

    // Find the tab to insertBefore() the new one.
    var ltr = window.getComputedStyle(client.tabs).direction == "ltr";
    for (
      var dropTab = client.tabs.firstChild;
      dropTab;
      dropTab = dropTab.nextSibling
    ) {
      if (dropTab.collapsed || dropTab.hidden) {
        continue;
      }
      var bo = dropTab.boxObject;
      if (
        (ltr && aEvent.screenX < bo.screenX + bo.width / 2) ||
        (!ltr && aEvent.screenX > bo.screenX + bo.width / 2)
      ) {
        break;
      }
    }

    // Check if the URL is already in the views.
    for (var i = 0; i < client.viewsArray.length; i++) {
      var view = client.viewsArray[i].source;
      if (view.getURL() == url) {
        client.pendingViewContext = { tabInsertBefore: dropTab };
        dispatch("create-tab-for-view", { view });
        delete client.pendingViewContext;
        return;
      }
    }

    // URL not found in tabs, so force it into life - this may connect/rejoin.
    if (url.substring(0, 3) == "irc") {
      gotoIRCURL(url, { tabInsertBefore: dropTab });
    }
  },

  onDragStart(aEvent) {
    var tb = aEvent.currentTarget;
    var href = tb.getAttribute("href");
    var name = tb.getAttribute("name");

    /* x-moz-url has the format "<url>\n<name>", goodie */
    aEvent.dataTransfer.setData("text/x-moz-url", href + "\n" + name);
    aEvent.dataTransfer.setData("text/unicode", href);
    aEvent.dataTransfer.setData("text/plain", href);
    aEvent.dataTransfer.setData(
      "text/html",
      "<a href='" + href + "'>" + name + "</a>"
    );
  },
};

function deleteTab(tb) {
  if (
    !ASSERT(
      tb.hasAttribute("viewKey"),
      "INVALID OBJECT passed to deleteTab (" + tb + ")"
    )
  ) {
    return null;
  }

  var key = Number(tb.getAttribute("viewKey"));

  // Re-index higher tabs.
  for (var i = key + 1; i < client.viewsArray.length; i++) {
    client.viewsArray[i].tb.setAttribute("viewKey", i - 1);
  }
  client.viewsArray.splice(key, 1);
  tb.remove();
  setTimeout(updateTabAttributes, 0);

  return key;
}

function deleteFrame(view) {
  const ALL = Ci.nsIWebProgress.NOTIFY_ALL;

  // We leave the progress listener attached so try to remove it.
  try {
    view.frame.removeProgressListener(client.progressListener, ALL);
  } catch (ex) {
    dd(formatException(ex));
  }

  view.frame.remove();
  delete view.frame;
}

function filterOutput(msg, msgtype, dest) {
  if ("outputFilters" in client) {
    for (var f in client.outputFilters) {
      if (client.outputFilters[f].enabled) {
        msg = client.outputFilters[f].func(msg, msgtype, dest);
      }
    }
  }

  return msg;
}

function updateTimestamps(view) {
  if (!("messages" in view)) {
    return;
  }

  view._timestampLast = "";
  var node = view.messages.firstChild.firstChild;
  var nested;
  while (node) {
    if (node.className == "msg-nested-tr") {
      nested = node.firstChild.firstChild.firstChild.firstChild;
      while (nested) {
        updateTimestampFor(view, nested);
        nested = nested.nextSibling;
      }
    } else {
      updateTimestampFor(view, node);
    }
    node = node.nextSibling;
  }
}

function updateTimestampFor(view, displayRow, forceOldStamp) {
  var time = new Date(1 * displayRow.getAttribute("timestamp"));
  var tsCell = displayRow.firstChild;
  if (!tsCell) {
    return;
  }

  var fmt;
  if (view.prefs.timestamps) {
    fmt = strftime(view.prefs["timestamps.display"], time);
  }

  while (tsCell.hasChildNodes()) {
    tsCell.lastChild.remove();
  }

  var needStamp =
    fmt &&
    (forceOldStamp || !view.prefs.collapseMsgs || fmt != view._timestampLast);
  if (needStamp) {
    tsCell.appendChild(document.createTextNode(fmt));
  }
  if (!forceOldStamp) {
    view._timestampLast = fmt;
  }
}

client.checkURLScheme = function (url) {
  if (!("schemes" in client)) {
    var pfx = "@mozilla.org/network/protocol;1?name=";
    var len = pfx.length;

    client.schemes = {};
    for (var c in Cc) {
      if (c.startsWith(pfx)) {
        client.schemes[c.substr(len)] = true;
      }
    }
  }
  return url.toLowerCase() in client.schemes;
};

client.adoptNode = function (node, doc) {
  try {
    doc.adoptNode(node);
  } catch (ex) {
    dd(formatException(ex));
    var err = ex.name;
    // TypeError from before adoptNode was added; NOT_IMPL after.
    if (err == "TypeError" || err == "NS_ERROR_NOT_IMPLEMENTED") {
      client.adoptNode = cli_adoptnode_noop;
    }
  }
  return node;
};

function cli_adoptnode_noop(node, doc) {
  return node;
}

client.addNetwork = function (name, serverList, temporary) {
  let net = new CIRCNetwork(name, serverList, client.eventPump, temporary);
  client.networks[net.collectionKey] = net;
};

client.getNetwork = function (name) {
  return client.networks[":" + name] || null;
};

client.removeNetwork = function (name) {
  let net = client.getNetwork(name);

  // Allow network a chance to clean up any mess.
  if (typeof net.destroy == "function") {
    net.destroy();
  }

  delete client.networks[net.collectionKey];
};

client.connectToNetwork = function (networkOrName, requireSecurity) {
  var network;
  var name;

  if (isinstance(networkOrName, CIRCNetwork)) {
    network = networkOrName;
  } else {
    name = networkOrName;
    network = client.getNetwork(name);

    if (!network) {
      display(getMsg(MSG_ERR_UNKNOWN_NETWORK, name), MT_ERROR);
      return null;
    }
  }
  name = network.unicodeName;

  dispatch("create-tab-for-view", { view: network });
  dispatch("set-current-view", { view: network });

  if (network.isConnected()) {
    network.display(getMsg(MSG_ALREADY_CONNECTED, name));
    return network;
  }

  if (network.state != NET_OFFLINE) {
    return network;
  }

  if (network.prefs.nickname == DEFAULT_NICK) {
    network.prefs.nickname = prompt(MSG_ENTER_NICK, DEFAULT_NICK);
  }

  if (!("connecting" in network)) {
    network.display(getMsg(MSG_NETWORK_CONNECTING, name));
  }

  network.connect(requireSecurity);

  network.updateHeader();
  client.updateHeader();
  updateTitle();

  return network;
};

client.getURL = function () {
  return "irc://";
};

client.sayToCurrentTarget = function (msg, isInteractive) {
  if ("say" in client.currentObject) {
    client.currentObject.dispatch("say", { message: msg }, isInteractive);
    return;
  }

  switch (client.currentObject.TYPE) {
    case "IRCClient":
      dispatch("eval", { expression: msg }, isInteractive);
      break;

    default:
      if (msg != "") {
        display(MSG_ERR_NO_DEFAULT, MT_ERROR);
      }
      break;
  }
};

CIRCNetwork.prototype.__defineGetter__("prefs", net_getprefs);
function net_getprefs() {
  if (!("_prefs" in this)) {
    this._prefManager = getNetworkPrefManager(this);
    this._prefs = this._prefManager.prefs;
  }

  return this._prefs;
}

CIRCNetwork.prototype.__defineGetter__("prefManager", net_getprefmgr);
function net_getprefmgr() {
  if (!("_prefManager" in this)) {
    this._prefManager = getNetworkPrefManager(this);
    this._prefs = this._prefManager.prefs;
  }

  return this._prefManager;
}

CIRCServer.prototype.__defineGetter__("prefs", srv_getprefs);
function srv_getprefs() {
  return this.parent.prefs;
}

CIRCServer.prototype.__defineGetter__("prefManager", srv_getprefmgr);
function srv_getprefmgr() {
  return this.parent.prefManager;
}

CIRCChannel.prototype.__defineGetter__("prefs", chan_getprefs);
function chan_getprefs() {
  if (!("_prefs" in this)) {
    this._prefManager = getChannelPrefManager(this);
    this._prefs = this._prefManager.prefs;
  }

  return this._prefs;
}

CIRCChannel.prototype.__defineGetter__("prefManager", chan_getprefmgr);
function chan_getprefmgr() {
  if (!("_prefManager" in this)) {
    this._prefManager = getChannelPrefManager(this);
    this._prefs = this._prefManager.prefs;
  }

  return this._prefManager;
}

CIRCUser.prototype.__defineGetter__("prefs", usr_getprefs);
function usr_getprefs() {
  if (!("_prefs" in this)) {
    this._prefManager = getUserPrefManager(this);
    this._prefs = this._prefManager.prefs;
  }

  return this._prefs;
}

CIRCUser.prototype.__defineGetter__("prefManager", usr_getprefmgr);
function usr_getprefmgr() {
  if (!("_prefManager" in this)) {
    this._prefManager = getUserPrefManager(this);
    this._prefs = this._prefManager.prefs;
  }

  return this._prefManager;
}

CIRCDCCUser.prototype.__defineGetter__("prefs", dccusr_getprefs);
function dccusr_getprefs() {
  if (!("_prefs" in this)) {
    this._prefManager = getDCCUserPrefManager(this);
    this._prefs = this._prefManager.prefs;
  }

  return this._prefs;
}

CIRCDCCUser.prototype.__defineGetter__("prefManager", dccusr_getprefmgr);
function dccusr_getprefmgr() {
  if (!("_prefManager" in this)) {
    this._prefManager = getDCCUserPrefManager(this);
    this._prefs = this._prefManager.prefs;
  }

  return this._prefManager;
}

CIRCDCCChat.prototype.__defineGetter__("prefs", dccchat_getprefs);
function dccchat_getprefs() {
  return this.user.prefs;
}

CIRCDCCChat.prototype.__defineGetter__("prefManager", dccchat_getprefmgr);
function dccchat_getprefmgr() {
  return this.user.prefManager;
}

CIRCDCCFileTransfer.prototype.__defineGetter__("prefs", dccfile_getprefs);
function dccfile_getprefs() {
  return this.user.prefs;
}

CIRCDCCFileTransfer.prototype.__defineGetter__(
  "prefManager",
  dccfile_getprefmgr
);
function dccfile_getprefmgr() {
  return this.user.prefManager;
}

/* Displays a network-centric message on the most appropriate view.
 *
 * When |client.SLOPPY_NETWORKS| is |true|, messages will be displayed on the
 * *current* view instead of the network view, if the current view is part of
 * the same network.
 */
CIRCNetwork.prototype.display = function (
  message,
  msgtype,
  sourceObj,
  destObj,
  tags
) {
  var o = getObjectDetails(client.currentObject);
  if (
    client.SLOPPY_NETWORKS &&
    client.currentObject != this &&
    o.network == this &&
    o.server &&
    o.server.isConnected
  ) {
    client.currentObject.display(message, msgtype, sourceObj, destObj, tags);
  } else {
    this.displayHere(message, msgtype, sourceObj, destObj, tags);
  }
};

/* Displays a channel-centric message on the most appropriate view.
 *
 * If the channel view already exists (visible or hidden), messages are added
 * to it; otherwise, messages go to the *network* view.
 */
CIRCChannel.prototype.display = function (
  message,
  msgtype,
  sourceObj,
  destObj,
  tags
) {
  if ("messages" in this) {
    this.displayHere(message, msgtype, sourceObj, destObj, tags);
  } else {
    this.parent.parent.displayHere(message, msgtype, sourceObj, destObj, tags);
  }
};

/* Displays a user-centric message on the most appropriate view.
 *
 * If the user view already exists (visible or hidden), messages are added to
 * it; otherwise, it goes to the *current* view if the current view is part of
 * the same network, or the *network* view if not.
 */
CIRCUser.prototype.display = function (
  message,
  msgtype,
  sourceObj,
  destObj,
  tags
) {
  if ("messages" in this) {
    this.displayHere(message, msgtype, sourceObj, destObj, tags);
  } else {
    var o = getObjectDetails(client.currentObject);
    if (
      o.server &&
      o.server.isConnected &&
      o.network == this.parent.parent &&
      client.currentObject.TYPE != "IRCUser"
    ) {
      client.currentObject.display(message, msgtype, sourceObj, destObj, tags);
    } else {
      this.parent.parent.displayHere(
        message,
        msgtype,
        sourceObj,
        destObj,
        tags
      );
    }
  }
};

/* Displays a DCC user/file transfer-centric message on the most appropriate view.
 *
 * If the DCC user/file transfer view already exists (visible or hidden),
 * messages are added to it; otherwise, messages go to the *current* view.
 */
CIRCDCCChat.prototype.display = CIRCDCCFileTransfer.prototype.display =
  function (message, msgtype, sourceObj, destObj) {
    if ("messages" in this) {
      this.displayHere(message, msgtype, sourceObj, destObj);
    } else {
      client.currentObject.display(message, msgtype, sourceObj, destObj);
    }
  };

function feedback(e, message, msgtype, sourceObj, destObj) {
  if ("isInteractive" in e && e.isInteractive) {
    display(message, msgtype, sourceObj, destObj);
  }
}

CIRCChannel.prototype.feedback =
  CIRCNetwork.prototype.feedback =
  CIRCUser.prototype.feedback =
  CIRCDCCChat.prototype.feedback =
  CIRCDCCFileTransfer.prototype.feedback =
  client.feedback =
    function (e, message, msgtype, sourceObj, destObj) {
      if ("isInteractive" in e && e.isInteractive) {
        this.displayHere(message, msgtype, sourceObj, destObj);
      }
    };

function display(message, msgtype, sourceObj, destObj, tags) {
  client.currentObject.display(message, msgtype, sourceObj, destObj, tags);
}

client.getFontCSS =
  CIRCNetwork.prototype.getFontCSS =
  CIRCChannel.prototype.getFontCSS =
  CIRCUser.prototype.getFontCSS =
  CIRCDCCChat.prototype.getFontCSS =
  CIRCDCCFileTransfer.prototype.getFontCSS =
    function (format) {
      /* Wow, this is cool. We just put together a CSS-rule string based on the
       * font preferences. *This* is what CSS is all about. :)
       * We also provide a "data: URL" format, to simplify other code.
       */
      var css;
      var fs;
      var fn;

      if (this.prefs["font.family"] != "default") {
        fn = "font-family: " + this.prefs["font.family"] + ";";
      } else {
        fn = "font-family: inherit;";
      }
      if (this.prefs["font.size"] != 0) {
        fs = "font-size: " + this.prefs["font.size"] + "pt;";
      } else {
        fs = "font-size: medium;";
      }

      css = ".chatzilla-body { " + fs + fn + " }";

      if (format == "data") {
        return "data:text/css," + encodeURIComponent(css);
      }
      return css;
    };

client.startMsgGroup =
  CIRCNetwork.prototype.startMsgGroup =
  CIRCChannel.prototype.startMsgGroup =
  CIRCUser.prototype.startMsgGroup =
  CIRCDCCChat.prototype.startMsgGroup =
  CIRCDCCFileTransfer.prototype.startMsgGroup =
    function (id, groupMsg, msgtype) {
      // The given ID may not be unique, so append a timestamp to ensure it is.
      var groupId = id + "-" + Date.now();

      // Add the button to the end of the message.
      var headerMsg =
        groupMsg +
        " " +
        getMsg(MSG_COLLAPSE_BUTTON, [
          MSG_COLLAPSE_HIDE,
          MSG_COLLAPSE_HIDETITLE,
          groupId,
        ]);

      // Show the group header message.
      client.munger.getRule(".inline-buttons").enabled = true;
      this.displayHere(headerMsg, msgtype);
      client.munger.getRule(".inline-buttons").enabled = false;

      // Add the group to a list of active message groups.
      if (!this.msgGroups) {
        this.msgGroups = [];
      }
      this.msgGroups.push(groupId);

      // Return the actual ID in case the caller wants to use it later.
      return groupId;
    };

function startMsgGroup(groupId, headerMsg, msgtype) {
  client.currentObject.startMsgGroup(groupId, headerMsg, msgtype);
}

client.endMsgGroup =
  CIRCNetwork.prototype.endMsgGroup =
  CIRCChannel.prototype.endMsgGroup =
  CIRCUser.prototype.endMsgGroup =
  CIRCDCCChat.prototype.endMsgGroup =
  CIRCDCCFileTransfer.prototype.endMsgGroup =
    function (groupId, message) {
      if (!this.msgGroups) {
        return;
      }

      // Remove the group from the list of active message groups.
      this.msgGroups.pop();
      if (this.msgGroups.length == 0) {
        delete this.msgGroups;
      }
    };

function endMsgGroup() {
  client.currentObject.endMsgGroup();
}

client.display =
  client.displayHere =
  CIRCNetwork.prototype.displayHere =
  CIRCChannel.prototype.displayHere =
  CIRCUser.prototype.displayHere =
  CIRCDCCChat.prototype.displayHere =
  CIRCDCCFileTransfer.prototype.displayHere =
    function (message, msgtype, sourceObj, destObj, tags) {
      // We need a message type, assume "INFO".
      if (!msgtype) {
        msgtype = MT_INFO;
      }

      var msgprefix = "";
      if (msgtype.includes("/")) {
        var ary = msgtype.match(/^(.*)\/(.*)$/);
        msgtype = ary[1];
        msgprefix = ary[2];
      }

      var blockLevel = false;
      /* true if this row should be rendered at block
       * level, (like, if it has a really long nickname
       * that might disturb the rest of the layout)     */
      var o = getObjectDetails(this); /* get the skinny on |this|     */

      // Get the 'me' object, so we can be sure to get the attributes right.
      var me;
      if ("me" in this) {
        me = this.me;
      } else if (o.server && "me" in o.server) {
        me = o.server.me;
      }

      /* Allow for matching (but not identical) user objects here. This tends to
       * happen with bouncers and proxies, when they send channel messages
       * pretending to be from the user; the sourceObj is a CIRCChanUser
       * instead of a CIRCUser so doesn't == 'me'.
       */
      if (me) {
        if (sourceObj && sourceObj.canonicalName == me.canonicalName) {
          sourceObj = me;
        }
        if (destObj && destObj.canonicalName == me.canonicalName) {
          destObj = me;
        }
      }

      // Let callers get away with "ME!" and we have to substitute here.
      if (sourceObj == "ME!") {
        sourceObj = me;
      }
      if (destObj == "ME!") {
        destObj = me;
      }

      // Get the TYPE of the source object.
      var fromType = sourceObj && sourceObj.TYPE ? sourceObj.TYPE : "unk";
      // Is the source a user?
      var fromUser = fromType.search(/IRC.*User/) != -1;
      // Get some sort of "name" for the source.
      var fromAttr = "";
      if (sourceObj) {
        if ("canonicalName" in sourceObj) {
          fromAttr = sourceObj.canonicalName;
        } else if ("name" in sourceObj) {
          fromAttr = sourceObj.name;
        } else {
          fromAttr = sourceObj.viewName;
        }
      }

      // Get the dest TYPE too...
      var toType = destObj ? destObj.TYPE : "unk";
      // Is the dest a user?
      var toUser = toType.search(/IRC.*User/) != -1;
      // Get a dest name too...
      var toAttr = "";
      if (destObj) {
        if ("canonicalName" in destObj) {
          toAttr = destObj.canonicalName;
        } else if ("name" in destObj) {
          toAttr = destObj.name;
        } else {
          toAttr = destObj.viewName;
        }
      }

      // Is the message 'to' or 'from' somewhere other than this view
      var toOther = sourceObj == me && destObj && destObj != this;
      var fromOther =
        toUser &&
        destObj == me &&
        sourceObj != this &&
        // Need extra check for DCC users:
        !(this.TYPE == "IRCDCCChat" && this.user == sourceObj);

      // Attach "ME!" if appropriate, so motifs can style differently.
      if (sourceObj == me && !toOther) {
        fromAttr = fromAttr + " ME!";
      }
      if (destObj && destObj == me) {
        toAttr = me.canonicalName + " ME!";
      }

      /* isImportant means to style the messages as important, and flash the
       * window, getAttention means just flash the window. */
      var isImportant = false,
        getAttention = false,
        isSuperfluous = false;
      var viewType = this.TYPE;
      var code;
      var time;
      if (tags && "time" in tags) {
        time = new Date(tags.time);
      } else {
        time = new Date();
      }

      var timeStamp = strftime(this.prefs["timestamps.log"], time);

      // Statusbar text, and the line that gets saved to the log.
      var statusString;
      var logStringPfx = timeStamp + " ";
      var logStrings = [];

      if (fromUser) {
        statusString = getMsg(MSG_FMT_STATUS, [
          timeStamp,
          sourceObj.unicodeName + "!" + sourceObj.name + "@" + sourceObj.host,
        ]);
      } else {
        var name;
        if (sourceObj) {
          name = sourceObj.viewName;
        } else {
          name = this.viewName;
        }

        statusString = getMsg(MSG_FMT_STATUS, [timeStamp, name]);
      }

      // The table row, and it's attributes.
      var msgRow = document.createElementNS(XHTML_NS, "html:tr");
      msgRow.setAttribute("class", "msg");
      if (this.msgGroups) {
        msgRow.setAttribute("msg-groups", this.msgGroups.join(", "));
      }
      msgRow.setAttribute("msg-type", msgtype);
      msgRow.setAttribute("msg-prefix", msgprefix);
      msgRow.setAttribute("msg-dest", toAttr);
      msgRow.setAttribute("dest-type", toType);
      msgRow.setAttribute("view-type", viewType);
      msgRow.setAttribute("status-text", statusString);
      msgRow.setAttribute("timestamp", Number(time));
      if (fromAttr) {
        if (fromUser) {
          msgRow.setAttribute("msg-user", fromAttr);
          // Set some mode information for channel users
          if (fromType == "IRCChanUser") {
            msgRow.setAttribute("msg-user-mode", sourceObj.modes.join(" "));
          }
        } else {
          msgRow.setAttribute("msg-source", fromAttr);
        }
      }
      if (toOther) {
        msgRow.setAttribute("to-other", toOther);
      }
      if (fromOther) {
        msgRow.setAttribute("from-other", fromOther);
      }

      // Timestamp cell.
      var msgRowTimestamp = document.createElementNS(XHTML_NS, "html:td");
      msgRowTimestamp.setAttribute("class", "msg-timestamp");

      var canMergeData;
      var msgRowSource, msgRowType, msgRowData;
      if (fromUser && msgtype.match(/^(PRIVMSG|ACTION|NOTICE|WALLOPS)$/)) {
        var nick = sourceObj.unicodeName;
        var decorSt = "";
        var decorEn = "";

        // Set default decorations.
        if (msgtype == "ACTION") {
          decorSt = "* ";
        } else {
          decorSt = "<";
          decorEn = ">";
        }

        var nickURL;
        if (sourceObj != me && "getURL" in sourceObj) {
          nickURL = sourceObj.getURL();
        }
        if (toOther && "getURL" in destObj) {
          nickURL = destObj.getURL();
        }

        if (sourceObj != me) {
          // Not from us...
          if (destObj == me) {
            // ...but to us. Messages from someone else to us.

            getAttention = true;
            this.defaultCompletion = "/msg " + nick + " ";

            // If this is a private message, and it's not in a query view,
            // use *nick* instead of <nick>.
            if (msgtype != "ACTION" && this.TYPE != "IRCUser") {
              decorSt = "*";
              decorEn = "*";
            }
          } else {
            // ...or to us. Messages from someone else to channel or similar.

            if (typeof message == "string" && me) {
              isImportant = msgIsImportant(message, nick, o.network);
            } else if (message.hasAttribute("isImportant") && me) {
              isImportant = true;
            }

            if (isImportant) {
              this.defaultCompletion =
                nick + client.prefs.nickCompleteStr + " ";
            }
          }
        } else {
          // Messages from us, to somewhere other than this view
          if (toOther) {
            nick = destObj.unicodeName;
            decorSt = ">";
            decorEn = "<";
          }
        }

        // Log the nickname in the same format as we'll let the user copy.
        // If the message has a prefix, show it after a "/".
        if (msgprefix) {
          logStringPfx += decorSt + nick + "/" + msgprefix + decorEn + " ";
        } else {
          logStringPfx += decorSt + nick + decorEn + " ";
        }

        if (!("lastNickDisplayed" in this) || this.lastNickDisplayed != nick) {
          this.lastNickDisplayed = nick;
          this.mark = "mark" in this && this.mark == "even" ? "odd" : "even";
        }

        msgRowSource = document.createElementNS(XHTML_NS, "html:td");
        msgRowSource.setAttribute("class", "msg-user");

        // Make excessive nicks get shunted.
        if (nick && nick.length > client.MAX_NICK_DISPLAY) {
          blockLevel = true;
        }

        if (decorSt) {
          msgRowSource.appendChild(newInlineText(decorSt, "chatzilla-decor"));
        }
        if (nickURL) {
          var nick_anchor = document.createElementNS(XHTML_NS, "html:a");
          nick_anchor.setAttribute("class", "chatzilla-link");
          nick_anchor.setAttribute("href", nickURL);
          nick_anchor.appendChild(newInlineText(nick));
          msgRowSource.appendChild(nick_anchor);
        } else {
          msgRowSource.appendChild(newInlineText(nick));
        }
        if (msgprefix) {
          /* We don't style the "/" with chatzilla-decor because the one
           * thing we don't want is it disappearing!
           */
          msgRowSource.appendChild(newInlineText("/", ""));
          msgRowSource.appendChild(
            newInlineText(msgprefix, "chatzilla-prefix")
          );
        }
        if (decorEn) {
          msgRowSource.appendChild(newInlineText(decorEn, "chatzilla-decor"));
        }
        canMergeData = this.prefs.collapseMsgs;
      } else if (msgprefix) {
        decorSt = "<";
        decorEn = ">";

        logStringPfx += decorSt + "/" + msgprefix + decorEn + " ";

        msgRowSource = document.createElementNS(XHTML_NS, "html:td");
        msgRowSource.setAttribute("class", "msg-user");

        msgRowSource.appendChild(newInlineText(decorSt, "chatzilla-decor"));
        msgRowSource.appendChild(newInlineText("/", ""));
        msgRowSource.appendChild(newInlineText(msgprefix, "chatzilla-prefix"));
        msgRowSource.appendChild(newInlineText(decorEn, "chatzilla-decor"));
        canMergeData = this.prefs.collapseMsgs;
      } else {
        isSuperfluous = true;
        if (!client.debugHook.enabled && msgtype in client.responseCodeMap) {
          code = client.responseCodeMap[msgtype];
        } else if (!client.debugHook.enabled && client.HIDE_CODES) {
          code = client.DEFAULT_RESPONSE_CODE;
        } else {
          code = "[" + msgtype + "]";
        }

        /* Display the message code */
        msgRowType = document.createElementNS(XHTML_NS, "html:td");
        msgRowType.setAttribute("class", "msg-type");

        msgRowType.appendChild(newInlineText(code));
        logStringPfx += code + " ";
      }

      if (message) {
        msgRowData = document.createElementNS(XHTML_NS, "html:td");
        msgRowData.setAttribute("class", "msg-data");

        var tmpMsgs = message;
        if (typeof message == "string") {
          msgRowData.appendChild(stringToMsg(message, this));
        } else {
          msgRowData.appendChild(message);
          tmpMsgs = tmpMsgs.innerHTML.replace(/<[^<]*>/g, "");
        }
        tmpMsgs = tmpMsgs.split(/\r?\n/);
        for (var l = 0; l < tmpMsgs.length; l++) {
          logStrings[l] = logStringPfx + tmpMsgs[l];
        }
      }

      if ("mark" in this) {
        msgRow.setAttribute("mark", this.mark);
      }

      if (isImportant) {
        if ("importantMessages" in this) {
          var importantId = "important" + this.importantMessages++;
          msgRow.setAttribute("id", importantId);
        }
        msgRow.setAttribute("important", "true");
        msgRow.setAttribute("aria-live", "assertive");
      }

      // Timestamps first...
      msgRow.appendChild(msgRowTimestamp);
      // Now do the rest of the row, after block-level stuff.
      if (msgRowSource) {
        msgRow.appendChild(msgRowSource);
      } else {
        msgRow.appendChild(msgRowType);
      }
      if (msgRowData) {
        msgRow.appendChild(msgRowData);
      }
      updateTimestampFor(this, msgRow);

      if (blockLevel) {
        /* putting a div here crashes mozilla, so fake it with nested tables
         * for now */
        var tr = document.createElementNS(XHTML_NS, "html:tr");
        tr.setAttribute("class", "msg-nested-tr");
        var td = document.createElementNS(XHTML_NS, "html:td");
        td.setAttribute("class", "msg-nested-td");
        td.setAttribute("colspan", "3");

        tr.appendChild(td);
        var table = document.createElementNS(XHTML_NS, "html:table");
        table.setAttribute("class", "msg-nested-table");
        table.setAttribute("role", "presentation");

        td.appendChild(table);
        var tbody = document.createElementNS(XHTML_NS, "html:tbody");

        tbody.appendChild(msgRow);
        table.appendChild(tbody);
        msgRow = tr;
      }

      // Actually add the item.
      addHistory(this, msgRow, canMergeData);

      // Update attention states...
      if (isImportant || getAttention) {
        setTabState(this, "attention");
        if (client.prefs["notify.aggressive"]) {
          window.getAttention();
        }
      } else if (isSuperfluous) {
        setTabState(this, "superfluous");
      } else {
        setTabState(this, "activity");
      }

      // Copy Important Messages [to network view].
      if (isImportant && client.prefs.copyMessages && o.network != this) {
        if (importantId) {
          // Create the linked inline button
          var msgspan = document.createElementNS(XHTML_NS, "html:span");
          msgspan.setAttribute("isImportant", "true");

          var cmd = "jump-to-anchor " + importantId + " " + this.unicodeName;
          var prefix = getMsg(MSG_JUMPTO_BUTTON, [this.unicodeName, cmd]);

          // Munge prefix as a button
          client.munger.getRule(".inline-buttons").enabled = true;
          client.munger.munge(prefix + " ", msgspan, o);

          // Munge rest of message normally
          client.munger.getRule(".inline-buttons").enabled = false;
          client.munger.munge(message, msgspan, o);

          o.network.displayHere(msgspan, msgtype, sourceObj, destObj);
        } else {
          o.network.displayHere(message, msgtype, sourceObj, destObj);
        }
      }

      // Log file time!
      if (this.prefs.log) {
        if (!this.logFile) {
          client.openLogFile(this);
        }

        try {
          var LE = client.lineEnd;
          for (var l = 0; l < logStrings.length; l++) {
            this.logFile.write(fromUnicode(logStrings[l] + LE, "utf-8"));
          }
        } catch (ex) {
          // Stop logging before showing any messages!
          this.prefs.log = false;
          dd("Log file write error: " + formatException(ex));
          this.displayHere(
            getMsg(MSG_LOGFILE_WRITE_ERROR, getLogPath(this)),
            "ERROR"
          );
        }
      }

      /* We want to show alerts if they're from a non-current view (optional),
       * or we don't have focus at all.
       */
      if (
        client.prefs["alert.globalEnabled"] &&
        this.prefs["alert.enabled"] &&
        client.alert &&
        (!window.isFocused ||
          (!client.prefs["alert.nonFocusedOnly"] &&
            !("currentObject" in client && client.currentObject == this)))
      ) {
        if (isImportant) {
          showEventAlerts(this.TYPE, "stalk", message, nick, o, this, msgtype);
        } else if (isSuperfluous) {
          showEventAlerts(this.TYPE, "event", message, nick, o, this, msgtype);
        } else {
          showEventAlerts(this.TYPE, "chat", message, nick, o, this, msgtype);
        }
      }
    };

function addHistory(source, obj, mergeData) {
  if (!("messages" in source) || source.messages == null) {
    createMessages(source);
  }

  var tbody = source.messages.firstChild;
  var appendTo = tbody;

  var needScroll = false;

  if (mergeData) {
    var inobj = obj;
    // This gives us the non-nested row when there is nesting.
    if (inobj.className == "msg-nested-tr") {
      inobj = inobj.firstChild.firstChild.firstChild.firstChild;
    }

    var thisUserCol = inobj.firstChild;
    while (
      thisUserCol &&
      !thisUserCol.className.match(/^(msg-user|msg-type)$/)
    ) {
      thisUserCol = thisUserCol.nextSibling;
    }

    var thisMessageCol = inobj.firstChild;
    while (thisMessageCol && !(thisMessageCol.className == "msg-data")) {
      thisMessageCol = thisMessageCol.nextSibling;
    }

    let columnInfo = findPreviousColumnInfo(source.messages);
    let nickColumns = columnInfo.nickColumns;
    let rowExtents = columnInfo.extents;
    let nickColumnCount = nickColumns.length;

    let lastRowSpan = 0;
    let sameNick = false;
    let samePrefix = false;
    let sameDest = false;
    let haveSameType = false;
    let isAction = false;
    let collapseActions;
    let needSameType = false;
    // 1 or messages, check for doubles.
    if (nickColumnCount > 0) {
      var lastRow = nickColumns[nickColumnCount - 1].parentNode;
      // What was the span last time?
      lastRowSpan = Number(nickColumns[0].getAttribute("rowspan"));
      // Are we the same user as last time?
      sameNick =
        lastRow.getAttribute("msg-user") == inobj.getAttribute("msg-user");
      // Do we have the same prefix as last time?
      samePrefix =
        lastRow.getAttribute("msg-prefix") == inobj.getAttribute("msg-prefix");
      // Do we have the same destination as last time?
      sameDest =
        lastRow.getAttribute("msg-dest") == inobj.getAttribute("msg-dest");
      // Is this message the same type as the last one?
      haveSameType =
        lastRow.getAttribute("msg-type") == inobj.getAttribute("msg-type");
      // Is either of the messages an action? We may not want to collapse
      // depending on the collapseActions pref
      isAction =
        inobj.getAttribute("msg-type") == "ACTION" ||
        lastRow.getAttribute("msg-type") == "ACTION";
      // Do we collapse actions?
      collapseActions = source.prefs.collapseActions;

      // Does the motif collapse everything, regardless of type?
      // NOTE: the collapseActions pref can override this for actions
      needSameType = !(
        "motifSettings" in source &&
        source.motifSettings &&
        "collapsemore" in source.motifSettings
      );
    }

    if (
      sameNick &&
      samePrefix &&
      sameDest &&
      (haveSameType || !needSameType) &&
      (!isAction || collapseActions)
    ) {
      obj = inobj;
      if (columnInfo.nested) {
        appendTo =
          source.messages.firstChild.lastChild.firstChild.firstChild.firstChild;
      }

      if (obj.getAttribute("important")) {
        nickColumns[nickColumnCount - 1].setAttribute("important", true);
      }

      // Remove nickname column from new row.
      thisUserCol.remove();

      // Expand previous grouping's nickname cell(s) to fill-in the gap.
      for (var i = 0; i < nickColumns.length; ++i) {
        nickColumns[i].setAttribute("rowspan", rowExtents.length + 1);
      }
    }
  }

  if ("frame" in source) {
    needScroll = checkScroll(source.frame);
  }
  if (obj) {
    appendTo.appendChild(client.adoptNode(obj, appendTo.ownerDocument));
  }

  if (source.MAX_MESSAGES) {
    if (typeof source.messageCount != "number") {
      source.messageCount = 1;
    } else {
      source.messageCount++;
    }

    if (source.messageCount > source.MAX_MESSAGES) {
      removeExcessMessages(source);
    }
  }

  if (needScroll) {
    scrollDown(source.frame, true);
  }
}

function removeExcessMessages(source) {
  var window = getContentWindow(source.frame);
  var rows = source.messages.rows;
  var lastItemOffset = rows[rows.length - 1].offsetTop;
  var tbody = source.messages.firstChild;
  while (source.messageCount > source.MAX_MESSAGES) {
    if (tbody.firstChild.className == "msg-nested-tr") {
      var table = tbody.firstChild.firstChild.firstChild;
      var toBeRemoved = source.messageCount - source.MAX_MESSAGES;
      // If we can remove the entire table, do that...
      if (table.rows.length <= toBeRemoved) {
        tbody.firstChild.remove();
        source.messageCount -= table.rows.length;
        table = null; // Don't hang onto this.
        continue;
      }
      // Otherwise, remove rows from this table instead:
      tbody = table.firstChild;
    }
    var nextLastNode = tbody.firstChild.nextSibling;
    // If the next node has only 2 childNodes,
    // assume we're dealing with collapsed msgs,
    // and move the nickname element:
    if (nextLastNode.childNodes.length == 2) {
      var nickElem = tbody.firstChild.childNodes[1];
      var rowspan = nickElem.getAttribute("rowspan") - 1;
      tbody.firstChild.removeChild(nickElem);
      nickElem.setAttribute("rowspan", rowspan);
      nextLastNode.insertBefore(nickElem, nextLastNode.lastChild);
    }
    tbody.firstChild.remove();
    --source.messageCount;
  }
  var oldestItem = rows[0];
  if (oldestItem.className == "msg-nested-tr") {
    oldestItem = rows[0].firstChild.firstChild.firstChild.firstChild;
  }
  updateTimestampFor(source, oldestItem, true);

  // Scroll by as much as the lowest item has moved up:
  lastItemOffset -= rows[rows.length - 1].offsetTop;
  var y = window.pageYOffset;
  if (!checkScroll(source.frame) && y > lastItemOffset) {
    window.scrollBy(0, -lastItemOffset);
  }
}

function findPreviousColumnInfo(table) {
  // All the rows in the grouping (for merged rows).
  var extents = [];
  // Get the last row in the table.
  var tr = table.firstChild.lastChild;
  // Bail if there's no rows.
  if (!tr) {
    return { extents: [], nickColumns: [], nested: false };
  }
  // Get message type.
  if (tr.className == "msg-nested-tr") {
    var rv = findPreviousColumnInfo(tr.firstChild.firstChild);
    rv.nested = true;
    return rv;
  }
  // Now get the read one...
  var className =
    tr && tr.childNodes[1] ? tr.childNodes[1].getAttribute("class") : "";
  // Keep going up rows until you find the first in a group.
  // This will go up until it hits the top of a multiline/merged block.
  while (
    tr &&
    tr.childNodes[1] &&
    className.search(/msg-user|msg-type/) == -1
  ) {
    extents.push(tr);
    tr = tr.previousSibling;
    if (tr && tr.childNodes[1]) {
      className = tr.childNodes[1].getAttribute("class");
    }
  }

  // If we ran out of rows, or it's not a talking line, we're outta here.
  if (!tr || className != "msg-user") {
    return { extents: [], nickColumns: [], nested: false };
  }

  extents.push(tr);

  // Time to collect the nick data...
  var nickCol = tr.firstChild;
  // All the cells that contain nickname info.
  var nickCols = [];
  while (nickCol) {
    // Just collect nickname column cells.
    if (nickCol.getAttribute("class") == "msg-user") {
      nickCols.push(nickCol);
    }
    nickCol = nickCol.nextSibling;
  }

  // And we're done.
  return { extents, nickColumns: nickCols, nested: false };
}

function getLogPath(obj) {
  // If we're logging, return the currently-used URL.
  if (obj.logFile) {
    return getURLSpecFromFile(obj.logFile.path);
  }
  // If not, return the ideal URL.
  return getURLSpecFromFile(obj.prefs.logFileName);
}

client.getConnectionCount = function () {
  var count = 0;

  for (var n in client.networks) {
    if (client.networks[n].isConnected()) {
      ++count;
    }
  }

  return count;
};

client.quit = function (reason) {
  var net, netReason;
  for (var n in client.networks) {
    net = client.networks[n];
    if (net.isConnected()) {
      netReason = reason ? reason : net.prefs.defaultQuitMsg;
      netReason = netReason ? netReason : client.userAgent;
      net.quit(netReason);
    }
  }
};

client.wantToQuit = function (reason, deliberate) {
  var close = true;
  if (client.prefs.warnOnClose && !deliberate) {
    const buttons = [MSG_QUIT_ANYWAY, MSG_DONT_QUIT];
    var checkState = { value: true };
    var rv = confirmEx(
      MSG_CONFIRM_QUIT,
      buttons,
      0,
      MSG_WARN_ON_EXIT,
      checkState
    );
    close = rv == 0;
    client.prefs.warnOnClose = checkState.value;
  }

  if (close) {
    client.userClose = true;
    display(MSG_CLOSING);
    client.quit(reason);
  }
};

client.promptToSaveLogin = function (url, type, username, password) {
  var name = "";
  switch (type) {
    case "nick":
    case "oper":
    case "sasl":
      name = username;
      break;
    case "serv":
    case "chan":
      name = url;
      username = "*";
      break;
    default:
      display(getMsg(MSG_LOGIN_ERR_UNKNOWN_TYPE, type), MT_ERROR);
      return;
  }

  const buttons = [MSG_LOGIN_SAVE, MSG_LOGIN_DONT];
  var checkState = { value: true };
  var rv = confirmEx(
    getMsg(MSG_LOGIN_CONFIRM, name),
    buttons,
    0,
    MSG_LOGIN_PROMPT,
    checkState
  );
  if (rv != 0) {
    return;
  }

  client.prefs["login.promptToSave"] = checkState.value;

  username = username.toLowerCase();
  var newinfo = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
    Ci.nsILoginInfo
  );
  newinfo.init(url, null, type, username, password, "", "");
  var oldinfo = getLogin(url, type, username);

  if (oldinfo) {
    // Update login.
    Services.logins.modifyLogin(oldinfo, newinfo);
    display(getMsg(MSG_LOGIN_UPDATED, name), MT_INFO);
    return;
  }

  // Add login.
  Services.logins.addLogin(newinfo);
  display(getMsg(MSG_LOGIN_ADDED, name), MT_INFO);
};

client.tryToGetLogin = function (
  url,
  type,
  username,
  existing,
  needpass,
  promptstring
) {
  // Password is optional. If it is not given, we look for a saved password
  // first. If there isn't one, we potentially use a safe prompt.
  var info = getLogin(url, type, username.toLowerCase());
  var stored = info && info.password ? info.password : "";
  var promptToSave = false;
  if (!existing && stored) {
    existing = stored;
  } else if (!existing && needpass) {
    existing = promptPassword(promptstring, "");
    if (existing) {
      promptToSave = true;
    }
  } else if (existing && stored != existing) {
    promptToSave = true;
  }

  if (promptToSave && client.prefs["login.promptToSave"]) {
    client.promptToSaveLogin(url, type, username, existing);
  }

  return existing;
};

/* gets a tab-complete match for the line of text specified by |line|.
 * wordStart is the position within |line| that starts the word being matched,
 * wordEnd marks the end position.  |cursorPos| marks the position of the caret
 * in the textbox.
 */
client.performTabMatch = function (line, wordStart, wordEnd, word, cursorPos) {
  if (wordStart != 0 || line[0] != client.COMMAND_CHAR) {
    return null;
  }

  var matches = client.commandManager.listNames(word.substr(1), CMD_CONSOLE);
  if (matches.length == 1 && wordEnd == line.length) {
    matches[0] = client.COMMAND_CHAR + matches[0] + " ";
  } else {
    for (var i in matches) {
      matches[i] = client.COMMAND_CHAR + matches[i];
    }
  }

  return matches;
};

client.openLogFile = function (view, showMessage) {
  function getNextLogFileDate() {
    var d = new Date();
    d.setMilliseconds(0);
    d.setSeconds(0);
    d.setMinutes(0);
    switch (view.smallestLogInterval) {
      case "h":
        return d.setHours(d.getHours() + 1);
      case "d":
        d.setHours(0);
        return d.setDate(d.getDate() + 1);
      case "m":
        d.setHours(0);
        d.setDate(1);
        return d.setMonth(d.getMonth() + 1);
      case "y":
        d.setHours(0);
        d.setDate(1);
        d.setMonth(0);
        return d.setFullYear(d.getFullYear() + 1);
    }
    //XXXhack: This should work...
    return Infinity;
  }

  try {
    var file = new LocalFile(view.prefs.logFileName);
    if (!file.localFile.exists()) {
      // futils.umask may be 0022. Result is 0644.
      file.localFile.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o666 & ~futils.umask);
    }
    view.logFile = new LocalFile(file.localFile, ">>");
    // If we're here, it's safe to say when we should re-open:
    view.nextLogFileDate = getNextLogFileDate();
  } catch (ex) {
    view.prefs.log = false;
    dd("Log file open error: " + formatException(ex));
    view.displayHere(getMsg(MSG_LOGFILE_ERROR, getLogPath(view)), MT_ERROR);
    return;
  }

  if (showMessage) {
    view.displayHere(getMsg(MSG_LOGFILE_OPENED, getLogPath(view)));
  }
};

client.closeLogFile = function (view, showMessage) {
  if (showMessage) {
    view.displayHere(getMsg(MSG_LOGFILE_CLOSING, getLogPath(view)));
  }

  if (view.logFile) {
    view.logFile.close();
    view.logFile = null;
  }
};

function getLogin(url, realm, username) {
  let logins = Services.logins.findLogins({}, url, null, realm);
  return logins.find(login => login.username === username);
}

function checkLogFiles() {
  // For every view that has a logfile, check if we need a different file
  // based on the current date and the logfile preference. We close the
  // current logfile, and display will open the new one based on the pref
  // when it's needed.

  var d = new Date();
  for (var n in client.networks) {
    var net = client.networks[n];
    if (net.logFile && d > net.nextLogFileDate) {
      client.closeLogFile(net);
    }
    if ("primServ" in net && net.primServ && "channels" in net.primServ) {
      for (var c in net.primServ.channels) {
        var chan = net.primServ.channels[c];
        if (chan.logFile && d > chan.nextLogFileDate) {
          client.closeLogFile(chan);
        }
      }
    }
    if ("users" in net) {
      for (var u in net.users) {
        var user = net.users[u];
        if (user.logFile && d > user.nextLogFileDate) {
          client.closeLogFile(user);
        }
      }
    }
  }

  for (var dc in client.dcc.chats) {
    var dccChat = client.dcc.chats[dc];
    if (dccChat.logFile && d > dccChat.nextLogFileDate) {
      client.closeLogFile(dccChat);
    }
  }
  for (var df in client.dcc.files) {
    var dccFile = client.dcc.files[df];
    if (dccFile.logFile && d > dccFile.nextLogFileDate) {
      client.closeLogFile(dccFile);
    }
  }

  // Don't forget about the client tab:
  if (client.logFile && d > client.nextLogFileDate) {
    client.closeLogFile(client);
  }

  /* We need to calculate the correct time for the next check. This is
   * attempting to hit 2 seconds past the hour. We need the timezone offset
   * here for when it is not a whole number of hours from UTC.
   */
  var shiftedDate = d.getTime() + d.getTimezoneOffset() * 60000;
  setTimeout(checkLogFiles, 3602000 - (shiftedDate % 3600000));
}

CIRCChannel.prototype.getLCFunction =
  CIRCNetwork.prototype.getLCFunction =
  CIRCUser.prototype.getLCFunction =
  CIRCDCCChat.prototype.getLCFunction =
  CIRCDCCFileTransfer.prototype.getLCFunction =
    function () {
      var details = getObjectDetails(this);
      var lcFn;

      if (details.server) {
        lcFn = function (text) {
          return details.server.toLowerCase(text);
        };
      } else {
        lcFn = function (text) {
          return text.toLowerCase();
        };
      }

      return lcFn;
    };

CIRCChannel.prototype.performTabMatch =
  CIRCNetwork.prototype.performTabMatch =
  CIRCUser.prototype.performTabMatch =
  CIRCDCCChat.prototype.performTabMatch =
  CIRCDCCFileTransfer.prototype.performTabMatch =
    function (line, wordStart, wordEnd, word, cursorpos, lcFn) {
      if (wordStart == 0 && line[0] == client.COMMAND_CHAR) {
        return client.performTabMatch(
          line,
          wordStart,
          wordEnd,
          word,
          cursorpos
        );
      }

      var matchList = [];
      var users;
      var channels;
      var userIndex = -1;

      var details = getObjectDetails(this);

      if (details.channel && word == details.channel.unicodeName[0]) {
        /* When we have #<tab>, we just want the current channel,
           if possible. */
        matchList.push(details.channel.unicodeName);
      } else {
        /* Ok, not #<tab> or no current channel, so get the full list. */

        if (details.channel) {
          users = details.channel.users;
        }

        if (details.server) {
          channels = details.server.channels;
          for (var c in channels) {
            matchList.push(channels[c].unicodeName);
          }
          if (!users) {
            users = details.server.users;
          }
        }

        if (users) {
          userIndex = matchList.length;
          for (var n in users) {
            matchList.push(users[n].unicodeName);
          }
        }
      }

      var matches = matchEntry(word, matchList, lcFn);

      var list = [];
      for (var i = 0; i < matches.length; i++) {
        list.push(matchList[matches[i]]);
      }

      if (list.length == 1) {
        if (users && userIndex >= 0 && matches[0] >= userIndex) {
          if (wordStart == 0) {
            list[0] += client.prefs.nickCompleteStr;
          }
        }

        if (wordEnd == line.length) {
          /* add a space if the word is at the end of the line. */
          list[0] += " ";
        }
      }

      return list;
    };

/*
 *   290miliseconds for 1st derive is allowing about 3-4 events per
 *   second. 200ms for 2nd derivative allows max 200ms difference of
 *   frequency. This means when the flood is massive, this value is
 *   very closed to zero. But runtime issues should cause some delay
 *   in the core js, so zero value is not too good. We need increase
 *   this with a small, to make more strict. And when flood is done,
 *   we need detect it - based on arithmetic medium. When doesn't happen
 *   anything for a long time, perhaps for 2seconds the
 *   value - based on last 10 events - the 2nd value goes
 *   over 200ms average, so event should start again.
 */

function FloodProtector(density, dispersion) {
  this.lastHit = Number(new Date());

  if (density) {
    this.floodDensity = density;
  }

  if (dispersion) {
    this.floodDispersion = dispersion;
  }
}

FloodProtector.prototype.requestedTotal = 0;
FloodProtector.prototype.acceptedTotal = 0;
FloodProtector.prototype.firedTotal = 0;
FloodProtector.prototype.lastHit = 0;
FloodProtector.prototype.derivative1 = 100;
FloodProtector.prototype.derivative1Count = 100;
FloodProtector.prototype.derivative2 = 0;
FloodProtector.prototype.derivative2Count = 0;
FloodProtector.prototype.floodDensity = 290;
FloodProtector.prototype.floodDispersion = 200;

FloodProtector.prototype.request = function () {
  this.requestedTotal++;
  var current = Number(new Date());
  var oldDerivative1 = this.derivative1;
  this.derivative1 = current - this.lastHit;
  this.derivative1Count = (this.derivative1Count * 9 + this.derivative1) / 10;
  this.derivative2 = Math.abs(this.derivative1 - oldDerivative1);
  this.derivative2Count = (this.derivative2Count * 9 + this.derivative2) / 10;
  this.lastHit = current;
};

FloodProtector.prototype.accept = function () {
  this.acceptedTotal++;
};

FloodProtector.prototype.fire = function () {
  // There is no activity for 10 seconds - flood is possibly done.
  // No need more recall. In other way the first normal activity
  // overwrites it automatically earlier, if nessesary.
  if (Number(new Date()) - this.lastHit > 10000) {
    return false;
  }

  // The activity is not too frequent or not massive so should not be fire.
  if (
    this.derivative1Count > this.floodDensity ||
    this.derivative2Count > this.floodDispersion
  ) {
    return false;
  }

  this.firedTotal++;
  return true;
};

function toasterPopupOverlapDelayReset(eventType) {
  // it smells like a flood attack so rather wait more...
  if (client.alert.floodProtector.fire()) {
    setTimeout(
      toasterPopupOverlapDelayReset,
      client.prefs["alert.overlapDelay"],
      eventType
    );
  } else {
    delete client.alert.alertList[eventType];
  }
}

var alertClickerObserver = {
  observe(subject, topic, data) {
    if (topic == "alertclickcallback") {
      var tb = document.getElementById(data);
      if (tb && tb.view) {
        tb.view.dispatch("set-current-view", { view: tb.view });
        window.focus();
      }
    }
  },

  // Gecko 1.7.* rulez
  onAlertClickCallback(data) {
    var tb = document.getElementById(data);
    if (tb && tb.view) {
      tb.view.dispatch("set-current-view", { view: tb.view });
      window.focus();
    }
  },

  onAlertFinished(data) {},
};

// Show the alert for a particular event on a type of object.
function showEventAlerts(type, event, message, nick, o, thisp, msgtype) {
  // Converts .TYPE values into the event object names.
  // IRCChannel => channel, IRCUser => user, etc.
  type = type.replace(/^IRC/i, "").toLowerCase();

  var source = type;
  // DCC Chat sessions should act just like user views.
  if (type == "dccchat") {
    type = "user";
  }

  var ev = type + "." + event;
  if (!("alert." + ev in thisp.prefs)) {
    return;
  }
  if (!thisp.prefs["alert." + ev]) {
    return;
  }

  client.alert.floodProtector.request();
  if (ev in client.alert.alertList) {
    return;
  }

  client.alert.floodProtector.accept();
  if (client.prefs["alert.overlapDelay"] > 0) {
    client.alert.alertList[ev] = true;
    setTimeout(
      toasterPopupOverlapDelayReset,
      client.prefs["alert.overlapDelay"],
      ev
    );
  }

  var clickable = client.prefs["alert.clickable"];
  var tabId = clickable ? getTabForObject(thisp, false).id : "";
  var listener = clickable ? alertClickerObserver : null;

  message = removeColorCodes(message);
  if (nick) {
    if (msgtype == "ACTION") {
      message = "* " + nick + " " + message;
    } else {
      message = "<" + nick + "> " + message;
    }
  }

  if (source == "channel" && o.channel) {
    source = o.channel.viewName;
  } else if (source == "user" && o.network) {
    source = o.network.viewName;
  }

  // We can't be sure if it is a macOS and Growl is now turned off or not
  try {
    client.alert.service.showAlertNotification(
      "chrome://chatzilla/skin/images/logo.png",
      "ChatZilla - " + source + " - " + event,
      message,
      clickable,
      tabId,
      listener
    );
  } catch (ex) {
    // yup. it is probably a MAC or NsIAlertsService is not initialized
  }
}

function matchEntry(partialName, list, lcFn) {
  function utils_lcfn(text) {
    return text.toLowerCase();
  }

  let ary = [];

  if (typeof partialName == "undefined" || String(partialName) == "") {
    for (let i in list) {
      ary.push(i);
    }
    return ary;
  }

  if (typeof lcFn != "function") {
    lcFn = utils_lcfn;
  }

  for (let i in list) {
    if (lcFn(list[i]).startsWith(lcFn(partialName))) {
      ary.push(i);
    }
  }

  return ary;
}
