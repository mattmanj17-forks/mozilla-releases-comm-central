/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

import { DNS } from "resource:///modules/DNS.sys.mjs";

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CardDAVDirectory: "resource:///modules/CardDAVDirectory.sys.mjs",

  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",

  MsgAuthPrompt: "resource:///modules/MsgAsyncPrompter.sys.mjs",
  OAuth2Module: "resource:///modules/OAuth2Module.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "nssErrorsService",
  "@mozilla.org/nss_errors_service;1",
  "nsINSSErrorsService"
);

// Use presets only where DNS discovery fails. Set to null to prevent
// auto-fill completely for a domain.
const PRESETS = {
  // For testing purposes.
  "bad.invalid": null,
  // Google responds correctly but the provided address returns 404.
  "gmail.com": "https://www.googleapis.com",
  "googlemail.com": "https://www.googleapis.com",
  // For testing purposes.
  "test.invalid": "http://localhost:9999",
  // Yahoo! OAuth is not working yet.
  "yahoo.com": null,
};

// At least one of these ACL privileges must be present to consider an address
// book writable.
const writePrivs = ["write", "write-properties", "write-content", "all"];

// At least one of these ACL privileges must be present to consider an address
// book readable.
const readPrivs = ["read", "all"];

export var CardDAVUtils = {
  _contextMap: new Map(),

  /**
   * Returns the id of a unique private context for each username. When the
   * userContextId is set on a principal, this allows the use of multiple
   * usernames on the same server without the networking code causing issues.
   *
   * @param {string} username
   * @returns {integer}
   */
  contextForUsername(username) {
    if (username && CardDAVUtils._contextMap.has(username)) {
      return CardDAVUtils._contextMap.get(username);
    }

    // This could be any 32-bit integer, as long as it isn't already in use.
    const nextId = 25000 + CardDAVUtils._contextMap.size;
    lazy.ContextualIdentityService.remove(nextId);
    CardDAVUtils._contextMap.set(username, nextId);
    return nextId;
  },

  /**
   * Make an HTTP request. If the request needs a username and password, the
   * given authPrompt is called.
   *
   * @param {string}  uri
   * @param {object}  details
   * @param {string}  [details.method]
   * @param {object}  [details.headers]
   * @param {string}  [details.body]
   * @param {string}  [details.contentType]
   * @param {OAuth2Module}  [details.oAuth] - If this is present the request
   *     will use OAuth2 authorization.
   * @param {NotificationCallbacks} [details.callbacks] - Handles usernames
   *     and passwords for this request.
   * @param {integer} [details.userContextId] - See _contextForUsername.
   *
   * @returns {Promise<object>} - Resolves to an object with getters for:
   *    - status, the HTTP response code
   *    - statusText, the HTTP response message
   *    - text, the returned data as a String
   *    - dom, the returned data parsed into a Document
   */
  async makeRequest(uri, details) {
    if (typeof uri == "string") {
      uri = Services.io.newURI(uri);
    }
    const {
      method = "GET",
      headers = {},
      body = null,
      contentType = "text/xml",
      oAuth = null,
      callbacks = new NotificationCallbacks(),
      userContextId = Ci.nsIScriptSecurityManager.DEFAULT_USER_CONTEXT_ID,
    } = details;
    headers["Content-Type"] = contentType;
    if (oAuth) {
      headers.Authorization = await new Promise((resolve, reject) => {
        oAuth.getAccessToken({
          onSuccess(token) {
            // Format the token as an HTTP Authorization header value.
            resolve(`Bearer ${token}`);
          },
          onFailure: reject,
        });
      });
    }

    return new Promise((resolve, reject) => {
      const principal = Services.scriptSecurityManager.createContentPrincipal(
        uri,
        { userContextId }
      );

      const channel = Services.io.newChannelFromURI(
        uri,
        null,
        principal,
        null,
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
        Ci.nsIContentPolicy.TYPE_OTHER
      );
      channel.QueryInterface(Ci.nsIHttpChannel);
      for (const [name, value] of Object.entries(headers)) {
        channel.setRequestHeader(name, value, false);
      }
      if (body !== null) {
        const stream = Cc[
          "@mozilla.org/io/string-input-stream;1"
        ].createInstance(Ci.nsIStringInputStream);
        stream.setUTF8Data(body);

        channel.QueryInterface(Ci.nsIUploadChannel);
        channel.setUploadStream(stream, contentType, -1);
      }
      channel.requestMethod = method; // Must go after setUploadStream.
      channel.notificationCallbacks = callbacks;

      const listener = Cc[
        "@mozilla.org/network/stream-loader;1"
      ].createInstance(Ci.nsIStreamLoader);
      listener.init({
        async onStreamComplete(loader, context, status, resultLength, result) {
          const finalChannel = loader.request.QueryInterface(Ci.nsIHttpChannel);
          if (!Components.isSuccessCode(status)) {
            let isCertError = false;
            try {
              const errorType = lazy.nssErrorsService.getErrorClass(status);
              if (errorType == Ci.nsINSSErrorsService.ERROR_CLASS_BAD_CERT) {
                isCertError = true;
              }
            } catch (ex) {
              // nsINSSErrorsService.getErrorClass throws if given a non-TLS,
              // non-cert error, so ignore this.
            }

            if (isCertError && finalChannel.securityInfo) {
              const secInfo = finalChannel.securityInfo.QueryInterface(
                Ci.nsITransportSecurityInfo
              );
              const params = {
                exceptionAdded: false,
                securityInfo: secInfo,
                prefetchCert: true,
                location: finalChannel.originalURI.displayHostPort,
              };
              const deferred = Promise.withResolvers();
              const dialog = Services.wm
                .getMostRecentWindow("")
                .openDialog(
                  "chrome://pippki/content/exceptionDialog.xhtml",
                  "",
                  "chrome,centerscreen,dependent",
                  params
                );
              function onWindowClosed(win) {
                if (win == dialog) {
                  Services.obs.removeObserver(
                    onWindowClosed,
                    "domwindowclosed"
                  );
                  deferred.resolve();
                }
              }
              Services.obs.addObserver(onWindowClosed, "domwindowclosed");
              await deferred.promise;

              if (params.exceptionAdded) {
                // Try again now that an exception has been added.
                CardDAVUtils.makeRequest(uri, details).then(resolve, reject);
                return;
              }
            }

            reject(new Components.Exception("Connection failure", status));
            return;
          }
          if (finalChannel.responseStatus == 401) {
            // We tried to authenticate, but failed.
            reject(
              new Components.Exception(
                "Authorization failure",
                Cr.NS_ERROR_FAILURE
              )
            );
            return;
          }
          resolve({
            get status() {
              return finalChannel.responseStatus;
            },
            get statusText() {
              return finalChannel.responseStatusText;
            },
            get text() {
              return new TextDecoder().decode(Uint8Array.from(result));
            },
            get dom() {
              if (this._dom === undefined) {
                try {
                  this._dom = new DOMParser().parseFromString(
                    this.text,
                    "text/xml"
                  );
                } catch (ex) {
                  this._dom = null;
                }
              }
              return this._dom;
            },
          });
        },
      });
      channel.asyncOpen(listener, channel);
    });
  },

  /**
   * @typedef foundBook
   * @property {URL} url - The address for this address book.
   * @param {string} name - The name of this address book on the server.
   * @param {Function} create - A callback to add this address book locally.
   */

  /**
   * Uses DNS look-ups and magic URLs to detects CardDAV address books.
   *
   * @param {string} username - Username for the server at `location`.
   * @param {string} [password] - If not given, the user will be prompted.
   * @param {string} location - The URL of a server to query.
   * @param {boolean} [forcePrompt=false] - If true, the user will be shown a
   *     login prompt even if `password` is specified. If false, the user will
   *     be shown a prompt only if `password` is not specified and no saved
   *     password matches `username` and `location`.
   * @param {boolean} [storePassword] - If provided, override the password
   *     storing behavior.
   * @returns {foundBook[]} - An array of found address books.
   */
  async detectAddressBooks(
    username,
    password,
    location,
    forcePrompt = false,
    storePassword
  ) {
    const log = console.createInstance({
      prefix: "carddav.setup",
      maxLogLevel: "Warn",
      maxLogLevelPref: "carddav.setup.loglevel",
    });

    // Use a unique context for each attempt, so a prompt is always shown.
    // Needs to be a new ID fairly frequently for tests.
    const userContextId = Math.floor(Date.now() / 10);

    let url = new URL(location);

    if (url.hostname in PRESETS) {
      if (PRESETS[url.hostname] === null) {
        throw new Components.Exception(
          `${url} is known to be incompatible`,
          Cr.NS_ERROR_NOT_AVAILABLE
        );
      }
      log.log(`Using preset URL for ${url}`);
      url = new URL(PRESETS[url.hostname]);
    }

    if (url.pathname == "/" && !(url.hostname in PRESETS)) {
      log.log(`Looking up DNS record for ${url.hostname}`);
      const domain = `_carddavs._tcp.${url.hostname}`;
      const srvRecords = await DNS.srv(domain);
      srvRecords.sort((a, b) => a.prio - b.prio || b.weight - a.weight);

      if (srvRecords[0]) {
        url = new URL(`https://${srvRecords[0].host}:${srvRecords[0].port}`);
        log.log(`Found a DNS SRV record pointing to ${url.host}`);

        const txtRecords = await DNS.txt(domain);
        // RFC 6763 rules state that each string in the TXT record is treated as
        // a key/value pair.
        const paths = txtRecords
          .map(result => result.strings.find(s => s.startsWith("path=")))
          .filter(Boolean);

        if (paths.length) {
          // Get the string after `path=`.
          url.pathname = paths[0].substring(5);
          log.log(`Found a DNS TXT record pointing to ${url.href}`);
        }
      } else {
        const mxRecords = await DNS.mx(url.hostname);
        if (mxRecords.some(r => /\bgoogle\.com$/.test(r.host))) {
          log.log(
            `Found a DNS MX record for Google, using preset URL for ${url}`
          );
          url = new URL(PRESETS["gmail.com"]);
        }
      }
    }

    const callbacks = new NotificationCallbacks(
      username,
      password,
      forcePrompt,
      storePassword
    );

    const requestParams = {
      method: "PROPFIND",
      callbacks,
      userContextId,
      headers: {
        Depth: 0,
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
      <propfind xmlns="DAV:">
          <prop>
            <resourcetype/>
            <displayname/>
            <current-user-principal/>
            <current-user-privilege-set/>
          </prop>
        </propfind>`,
    };

    let oAuth = new lazy.OAuth2Module();
    if (oAuth.initFromHostname(url.host, username, "carddav")) {
      requestParams.oAuth = oAuth;
    } else {
      oAuth = null;
    }

    let response;
    async function tryURL(urlCandidate) {
      log.log(`Attempting to connect to ${urlCandidate}`);
      response = await CardDAVUtils.makeRequest(urlCandidate, requestParams);
      if (response.status == 207 && response.dom) {
        log.log(`${urlCandidate} ... success`);
      } else {
        log.log(
          `${urlCandidate} ... response was "${response.status} ${response.statusText}"`
        );
        response = null;
      }
    }

    if (url.pathname != "/") {
      // This might be the full URL of an address book.
      await tryURL(url.href);
      if (
        !response?.dom?.querySelector("resourcetype addressbook") &&
        !response?.dom?.querySelector("current-user-principal href")
      ) {
        response = null;
      }
    }
    if (!response || !response.dom) {
      // Auto-discovery using a magic URL.
      requestParams.body = `<?xml version="1.0" encoding="utf-8"?>
      <propfind xmlns="DAV:">
        <prop>
          <current-user-principal/>
        </prop>
      </propfind>`;
      await tryURL(`${url.origin}/.well-known/carddav`);
      // The request may have been successfull, returning a 207 status, but it
      // could still not contain any useful information.
      if (
        !response?.dom?.querySelector("resourcetype addressbook") &&
        !response?.dom?.querySelector("current-user-principal href")
      ) {
        response = null;
      }
    }
    if (!response) {
      // Auto-discovery at the root of the domain.
      await tryURL(`${url.origin}/`);
    }
    if (!response) {
      // We've run out of ideas.
      throw new Components.Exception(
        "Address book discovery failed",
        Cr.NS_ERROR_FAILURE
      );
    }

    if (!response.dom.querySelector("resourcetype addressbook")) {
      const userPrincipal = response.dom.querySelector(
        "current-user-principal href"
      );
      if (!userPrincipal) {
        // We've run out of ideas.
        throw new Components.Exception(
          "Address book discovery failed",
          Cr.NS_ERROR_FAILURE
        );
      }
      // Steps two and three of auto-discovery. If the entered URL did point
      // to an address book, we won't get here.
      url = new URL(userPrincipal.textContent, url);
      requestParams.body = `<?xml version="1.0" encoding="utf-8"?>
      <propfind xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
        <prop>
          <card:addressbook-home-set/>
        </prop>
      </propfind>`;
      await tryURL(url.href);

      url = new URL(
        response.dom.querySelector("addressbook-home-set href").textContent,
        url
      );
      requestParams.headers.Depth = 1;
      requestParams.body = `<?xml version="1.0" encoding="utf-8"?>
      <propfind xmlns="DAV:">
        <prop>
          <resourcetype/>
          <displayname/>
          <current-user-privilege-set/>
        </prop>
      </propfind>`;
      await tryURL(url.href);
    }

    // Find any directories in the response.

    const foundBooks = [];
    for (const r of response.dom.querySelectorAll("response")) {
      if (r.querySelector("status")?.textContent != "HTTP/1.1 200 OK") {
        continue;
      }
      if (!r.querySelector("resourcetype addressbook")) {
        continue;
      }

      // If the server provided ACL information, skip address books that we do
      // not have read privileges to.
      const privNode = r.querySelector("current-user-privilege-set");
      let isWritable = false;
      let isReadable = false;
      if (privNode) {
        const privs = Array.from(
          privNode.querySelectorAll("privilege > *")
        ).map(node => node.localName);

        isWritable = writePrivs.some(priv => privs.includes(priv));
        isReadable = readPrivs.some(priv => privs.includes(priv));

        if (!isWritable && !isReadable) {
          continue;
        }
      }

      url = new URL(r.querySelector("href").textContent, url);
      let name = r.querySelector("displayname")?.textContent;
      if (!name) {
        // The server didn't give a name, let's make one from the path.
        name = url.pathname.replace(/\/$/, "").split("/").slice(-1)[0];
      }
      if (!name) {
        // That didn't work either, use the hostname.
        name = url.hostname;
      }
      foundBooks.push({
        url,
        name,
        async create() {
          const dirPrefId = MailServices.ab.newAddressBook(
            this.name,
            null,
            Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE,
            null
          );
          const book = MailServices.ab.getDirectoryFromId(dirPrefId);
          book.setStringValue("carddav.url", this.url);

          if (!isWritable && isReadable) {
            book.setBoolValue("readOnly", true);
          }

          if (oAuth) {
            book.setStringValue("carddav.username", username);
          } else if (callbacks.authInfo?.username) {
            log.log(`Saving login info for ${callbacks.authInfo.username}`);
            book.setStringValue(
              "carddav.username",
              callbacks.authInfo.username
            );
            await callbacks.saveAuth();
          }

          const dir = lazy.CardDAVDirectory.forFile(book.fileName);
          // Pass the context to the created address book. This prevents asking
          // for a username/password again in the case that we didn't save it.
          // The user won't be prompted again until Thunderbird is restarted.
          dir._userContextId = userContextId;
          dir.fetchAllFromServer();

          return dir;
        },
      });
    }
    return foundBooks;
  },
};

/**
 * Passed to nsIChannel.notificationCallbacks in CardDAVDirectory.makeRequest.
 * This handles HTTP authentication, prompting the user if necessary. It also
 * ensures important headers are copied from one channel to another if a
 * redirection occurs.
 *
 * @implements {nsIInterfaceRequestor}
 * @implements {nsIAuthPrompt2}
 * @implements {nsIChannelEventSink}
 */
export class NotificationCallbacks {
  /**
   * @param {string}  [username] - Used to pre-fill any auth dialogs.
   * @param {string}  [password] - Used to pre-fill any auth dialogs.
   * @param {boolean} [forcePrompt] - Skips checking the password manager for
   *     a password, even if username is given. The user will be prompted.
   * @param {boolean} [storePasswordOverride] - If provided, override store
   *     password behavior.
   */
  constructor(username, password, forcePrompt, storePasswordOverride) {
    this.username = username;
    this.password = password;
    this.forcePrompt = forcePrompt;
    this.storePasswordOverride = storePasswordOverride;
  }
  QueryInterface = ChromeUtils.generateQI([
    "nsIInterfaceRequestor",
    "nsIAuthPrompt2",
    "nsIChannelEventSink",
  ]);
  getInterface = ChromeUtils.generateQI([
    "nsIAuthPrompt2",
    "nsIChannelEventSink",
  ]);
  promptAuth(channel, level, authInfo) {
    if (authInfo.flags & Ci.nsIAuthInformation.PREVIOUS_FAILED) {
      return false;
    }

    this.origin = channel.URI.prePath;
    this.authInfo = authInfo;

    if (!this.forcePrompt) {
      if (this.username && this.password) {
        authInfo.username = this.username;
        authInfo.password = this.password;
        this.shouldSaveAuth = this.storePasswordOverride ?? true;
        return true;
      }

      const logins = Services.logins.findLogins(channel.URI.prePath, null, "");
      for (const l of logins) {
        if (l.username == this.username) {
          authInfo.username = l.username;
          authInfo.password = l.password;
          return true;
        }
      }
    }

    authInfo.username = this.username;
    authInfo.password = this.password;

    let savePasswordLabel = null;
    const savePassword = {};
    if (Services.prefs.getBoolPref("signon.rememberSignons", true)) {
      savePasswordLabel = lazy.MsgAuthPrompt.l10n.formatValueSync(
        "remember-password-checkbox-label"
      );
      savePassword.value = true;
    }

    const returnValue = new lazy.MsgAuthPrompt().promptAuth(
      channel,
      level,
      authInfo,
      savePasswordLabel,
      savePassword
    );
    if (returnValue) {
      this.shouldSaveAuth = savePassword.value;
    }
    return returnValue;
  }
  async saveAuth() {
    if (this.shouldSaveAuth) {
      const newLoginInfo = Cc[
        "@mozilla.org/login-manager/loginInfo;1"
      ].createInstance(Ci.nsILoginInfo);
      newLoginInfo.init(
        this.origin,
        null,
        this.authInfo.realm,
        this.authInfo.username,
        this.authInfo.password,
        "",
        ""
      );
      try {
        await Services.logins.addLoginAsync(newLoginInfo);
      } catch (ex) {
        console.error(ex);
      }
    }
  }
  asyncOnChannelRedirect(oldChannel, newChannel, flags, callback) {
    /**
     * Copy the given header from the old channel to the new one, ignoring missing headers
     *
     * @param {string} header - The header to copy
     */
    function copyHeader(header) {
      try {
        const headerValue = oldChannel.getRequestHeader(header);
        if (headerValue) {
          newChannel.setRequestHeader(header, headerValue, false);
        }
      } catch (e) {
        if (e.result != Cr.NS_ERROR_NOT_AVAILABLE) {
          // The header could possibly not be available, ignore that
          // case but throw otherwise
          throw e;
        }
      }
    }

    // Make sure we can get/set headers on both channels.
    newChannel.QueryInterface(Ci.nsIHttpChannel);
    oldChannel.QueryInterface(Ci.nsIHttpChannel);

    // If any other header is used, it should be added here. We might want
    // to just copy all headers over to the new channel.
    copyHeader("Authorization");
    copyHeader("Depth");
    copyHeader("Originator");
    copyHeader("Recipient");
    copyHeader("If-None-Match");
    copyHeader("If-Match");

    newChannel.requestMethod = oldChannel.requestMethod;
    callback.onRedirectVerifyCallback(Cr.NS_OK);
  }
}
