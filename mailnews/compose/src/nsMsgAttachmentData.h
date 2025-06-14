/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_COMPOSE_SRC_NSMSGATTACHMENTDATA_H_
#define COMM_MAILNEWS_COMPOSE_SRC_NSMSGATTACHMENTDATA_H_

#include "nsString.h"
#include "nsIMsgSend.h"

// Attachment file/URL structures - we're letting libmime use this directly
class nsMsgAttachmentData final : public nsIMsgAttachmentData {
 public:
  NS_DECL_NSIMSGATTACHMENTDATA
  NS_DECL_ISUPPORTS

  nsMsgAttachmentData();
  virtual ~nsMsgAttachmentData();

  nsCOMPtr<nsIURI> m_url;  // The URL to attach.

  nsCString m_desiredType;  // The type to which this document should be
                            // converted.  Legal values are NULL, TEXT_PLAIN
                            // and APPLICATION_POSTSCRIPT (which are macros
                            // defined in net.h); other values are ignored.

  nsCString
      m_realType;  // The type of the URL if known, otherwise NULL. For example,
                   // if you were attaching a temp file which was known to
                   // contain HTML data, you would pass in TEXT_HTML as the
                   // real_type, to override whatever type the name of the tmp
                   // file might otherwise indicate.

  nsCString m_realEncoding;  // Goes along with real_type

  nsCString
      m_realName;  // The original name of this document, which will eventually
                   // show up in the Content-Disposition header. For example, if
                   // you had copied a document to a tmp file, this would be the
                   // original, human-readable name of the document.

  nsCString m_description;  // If you put a string here, it will show up as the
                            // Content-Description header. This can be any
                            // explanatory text; it's not a file name.

  nsCString m_disposition;    // The Content-Disposition header (if any). a
                              // nsMsgAttachmentData can very well have
                              // Content-Disposition: inline value, instead of
                              // "attachment".
  nsCString m_cloudPartInfo;  // For X-Mozilla-Cloud-Part header, if any

  int32_t m_size;  // The size of the attachment. May be 0.
  nsCString
      m_sizeExternalStr;  // The reported size of an external attachment.
                          // Originally set at "-1" to mean an unknown value.
  bool m_isExternalAttachment;      // Flag for determining if the attachment is
                                    // external
  bool m_isExternalLinkAttachment;  // Flag for determining if the attachment is
                                    // external and an http link.
  bool m_isDownloaded;  // Flag for determining if the attachment has already
                        // been downloaded
  bool m_hasFilename;   // Tells whether the name is provided by us or if it's a
                        // Part 1.2-like attachment
  bool m_displayableInline;  // Tells whether the attachment could be displayed
                             // inline
};

class nsMsgAttachedFile final : public nsIMsgAttachedFile {
 public:
  NS_DECL_NSIMSGATTACHEDFILE
  NS_DECL_ISUPPORTS

  nsMsgAttachedFile();
  virtual ~nsMsgAttachedFile();

  nsCOMPtr<nsIURI> m_origUrl;  // Where it came from on the network (or even
                               // elsewhere on the local disk.)

  nsCOMPtr<nsIFile> m_tmpFile;  // The tmp file in which the (possibly
                                // converted) data now resides.

  nsCString m_type;  // The type of the data in file_name (not necessarily the
                     // same as the type of orig_url.)

  nsCString
      m_encoding;  // Likewise, the encoding of the tmp file. This will be set
                   // only if the original document had an encoding already; we
                   // don't do base64 encoding and so forth until it's time to
                   // assemble a full MIME message of all parts.

  nsCString m_description;    // For Content-Description header
  nsCString m_cloudPartInfo;  // For X-Mozilla-Cloud-Part header, if any
  nsCString m_realName;       // The real name of the file.

  uint32_t m_size;
};

#undef MOZ_ASSERT_TYPE_OK_FOR_REFCOUNTING
#ifdef MOZ_IS_DESTRUCTIBLE
#  define MOZ_ASSERT_TYPE_OK_FOR_REFCOUNTING(X)                              \
    static_assert(                                                           \
        !MOZ_IS_DESTRUCTIBLE(X) ||                                           \
            mozilla::IsSame<X, nsMsgAttachmentData>::value ||                \
            mozilla::IsSame<X, nsMsgAttachedFile>::value,                    \
        "Reference-counted class " #X                                        \
        " should not have a public destructor. "                             \
        "Try to make this class's destructor non-public. If that is really " \
        "not possible, you can whitelist this class by providing a "         \
        "HasDangerousPublicDestructor specialization for it.");
#else
#  define MOZ_ASSERT_TYPE_OK_FOR_REFCOUNTING(X)
#endif

#endif  // COMM_MAILNEWS_COMPOSE_SRC_NSMSGATTACHMENTDATA_H_
