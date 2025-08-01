/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

import { CommonUtils } from "resource://services-common/utils.sys.mjs";
import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { LineReader } from "resource:///modules/LineReader.sys.mjs";
import { NntpNewsGroup } from "resource:///modules/NntpNewsGroup.sys.mjs";

// Server response code.
const AUTH_ACCEPTED = 281;
const AUTH_PASSWORD_REQUIRED = 381;
const AUTH_REQUIRED = 480;
const AUTH_FAILED = 481;
const SERVICE_UNAVAILABLE = 502;
const HEADER_FOLLOWS = 221;
const NO_SUCH_NEWSGROUP = 411;
const NO_ARTICLE_WITH_THAT_NUMBER = 423;

/**
 * A structure to represent a response received from the server. A response can
 * be a single status line of a multi-line data block.
 *
 * @typedef {object} NntpResponse
 * @property {number} status - The status code of the response.
 * @property {string} statusText - The status line of the response excluding the
 *   status code.
 * @property {string} data - The part of a multi-line data block excluding the
 *   status line.
 */

const lazy = {};
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["netwerk/necko.ftl", "messenger/news.ftl"], true)
);
ChromeUtils.defineLazyGetter(lazy, "messengerBundle", () =>
  Services.strings.createBundle(
    "chrome://messenger/locale/messenger.properties"
  )
);

/**
 * A class to interact with NNTP server.
 */
export class NntpClient {
  /**
   * @param {nsINntpIncomingServer} server - The associated server instance.
   */
  constructor(server) {
    this._server = server;
    this._lineReader = new LineReader();

    this._reset();
    this._logger = console.createInstance({
      prefix: "mailnews.nntp",
      maxLogLevel: "Warn",
      maxLogLevelPref: "mailnews.nntp.loglevel",
    });
  }

  /**
   * @type {NntpAuthenticator} - An authentication helper.
   */
  get _authenticator() {
    if (!this._nntpAuthenticator) {
      var { NntpAuthenticator } = ChromeUtils.importESModule(
        "resource:///modules/MailAuthenticator.sys.mjs"
      );
      this._nntpAuthenticator = new NntpAuthenticator(this._server);
    }
    return this._nntpAuthenticator;
  }

  /**
   * Reset some internal states to be safely reused.
   */
  _reset() {
    this.onOpen = () => {};
    this.onError = () => {};
    this.onData = () => {};
    this.onDone = () => {};

    this.runningUri = null;
    this.urlListener = null;
    this._msgWindow = null;
    this._newsFolder = null;
    this._nextAction = null;
    this._currentAction = null;
    this._messageId = null;
    this._articleNumber = null;
  }

  /**
   * Initiate a connection to the server
   */
  connect() {
    this._done = false;
    if (this._socket?.readyState == "open") {
      // Reuse the connection.
      this.onOpen();
    } else {
      // Start a new connection.
      this._authenticated = false;
      const hostname = this._server.hostName.toLowerCase();
      const useSecureTransport = this._server.isSecure;
      this._logger.debug(
        `Connecting to ${useSecureTransport ? "snews" : "news"}://${hostname}:${
          this._server.port
        }`
      );
      this._socket = new TCPSocket(hostname, this._server.port, {
        binaryType: "arraybuffer",
        useSecureTransport,
      });
      this._socket.onopen = this._onOpen;
      this._socket.onerror = this._onError;
      this._showNetworkStatus(Ci.nsISocketTransport.STATUS_CONNECTING_TO);
    }
  }

  /**
   * Construct an nsIMsgMailNewsUrl instance, setup urlListener to notify when
   * the current request is finished.
   *
   * @param {nsIUrlListener} urlListener - Callback for the request.
   * @param {nsIMsgWindow} msgWindow - The associated msg window.
   * @param {nsIMsgMailNewsUrl} [runningUri] - The url to run, if provided.
   * @returns {nsIMsgMailNewsUrl}
   */
  startRunningUrl(urlListener, msgWindow, runningUri) {
    this.urlListener = urlListener;
    this._msgWindow = msgWindow;
    this.runningUri = runningUri;
    if (!this.runningUri) {
      this.runningUri = Services.io
        .newURI(`news://${this._server.hostName}:${this._server.port}`)
        .QueryInterface(Ci.nsIMsgMailNewsUrl);
    }
    if (msgWindow) {
      this.runningUri.msgWindow = msgWindow;
    }
    this.urlListener?.OnStartRunningUrl(this.runningUri, Cr.NS_OK);
    this.runningUri.SetUrlState(true, Cr.NS_OK);
    return this.runningUri;
  }

  /**
   * The open event handler.
   */
  _onOpen = () => {
    this._logger.debug("Connected");
    const timeout = this._server.connectionTimeout;
    if (timeout > 0) {
      this._socket.transport.setTimeout(
        Ci.nsISocketTransport.TIMEOUT_READ_WRITE,
        timeout
      );
    }
    this._socket.ondata = this._onData;
    this._socket.onclose = this._onClose;
    this._inReadingMode = false;
    this._currentGroupName = null;
    this._nextAction = ({ status }) => {
      if ([200, 201].includes(status)) {
        this._nextAction = null;
        this.onOpen();
      } else {
        this.quit(Cr.NS_ERROR_FAILURE);
      }
    };
    this._showNetworkStatus(Ci.nsISocketTransport.STATUS_CONNECTED_TO);
  };

  /**
   * The data event handler.
   *
   * @param {TCPSocketEvent} event - The data event.
   */
  _onData = event => {
    const stringPayload = CommonUtils.arrayBufferToByteString(
      new Uint8Array(event.data)
    );
    this._logger.debug(`S: ${stringPayload}`);

    const res = this._parse(stringPayload);
    switch (res.status) {
      case AUTH_REQUIRED:
        this._currentGroupName = null;
        this._actionAuthUser();
        return;
      case SERVICE_UNAVAILABLE:
        this._actionError(res.status, res.statusText);
        return;
      case NO_SUCH_NEWSGROUP:
        this._updateStatus("no-such-newsgroup", {
          newsgroup: this._newsFolder.localizedName,
        });
        // Close the connection without any further error message.
        this._actionDone(Cr.NS_ERROR_FAILURE);
        return;
      case NO_ARTICLE_WITH_THAT_NUMBER:
        if (this._nextAction == this._actionHeadResponse) {
          // This appears to be a response from a HEAD request. Do not regard
          // this as an error, the article will just be skipped.
          break;
        }
      // Otherwise fallthrough to default error handling.
      default:
        if (
          res.status != AUTH_FAILED &&
          res.status >= 400 &&
          res.status < 500
        ) {
          if (this._messageId || this._articleNumber) {
            this._logger.error(
              `Got an error, the server said: ${res.status} ${res.statusText}`
            );
            let uri = `about:newserror?r=${res.statusText}`;

            if (this._messageId) {
              uri += `&m=${encodeURIComponent(this._messageId)}`;
            } else {
              const msgId = this._newsFolder?.getMessageIdForKey(
                this._articleNumber
              );
              if (msgId) {
                uri += `&m=${encodeURIComponent(msgId)}`;
              }
              uri += `&k=${this._articleNumber}`;
            }
            if (this._newsFolder) {
              uri += `&f=${this._newsFolder.URI}`;
            }
            // Store the uri to display. The registered uriListener will get
            // notified when we stop running the uri, and can act on this data.
            this.runningUri.seeOtherURI = uri;
            // Do not display an additional alert dialog.
            this._actionDone(Cr.NS_ERROR_FAILURE);
          } else {
            this._actionError(res.status, res.statusText);
          }
          return;
        }
    }

    try {
      this._nextAction?.(res);
    } catch (e) {
      this._logger.error(`Failed to process server response ${res}.`, e);
      this._actionDone(Cr.NS_ERROR_FAILURE);
    }
  };

  /**
   * The error event handler.
   *
   * @param {TCPSocketErrorEvent} event - The error event.
   */
  _onError = event => {
    if (event.errorCode == Cr.NS_ERROR_NET_TIMEOUT && !this.runningUri) {
      // This should be the scheduled timeout, just close the connection
      // without indicating any error.
      this._logger.debug("Expected timeout.");
      this.quit();
      return;
    }

    this._logger.error(event, event.name, event.message, event.errorCode);
    let errorName;
    let uri;
    switch (event.errorCode) {
      case Cr.NS_ERROR_UNKNOWN_HOST:
      case Cr.NS_ERROR_UNKNOWN_PROXY_HOST:
        errorName = "unknownHostError";
        uri = "about:neterror?e=dnsNotFound";
        break;
      case Cr.NS_ERROR_CONNECTION_REFUSED:
        errorName = "connectionRefusedError";
        uri = "about:neterror?e=connectionFailure";
        break;
      case Cr.NS_ERROR_PROXY_CONNECTION_REFUSED:
        errorName = "connectionRefusedError";
        uri = "about:neterror?e=proxyConnectFailure";
        break;
      case Cr.NS_ERROR_NET_TIMEOUT:
        errorName = "netTimeoutError";
        uri = "about:neterror?e=netTimeout";
        break;
      case Cr.NS_ERROR_NET_RESET:
        errorName = "netResetError";
        uri = "about:neterror?e=netReset";
        break;
      case Cr.NS_ERROR_NET_INTERRUPT:
        errorName = "netInterruptError";
        uri = "about:neterror?e=netInterrupt";
        break;
    }
    if (errorName && uri) {
      // If there's a message window on the URI, then we should alert the user.
      // Otherwise (i.e. if the getter for `msgWindow` raised
      // `NS_ERROR_NULL_POINTER`), this is a background operation and we should
      // tell the mail session to only call the listeners but not alert.
      let silent = false;
      try {
        this.runningUri.msgWindow;
        silent = false;
      } catch (ex) {
        if (
          !(ex instanceof Ci.nsIException) &&
          ex.result != Cr.NS_ERROR_NULL_POINTER
        ) {
          throw ex;
        }
      }

      MailServices.mailSession.alertUser(
        lazy.messengerBundle.formatStringFromName(errorName, [
          this._server.hostName,
        ]),
        this.runningUri,
        silent
      );

      // If we were going to display an article, instead show an error page.
      if (this.runningUri) {
        this.runningUri.seeOtherURI = uri;
      }
    }

    this._msgWindow?.statusFeedback?.showStatusString("");
    this.quit(event.errorCode);
  };

  /**
   * The close event handler.
   */
  _onClose = () => {
    this._logger.debug("Connection closed.");
  };

  /**
   * Parse the server response.
   *
   * @param {string} str - Response received from the server.
   * @returns {NntpResponse}
   */
  _parse(str) {
    if (this._lineReader.receivingMultiLineResponse) {
      // When receiving multi-line response, no parsing should happen.
      return { data: str };
    }
    const matches = /^(\d{3}) (.+)\r\n([^]*)/.exec(str);
    if (matches) {
      const [, status, statusText, data] = matches;
      return { status: Number(status), statusText, data };
    }
    return { data: str };
  }

  /**
   * Send a command to the socket.
   *
   * @param {string} str - The command string to send.
   * @param {boolean} [suppressLogging=false] - Whether to suppress logging the str.
   */
  _sendCommand(str, suppressLogging) {
    if (this._socket.readyState != "open") {
      if (str != "QUIT") {
        this._logger.warn(
          `Failed to send "${str}" because socket state is ${this._socket.readyState}`
        );
      }
      return;
    }
    if (suppressLogging && AppConstants.MOZ_UPDATE_CHANNEL != "default") {
      this._logger.debug(
        "C: Logging suppressed (it probably contained auth information)"
      );
    } else {
      // Do not suppress for non-release builds, so that debugging auth problems
      // is easier.
      this._logger.debug(`C: ${str}`);
    }
    this.send(str + "\r\n");
  }

  /**
   * Send a string to the socket.
   *
   * @param {string} str - The string to send.
   */
  send(str) {
    this._socket.send(CommonUtils.byteStringToArrayBuffer(str).buffer);
  }

  /**
   * Send a LIST or NEWGROUPS command to get groups in the current server.
   *
   * @param {boolean} getOnlyNew - List only new groups.
   */
  getListOfGroups(getOnlyNew) {
    if (!getOnlyNew) {
      this._actionModeReader(this._actionList);
    } else {
      this._actionModeReader(this._actionNewgroups);
    }
    this.urlListener = this._server.QueryInterface(Ci.nsIUrlListener);
  }

  /**
   * Get new articles.
   *
   * @param {string} groupName - The group to get new articles.
   * @param {boolean} getOld - Get old articles as well.
   */
  getNewNews(groupName, getOld) {
    this._currentGroupName = null;
    this._newsFolder = this._getNewsFolder(groupName);
    this._newsGroup = new NntpNewsGroup(this._server, this._newsFolder);
    this._newsGroup.getOldMessages = getOld;
    this._nextGroupName = this._newsFolder.rawName;
    this.runningUri.updatingFolder = true;
    this._firstGroupCommand = this._actionXOver;
    this._actionModeReader(this._actionGroup);
  }

  /**
   * Get a single article by group name and article number.
   *
   * @param {string} groupName - The group name.
   * @param {integer} articleNumber - The article number.
   */
  getArticleByArticleNumber(groupName, articleNumber) {
    this._newsFolder = this._server.rootFolder.getChildNamed(groupName);
    this._nextGroupName = this._getNextGroupName(groupName);
    this._articleNumber = articleNumber;
    this._messageId = "";
    this._firstGroupCommand = this._actionArticle;
    this._actionModeReader(this._actionGroup);
  }

  /**
   * Get a single article by the message id.
   *
   * @param {string} messageId - The message id.
   */
  getArticleByMessageId(messageId) {
    this._messageId = `<${messageId}>`;
    this._articleNumber = 0;
    this._actionModeReader(this._actionArticle);
  }

  /**
   * Send a `Control: cancel <msg-id>` message to cancel an article, not every
   * server supports it, see rfc5537.
   *
   * @param {string} groupName - The group name.
   */
  cancelArticle(groupName) {
    this._nextGroupName = this._getNextGroupName(groupName);
    this._firstGroupCommand = this.post;
    this._actionModeReader(this._actionGroup);
  }

  /**
   * Send a `XPAT <header> <message-id> <pattern>` message, not every server
   * supports it, see rfc2980.
   *
   * @param {string} groupName - The group name.
   * @param {string[]} xpatLines - An array of xpat lines to send.
   */
  search(groupName, xpatLines) {
    this._nextGroupName = this._getNextGroupName(groupName);
    this._xpatLines = xpatLines;
    this._firstGroupCommand = this._actionXPat;
    this._actionModeReader(this._actionGroup);
  }

  /**
   * Load a news uri directly, see rfc5538 about supported news uri.
   *
   * @param {string} uri - The news uri to load.
   * @param {nsIMsgWindow} msgWindow - The associated msg window.
   * @param {nsIStreamListener} streamListener - The listener for the request.
   */
  loadNewsUrl(uri, msgWindow, streamListener) {
    this._logger.debug(`Loading ${uri}`);
    const url = new URL(uri);
    const path = url.pathname.slice(1);
    let action;
    if (path == "*") {
      action = () => this.getListOfGroups();
    } else if (path.includes("@")) {
      action = () => this.getArticleByMessageId(path);
    } else {
      this._newsFolder = this._getNewsFolder(path);
      this._newsGroup = new NntpNewsGroup(this._server, this._newsFolder);
      this._nextGroupName = this._newsFolder.rawName;
      action = () => this._actionModeReader(this._actionGroup);
    }
    if (!action) {
      return;
    }
    this._msgWindow = msgWindow;
    const pipe = Cc["@mozilla.org/pipe;1"].createInstance(Ci.nsIPipe);
    pipe.init(true, true, 0, 0);
    const inputStream = pipe.inputStream;
    const outputStream = pipe.outputStream;
    this.onOpen = () => {
      streamListener.onStartRequest(null, Cr.NS_OK);
      action();
    };
    this.onData = data => {
      outputStream.write(data, data.length);
      streamListener.onDataAvailable(null, inputStream, 0, data.length);
    };
    this.onDone = status => {
      streamListener.onStopRequest(null, status);
    };
  }

  /**
   * Send LISTGROUP request to the server.
   *
   * @param {string} groupName - The group to request.
   */
  listgroup(groupName) {
    this._actionModeReader(() => {
      this._nextAction = this._actionListgroupResponse;
      this._sendCommand(`LISTGROUP ${groupName}`);
    });
  }

  /**
   * Send `POST` request to the server.
   */
  post() {
    const action = () => {
      this._nextAction = this._actionHandlePost;
      this._sendCommand("POST");
    };
    this._currentAction = action;
    if (this._server.pushAuth && !this._authenticated) {
      this._actionAuthUser();
    } else {
      action();
    }
  }

  /**
   * Send `QUIT` request to the server.
   */
  quit(status = Cr.NS_OK) {
    this._sendCommand("QUIT");
    this._nextAction = this.close;
    this.close();
    this._actionDone(status);
  }

  /**
   * Close the socket.
   */
  close() {
    this._socket.close();
  }

  /**
   * Get the news folder corresponding to a group name.
   *
   * @param {string} groupName - The group name.
   * @returns {nsIMsgNewsFolder}
   */
  _getNewsFolder(groupName) {
    return this._server.rootFolder
      .getChildNamed(groupName)
      .QueryInterface(Ci.nsIMsgNewsFolder);
  }

  /**
   * Given a UTF-8 group name, return the underlying group name used by the server.
   *
   * @param {string} groupName - The UTF-8 group name.
   * @returns {BinaryString} - The group name that can be sent to the server.
   */
  _getNextGroupName(groupName) {
    return this._getNewsFolder(groupName).rawName;
  }

  /**
   * Send `MODE READER` request to the server.
   */
  _actionModeReader(nextAction) {
    if (this._inReadingMode) {
      nextAction();
    } else {
      this._currentAction = () => {
        this._inReadingMode = false;
        this._actionModeReader(nextAction);
      };
      this._sendCommand("MODE READER");
      this._inReadingMode = true;
      this._nextAction = () => {
        if (this._server.pushAuth && !this._authenticated) {
          this._currentAction = nextAction;
          this._actionAuthUser();
        } else {
          nextAction();
        }
      };
    }
  }

  /**
   * Send `LIST` request to the server.
   */
  _actionList = () => {
    this._sendCommand("LIST");
    this._currentAction = this._actionList;
    this._nextAction = this._actionReadData;
  };

  /**
   * Send `NEWGROUPS` request to the server.
   *
   * @see rfc3977#section-7.3
   */
  _actionNewgroups = () => {
    const days = Services.prefs.getIntPref("news.newgroups_for_num_days", 180);
    const dateTime = new Date(Date.now() - 86400000 * days)
      .toISOString()
      .replace(
        /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*/,
        "$1$2$3 $4$5$6"
      );
    this._sendCommand("NEWGROUPS " + dateTime + " GMT");
    this._currentAction = this._actionNewgroups;
    this._nextAction = this._actionReadData;
  };

  /**
   * Send `GROUP` request to the server.
   */
  _actionGroup = () => {
    this._firstGroupCommand = this._firstGroupCommand || this._actionXOver;
    if (this._nextGroupName == this._currentGroupName) {
      this._firstGroupCommand();
    } else {
      this._sendCommand(`GROUP ${this._nextGroupName}`);
      this._currentAction = this._actionGroup;
      this._currentGroupName = this._nextGroupName;
      this._nextAction = this._actionGroupResponse;
    }
  };

  /**
   * Handle GROUP response.
   *
   * @param {NntpResponse} res - GROUP response received from the server.
   */
  _actionGroupResponse = res => {
    this._firstGroupCommand(res);
  };

  /**
   * Consume the status line of LISTGROUP response.
   */
  _actionListgroupResponse = res => {
    this._nextAction = this._actionListgroupDataResponse;
    if (res.data) {
      this._actionListgroupDataResponse(res);
    }
  };

  /**
   * Consume the multi-line data of LISTGROUP response.
   *
   * @param {NntpResponse} res - The server response.
   */
  _actionListgroupDataResponse = ({ data }) => {
    this._lineReader.read(
      data,
      line => {
        this.onData(line);
      },
      () => {
        this._actionDone();
      }
    );
  };

  /**
   * Send `XOVER` request to the server.
   */
  _actionXOver = res => {
    const [count, low, high] = res.statusText.split(" ");
    this._newsFolder.updateSummaryFromNNTPInfo(low, high, count);
    const [start, end] = this._newsGroup.getArticlesRangeToFetch(
      this._msgWindow,
      Number(low),
      Number(high)
    );
    if (start && end && end >= start) {
      this._updateStatus("new-newsgroup-headers", {
        count: end - start + 1,
        newsgroup: this._newsFolder.localizedName,
      });
      this._newsGroup.addKnownArticles(start, end);
      this._startArticle = start;
      this._endArticle = end;
      this._nextAction = this._actionXOverResponse;
      this._sendCommand(`XOVER ${start}-${end}`);
    } else {
      this._updateStatus("no-new-messages", {
        newsgroup: this._newsFolder.localizedName,
      });
      this._actionDone();
    }
  };

  /**
   * A transient action to consume the status line of XOVER response.
   *
   * @param {NntpResponse} res - XOVER response received from the server.
   */
  _actionXOverResponse(res) {
    if (res.status == 224) {
      this._nextAction = this._actionReadXOver;
      this._actionReadXOver(res);
    } else {
      this._logger.debug(
        "XOVER not supported by the server. Falling back to using HEAD."
      );
      this._actionHead();
    }
  }

  /**
   * Handle XOVER response.
   *
   * @param {NntpResponse} res - XOVER response received from the server.
   */
  _actionReadXOver({ data }) {
    this._lineReader.read(
      data,
      line => {
        this._newsGroup.processXOverLine(line);
      },
      () => {
        // Fetch extra headers used by filters, but not returned in XOVER response.
        this._xhdrFields = this._newsGroup.getXHdrFields();
        this._actionXHdr();
      }
    );
  }

  /**
   * Send `XHDR` request to the server.
   */
  _actionXHdr = () => {
    this._curXHdrHeader = this._xhdrFields.shift();
    if (this._curXHdrHeader) {
      this._nextAction = this._actionXHdrResponse;
      this._sendCommand(
        `XHDR ${this._curXHdrHeader} ${this._startArticle}-${this._endArticle}`
      );
    } else {
      this._newsGroup.finishProcessingXOver();
      this._actionDone();
    }
  };

  /**
   * A transient action to consume the status line of XHDR response.
   *
   * @param {NntpResponse} res - XHDR response received from the server.
   */
  _actionXHdrResponse(res) {
    if (res.status == HEADER_FOLLOWS) {
      this._nextAction = this._actionReadXHdr;
      this._actionReadXHdr(res);
    } else {
      this._logger.debug(
        "XHDR not supported by the server. Falling back to using HEAD."
      );
      this._actionHead();
    }
  }

  /**
   * Handle XHDR response.
   *
   * @param {NntpResponse} res - XOVER response received from the server.
   */
  _actionReadXHdr({ data }) {
    this._lineReader.read(
      data,
      line => {
        this._newsGroup.processXHdrLine(this._curXHdrHeader, line);
      },
      this._actionXHdr
    );
  }

  /**
   * Send `HEAD` request to the server.
   */
  _actionHead = () => {
    if (this._startArticle <= this._endArticle) {
      this._nextAction = this._actionHeadResponse;
      this._sendCommand(`HEAD ${this._startArticle}`);
    } else {
      this._newsGroup.finishProcessingXOver();
      this._actionDone();
    }
  };

  /**
   * A transient action to consume the status line of HEAD response.
   *
   * @param {NntpResponse} res - HEAD response received from the server.
   */
  _actionHeadResponse(res) {
    if (res.status == HEADER_FOLLOWS) {
      this._newsGroup.initHdr(this._startArticle);
      this._startArticle++;
      this._nextAction = this._actionReadHead;
      this._actionReadHead(res);
    } else {
      // The article is no longer available on the server, just skip it.
      this._startArticle++;
      this._actionHead(res);
    }
  }

  /**
   * Handle HEAD response.
   *
   * @param {NntpResponse} res - XOVER response received from the server.
   */
  _actionReadHead({ data }) {
    this._lineReader.read(
      data,
      line => {
        this._newsGroup.processHeadLine(line);
      },
      () => {
        this._newsGroup.initHdr(-1);
        this._actionHead();
      }
    );
  }

  /**
   * Send `ARTICLE` request to the server.
   *
   * @see {@link https://www.rfc-editor.org/rfc/rfc3977#section-6.2.1|RFC 3977 §6.2.1}
   */
  _actionArticle = () => {
    this._sendCommand(`ARTICLE ${this._articleNumber || this._messageId}`);
    this._nextAction = this._actionArticleResponse;
  };

  /**
   * Handle `ARTICLE` response.
   *
   * @param {NntpResponse} res - ARTICLE response received from the server.
   */
  _actionArticleResponse = ({ data }) => {
    const lineSeparator = AppConstants.platform == "win" ? "\r\n" : "\n";

    let article = "";
    this._lineReader.read(
      data,
      line => {
        article += line.slice(0, -2) + lineSeparator;
        this.onData(line);
      },
      () => {
        this._newsFolder?.notifyArticleDownloaded(this._articleNumber, article);
        this._actionDone();
      }
    );
  };

  /**
   * Handle multi-line data blocks response, e.g. ARTICLE/LIST response. Emit
   * each line through onData.
   *
   * @param {NntpResponse} res - Response received from the server.
   */
  _actionReadData({ data }) {
    this._lineReader.read(data, this.onData, this._actionDone);
  }

  /**
   * Handle POST response.
   *
   * @param {NntpResponse} res - POST response received from the server.
   */
  _actionHandlePost({ status, statusText }) {
    if (status == 340) {
      this.onReadyToPost();
    } else if (status == 240) {
      this._actionDone();
    } else {
      this._actionError(status, statusText);
    }
  }

  /**
   * Send `AUTHINFO user <name>` to the server.
   *
   * @param {boolean} [forcePrompt=false] - Whether to force showing an auth prompt.
   */
  _actionAuthUser(forcePrompt = false) {
    if (!this._newsFolder) {
      this._newsFolder = this._server.rootFolder.QueryInterface(
        Ci.nsIMsgNewsFolder
      );
    }
    if (!this._newsFolder.groupUsername) {
      const gotPassword = this._newsFolder.getAuthenticationCredentials(
        this._msgWindow,
        true,
        forcePrompt
      );
      if (!gotPassword) {
        this._actionDone(Cr.NS_ERROR_ABORT);
        return;
      }
    }
    this._sendCommand(`AUTHINFO user ${this._newsFolder.groupUsername}`, true);
    this._nextAction = this._actionAuthResult;
    this._authenticator.username = this._newsFolder.groupUsername;
  }

  /**
   * Send `AUTHINFO pass <password>` to the server.
   */
  _actionAuthPassword() {
    this._sendCommand(`AUTHINFO pass ${this._newsFolder.groupPassword}`, true);
    this._nextAction = this._actionAuthResult;
  }

  /**
   * Decide the next step according to the auth response.
   *
   * @param {NntpResponse} res - Auth response received from the server.
   */
  _actionAuthResult({ status }) {
    switch (status) {
      case AUTH_ACCEPTED:
        this._authenticated = true;
        this._currentAction?.();
        return;
      case AUTH_PASSWORD_REQUIRED:
        this._actionAuthPassword();
        return;
      case AUTH_FAILED: {
        const action = this._authenticator.promptAuthFailed(this._msgWindow);
        if (action == 1) {
          // Cancel button pressed.
          this._actionDone();
          return;
        }
        if (action == 2) {
          // 'New password' button pressed.
          this._newsFolder.forgetAuthenticationCredentials();
        }
        // Retry.
        this._actionAuthUser();
      }
    }
  }

  /**
   * Send `XPAT <header> <message-id> <pattern>` to the server.
   */
  _actionXPat = () => {
    const xptLine = this._xpatLines.shift();
    if (!xptLine) {
      this._actionDone();
      return;
    }
    this._sendCommand(xptLine);
    this._nextAction = this._actionXPatResponse;
  };

  /**
   * Handle XPAT response.
   *
   * @param {NntpResponse} res - XPAT response received from the server.
   */
  _actionXPatResponse({ status, statusText, data }) {
    if (status && status != HEADER_FOLLOWS) {
      this._actionError(status, statusText);
      return;
    }
    this._lineReader.read(data, this.onData, this._actionXPat);
  }

  /**
   * Show network status in the status bar.
   *
   * @param {number} status - See NS_NET_STATUS_* in nsISocketTransport.idl.
   */
  _showNetworkStatus(status) {
    const NS_NET_STATUS_RESOLVING_HOST = 0x4b0003;
    const NS_NET_STATUS_RESOLVED_HOST = 0x4b000b;
    const NS_NET_STATUS_CONNECTING_TO = 0x4b0007;
    const NS_NET_STATUS_CONNECTED_TO = 0x4b0004;
    const NS_NET_STATUS_TLS_HANDSHAKE_STARTING = 0x4b000c;
    const NS_NET_STATUS_TLS_HANDSHAKE_ENDED = 0x4b000d;
    const NS_NET_STATUS_SENDING_TO = 0x4b0005;
    const NS_NET_STATUS_WAITING_FOR = 0x4b000a;
    const NS_NET_STATUS_RECEIVING_FROM = 0x4b0006;
    const NS_NET_STATUS_READING = 0x4b0008;
    const NS_NET_STATUS_WRITING = 0x4b0009;

    const statusToId = netStatus => {
      switch (netStatus) {
        case NS_NET_STATUS_WRITING:
          return "network-connection-status-wrote";
        case NS_NET_STATUS_READING:
          return "network-connection-status-read";
        case NS_NET_STATUS_RESOLVING_HOST:
          return "network-connection-status-looking-up";
        case NS_NET_STATUS_RESOLVED_HOST:
          return "network-connection-status-looked-up";
        case NS_NET_STATUS_CONNECTING_TO:
          return "network-connection-status-connecting";
        case NS_NET_STATUS_CONNECTED_TO:
          return "network-connection-status-connected";
        case NS_NET_STATUS_TLS_HANDSHAKE_STARTING:
          return "network-connection-status-tls-handshake";
        case NS_NET_STATUS_TLS_HANDSHAKE_ENDED:
          return "network-connection-status-tls-handshake-finished";
        case NS_NET_STATUS_SENDING_TO:
          return "network-connection-status-sending-request";
        case NS_NET_STATUS_WAITING_FOR:
          return "network-connection-status-waiting";
        case NS_NET_STATUS_RECEIVING_FROM:
          return "network-connection-status-transferring-data";
        default:
          throw new Error(`Unexpected net status: ${netStatus}`);
      }
    };
    const l10nId = statusToId(status);
    const statusMessage = lazy.l10n.formatValueSync(l10nId, {
      host: this._server.hostName,
    });
    this._msgWindow?.statusFeedback?.showStatusString(statusMessage);
  }

  /**
   * Show an error prompt.
   *
   * @param {number} status - The response code returned by the server.
   * @param {string} statusText - The meaning of the response as returned by
   *   the server.
   */
  _actionError(status, statusText) {
    this._logger.error(
      `Got an error, the server said: ${status} ${statusText}`
    );
    if (this._msgWindow) {
      Services.prompt.alert(
        this._msgWindow.domWindow,
        null,
        lazy.messengerBundle.formatStringFromName("statusMessage", [
          this._server.prettyName,
          `${statusText}`,
        ])
      );
    }
    this._actionDone(Cr.NS_ERROR_FAILURE);
  }

  /**
   * Close the connection and do necessary cleanup.
   */
  _actionDone = (status = Cr.NS_OK) => {
    if (this._done) {
      return;
    }
    this._done = true;
    this._logger.debug(`Done with status=${status}`);
    this.onDone(status);
    this._newsGroup?.cleanUp();
    this._newsFolder?.OnStopRunningUrl?.(this.runningUri, status);
    this.urlListener?.OnStopRunningUrl(this.runningUri, status);
    this.runningUri?.SetUrlState(false, status);
    this._reset();
    this.onIdle?.();
  };

  /**
   * Show a status message in the status bar.
   *
   * @param {string} statusName - A string name in news.ftl.
   * @param {object} params - Params to format the string.
   */
  _updateStatus(statusName, params) {
    this._msgWindow?.statusFeedback?.showStatusString(
      lazy.messengerBundle.formatStringFromName("statusMessage", [
        this._server.prettyName,
        lazy.l10n.formatValueSync(statusName, params),
      ])
    );
  }
}
