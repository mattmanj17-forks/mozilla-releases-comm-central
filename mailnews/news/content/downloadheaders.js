/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

var markreadElement = null;
var numberElement = null;

var nntpServer = null;
var propBag, args;

window.addEventListener("load", onLoad);
window.addEventListener("unload", onUnload);
document.addEventListener("dialogaccept", onOK);
document.addEventListener("dialogcancel", onCancel);

function onLoad() {
  const newsBundle = document.getElementById("bundle_news");

  if ("arguments" in window && window.arguments[0]) {
    propBag = window.arguments[0]
      .QueryInterface(Ci.nsIWritablePropertyBag2)
      .QueryInterface(Ci.nsIWritablePropertyBag);
    // Convert to a JS object.
    args = {};
    for (const prop of propBag.enumerator) {
      args[prop.name] = prop.value;
    }

    /* by default, act like the user hit cancel */
    args.hitOK = false;
    /* by default, act like the user did not select download all */
    args.downloadAll = false;

    nntpServer = MailServices.accounts
      .getIncomingServer(args.serverKey)
      .QueryInterface(Ci.nsINntpIncomingServer);

    document.title = newsBundle.getString("downloadHeadersTitlePrefix");

    const infotext = newsBundle.getFormattedString("downloadHeadersInfoText", [
      args.articleCount,
    ]);
    setText("info", infotext);
    const okButtonText = newsBundle.getString("okButtonText");
    const okbutton = document.querySelector("dialog").getButton("accept");
    okbutton.setAttribute("label", okButtonText);
    okbutton.focus();
    setText("newsgroupLabel", args.groupName);
  }

  numberElement = document.getElementById("number");
  numberElement.value = nntpServer.maxArticles;

  markreadElement = document.getElementById("markread");
  markreadElement.checked = nntpServer.markOldRead;

  setupDownloadUI(true);

  return true;
}

function onUnload() {
  // Convert args back into property bag.
  for (const propName in args) {
    propBag.setProperty(propName, args[propName]);
  }
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (!element) {
    return;
  }

  while (element.lastChild) {
    element.lastChild.remove();
  }
  const textNode = document.createTextNode(value);
  element.appendChild(textNode);
}

function onOK() {
  nntpServer.maxArticles = numberElement.value;
  nntpServer.markOldRead = markreadElement.checked;

  const radio = document.getElementById("all");
  if (radio) {
    args.downloadAll = radio.selected;
  }

  args.hitOK = true;
}

function onCancel() {
  args.hitOK = false;
}

function setupDownloadUI(enable) {
  const checkbox = document.getElementById("markread");
  const numberFld = document.getElementById("number");

  checkbox.disabled = !enable;
  numberFld.disabled = !enable;
  numberFld.select();
}
