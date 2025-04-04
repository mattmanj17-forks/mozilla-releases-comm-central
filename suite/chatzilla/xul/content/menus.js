/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function initMenus() {
  function isMotif(name) {
    return (
      "client.prefs['motif.current'] == " + "client.prefs['motif." + name + "']"
    );
  }

  function isFontFamily(name) {
    return "cx.sourceObject.prefs['font.family'] == '" + name + "'";
  }

  function isFontFamilyCustom() {
    return (
      "!cx.sourceObject.prefs['font.family']." +
      "match(/^(default|(sans-)?serif|monospace)$/)"
    );
  }

  function isFontSize(size) {
    return "cx.fontSize == cx.fontSizeDefault + " + size;
  }

  function isFontSizeCustom() {
    // It's "custom" if it's set (non-zero/not default), not the default
    // size (medium) and not +/-2 (small/large).
    return (
      "'fontSize' in cx && cx.fontSize != 0 && " +
      "cx.fontSizeDefault != cx.fontSize && " +
      "Math.abs((cx.fontSizeDefault - cx.fontSize) / 2) != 1"
    );
  }

  function onMenuCommand(event, window) {
    var commandName = event.originalTarget.getAttribute("commandname");
    var params = new Object();
    if ("cx" in client.menuManager && client.menuManager.cx) {
      params = client.menuManager.cx;
    }
    params.sourceWindow = window;
    params.source = "menu";
    params.shiftKey = event.shiftKey;

    dispatch(commandName, params, true);

    delete client.menuManager.cx;
  }

  client.onMenuCommand = onMenuCommand;
  client.menuSpecs = new Object();
  var menuManager = new MenuManager(
    client.commandManager,
    client.menuSpecs,
    getCommandContext,
    "client.onMenuCommand(event, window);"
  );
  client.menuManager = menuManager;

  client.menuSpecs.maintoolbar = {
    items: [["disconnect"], ["quit"], ["part"]],
  };

  // OS values
  var Win = "(client.platform == 'Windows')";
  var NotWin = "(client.platform != 'Windows')";
  var Linux = "(client.platform == 'Linux')";
  var NotLinux = "(client.platform != 'Linux')";
  var Mac = "(client.platform == 'Mac')";
  var NotMac = "(client.platform != 'Mac')";

  // IRC specific values
  var ViewClient = "(cx.TYPE == 'IRCClient')";
  var ViewNetwork = "(cx.TYPE == 'IRCNetwork')";
  var ViewChannel = "(cx.TYPE == 'IRCChannel')";
  var ViewUser = "(cx.TYPE == 'IRCUser')";
  var ViewDCC = "(cx.TYPE.substr(0, 6) == 'IRCDCC')";

  // IRC specific combinations
  var ChannelActive = "(" + ViewChannel + " and cx.channel.active)";
  var ChannelInactive = "(" + ViewChannel + " and !cx.channel.active)";
  var DCCActive = "(" + ViewDCC + " and cx.sourceObject.isActive())";
  var NetConnected = "(cx.network and cx.network.isConnected())";
  var NetDisconnected = "(cx.network and !cx.network.isConnected())";

  client.menuSpecs["mainmenu:chatzilla"] = {
    label: MSG_MNU_CHATZILLA,
    accesskey: getAccessKeyForMenu("MSG_MNU_CHATZILLA"),
    getContext: getDefaultContext,
    items: [
      ["cmd-prefs"],
      ["install-plugin"],
      ["goto-startup"],
      ["-"],
      ["print"],
      ["save"],
      ["-", { visibleif: NotMac }],
      ["exit", { visibleif: Win }],
      ["quit", { visibleif: NotMac + " and " + NotWin }],
    ],
  };

  client.menuSpecs["mainmenu:irc"] = {
    label: MSG_MNU_IRC,
    accesskey: getAccessKeyForMenu("MSG_MNU_IRC"),
    getContext: getDefaultContext,
    items: [
      ["join"],
      ["-"],
      ["edit-networks"],
      ["-"],
      [">popup:views"],
      [">popup:nickname"],
      ["-"],
      ["clear-view"],
      ["hide-view", { enabledif: "client.viewsArray.length > 1" }],
      [
        "toggle-oas",
        {
          type: "checkbox",
          checkedif: "isStartupURL(cx.sourceObject.getURL())",
        },
      ],
      ["-"],
      ["leave", { visibleif: ChannelActive }],
      ["rejoin", { visibleif: ChannelInactive }],
      ["dcc-close", { visibleif: DCCActive }],
      [
        "delete-view",
        { visibleif: "!" + ChannelActive + " and !" + DCCActive },
      ],
      ["disconnect", { visibleif: NetConnected }],
      ["reconnect", { visibleif: NetDisconnected }],
      ["-"],
      ["toggle-text-dir"],
    ],
  };

  client.menuSpecs["popup:views"] = {
    label: MSG_MNU_VIEWS,
    accesskey: getAccessKeyForMenu("MSG_MNU_VIEWS"),
    getContext: getViewsContext,
    items: [
      [
        "goto-url",
        {
          type: "radio",
          checkedif: "cx.url == cx.sourceObject.getURL()",
          repeatfor: "cx.views",
          repeatgroup: "item.group",
          repeatmap: "cx.url = item.url; cx.label = item.label",
        },
      ],
    ],
  };

  client.menuSpecs["mainmenu:edit"] = {
    label: MSG_MNU_EDIT,
    accesskey: getAccessKeyForMenu("MSG_MNU_EDIT"),
    getContext: getDefaultContext,
    items: [
      ["cmd-undo", { enabledif: "getCommandEnabled('cmd_undo')" }],
      ["cmd-redo", { enabledif: "getCommandEnabled('cmd_redo')" }],
      ["-"],
      ["cmd-cut", { enabledif: "getCommandEnabled('cmd_cut')" }],
      ["cmd-copy", { enabledif: "getCommandEnabled('cmd_copy')" }],
      ["cmd-paste", { enabledif: "getCommandEnabled('cmd_paste')" }],
      ["cmd-delete", { enabledif: "getCommandEnabled('cmd_delete')" }],
      ["-"],
      ["cmd-selectall", { enabledif: "getCommandEnabled('cmd_selectAll')" }],
      ["-"],
      ["find"],
      ["find-again", { enabledif: "canFindAgainInPage()" }],
      ["-"],
      ["cmd-mozilla-prefs"],
    ],
  };

  client.menuSpecs["popup:motifs"] = {
    label: MSG_MNU_MOTIFS,
    accesskey: getAccessKeyForMenu("MSG_MNU_MOTIFS"),
    items: [
      ["motif-dark", { type: "checkbox", checkedif: isMotif("dark") }],
      ["motif-light", { type: "checkbox", checkedif: isMotif("light") }],
    ],
  };

  client.menuSpecs["mainmenu:view"] = {
    label: MSG_MNU_VIEW,
    accesskey: getAccessKeyForMenu("MSG_MNU_VIEW"),
    getContext: getDefaultContext,
    items: [
      ["tabstrip", { type: "checkbox", checkedif: "isVisible('view-tabs')" }],
      [
        "header",
        {
          type: "checkbox",
          checkedif: "cx.sourceObject.prefs['displayHeader']",
        },
      ],
      [
        "userlist",
        { type: "checkbox", checkedif: "isVisible('user-list-box')" },
      ],
      ["statusbar", { type: "checkbox", checkedif: "isVisible('status-bar')" }],
      ["-"],
      [">popup:motifs"],
      [">popup:fonts"],
      ["-"],
      [
        "toggle-ccm",
        { type: "checkbox", checkedif: "client.prefs['collapseMsgs']" },
      ],
      [
        "toggle-copy",
        { type: "checkbox", checkedif: "client.prefs['copyMessages']" },
      ],
      [
        "toggle-timestamps",
        { type: "checkbox", checkedif: "cx.sourceObject.prefs['timestamps']" },
      ],
    ],
  };

  /* Mac expects a help menu with this ID, and there is nothing we can do
   * about it. */
  client.menuSpecs["mainmenu:help"] = {
    label: MSG_MNU_HELP,
    accesskey: getAccessKeyForMenu("MSG_MNU_HELP"),
    domID: "menu_Help",
    items: [
      ["-"],
      ["homepage"],
      ["faq"],
      ["-"],
      ["about", { id: "aboutName" }],
    ],
  };

  client.menuSpecs["popup:fonts"] = {
    label: MSG_MNU_FONTS,
    accesskey: getAccessKeyForMenu("MSG_MNU_FONTS"),
    getContext: getFontContext,
    items: [
      ["font-size-bigger", {}],
      ["font-size-smaller", {}],
      ["-"],
      ["font-size-default", { type: "checkbox", checkedif: "!cx.fontSize" }],
      ["font-size-small", { type: "checkbox", checkedif: isFontSize(-2) }],
      ["font-size-medium", { type: "checkbox", checkedif: isFontSize(0) }],
      ["font-size-large", { type: "checkbox", checkedif: isFontSize(+2) }],
      ["font-size-other", { type: "checkbox", checkedif: isFontSizeCustom() }],
      ["-"],
      [
        "font-family-default",
        { type: "checkbox", checkedif: isFontFamily("default") },
      ],
      [
        "font-family-serif",
        { type: "checkbox", checkedif: isFontFamily("serif") },
      ],
      [
        "font-family-sans-serif",
        { type: "checkbox", checkedif: isFontFamily("sans-serif") },
      ],
      [
        "font-family-monospace",
        { type: "checkbox", checkedif: isFontFamily("monospace") },
      ],
      [
        "font-family-other",
        { type: "checkbox", checkedif: isFontFamilyCustom() },
      ],
    ],
  };

  // Me is op.
  var isop = "(cx.channel.iAmOp()) && ";
  // Me is op or half-op.
  var isopish = "(cx.channel.iAmOp() || cx.channel.iAmHalfOp()) && ";
  // Server has half-ops.
  var shop = "(cx.server.supports.prefix.indexOf('h') > 0) && ";
  // User is Me or Me is op.
  var isoporme = "((cx.user == cx.server.me) || cx.channel.iAmOp()) && ";

  client.menuSpecs["popup:opcommands"] = {
    label: MSG_MNU_OPCOMMANDS,
    accesskey: getAccessKeyForMenu("MSG_MNU_OPCOMMANDS"),
    items: [
      ["op", { visibleif: isop + "!cx.user.isOp" }],
      ["deop", { visibleif: isop + "cx.user.isOp" }],
      ["hop", { visibleif: isop + "!cx.user.isHalfOp" }],
      ["dehop", { visibleif: isoporme + "cx.user.isHalfOp" }],
      ["voice", { visibleif: isopish + "!cx.user.isVoice" }],
      ["devoice", { visibleif: isopish + "cx.user.isVoice" }],
      ["-"],
      [
        "ban",
        { enabledif: "(" + isop + "1) || (" + isopish + "!cx.user.isOp)" },
      ],
      [
        "unban",
        { enabledif: "(" + isop + "1) || (" + isopish + "!cx.user.isOp)" },
      ],
      [
        "kick",
        { enabledif: "(" + isop + "1) || (" + isopish + "!cx.user.isOp)" },
      ],
      [
        "kick-ban",
        { enabledif: "(" + isop + "1) || (" + isopish + "!cx.user.isOp)" },
      ],
    ],
  };

  client.menuSpecs["popup:usercommands"] = {
    label: MSG_MNU_USERCOMMANDS,
    accesskey: getAccessKeyForMenu("MSG_MNU_USERCOMMANDS"),
    items: [
      ["query", { visibleif: "cx.channel && cx.user" }],
      ["whois", { visibleif: "cx.user" }],
      ["whowas", { visibleif: "cx.nickname && !cx.user" }],
      ["ping", { visibleif: "cx.user" }],
      ["time", { visibleif: "cx.user" }],
      ["version", { visibleif: "cx.user" }],
      ["-", { visibleif: "cx.user" }],
      ["dcc-chat", { visibleif: "cx.user" }],
      ["dcc-send", { visibleif: "cx.user" }],
    ],
  };

  client.menuSpecs["context:userlist"] = {
    getContext: getUserlistContext,
    items: [
      [
        "toggle-usort",
        { type: "checkbox", checkedif: "client.prefs['sortUsersByMode']" },
      ],
      [
        "toggle-umode",
        { type: "checkbox", checkedif: "client.prefs['showModeSymbols']" },
      ],
      ["-", { visibleif: "cx.nickname" }],
      [
        "label-user",
        { visibleif: "cx.nickname && (cx.userCount == 1)", header: true },
      ],
      [
        "label-user-multi",
        { visibleif: "cx.nickname && (cx.userCount != 1)", header: true },
      ],
      [
        ">popup:opcommands",
        { visibleif: "cx.nickname", enabledif: isopish + "true" },
      ],
      [
        ">popup:usercommands",
        { visibleif: "cx.nickname", enabledif: "cx.userCount == 1" },
      ],
    ],
  };

  var urlenabled = "has('url')";
  var urlexternal = "has('url') && cx.url.search(/^ircs?:/i) == -1";
  var textselected = "getCommandEnabled('cmd_copy')";

  client.menuSpecs["context:messages"] = {
    getContext: getMessagesContext,
    items: [
      ["goto-url", { visibleif: urlenabled }],
      ["goto-url-newwin", { visibleif: urlexternal }],
      ["goto-url-newtab", { visibleif: urlexternal }],
      ["cmd-copy-link-url", { visibleif: urlenabled }],
      ["cmd-copy", { visibleif: "!" + urlenabled, enabledif: textselected }],
      ["cmd-selectall", { visibleif: "!" + urlenabled }],
      ["websearch", { visibleif: textselected }],
      ["-", { visibleif: "cx.nickname" }],
      ["label-user", { visibleif: "cx.nickname", header: true }],
      [
        ">popup:opcommands",
        {
          visibleif: "cx.channel && cx.nickname",
          enabledif: isopish + "cx.user",
        },
      ],
      [">popup:usercommands", { visibleif: "cx.nickname" }],
      ["-"],
      ["clear-view"],
      ["hide-view", { enabledif: "client.viewsArray.length > 1" }],
      [
        "toggle-oas",
        {
          type: "checkbox",
          checkedif: "isStartupURL(cx.sourceObject.getURL())",
        },
      ],
      ["-"],
      ["leave", { visibleif: ChannelActive }],
      ["rejoin", { visibleif: ChannelInactive }],
      ["dcc-close", { visibleif: DCCActive }],
      [
        "delete-view",
        { visibleif: "!" + ChannelActive + " and !" + DCCActive },
      ],
      ["disconnect", { visibleif: NetConnected }],
      ["reconnect", { visibleif: NetDisconnected }],
      ["-"],
      ["toggle-text-dir"],
    ],
  };

  client.menuSpecs["context:tab"] = {
    getContext: getTabContext,
    items: [
      ["clear-view"],
      ["hide-view", { enabledif: "client.viewsArray.length > 1" }],
      [
        "toggle-oas",
        {
          type: "checkbox",
          checkedif: "isStartupURL(cx.sourceObject.getURL())",
        },
      ],
      ["-"],
      ["leave", { visibleif: ChannelActive }],
      ["rejoin", { visibleif: ChannelInactive }],
      ["dcc-close", { visibleif: DCCActive }],
      [
        "delete-view",
        { visibleif: "!" + ChannelActive + " and !" + DCCActive },
      ],
      ["disconnect", { visibleif: NetConnected }],
      ["reconnect", { visibleif: NetDisconnected }],
      ["-"],
      ["rename"],
      ["-"],
      ["toggle-text-dir"],
    ],
  };

  client.menuSpecs["context:edit"] = {
    getContext: getDefaultContext,
    items: [
      ["cmd-undo", { enabledif: "getCommandEnabled('cmd_undo')" }],
      ["-"],
      ["cmd-cut", { enabledif: "getCommandEnabled('cmd_cut')" }],
      ["cmd-copy", { enabledif: "getCommandEnabled('cmd_copy')" }],
      ["cmd-paste", { enabledif: "getCommandEnabled('cmd_paste')" }],
      ["cmd-delete", { enabledif: "getCommandEnabled('cmd_delete')" }],
      ["-"],
      ["cmd-selectall", { enabledif: "getCommandEnabled('cmd_selectAll')" }],
    ],
  };

  // Gross hacks to figure out if we're away:
  var netAway = "cx.network.prefs['away']";
  var cliAway = "client.prefs['away']";
  var awayCheckNet = "(cx.network and (" + netAway + " == item.message))";
  var awayCheckCli = "(!cx.network and (" + cliAway + " == item.message))";
  var awayChecked = awayCheckNet + " or " + awayCheckCli;
  var areBack =
    "(cx.network and !" +
    netAway +
    ") or " +
    "(!cx.network and !" +
    cliAway +
    ")";

  client.menuSpecs["mainmenu:nickname"] = {
    label: client.prefs.nickname,
    domID: "server-nick",
    getContext: getDefaultContext,
    items: [
      ["nick"],
      ["-"],
      ["back", { type: "checkbox", checkedif: areBack }],
      [
        "away",
        {
          type: "checkbox",
          checkedif: awayChecked,
          repeatfor: "client.awayMsgs",
          repeatmap: "cx.reason = item.message",
        },
      ],
      ["-"],
      ["custom-away"],
    ],
  };

  client.menuSpecs["popup:nickname"] = {
    label: MSG_STATUS,
    accesskey: getAccessKeyForMenu("MSG_STATUS"),
    getContext: getDefaultContext,
    items: client.menuSpecs["mainmenu:nickname"].items,
  };
}

function createMenus() {
  client.menuManager.createMenus(document, "mainmenu");
  client.menuManager.createContextMenus(document);
}

function getCommandContext(id, event) {
  var cx = { originalEvent: event };

  if (id in client.menuSpecs) {
    if ("getContext" in client.menuSpecs[id]) {
      cx = client.menuSpecs[id].getContext(cx);
    } else if ("cx" in client.menuManager) {
      //dd ("using existing context");
      cx = client.menuManager.cx;
    } else {
      //no context.
    }
  } else {
    dd("getCommandContext: unknown menu id " + id);
  }

  if (typeof cx == "object") {
    if (!("menuManager" in cx)) {
      cx.menuManager = client.menuManager;
    }
    if (!("contextSource" in cx)) {
      cx.contextSource = id;
    }
    if ("dbgContexts" in client && client.dbgContexts) {
      dd("context '" + id + "'\n" + dumpObjectTree(cx));
    }
  }

  return cx;
}

/**
 * Gets an accesskey for the menu with label string ID labelString.
 * At first, we attempt to extract it from the label string, otherwise
 * we fall back to using a separate string.
 *
 * @param labelString   the id for the locale string corresponding to the label
 * @return              the accesskey for the menu.
 */
function getAccessKeyForMenu(labelString) {
  var rv = getAccessKey(window[labelString]);
  if (!rv) {
    rv = window[labelString + "_ACCESSKEY"] || "";
  }
  return rv;
}
