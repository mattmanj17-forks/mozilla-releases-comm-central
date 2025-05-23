/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ts=2 et sw=2 tw=80 filetype=javascript: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/*
 * This module implements the front end behavior for AeroPeek. Starting in
 * Windows Vista, the taskbar began showing live thumbnail previews of windows
 * when the user hovered over the window icon in the taskbar. Starting with
 * Windows 7, the taskbar allows an application to expose its tabbed interface
 * in the taskbar by showing thumbnail previews rather than the default window
 * preview. Additionally, when a user hovers over a thumbnail (tab or window),
 * they are shown a live preview of the window (or tab + its containing window).
 *
 * In Windows 7, a title, icon, close button and optional toolbar are shown for
 * each preview. This feature does not make use of the toolbar. For window
 * previews, the title is the window title and the icon the window icon. For
 * tab previews, the title is the page title and the page's favicon. In both
 * cases, the close button "does the right thing."
 *
 * The primary objects behind this feature are nsITaskbarTabPreview and
 * nsITaskbarPreviewController. Each preview has a controller. The controller
 * responds to the user's interactions on the taskbar and provides the required
 * data to the preview for determining the size of the tab and thumbnail. The
 * PreviewController class implements this interface. The preview will request
 * the controller to provide a thumbnail or preview when the user interacts with
 * the taskbar. To reduce the overhead of drawing the tab area, the controller
 * implementation caches the tab's contents in a <canvas> element. If no
 * previews or thumbnails have been requested for some time, the controller will
 * discard its cached tab contents.
 *
 * Screen real estate is limited so when there are too many thumbnails to fit
 * on the screen, the taskbar stops displaying thumbnails and instead displays
 * just the title, icon and close button in a similar fashion to previous
 * versions of the taskbar. If there are still too many previews to fit on the
 * screen, the taskbar resorts to a scroll up and scroll down button pair to let
 * the user scroll through the list of tabs. Since this is undoubtedly
 * inconvenient for users with many tabs, the AeroPeek objects turns off all of
 * the tab previews. This tells the taskbar to revert to one preview per window.
 * If the number of tabs falls below this magic threshold, the preview-per-tab
 * behavior returns. There is no reliable way to determine when the scroll
 * buttons appear on the taskbar, so a magic pref-controlled number determines
 * when this threshold has been crossed.
 */
var EXPORTED_SYMBOLS = ["AeroPeek"];


const {NetUtil} = ChromeUtils.import("resource://gre/modules/NetUtil.jsm");
const {PlacesUtils} = ChromeUtils.import("resource://gre/modules/PlacesUtils.jsm");
const {PrivateBrowsingUtils} = ChromeUtils.import("resource://gre/modules/PrivateBrowsingUtils.jsm");
const {XPCOMUtils} = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

// Pref to enable/disable preview-per-tab.
const TOGGLE_PREF_NAME = "browser.taskbar.previews.enable";
// Pref to determine the magic auto-disable threshold.
const DISABLE_THRESHOLD_PREF_NAME = "browser.taskbar.previews.max";
// Pref to control the time in seconds that tab contents live in the cache.
const CACHE_EXPIRATION_TIME_PREF_NAME = "browser.taskbar.previews.cachetime";

const WINTASKBAR_CONTRACTID = "@mozilla.org/windows-taskbar;1";

////////////////////////////////////////////////////////////////////////////////
//// Various utility properties.
XPCOMUtils.defineLazyServiceGetter(this, "imgTools",
                                   "@mozilla.org/image/tools;1",
                                   "imgITools");
ChromeUtils.defineModuleGetter(this, "PageThumbs",
                               "resource://gre/modules/PageThumbs.jsm");

// nsIURI -> imgIContainer
function _imageFromURI(uri, privateMode, callback) {
  let channel = NetUtil.newChannel({
    uri: uri,
    loadUsingSystemPrincipal: true,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_INTERNAL_IMAGE
  });

  try {
    channel.QueryInterface(Ci.nsIPrivateBrowsingChannel);
    channel.setPrivate(privateMode);
  } catch (e) {
    // Ignore channels which do not support nsIPrivateBrowsingChannel.
  }
  NetUtil.asyncFetch(channel, function(inputStream, resultCode) {
    if (!Components.isSuccessCode(resultCode)) {
      return;
    }

    const decodeCallback = {
      onImageReady(image, status) {
        if (!image) {
          // We failed, so use the default favicon (only if this wasn't the
          // default favicon).
          let defaultURI = PlacesUtils.favicons.defaultFavicon;
          if (!defaultURI.equals(uri)) {
            _imageFromURI(defaultURI, privateMode, callback);
            return;
          }
        }

        callback(image);
      }
    };

    try {
      let threadManager = Cc["@mozilla.org/thread-manager;1"].getService();
      imgTools.decodeImageAsync(inputStream, channel.contentType,
                                decodeCallback, threadManager.currentThread);
    } catch (e) {
      // We failed, so use the default favicon (only if this wasn't the default
      // favicon).
      let defaultURI = PlacesUtils.favicons.defaultFavicon;
      if (!defaultURI.equals(uri))
        _imageFromURI(defaultURI, privateMode, callback);
    }
  });
}

// string? -> imgIContainer
function getFaviconAsImage(iconurl, privateMode, callback) {
  if (iconurl) {
    _imageFromURI(NetUtil.newURI(iconurl), privateMode, callback);
  } else {
    _imageFromURI(PlacesUtils.favicons.defaultFavicon, privateMode, callback);
  }
}

////////////////////////////////////////////////////////////////////////////////
//// PreviewController

/*
 * This class manages the behavior of thumbnails and previews. It has the following
 * responsibilities:
 * 1) Responding to requests from Windows taskbar for a thumbnail or window
 *    preview.
 * 2) Listens for dom events that result in a thumbnail or window preview needing
 *    to be refreshed and communicates this to the taskbar.
 * 3) Handles querying and returning to the taskbar new thumbnail or window
 *    preview images through PageThumbs.
 *
 * @param win
 *        The TabWindow (see below) that owns the preview that this controls.
 * @param tab
 *        The <tab> that this preview is associated with.
 */
function PreviewController(win, tab) {
  this.win = win;
  this.tab = tab;
  this.linkedBrowser = tab.linkedBrowser;
  this.preview = this.win.createTabPreview(this);

  this.tab.addEventListener("TabAttrModified", this);

  XPCOMUtils.defineLazyGetter(this, "canvasPreview", function () {
    let canvas = PageThumbs.createCanvas();
    canvas.mozOpaque = true;
    return canvas;
  });
}

PreviewController.prototype = {
  QueryInterface: ChromeUtils.generateQI([Ci.nsITaskbarPreviewController]),

  _cachedWidth: 0,
  _cachedHeight: 0,

  destroy: function () {
    this.tab.removeEventListener("TabAttrModified", this);

    // Break cycles, otherwise we end up leaking the window with everything
    // attached to it.
    delete this.win;
    delete this.preview;
  },

  get wrappedJSObject() {
    return this;
  },

  // Resizes the canvasPreview to 0x0, essentially freeing its memory.
  resetCanvasPreview: function () {
    this.canvasPreview.width = 0;
    this.canvasPreview.height = 0;
  },

  // Set the canvas dimensions.
  resizeCanvasPreview: function (aRequestedWidth, aRequestedHeight) {
    this.canvasPreview.width = aRequestedWidth;
    this.canvasPreview.height = aRequestedHeight;
  },

  get zoom() {
    // Note that winutils.fullZoom accounts for "quantization" of the zoom factor
    // from nsIContentViewer due to conversion through appUnits.
    // We do -not- want screenPixelsPerCSSPixel here, because that would -also-
    // incorporate any scaling that is applied due to hi-dpi resolution options.
    return this.tab.linkedBrowser.fullZoom;
  },

  get screenPixelsPerCSSPixel() {
    let chromeWin = this.tab.ownerGlobal;
    let windowUtils = chromeWin.getInterface(Ci.nsIDOMWindowUtils);
    return windowUtils.screenPixelsPerCSSPixel;
  },

  get browserDims() {
    return this.tab.linkedBrowser.getBoundingClientRect();
  },

  cacheBrowserDims: function () {
    let dims = this.browserDims;
    this._cachedWidth = dims.width;
    this._cachedHeight = dims.height;
  },

  testCacheBrowserDims: function () {
    let dims = this.browserDims;
    return this._cachedWidth == dims.width &&
      this._cachedHeight == dims.height;
  },

  // Capture a new thumbnail image for this preview. Called by the controller
  // in response to a request for a new thumbnail image.
  updateCanvasPreview: function (aFullScale, aCallback) {
    // Update our cached browser dims so that delayed resize
    // events don't trigger another invalidation if this tab becomes active.
    this.cacheBrowserDims();
    PageThumbs.captureToCanvas(this.linkedBrowser, this.canvasPreview,
                               aCallback, { fullScale: aFullScale });
    // If we're updating the canvas, then we're in the middle of a peek so
    // don't discard the cache of previews.
    AeroPeek.resetCacheTimer();
  },

  updateTitleAndTooltip: function () {
    let title = this.win.tabbrowser.getWindowTitleForBrowser(this.linkedBrowser);
    this.preview.title = title;
    this.preview.tooltip = title;
  },

  //////////////////////////////////////////////////////////////////////////////
  //// nsITaskbarPreviewController

  // Window width, not browser.
  get width() {
    return this.win.width;
  },

  // Window height, not browser.
  get height() {
    return this.win.height;
  },

  get thumbnailAspectRatio() {
    let browserDims = this.browserDims;
    // Avoid returning 0.
    let tabWidth = browserDims.width || 1;
    // Avoid divide by 0.
    let tabHeight = browserDims.height || 1;
    return tabWidth / tabHeight;
  },

  /**
   * Responds to taskbar requests for window previews. Returns the results asynchronously
   * through updateCanvasPreview.
   *
   * @param aTaskbarCallback nsITaskbarPreviewCallback results callback
   */
  requestPreview: function (aTaskbarCallback) {
    // Grab a high res content preview.
    this.resetCanvasPreview();
    this.updateCanvasPreview(true, (aPreviewCanvas) => {
      let winWidth = this.win.width;
      let winHeight = this.win.height;

      let composite = PageThumbs.createCanvas();

      // Use transparency, Aero glass is drawn black without it.
      composite.mozOpaque = false;

      let ctx = composite.getContext('2d');
      let scale = this.screenPixelsPerCSSPixel / this.zoom;

      composite.width = winWidth * scale;
      composite.height = winHeight * scale;

      ctx.save();
      ctx.scale(scale, scale);

      // Draw chrome. Note we currently do not get scrollbars for remote frames
      // in the image above.
      ctx.drawWindow(this.win.win, 0, 0, winWidth, winHeight, "rgba(0,0,0,0)");

      // Draw the content are into the composite canvas at the right location.
      ctx.drawImage(aPreviewCanvas, this.browserDims.x, this.browserDims.y,
                    aPreviewCanvas.width, aPreviewCanvas.height);
      ctx.restore();

      // Deliver the resulting composite canvas to Windows.
      this.win.tabbrowser.previewTab(this.tab, function () {
        aTaskbarCallback.done(composite, false);
      });
    });
  },

  /**
   * Responds to taskbar requests for tab thumbnails. Returns the results asynchronously
   * through updateCanvasPreview.
   *
   * Note Windows requests a specific width and height here, if the resulting thumbnail
   * does not match these dimensions thumbnail display will fail.
   *
   * @param aTaskbarCallback nsITaskbarPreviewCallback results callback
   * @param aRequestedWidth width of the requested thumbnail
   * @param aRequestedHeight height of the requested thumbnail
   */
  requestThumbnail: function (aTaskbarCallback, aRequestedWidth, aRequestedHeight) {
    this.resizeCanvasPreview(aRequestedWidth, aRequestedHeight);
    this.updateCanvasPreview(false, (aThumbnailCanvas) => {
      aTaskbarCallback.done(aThumbnailCanvas, false);
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  //// Event handling

  onClose: function () {
    this.win.tabbrowser.removeTab(this.tab);
  },

  onActivate: function () {
    this.win.tabbrowser.selectedTab = this.tab;

    // Accept activation - this will restore the browser window
    // if it's minimized.
    return true;
  },

  // EventListener
  handleEvent: function (evt) {
    switch (evt.type) {
      case "TabAttrModified":
        this.updateTitleAndTooltip();
        break;
    }
  }
};

////////////////////////////////////////////////////////////////////////////////
//// TabWindow

/*
 * This class monitors a browser window for changes to its tabs.
 *
 * @param win
 *        The nsIDOMWindow browser window
 */
function TabWindow(win) {
  this.win = win;
  this.tabbrowser = win.getBrowser();

  this.previews = new Map();

  for (let i = 0; i < this.tabEvents.length; i++)
    this.tabbrowser.tabContainer.addEventListener(this.tabEvents[i], this);

  for (let i = 0; i < this.winEvents.length; i++)
    this.win.addEventListener(this.winEvents[i], this);

  this.tabbrowser.addTabsProgressListener(this);

  AeroPeek.windows.push(this);
  let tabs = this.tabbrowser.tabs;
  for (let i = 0; i < tabs.length; i++)
    this.newTab(tabs[i]);

  this.updateTabOrdering();
  AeroPeek.checkPreviewCount();
}

TabWindow.prototype = {
  _enabled: false,
  _cachedWidth: 0,
  _cachedHeight: 0,
  tabEvents: ["TabOpen", "TabClose", "TabSelect", "TabMove"],
  winEvents: ["resize"],

  destroy: function () {
    this._destroying = true;

    let tabs = this.tabbrowser.tabs;

    this.tabbrowser.removeTabsProgressListener(this);

    for (let i = 0; i < this.winEvents.length; i++)
      this.win.removeEventListener(this.winEvents[i], this);

    for (let i = 0; i < this.tabEvents.length; i++)
      this.tabbrowser.tabContainer.removeEventListener(this.tabEvents[i], this);

    for (let i = 0; i < tabs.length; i++)
      this.removeTab(tabs[i]);

    let idx = AeroPeek.windows.indexOf(this.win.gTaskbarTabGroup);
    AeroPeek.windows.splice(idx, 1);
    AeroPeek.checkPreviewCount();
  },

  get width () {
    return this.win.innerWidth;
  },
  get height () {
    return this.win.innerHeight;
  },

  cacheDims: function () {
    this._cachedWidth = this.width;
    this._cachedHeight = this.height;
  },

  testCacheDims: function () {
    return this._cachedWidth == this.width && this._cachedHeight == this.height;
  },

  // Invoked when the given tab is added to this window.
  newTab: function (tab) {
    let controller = new PreviewController(this, tab);
    // It's OK to add the preview now while the favicon still loads.
    this.previews.set(tab, controller.preview);
    AeroPeek.addPreview(controller.preview);
    // updateTitleAndTooltip relies on having controller.preview which is lazily resolved.
    // Now that we've updated this.previews, it will resolve successfully.
    controller.updateTitleAndTooltip();
  },

  createTabPreview: function (controller) {
    let docShell = this.win
                       .QueryInterface(Ci.nsIInterfaceRequestor)
                       .getInterface(Ci.nsIWebNavigation)
                       .QueryInterface(Ci.nsIDocShell);
    let preview = AeroPeek.taskbar.createTaskbarTabPreview(docShell, controller);
    preview.visible = AeroPeek.enabled;
    preview.active = this.tabbrowser.selectedTab == controller.tab;
    this.onLinkIconAvailable(controller.tab.linkedBrowser,
                             controller.tab.getAttribute("image"));

    return preview;
  },

  // Invoked when the given tab is closed.
  removeTab: function (tab) {
    let preview = this.previewFromTab(tab);
    preview.active = false;
    preview.visible = false;
    preview.move(null);
    preview.controller.wrappedJSObject.destroy();

    this.previews.delete(tab);
    AeroPeek.removePreview(preview);
  },

  get enabled () {
    return this._enabled;
  },

  set enabled (enable) {
    this._enabled = enable;
    // Because making a tab visible requires that the tab it is next to be
    // visible, it is far simpler to unset the 'next' tab and recreate them all
    // at once.
    for (let [tab, preview] of this.previews) {
      preview.move(null);
      preview.visible = enable;
    }
    this.updateTabOrdering();
  },

  previewFromTab: function (tab) {
    return this.previews.get(tab);
  },

  updateTabOrdering: function () {
    let previews = this.previews;
    let tabs = this.tabbrowser.tabs;

    // Previews are internally stored using a map, so we need to iterate the
    // tabbrowser's array of tabs to retrieve previews in the same order.
    let inorder = [];
    for (let t of tabs) {
      if (previews.has(t)) {
        inorder.push(previews.get(t));
      }
    }

    // Since the internal taskbar array has not yet been updated we must force
    // on it the sorting order of our local array.  To do so we must walk
    // the local array backwards, otherwise we would send move requests in the
    // wrong order. See bug 522610 for details.
    for (let i = inorder.length - 1; i >= 0; i--) {
      inorder[i].move(inorder[i + 1] || null);
    }
  },

  // EventListener
  handleEvent: function (evt) {
    let tab = evt.originalTarget;
    switch (evt.type) {
      case "TabOpen":
        this.newTab(tab);
        this.updateTabOrdering();
        break;
      case "TabClose":
        this.removeTab(tab);
        this.updateTabOrdering();
        break;
      case "TabSelect":
        this.previewFromTab(tab).active = true;
        break;
      case "TabMove":
        this.updateTabOrdering();
        break;
      case "resize":
        if (!AeroPeek._prefenabled)
          return;
        this.onResize();
        break;
    }
  },

  // Set or reset a timer that will invalidate visible thumbnails soon.
  setInvalidationTimer: function () {
    if (!this.invalidateTimer) {
      this.invalidateTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    }
    this.invalidateTimer.cancel();

    // Delay 1 second before invalidating.
    this.invalidateTimer.initWithCallback(() => {
      // Invalidate every preview. Note the internal implementation of
      // invalidate ignores thumbnails that aren't visible.
      this.previews.forEach(function (aPreview) {
        let controller = aPreview.controller.wrappedJSObject;
        if (!controller.testCacheBrowserDims()) {
          controller.cacheBrowserDims();
          aPreview.invalidate();
        }
      });
    }, 1000, Ci.nsITimer.TYPE_ONE_SHOT);
  },

  onResize: function () {
    // Specific to a window.

    // Call invalidate on each tab thumbnail so that Windows will request an
    // updated image. However don't do this repeatedly across multiple resize
    // events triggered during window border drags.
    if (this.testCacheDims()) {
      return;
    }

    // Update the window dims on our TabWindow object.
    this.cacheDims();

    // Invalidate soon.
    this.setInvalidationTimer();
  },

  invalidateTabPreview: function(aBrowser) {
    for (let [tab, preview] of this.previews) {
      if (aBrowser == tab.linkedBrowser) {
        preview.invalidate();
        break;
      }
    }
  },

  //// Browser progress listener

  onLocationChange: function (aBrowser) {
    // I'm not sure we need this, onStateChange does a really good job
    // of picking up page changes.
    // this.invalidateTabPreview(aBrowser);
  },

  onStateChange: function (aBrowser, aWebProgress, aRequest, aStateFlags, aStatus) {
    if (aStateFlags & Ci.nsIWebProgressListener.STATE_STOP &&
        aStateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK) {
      this.invalidateTabPreview(aBrowser);
    }
  },

  directRequestProtocols: new Set([
    "file", "chrome", "resource", "about"
  ]),

  onLinkIconAvailable: function (aBrowser, aIconURL) {

    let requestURL = null;
    if (aIconURL) {
      let shouldRequestFaviconURL = true;
      try {
        let urlObject = NetUtil.newURI(aIconURL);
        shouldRequestFaviconURL =
          !this.directRequestProtocols.has(urlObject.scheme);
      } catch (ex) {}

      requestURL = shouldRequestFaviconURL ?
        "moz-anno:favicon:" + aIconURL :
        aIconURL;
    }

    let isDefaultFavicon = !requestURL;

    getFaviconAsImage(
      requestURL,
      PrivateBrowsingUtils.isWindowPrivate(this.win),
      img => {
        let index = this.tabbrowser.browsers.indexOf(aBrowser);
        // Only add it if we've found the index and the URI is still the same.
        // The tab could have closed, and there's no guarantee the icons
        // will have finished fetching 'in order'.
        if (index != -1) {
          let tab = this.tabbrowser.tabs[index];

          let preview = this.previews.get(tab);

          if (tab.getAttribute("image") == aIconURL ||
              (!preview.icon && isDefaultFavicon)) {
            preview.icon = img;
          }
        }
      }
    );
  }
}

////////////////////////////////////////////////////////////////////////////////
//// AeroPeek

// This object acts as global storage and external interface for this feature.
// It maintains the values of the prefs.
var AeroPeek = {
  available: false,
  // Does the pref say we're enabled?
  _prefenabled: false,

  _enabled: true,

   initialized: false,

  // nsITaskbarTabPreview array
  previews: [],

  // TabWindow array
  windows: [],

  // nsIWinTaskbar service
  taskbar: null,

  // Maximum number of previews.
  maxpreviews: 20,

  // Length of time in seconds that previews are cached.
  cacheLifespan: 20,

  initialize: function () {
    if (!(WINTASKBAR_CONTRACTID in Cc))
      return;
    this.taskbar = Cc[WINTASKBAR_CONTRACTID]
                     .getService(Ci.nsIWinTaskbar);
    this.available = this.taskbar.available;
    if (!this.available)
      return;

    this.prefs.addObserver(TOGGLE_PREF_NAME, this, true);
     this.enabled = this._prefenabled = this.prefs.getBoolPref(TOGGLE_PREF_NAME);
    this.initialized = true;
  },

  destroy: function destroy() {
    this._enabled = false;

    this.prefs.removeObserver(TOGGLE_PREF_NAME, this);
    this.prefs.removeObserver(DISABLE_THRESHOLD_PREF_NAME, this);
    this.prefs.removeObserver(CACHE_EXPIRATION_TIME_PREF_NAME, this);

    if (this.cacheTimer)
      this.cacheTimer.cancel();
  },

  get enabled() {
    return this._enabled;
  },

  set enabled(enable) {
    if (this._enabled == enable)
      return;

    this._enabled = enable;

    this.windows.forEach(function (win) {
      win.enabled = enable;
    });
  },
  get _prefenabled() {
    return this.__prefenabled;
  },

  set _prefenabled(enable) {
    if (enable == this.__prefenabled) {
      return;
    }
    this.__prefenabled = enable;

    if (enable) {
      this.enable();
    } else {
      this.disable();
    }
  },

  _observersAdded: false,

  enable() {
    if (!this._observersAdded) {
      this.prefs.addObserver(DISABLE_THRESHOLD_PREF_NAME, this, true);
      this.prefs.addObserver(CACHE_EXPIRATION_TIME_PREF_NAME, this, true);
      PlacesUtils.history.addObserver(this, true);
      this._observersAdded = true;
    }

    this.cacheLifespan = this.prefs.getIntPref(CACHE_EXPIRATION_TIME_PREF_NAME);

    this.maxpreviews = this.prefs.getIntPref(DISABLE_THRESHOLD_PREF_NAME);

    // If the user toggled us on/off while the browser was already up
    // (rather than this code running on startup because the pref was
    // already set to true), we must initialize previews for open windows.
    if (this.initialized) {
      let browserWindows = Services.wm.getEnumerator("navigator:browser");
      while (browserWindows.hasMoreElements()) {
        let win = browserWindows.getNext();
        if (!win.closed) {
          this.onOpenWindow(win);
        }
      }
    }
  },

  disable() {
    while (this.windows.length) {
      // We can't call onCloseWindow here because it'll bail if we're not
      // enabled.
      let tabWinObject = this.windows[0];
      tabWinObject.destroy(); // This will remove us from the array.
      delete tabWinObject.win.gTaskbarTabGroup; // Tidy up the window.
    }
  },

  addPreview: function (preview) {
    this.previews.push(preview);
    this.checkPreviewCount();
  },

  removePreview: function (preview) {
    let idx = this.previews.indexOf(preview);
    this.previews.splice(idx, 1);
    this.checkPreviewCount();
  },

  checkPreviewCount: function () {
    if (!this._prefenabled) {
      return;
    }
    this.enabled = this.previews.length <= this.maxpreviews;
  },

  onOpenWindow: function (win) {
    // This occurs when the taskbar service is not available (xp, vista).
    if (!this.available || !this._prefenabled)
      return;

    win.gTaskbarTabGroup = new TabWindow(win);
  },

  onCloseWindow: function (win) {
    // This occurs when the taskbar service is not available (xp, vista).
    if (!this.available || !this._prefenabled)
      return;

    win.gTaskbarTabGroup.destroy();
    delete win.gTaskbarTabGroup;

    if (this.windows.length == 0)
      this.destroy();
  },

  resetCacheTimer: function () {
    this.cacheTimer.cancel();
    this.cacheTimer.init(this, 1000 * this.cacheLifespan,
                         Ci.nsITimer.TYPE_ONE_SHOT);
  },

  //// nsIObserver
  observe: function (aSubject, aTopic, aData) {

    if (aTopic == "nsPref:changed" && aData == TOGGLE_PREF_NAME) {
      this._prefenabled = this.prefs.getBoolPref(TOGGLE_PREF_NAME);
    }

    // Bail out. Nothing more to do here if previews are disabled.
    if (!this._prefenabled) {
      return;
    }

    switch (aTopic) {
      case "nsPref:changed":
        if (aData == CACHE_EXPIRATION_TIME_PREF_NAME)
          break;

        if (aData == DISABLE_THRESHOLD_PREF_NAME)
          this.maxpreviews = this.prefs.getIntPref(DISABLE_THRESHOLD_PREF_NAME);
        // Might need to enable/disable ourselves.
        this.checkPreviewCount();
        break;
      case "timer-callback":
        this.previews.forEach(function (preview) {
          let controller = preview.controller.wrappedJSObject;
          controller.resetCanvasPreview();
        });
        break;
    }
  },

  // nsINavHistoryObserver implementation
  onBeginUpdateBatch() {},
  onEndUpdateBatch() {},
  onVisits() {},
  onTitleChanged() {},
  onFrecencyChanged() {},
  onManyFrecenciesChanged() {},
  onDeleteURI() {},
  onClearHistory() {},
  onDeleteVisits() {},
  onPageChanged(uri, changedConst, newValue) {
    if (this.enabled && changedConst == Ci.nsINavHistoryObserver.ATTRIBUTE_FAVICON) {
      for (let win of this.windows) {
        for (let [tab, preview] of win.previews) {
          if (tab.getAttribute("image") == newValue) {
            win.onLinkIconAvailable(tab.linkedBrowser, newValue);
          }
        }
      }
    }
  },

  QueryInterface: ChromeUtils.generateQI([Ci.nsISupportsWeakReference,
                                          Ci.nsINavHistoryObserver,
                                          Ci.nsIObserver]),
};

XPCOMUtils.defineLazyGetter(AeroPeek, "cacheTimer", () =>
  Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer)
);

XPCOMUtils.defineLazyServiceGetter(AeroPeek, "prefs",
                                   "@mozilla.org/preferences-service;1",
                                   "nsIPrefBranch");

AeroPeek.initialize();
