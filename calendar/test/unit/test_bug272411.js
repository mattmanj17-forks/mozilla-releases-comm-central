/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function run_test() {
  const jsd = new Date();
  const cdt = cal.dtz.jsDateToDateTime(jsd);

  const cdtTime = cal.dtz.dateTimeToJsDate(cdt).getTime() / 1000;
  const jsdTime = Math.floor(jsd.getTime() / 1000);

  // calIDateTime is only accurate to the second, milliseconds need to be
  // stripped.
  equal(cdtTime, jsdTime);
}
