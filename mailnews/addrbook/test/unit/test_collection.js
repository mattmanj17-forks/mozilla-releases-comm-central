/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Test suite for the Address Collector Service.
 *
 * This tests the main collection functions for adding new cards and modifying
 * existing ones.
 *
 * Tests against cards in different ABs are done in test_collection_2.js.
 */

var { collectSingleAddress } = ChromeUtils.importESModule(
  "resource:///modules/AddressCollector.sys.mjs"
);

// Source fields (emailHeader) and expected results for use for
// testing the addition of new addresses to the database.
//
// Note: these email addresses should be different to allow collecting an
// address to add a different card each time.
var addEmailChecks =
  // First 3 items aimed at basic collection and mail format.
  [
    {
      emailHeader: "test0@foo.invalid",
      primaryEmail: "test0@foo.invalid",
      displayName: "",
      firstName: "",
      lastName: "",
      screenName: "",
    },
    {
      emailHeader: "test1@foo.invalid",
      primaryEmail: "test1@foo.invalid",
      displayName: "",
      firstName: "",
      lastName: "",
      screenName: "",
    },
    {
      emailHeader: "test2@foo.invalid",
      primaryEmail: "test2@foo.invalid",
      displayName: "",
      firstName: "",
      lastName: "",
      screenName: "",
    },
    // UTF-8 based addresses (bug 407564)
    {
      emailHeader: "test0@\u00D0.invalid",
      primaryEmail: "test0@\u00D0.invalid",
      displayName: "",
      firstName: "",
      lastName: "",
      screenName: "",
    },
    {
      emailHeader: "test0\u00D0@foo.invalid",
      primaryEmail: "test0\u00D0@foo.invalid",
      displayName: "",
      firstName: "",
      lastName: "",
      screenName: "",
    },
    // Collection of names
    {
      emailHeader: "Test User <test3@foo.invalid>",
      primaryEmail: "test3@foo.invalid",
      displayName: "Test User",
      firstName: "Test",
      lastName: "User",
      screenName: "",
    },
    {
      emailHeader: "Test <test4@foo.invalid>",
      primaryEmail: "test4@foo.invalid",
      displayName: "Test",
      firstName: "",
      lastName: "",
      screenName: "",
    },
    // Collection of names with UTF-8 specific items
    {
      emailHeader: "Test\u00D0 User <test5@foo.invalid>",
      primaryEmail: "test5@foo.invalid",
      displayName: "Test\u00D0 User",
      firstName: "Test\u00D0",
      lastName: "User",
      screenName: "",
    },
    {
      emailHeader: "Test\u00D0 <test6@foo.invalid>",
      primaryEmail: "test6@foo.invalid",
      displayName: "Test\u00D0",
      firstName: "",
      lastName: "",
      screenName: "",
    },
  ];

// Source fields (emailHeader) and expected results for use for
// testing the modification of cards in the database.
//
// Note: these sets re-use some of the ones for ease of definition.
var modifyEmailChecks =
  // No display name/other details. Add details and modify mail format.
  [
    {
      emailHeader: "Modify User\u00D0 <test0@\u00D0.invalid>",
      primaryEmail: "test0@\u00D0.invalid",
      displayName: "Modify User\u00D0",
      firstName: "Modify",
      lastName: "User\u00D0",
      screenName: "",
    },
    {
      emailHeader: "Modify <test0\u00D0@foo.invalid>",
      primaryEmail: "test0\u00D0@foo.invalid",
      displayName: "Modify",
      firstName: "",
      lastName: "",
      screenName: "",
    },
    // No modification of existing cards with display names
    {
      emailHeader: "Modify2 User\u00D02 <test0@\u00D0.invalid>",
      primaryEmail: "test0@\u00D0.invalid",
      displayName: "Modify User\u00D0",
      firstName: "Modify",
      lastName: "User\u00D0",
      screenName: "",
    },
    {
      emailHeader: "Modify3 <test0\u00D0@foo.invalid>",
      primaryEmail: "test0\u00D0@foo.invalid",
      displayName: "Modify",
      firstName: "",
      lastName: "",
      screenName: "",
    },
    // Check no modification of cards for mail format where format is not
    // "unknown".
    {
      emailHeader: "Modify User\u00D0 <test0@\u00D0.invalid>",
      primaryEmail: "test0@\u00D0.invalid",
      displayName: "Modify User\u00D0",
      firstName: "Modify",
      lastName: "User\u00D0",
      screenName: "",
    },
    {
      emailHeader: "Modify <test0\u00D0@foo.invalid>",
      primaryEmail: "test0\u00D0@foo.invalid",
      displayName: "Modify",
      firstName: "",
      lastName: "",
      screenName: "",
    },
    // No modification of cards with email in second email address.
    {
      emailHeader: "Modify Secondary <usersec\u00D0@foo.invalid>",
      primaryEmail: "userprim\u00D0@foo.invalid",
      secondEmail: "usersec\u00D0@foo.invalid",
      displayName: "",
      firstName: "",
      lastName: "",
      screenName: "",
    },
    {
      emailHeader: "Modify <usersec\u00D0@foo.invalid>",
      primaryEmail: "userprim\u00D0@foo.invalid",
      secondEmail: "usersec\u00D0@foo.invalid",
      displayName: "",
      firstName: "",
      lastName: "",
      screenName: "",
    },
  ];

var collectChecker = {
  addressCollect: null,
  AB: null,
  part: 0,

  checkAddress(aDetails) {
    info("checkAddress: " + aDetails.emailHeader);
    try {
      this.addressCollect.collectAddress(aDetails.emailHeader, true);

      this.checkCardResult(aDetails, false);
    } catch (e) {
      throw new Error(
        "FAILED in checkAddress emailHeader: " +
          aDetails.emailHeader +
          " part: " +
          this.part +
          " : " +
          e
      );
    }
    ++this.part;
  },

  checkAll(aDetailsArray) {
    try {
      // Formulate the string to add.
      var emailHeader = "";
      var i;

      for (i = 0; i < aDetailsArray.length - 1; ++i) {
        emailHeader += aDetailsArray[i].emailHeader + ", ";
      }

      emailHeader += aDetailsArray[aDetailsArray.length - 1].emailHeader;

      // Now add it. In this case we just set the Mail format Type to unknown.
      this.addressCollect.collectAddress(emailHeader, true);

      for (i = 0; i < aDetailsArray.length; ++i) {
        this.checkCardResult(aDetailsArray[i], true);
      }
    } catch (e) {
      throw new Error("FAILED in checkAll item: " + i + " : " + e);
    }
  },

  checkCardResult(aDetails) {
    info("checkCardResult: " + aDetails.emailHeader);
    try {
      var card = this.AB.cardForEmailAddress(aDetails.primaryEmail);

      Assert.notEqual(card, null);

      if ("secondEmail" in aDetails) {
        Assert.equal(card.emailAddresses[1], aDetails.secondEmail);
      }

      Assert.equal(card.displayName, aDetails.displayName);
      Assert.equal(card.firstName, aDetails.firstName);
      Assert.equal(card.lastName, aDetails.lastName);
    } catch (e) {
      throw new Error(
        "FAILED in checkCardResult emailHeader: " +
          aDetails.emailHeader +
          " : " +
          e
      );
    }
  },
};

function run_test() {
  // Test - Get the address collecter

  // Get the actual AB for the collector so we can check cards have been
  // added.
  collectChecker.AB = MailServices.ab.getDirectory(
    Services.prefs.getCharPref("mail.collect_addressbook")
  );

  // Get the actual collecter
  const collectAddress = (addresses, addCard) => {
    const parsedAddresses =
      MailServices.headerParser.parseEncodedHeaderW(addresses);
    for (const addr of parsedAddresses.filter(a => a.email)) {
      collectChecker.addressCollect.collectSingleAddress(
        addr.email,
        addr.name,
        addCard
      );
    }
  };
  collectChecker.addressCollect = { collectAddress, collectSingleAddress };

  // Test - Addition of header without email address.

  collectChecker.addressCollect.collectAddress("MyTest <>", true);

  // Address book should have no cards present.
  Assert.equal(collectChecker.AB.childCards.length, 0);

  // Test - Email doesn't exist, but don't add it.

  // As we've just set everything up, we know we haven't got anything in the
  // AB, so just try and collect without adding.
  collectChecker.addressCollect.collectAddress(
    addEmailChecks[0].emailHeader,
    false
  );

  var card = collectChecker.AB.cardForEmailAddress(
    addEmailChecks[0].emailHeader
  );

  Assert.equal(card, null);

  // Test - Try and collect various emails and formats.

  collectChecker.part = 0;

  addEmailChecks.forEach(collectChecker.checkAddress, collectChecker);

  // Test - Do all emails at the same time.

  // First delete all existing cards
  collectChecker.AB.deleteCards(collectChecker.AB.childCards);

  // Address book should have no cards present.
  Assert.equal(collectChecker.AB.childCards.length, 0);

  Assert.equal(
    collectChecker.AB.cardForEmailAddress(addEmailChecks[0].emailHeader),
    null
  );

  // Now do all emails at the same time.
  collectChecker.checkAll(addEmailChecks);

  // Test - Try and modify various emails and formats.

  // Add a basic card with just primary and second email to allow testing
  // of the case where we don't modify when second email is matching.
  card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );

  card.primaryEmail = "userprim\u00D0@foo.invalid";
  card.setProperty("SecondEmail", "usersec\u00D0@foo.invalid");

  collectChecker.AB.addCard(card);

  collectChecker.part = 0;

  modifyEmailChecks.forEach(collectChecker.checkAddress, collectChecker);

  // Test collectSingleAddress - Note: because the above tests test
  // collectAddress which we know calls collectSingleAddress, we only need to
  // test the case where aSkipCheckExisting is true.

  // Add an email that is already there and check we get two instances of it in
  // the AB.

  const kSingleAddress =
    modifyEmailChecks[modifyEmailChecks.length - 1].primaryEmail;
  const kSingleDisplayName = "Test Single";

  collectChecker.addressCollect.collectSingleAddress(
    kSingleAddress,
    kSingleDisplayName,
    true,
    true
  );

  // Try collecting the same address in another case. This shouldn't create any
  // new card.
  collectChecker.addressCollect.collectSingleAddress(
    kSingleAddress.toUpperCase(),
    kSingleDisplayName,
    true,
    true
  );

  var foundCards = [];

  for (card of collectChecker.AB.childCards) {
    if (card.primaryEmail == kSingleAddress) {
      foundCards.push(card);
    }
  }

  Assert.equal(foundCards.length, 2);

  if (
    foundCards[0].displayName != kSingleDisplayName &&
    foundCards[1].displayName != kSingleDisplayName
  ) {
    do_throw("Error, collectSingleCard didn't create a new card");
  }

  if (foundCards[0].displayName != "" && foundCards[1].displayName != "") {
    do_throw(
      "Error, collectSingleCard created ok, but other card does not exist"
    );
  }
}
