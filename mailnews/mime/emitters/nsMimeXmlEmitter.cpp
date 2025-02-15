/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <stdio.h>
#include "nsMimeXmlEmitter.h"
#include "plstr.h"
#include "nsPrintfCString.h"
#include "nsMailHeaders.h"
#include "nscore.h"
#include "prmem.h"
#include "nsEscape.h"

/*
 * nsMimeXmlEmitter definitions....
 */
nsMimeXmlEmitter::nsMimeXmlEmitter() {}

nsMimeXmlEmitter::~nsMimeXmlEmitter(void) {}

// Note - this is teardown only...you should not write
// anything to the stream since these may be image data
// output streams, etc...
nsresult nsMimeXmlEmitter::Complete() {
  // Now write out the total count of attachments for this message
  UtilityWrite("<mailattachcount>");
  UtilityWrite(nsPrintfCString("%d", mAttachCount));
  UtilityWrite("</mailattachcount>");

  UtilityWrite("</message>");

  return nsMimeBaseEmitter::Complete();
}

nsresult nsMimeXmlEmitter::WriteXMLHeader(const char* msgID) {
  if ((!msgID) || (!*msgID)) msgID = "none";

  nsCString newValue;
  nsAppendEscapedHTML(nsDependentCString(msgID), newValue);

  UtilityWrite("<?xml version=\"1.0\"?>");

  UtilityWriteCRLF(
      "<?xml-stylesheet href=\"chrome://messagebody/skin/messageBody.css\" "
      "type=\"text/css\"?>");

  UtilityWrite("<message id=\"");
  UtilityWrite(newValue.get());
  UtilityWrite("\">");

  mXMLHeaderStarted = true;
  return NS_OK;
}

nsresult nsMimeXmlEmitter::WriteXMLTag(const char* tagName, const char* value) {
  if ((!value) || (!*value)) return NS_OK;

  char* upCaseTag = NULL;
  nsCString newValue;
  nsAppendEscapedHTML(nsDependentCString(value), newValue);

  nsCString newTagName(tagName);
  newTagName.StripWhitespace();
  ToUpperCase(newTagName);
  upCaseTag = ToNewCString(newTagName);

  UtilityWrite("<header field=\"");
  UtilityWrite(upCaseTag);
  UtilityWrite("\">");

  // Here is where we are going to try to L10N the tagName so we will always
  // get a field name next to an emitted header value. Note: Default will always
  // be the name of the header itself.
  //
  UtilityWrite("<headerdisplayname>");
  char* l10nTagName = LocalizeHeaderName(upCaseTag, tagName);
  if ((!l10nTagName) || (!*l10nTagName))
    UtilityWrite(tagName);
  else {
    UtilityWrite(l10nTagName);
  }
  PR_FREEIF(l10nTagName);

  UtilityWrite(": ");
  UtilityWrite("</headerdisplayname>");

  // Now write out the actual value itself and move on!
  //
  UtilityWrite(newValue.get());
  UtilityWrite("</header>");

  free(upCaseTag);

  return NS_OK;
}

// Header handling routines.
nsresult nsMimeXmlEmitter::StartHeader(bool rootMailHeader, bool headerOnly,
                                       const char* msgID,
                                       const char* outCharset) {
  mDocHeader = rootMailHeader;
  WriteXMLHeader(msgID);
  UtilityWrite("<mailheader>");

  return NS_OK;
}

nsresult nsMimeXmlEmitter::AddHeaderField(const char* field,
                                          const char* value) {
  if ((!field) || (!value)) return NS_OK;

  WriteXMLTag(field, value);
  return NS_OK;
}

nsresult nsMimeXmlEmitter::EndHeader(const nsACString& name) {
  UtilityWrite("</mailheader>");
  return NS_OK;
}

// Attachment handling routines
nsresult nsMimeXmlEmitter::StartAttachment(const nsACString& name,
                                           const char* contentType,
                                           const char* url,
                                           bool aIsExternalAttachment) {
  ++mAttachCount;

  UtilityWrite(nsPrintfCString("<mailattachment id=\"%d\">", mAttachCount));

  AddAttachmentField(HEADER_PARM_FILENAME, PromiseFlatCString(name).get());
  return NS_OK;
}

nsresult nsMimeXmlEmitter::AddAttachmentField(const char* field,
                                              const char* value) {
  WriteXMLTag(field, value);
  return NS_OK;
}

nsresult nsMimeXmlEmitter::EndAttachment() {
  UtilityWrite("</mailattachment>");
  return NS_OK;
}
