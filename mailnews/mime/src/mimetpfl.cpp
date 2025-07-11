/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mimetpfl.h"

#include "nsMailHeaders.h"
#include "prmem.h"
#include "plstr.h"
#include "mozITXTToHTMLConv.h"
#include "nsString.h"
#include "nsMimeStringResources.h"
#include "mimemoz2.h"
#include "prprf.h"
#include "nsMsgI18N.h"
#include "mozilla/Preferences.h"

using mozilla::Preferences;

static const uint32_t kSpacesForATab = 4;  // Must be at least 1.

#define MIME_SUPERCLASS mimeInlineTextClass
MimeDefClass(MimeInlineTextPlainFlowed, MimeInlineTextPlainFlowedClass,
             mimeInlineTextPlainFlowedClass, &MIME_SUPERCLASS);

static int MimeInlineTextPlainFlowed_parse_begin(MimeObject*);
static int MimeInlineTextPlainFlowed_parse_line(const char*, int32_t,
                                                MimeObject*);
static int MimeInlineTextPlainFlowed_parse_eof(MimeObject*, bool);

static MimeInlineTextPlainFlowedExData* MimeInlineTextPlainFlowedExDataList =
    nullptr;

// From mimetpla.cpp
extern "C" void MimeTextBuildPrefixCSS(
    int32_t quotedSizeSetting,   // mail.quoted_size
    int32_t quotedStyleSetting,  // mail.quoted_style
    nsACString& citationColor,   // mail.citation_color
    nsACString& style);
// Definition below
static nsresult Line_convert_whitespace(const nsString& a_line,
                                        const bool a_convert_all_whitespace,
                                        nsString& a_out_line);

static int MimeInlineTextPlainFlowedClassInitialize(MimeObjectClass* oclass) {
  NS_ASSERTION(!oclass->class_initialized, "class not initialized");
  oclass->parse_begin = MimeInlineTextPlainFlowed_parse_begin;
  oclass->parse_line = MimeInlineTextPlainFlowed_parse_line;
  oclass->parse_eof = MimeInlineTextPlainFlowed_parse_eof;
  return 0;
}

static int MimeInlineTextPlainFlowed_parse_begin(MimeObject* obj) {
  int status = ((MimeObjectClass*)&MIME_SUPERCLASS)->parse_begin(obj);
  if (status < 0) return status;

  status = MimeObject_write(obj, "", 0, true); /* force out any separators... */
  if (status < 0) return status;

  bool quoting =
      (obj->options &&
       (obj->options->format_out == nsMimeOutput::nsMimeMessageQuoting ||
        obj->options->format_out ==
            nsMimeOutput::nsMimeMessageBodyQuoting));  // The output will be
                                                       // inserted in the
                                                       // composer as quotation
  bool plainHTML =
      quoting || (obj->options && obj->options->format_out ==
                                      nsMimeOutput::nsMimeMessageSaveAs);
  // Just good(tm) HTML. No reliance on CSS.

  // Setup the data structure that is connected to the actual document
  // Saved in a linked list in case this is called with several documents
  // at the same time.
  /* This memory is freed when parse_eof is called. So it better be! */
  struct MimeInlineTextPlainFlowedExData* exdata =
      (MimeInlineTextPlainFlowedExData*)PR_MALLOC(
          sizeof(struct MimeInlineTextPlainFlowedExData));
  if (!exdata) return MIME_OUT_OF_MEMORY;

  MimeInlineTextPlainFlowed* text = (MimeInlineTextPlainFlowed*)obj;

  // Link it up.
  exdata->next = MimeInlineTextPlainFlowedExDataList;
  MimeInlineTextPlainFlowedExDataList = exdata;

  // Initialize data

  exdata->ownerobj = obj;
  exdata->inflow = false;
  exdata->quotelevel = 0;
  exdata->isSig = false;

  // check for DelSp=yes (RFC 3676)

  char* content_type_row =
      (obj->headers
           ? MimeHeaders_get(obj->headers, HEADER_CONTENT_TYPE, false, false)
           : 0);
  char* content_type_delsp =
      (content_type_row
           ? MimeHeaders_get_parameter(content_type_row, "delsp", NULL, NULL)
           : 0);
  ((MimeInlineTextPlainFlowed*)obj)->delSp =
      content_type_delsp && !PL_strcasecmp(content_type_delsp, "yes");
  PR_Free(content_type_delsp);
  PR_Free(content_type_row);

  // Get Prefs for viewing

  exdata->fixedwidthfont = false;
  //  Quotes
  text->mQuotedSizeSetting = 0;     // mail.quoted_size
  text->mQuotedStyleSetting = 0;    // mail.quoted_style
  text->mCitationColor.Truncate();  // mail.citation_color
  text->mStripSig = true;           // mail.strip_sig_on_reply

  Preferences::GetInt("mail.quoted_size", &(text->mQuotedSizeSetting));
  Preferences::GetInt("mail.quoted_style", &(text->mQuotedStyleSetting));
  Preferences::GetCString("mail.citation_color", text->mCitationColor);
  Preferences::GetBool("mail.strip_sig_on_reply", &(text->mStripSig));
  Preferences::GetBool("mail.fixed_width_messages", &(exdata->fixedwidthfont));

  // Get font
  // only used for viewing (!plainHTML)
  nsAutoCString fontstyle;
  nsAutoCString fontLang;  // langgroup of the font

  // generic font-family name ( -moz-fixed for fixed font and NULL for
  // variable font ) is sufficient now that bug 105199 has been fixed.

  if (exdata->fixedwidthfont) fontstyle = "font-family: -moz-fixed";

  if (nsMimeOutput::nsMimeMessageBodyDisplay == obj->options->format_out ||
      nsMimeOutput::nsMimeMessagePrintOutput == obj->options->format_out) {
    int32_t fontSize;            // default font size
    int32_t fontSizePercentage;  // size percentage
    nsresult rv = GetMailNewsFont(obj, exdata->fixedwidthfont, &fontSize,
                                  &fontSizePercentage, fontLang);
    if (NS_SUCCEEDED(rv)) {
      if (!fontstyle.IsEmpty()) {
        fontstyle += "; ";
      }
      fontstyle += "font-size: ";
      fontstyle.AppendInt(fontSize);
      fontstyle += "px;";
    }
  }

  // Opening <div>.
  if (!quoting)
  /* 4.x' editor can't break <div>s (e.g. to interleave comments).
     We'll add the class to the <blockquote type=cite> later. */
  {
    nsAutoCString openingDiv("<div class=\"moz-text-flowed\"");
    // We currently have to add formatting here. :-(
    if (!plainHTML && !fontstyle.IsEmpty()) {
      openingDiv += " style=\"";
      openingDiv += fontstyle;
      openingDiv += '"';
    }
    if (!plainHTML && !fontLang.IsEmpty()) {
      openingDiv += " lang=\"";
      openingDiv += fontLang;
      openingDiv += '\"';
    }
    openingDiv += ">";
    status =
        MimeObject_write(obj, openingDiv.get(), openingDiv.Length(), false);
    if (status < 0) return status;
  }

  return 0;
}

static int MimeInlineTextPlainFlowed_parse_eof(MimeObject* obj, bool abort_p) {
  int status = 0;
  struct MimeInlineTextPlainFlowedExData* exdata = nullptr;

  bool quoting =
      (obj->options &&
       (obj->options->format_out == nsMimeOutput::nsMimeMessageQuoting ||
        obj->options->format_out ==
            nsMimeOutput::nsMimeMessageBodyQuoting));  // see above

  // Has this method already been called for this object?
  // In that case return.
  if (obj->closed_p) return 0;

  /* Run parent method first, to flush out any buffered data. */
  status = ((MimeObjectClass*)&MIME_SUPERCLASS)->parse_eof(obj, abort_p);
  if (status < 0) goto EarlyOut;

  // Look up and unlink "our" extended data structure
  // We do it in the beginning so that if an error occur, we can
  // just free |exdata|.
  struct MimeInlineTextPlainFlowedExData** prevexdata;
  prevexdata = &MimeInlineTextPlainFlowedExDataList;

  while ((exdata = *prevexdata) != nullptr) {
    if (exdata->ownerobj == obj) {
      // Fill hole
      *prevexdata = exdata->next;
      break;
    }
    prevexdata = &exdata->next;
  }
  NS_ASSERTION(exdata, "The extra data has disappeared!");

  if (!obj->output_p) {
    status = 0;
    goto EarlyOut;
  }

  for (; exdata->quotelevel > 0; exdata->quotelevel--) {
    status = MimeObject_write(obj, "</blockquote>", 13, false);
    if (status < 0) goto EarlyOut;
  }

  if (exdata->isSig && !quoting) {
    status = MimeObject_write(obj, "</div>", 6, false);  // .moz-txt-sig
    if (status < 0) goto EarlyOut;
  }
  if (!quoting)  // HACK (see above)
  {
    status = MimeObject_write(obj, "</div>", 6, false);  // .moz-text-flowed
    if (status < 0) goto EarlyOut;
  }

  status = 0;

EarlyOut:
  PR_Free(exdata);

  // Clear mCitationColor
  MimeInlineTextPlainFlowed* text = (MimeInlineTextPlainFlowed*)obj;
  text->mCitationColor.Truncate();

  return status;
}

static int MimeInlineTextPlainFlowed_parse_line(const char* aLine,
                                                int32_t length,
                                                MimeObject* obj) {
  bool quoting =
      (obj->options &&
       (obj->options->format_out == nsMimeOutput::nsMimeMessageQuoting ||
        obj->options->format_out ==
            nsMimeOutput::nsMimeMessageBodyQuoting));  // see above
  bool plainHTML =
      quoting || (obj->options && obj->options->format_out ==
                                      nsMimeOutput::nsMimeMessageSaveAs);
  // see above

  struct MimeInlineTextPlainFlowedExData* exdata;
  exdata = MimeInlineTextPlainFlowedExDataList;
  while (exdata && (exdata->ownerobj != obj)) {
    exdata = exdata->next;
  }

  NS_ASSERTION(exdata, "The extra data has disappeared!");

  NS_ASSERTION(length > 0, "zero length");
  if (length <= 0) return 0;

  uint32_t linequotelevel = 0;
  nsAutoCString real_line(aLine, length);
  char* line = real_line.BeginWriting();
  const char* linep = real_line.BeginReading();
  // Space stuffed?
  if (' ' == *linep) {
    line++;
    linep++;
    length--;
  } else {
    // count '>':s before the first non-'>'
    while ('>' == *linep) {
      linep++;
      linequotelevel++;
    }
    // Space stuffed?
    if (' ' == *linep) {
      linep++;
    }
  }

  // Look if the last character (after stripping ending end
  // of lines and quoting stuff) is a SPACE. If it is, we are looking at a
  // flowed line. Normally we assume that the last two chars
  // are CR and LF as said in RFC822, but that doesn't seem to
  // be the case always.
  bool flowed = false;
  bool sigSeparator = false;
  int32_t index = length - 1;
  while (index >= 0 && ('\r' == line[index] || '\n' == line[index])) {
    index--;
  }
  if (index > linep - line && ' ' == line[index])
  /* Ignore space stuffing, i.e. lines with just
     (quote marks and) a space count as empty */
  {
    flowed = true;
    sigSeparator =
        (index - (linep - line) + 1 == 3) && !strncmp(linep, "-- ", 3);
    if (((MimeInlineTextPlainFlowed*)obj)->delSp && !sigSeparator)
    /* If line is flowed and DelSp=yes, logically
       delete trailing space. Line consisting of
       dash dash space ("-- "), commonly used as
       signature separator, gets special handling
       (RFC 3676) */
    {
      length = index;
      line[index] = '\0';
    }
  }

  if (obj->options && obj->options->decompose_file_p &&
      obj->options->decompose_file_output_fn) {
    return obj->options->decompose_file_output_fn(line, length,
                                                  obj->options->stream_closure);
  }

  mozITXTToHTMLConv* conv = GetTextConverter(obj->options);

  bool skipConversion =
      !conv || (obj->options && obj->options->force_user_charset);

  nsAutoString lineSource;
  nsString lineResult;

  char* mailCharset = NULL;
  nsresult rv;

  if (!skipConversion) {
    // Convert only if the source string is not empty
    if (length - (linep - line) > 0) {
      uint32_t whattodo = obj->options->whattodo;
      if (plainHTML) {
        if (quoting)
          whattodo = 0;
        else
          whattodo = whattodo & ~mozITXTToHTMLConv::kGlyphSubstitution;
        /* Do recognition for the case, the result is viewed in
            Mozilla, but not GlyphSubstitution, because other UAs
            might not be able to display the glyphs. */
      }

      const nsDependentCSubstring& inputStr =
          Substring(linep, linep + (length - (linep - line)));

      // For 'SaveAs', |line| is in |mailCharset|.
      // convert |line| to UTF-16 before 'html'izing (calling ScanTXT())
      if (obj->options->format_out == nsMimeOutput::nsMimeMessageSaveAs) {
        // Get the mail charset of this message.
        MimeInlineText* inlinetext = (MimeInlineText*)obj;
        if (!inlinetext->initializeCharset)
          ((MimeInlineTextClass*)&mimeInlineTextClass)->initialize_charset(obj);
        mailCharset = inlinetext->charset;
        if (mailCharset && *mailCharset) {
          rv = nsMsgI18NConvertToUnicode(nsDependentCString(mailCharset),
                                         PromiseFlatCString(inputStr),
                                         lineSource);
          NS_ENSURE_SUCCESS(rv, -1);
        } else  // this probably never happens...
          CopyUTF8toUTF16(inputStr, lineSource);
      } else  // line is in UTF-8
        CopyUTF8toUTF16(inputStr, lineSource);

      // This is the main TXT to HTML conversion:
      // escaping (very important), eventually recognizing etc.
      rv = conv->ScanTXT(lineSource, whattodo, lineResult);
      NS_ENSURE_SUCCESS(rv, -1);
    }
  } else {
    CopyUTF8toUTF16(nsDependentCString(line, length), lineResult);
  }

  nsAutoCString preface;

  /* Correct number of blockquotes */
  int32_t quoteleveldiff = linequotelevel - exdata->quotelevel;
  if ((quoteleveldiff != 0) && flowed && exdata->inflow) {
    // From RFC 2646 4.5
    // The receiver SHOULD handle this error by using the 'quote-depth-wins'
    // rule, which is to ignore the flowed indicator and treat the line as
    // fixed.  That is, the change in quote depth ends the paragraph.

    // We get that behaviour by just going on.
  }

  // Cast so we have access to the prefs we need.
  MimeInlineTextPlainFlowed* tObj = (MimeInlineTextPlainFlowed*)obj;
  while (quoteleveldiff > 0) {
    quoteleveldiff--;
    preface += "<blockquote type=cite";

    nsAutoCString style;
    MimeTextBuildPrefixCSS(tObj->mQuotedSizeSetting, tObj->mQuotedStyleSetting,
                           tObj->mCitationColor, style);
    if (!plainHTML && !style.IsEmpty()) {
      preface += " style=\"";
      preface += style;
      preface += '"';
    }
    preface += '>';
  }
  while (quoteleveldiff < 0) {
    quoteleveldiff++;
    preface += "</blockquote>";
  }
  exdata->quotelevel = linequotelevel;

  nsAutoString lineResult2;

  if (flowed) {
    // Check RFC 2646 "4.3. Usenet Signature Convention": "-- "+CRLF is
    // not a flowed line
    if (sigSeparator) {
      if (linequotelevel > 0 || exdata->isSig) {
        preface += "--&nbsp;<br>";
      } else {
        exdata->isSig = true;
        preface +=
            "<div class=\"moz-txt-sig\"><span class=\"moz-txt-tag\">"
            "--&nbsp;<br></span>";
      }
    } else {
      Line_convert_whitespace(lineResult, false /* Allow wraps */, lineResult2);
    }

    exdata->inflow = true;
  } else {
    // Fixed paragraph.
    Line_convert_whitespace(lineResult,
                            !plainHTML && !obj->options->wrap_long_lines_p
                            /* If wrap, convert all spaces but the last in
                               a row into nbsp, otherwise all. */
                            ,
                            lineResult2);
    lineResult2.AppendLiteral("<br>");
    exdata->inflow = false;
  }  // End Fixed line

  if (!(exdata->isSig && quoting && tObj->mStripSig)) {
    int status = MimeObject_write(obj, preface.get(), preface.Length(), true);
    if (status < 0) return status;
    nsAutoCString outString;
    if (obj->options->format_out != nsMimeOutput::nsMimeMessageSaveAs ||
        !mailCharset || !*mailCharset)
      CopyUTF16toUTF8(lineResult2, outString);
    else {  // convert back to mailCharset before writing.
      rv = nsMsgI18NConvertFromUnicode(nsDependentCString(mailCharset),
                                       lineResult2, outString);
      NS_ENSURE_SUCCESS(rv, -1);
    }
    status = MimeObject_write(obj, outString.get(), outString.Length(), true);
    return status;
  }
  return 0;
}

/**
 * Maintains a small state machine with three states. "Not in tag",
 * "In tag, but not in quote" and "In quote inside a tag". It also
 * remembers what character started the quote (" or '). The state
 * variables are kept outside this function and are included as
 * parameters.
 *
 * @param in/out a_in_tag, if we are in a tag right now.
 * @param in/out a_in_quote_in_tag, if we are in a quote inside a tag.
 * @param in/out a_quote_char, the kind of quote (" or ').
 * @param in a_current_char, the next char. It decides which state
 *                           will be next.
 */
static void Update_in_tag_info(
    bool* a_in_tag,          /* IN/OUT */
    bool* a_in_quote_in_tag, /* IN/OUT */
    char16_t* a_quote_char,  /* IN/OUT (pointer to single char) */
    char16_t a_current_char) /* IN */
{
  if (*a_in_tag) {
    // Keep us informed of what's quoted so that we
    // don't end the tag too soon. For instance in
    // <font face="weird>font<name">
    if (*a_in_quote_in_tag) {
      // We are in a quote. A quote is ended by the same
      // character that started it ('...' or "...")
      if (*a_quote_char == a_current_char) {
        *a_in_quote_in_tag = false;
      }
    } else {
      // We are not currently in a quote, but we may enter
      // one right this minute.
      switch (a_current_char) {
        case '"':
        case '\'':
          *a_in_quote_in_tag = true;
          *a_quote_char = a_current_char;
          break;
        case '>':
          // Tag is ended
          *a_in_tag = false;
          break;
        default:
            // Do nothing
            ;
      }
    }
    return;
  }

  // Not in a tag.
  // Check if we are entering a tag by looking for '<'.
  // All normal occurrences of '<' should have been replaced
  // by &lt;
  if ('<' == a_current_char) {
    *a_in_tag = true;
    *a_in_quote_in_tag = false;
  }
}

/**
 * Converts whitespace to |&nbsp;|, if appropriate.
 *
 * @param in a_current_char, the char to convert.
 * @param in a_next_char, the char after the char to convert.
 * @param in a_convert_all_whitespace, if also the last whitespace
 *                                     in a sequence should be
 *                                     converted.
 * @param out a_out_string, result will be appended.
 */
static void Convert_whitespace(const char16_t a_current_char,
                               const char16_t a_next_char,
                               const bool a_convert_all_whitespace,
                               nsString& a_out_string) {
  NS_ASSERTION('\t' == a_current_char || ' ' == a_current_char,
               "Convert_whitespace got something else than a whitespace!");

  uint32_t number_of_nbsp = 0;
  uint32_t number_of_space = 1;  // Assume we're going to output one space.

  /* Output the spaces for a tab. All but the last are made into &nbsp;.
     The last is treated like a normal space.
  */
  if ('\t' == a_current_char) {
    number_of_nbsp = kSpacesForATab - 1;
  }

  if (' ' == a_next_char || '\t' == a_next_char || a_convert_all_whitespace) {
    number_of_nbsp += number_of_space;
    number_of_space = 0;
  }

  if (number_of_nbsp != 0) {
    while (number_of_nbsp--) {
      a_out_string.AppendLiteral("&nbsp;");
    }
  }

  if (number_of_space != 0) {
    while (number_of_space--) {
      // a_out_string += ' '; gives error
      a_out_string.Append(' ');
    }
  }
  return;
}

/**
 * Passes over the line and converts whitespace to |&nbsp;|, if appropriate
 *
 * @param in a_convert_all_whitespace, if also the last whitespace
 *                                     in a sequence should be
 *                                     converted.
 * @param out a_out_string, result will be appended.
 */
static nsresult Line_convert_whitespace(const nsString& a_line,
                                        const bool a_convert_all_whitespace,
                                        nsString& a_out_line) {
  bool in_tag = false;
  bool in_quote_in_tag = false;
  char16_t quote_char;

  for (uint32_t i = 0; a_line.Length() > i; i++) {
    const char16_t ic = a_line[i];  // Cache

    Update_in_tag_info(&in_tag, &in_quote_in_tag, &quote_char, ic);
    // We don't touch anything inside a tag.
    if (!in_tag) {
      if (ic == ' ' || ic == '\t') {
        // Convert the whitespace to something appropriate
        Convert_whitespace(
            ic, a_line.Length() > i + 1 ? a_line[i + 1] : '\0',
            a_convert_all_whitespace || !i,  // First char on line
            a_out_line);
      } else if (ic == '\r') {
        // strip CRs
      } else {
        a_out_line += ic;
      }
    } else {
      // In tag. Don't change anything
      a_out_line += ic;
    }
  }
  return NS_OK;
}
