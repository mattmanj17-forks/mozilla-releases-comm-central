/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/*
 * Test suite for checking SMTP URLs are working as expected.
 * XXX this test needs extending as we fix up nsSmtpUrl.
 */

var smtpURLs = [
  {
    url: "smtp://user@localhost/",
    spec: "smtp://user@localhost/",
    username: "user",
  },
  {
    url: "smtps://user@localhost/",
    spec: "smtps://user@localhost/",
    username: "user",
  },
  {
    url: "mailto:should.not.crash@example.com?to",
    spec: "mailto:should.not.crash@example.com?to",
  },
];

function run_test() {
  var url;
  for (var part = 0; part < smtpURLs.length; ++part) {
    print("url: " + smtpURLs[part].url);

    url = Services.io.newURI(smtpURLs[part].url);

    Assert.equal(url.spec, smtpURLs[part].spec);
    if (smtpURLs[part].username) {
      Assert.equal(url.username, smtpURLs[part].username);
    }
  }
}
