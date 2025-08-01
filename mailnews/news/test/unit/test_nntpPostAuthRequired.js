// Tests that messages are correctly posted even if the server requests for
// authentication (Bug 1979618).

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

/* import-globals-from ../../../test/resources/passwordStorage.js */
load("../../../resources/passwordStorage.js");

add_task(async function test_bug1979618() {
  // Prepare files for passwords (generated by a script in bug 1018624).
  await setupForPassword("signons-mailnews1.8.json");

  const daemon = setupNNTPDaemon();
  const handler = new NNTP_RFC4643_extension(daemon);
  const server = new nsMailServer(() => handler, daemon);
  server.start();

  // Send post3.eml to the server.
  const localServer = setupLocalServer(server.port);
  const testFile = do_get_file("postings/post3.eml");
  const urlListener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.nntp.postMessage(
    testFile,
    "test.empty",
    localServer.key,
    urlListener,
    null
  );
  await urlListener.promise;

  // Check that the POST command is resend after the server requested
  // authentication.
  const transaction = server.playTransaction();
  do_check_transaction(transaction, [
    "POST",
    "AUTHINFO user testnews",
    "AUTHINFO pass newstest",
    "POST",
  ]);

  // Check that the message has been transferred correctly to the server.
  equal(handler.post, await IOUtils.readUTF8(testFile.path));

  server.stop();
});
