/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ts=2 et sw=2 tw=80 filetype=javascript: */
/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
  This file creates a JS-based override of the JaMsgFolder implementation. It
  demos a minimal JS class, and is also used in testing the additional methods
  added to JaMsgFolder.cpp that are not in nsMsgDBFolder.cpp
 */

// A partial JavaScript implementation of the base server methods.

export const JaBaseMsgFolderProperties = {
  baseContractID: "@mozilla.org/jacppmsgfolderdelegator;1",
  baseInterfaces: [
    Ci.nsISupports,
    Ci.nsIMsgFolder,
    Ci.nsIDBChangeListener,
    Ci.nsIUrlListener,
    Ci.nsIJunkMailClassificationListener,
    Ci.nsIMsgTraitClassificationListener,
    Ci.nsIInterfaceRequestor,
    Ci.msgIOverride,
  ],
  delegateInterfaces: ["nsIMsgFolder"],
  contractID: "@mozilla.org/mail/folder-factory;1?name=testja",
  classID: Components.ID("{8508ddeb-3eab-4877-a420-297518f62371}"),
};

export function JaBaseMsgFolder(aDelegator, aBaseInterfaces) {
  // Typical boilerplate to include in all implementations.

  // Object delegating method calls to the appropriate XPCOM object.
  // Weak because it owns us.
  this.delegator = Cu.getWeakReference(aDelegator);

  // Base implementation of methods with no overrides.
  this.cppBase = aDelegator.cppBase;

  // cppBase class sees all interfaces
  aBaseInterfaces.forEach(iface => this.cppBase instanceof iface);
}

JaBaseMsgFolder.prototype = {
  // Typical boilerplate to include in all implementations.

  // Flag this item as CPP needs to delegate to JS.
  _JsPrototypeToDelegate: true,

  // QI to the (partially implemented only) interfaces.
  QueryInterface: ChromeUtils.generateQI(
    JaBaseMsgFolderProperties.delegateInterfaces
  ),

  // Used to access an instance as JS, bypassing XPCOM.
  get wrappedJSObject() {
    return this;
  },

  // Dynamically-generated list of delegate methods.
  delegateList: null,

  // nsIMsgFolder overrides.
  get incomingServerType() {
    return "testja";
  },
};
