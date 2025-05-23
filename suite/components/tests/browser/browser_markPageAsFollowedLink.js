/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

/**
 * Tests that visits across frames are correctly represented in the database.
 */

const BASE_URL = "http://mochi.test:8888/browser/suite/common/tests/browser";
const PAGE_URL = BASE_URL + "/framedPage.html";
const LEFT_URL = BASE_URL + "/frameLeft.html";
const RIGHT_URL = BASE_URL + "/frameRight.html";

var gTabLoaded = false;
var gLeftFrameVisited = false;

var observer = {
  observe: function(aSubject, aTopic, aData)
  {
    let url = aSubject.QueryInterface(Ci.nsIURI).spec;
    if (url == LEFT_URL ) {
      is(getTransitionForUrl(url), null,
         "Embed visits should not get a database entry.");
      gLeftFrameVisited = true;
      maybeClickLink();
    }
    else if (url == RIGHT_URL ) {
      is(getTransitionForUrl(url), PlacesUtils.history.TRANSITION_FRAMED_LINK,
         "User activated visits should get a FRAMED_LINK transition.");
      finish();
    }
  },
  QueryInterface: ChromeUtils.generateQI([Ci.nsIObserver])
};
Services.obs.addObserver(observer, "uri-visit-saved");

function test()
{
  waitForExplicitFinish();
  gBrowser.selectedTab = gBrowser.addTab(PAGE_URL);
  let frameCount = 0;
  gBrowser.selectedTab.linkedBrowser.addEventListener("DOMContentLoaded",
    function gBrowserDOMContentLoaded(event)
    {
      // Wait for all the frames.
      if (frameCount++ < 2)
        return;
      gBrowser.selectedTab.linkedBrowser.removeEventListener("DOMContentLoaded",
        gBrowserDOMContentLoaded)
      gTabLoaded = true;
      maybeClickLink();
    }
  );
}

function maybeClickLink() {
  if (gTabLoaded && gLeftFrameVisited) {
    // Click on the link in the left frame to cause a page load in the
    // right frame.
    EventUtils.sendMouseEvent({type: "click"}, "clickme", content.frames[0]);
  }
}

function getTransitionForUrl(aUrl)
{
  let dbConn = PlacesUtils.history
                          .QueryInterface(Ci.nsPIPlacesDatabase).DBConnection;
  let stmt = dbConn.createStatement(
    "SELECT visit_type FROM moz_historyvisits WHERE place_id = " +
      "(SELECT id FROM moz_places WHERE url = :page_url)");
  stmt.params.page_url = aUrl;
  try {
    if (!stmt.executeStep()) {
      return null;
    }
    return stmt.row.visit_type;
  }
  finally {
    stmt.finalize();
  }
}

registerCleanupFunction(function ()
{
  gBrowser.removeTab(gBrowser.selectedTab);
  Services.obs.removeObserver(observer, "uri-visit-saved");
})
