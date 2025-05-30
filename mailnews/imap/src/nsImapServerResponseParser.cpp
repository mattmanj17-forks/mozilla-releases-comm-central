/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MailNewsTypes.h"
#include "nsMimeTypes.h"
#include "nsImapCore.h"
#include "nsImapProtocol.h"
#include "nsImapServerResponseParser.h"
#include "nsIImapFlagAndUidState.h"
#include "nsImapNamespace.h"
#include "nsImapUtils.h"
#include "nsMsgUtils.h"
#include "mozilla/Logging.h"

////////////////// nsImapServerResponseParser /////////////////////////

extern mozilla::LazyLogModule IMAP;  // defined in nsImapProtocol.cpp

nsImapServerResponseParser::nsImapServerResponseParser(
    nsImapProtocol& imapProtocolConnection)
    : fReportingErrors(true),
      fCurrentFolderReadOnly(false),
      fCurrentLineContainedFlagInfo(false),
      fServerIsNetscape3xServer(false),
      fSeqNumOfFirstUnseenMsg(0),
      fNumberOfExistingMessages(0),
      fNumberOfRecentMessages(0),
      fSizeOfMostRecentMessage(0),
      fTotalDownloadSize(0),
      fCurrentCommandTag(nullptr),
      mLock("nsImapServerResponseParser.mLock"),
      fSelectedMailboxName(nullptr),
      fIMAPstate(kNonAuthenticated),
      fLastChunk(false),
      fNextChunkStartsWithNewline(false),
      fServerConnection(imapProtocolConnection),
      fHostSessionList(nullptr) {
  fSearchResults = nsImapSearchResultSequence::CreateSearchResultSequence();
  fFolderAdminUrl = nullptr;
  fNetscapeServerVersionString = nullptr;
  fXSenderInfo = nullptr;
  fSupportsUserDefinedFlags = 0;
  fSettablePermanentFlags = 0;
  fCapabilityFlag = kCapabilityUndefined;
  fLastAlert = nullptr;
  fDownloadingHeaders = false;
  fGotPermanentFlags = false;
  fFolderUIDValidity = 0;
  fHighestModSeq = 0;
  fAuthChallenge = nullptr;
  fStatusUnseenMessages = 0;
  fStatusRecentMessages = 0;
  fStatusNextUID = nsMsgKey_None;
  fNextUID = nsMsgKey_None;
  fStatusExistingMessages = 0;
  fReceivedHeaderOrSizeForUID = nsMsgKey_None;
  fUtf8AcceptEnabled = false;
  fStdJunkNotJunkUseOk = false;
  fUseModSeq = false;
  fCurrentCommandFailed = false;
  fUntaggedResponse = false;
  fFetchingAllFlags = false;
  fWaitingForMoreClientInput = false;
  fCurrentCommandIsSingleMessageFetch = false;
  fSavedFlagInfo = false;
  fCurrentResponseUID = 0;
  fHighestRecordedUID = 0;
  fNumberOfTaggedResponsesExpected = 0;
  fMsgID = 0;
  fThreadID = 0;
  fLabels = nullptr;
  fFetchResponseIndex = 0;
  numberOfCharsInThisChunk = 0;
  charsReadSoFar = 0;
  fServerUnavailable = false;
}

nsImapServerResponseParser::~nsImapServerResponseParser() {
  PR_Free(fCurrentCommandTag);
  delete fSearchResults;
  PR_Free(fFolderAdminUrl);
  PR_Free(fNetscapeServerVersionString);
  PR_Free(fXSenderInfo);
  PR_Free(fLastAlert);
  PR_Free(fSelectedMailboxName);
  PR_Free(fAuthChallenge);
}

bool nsImapServerResponseParser::LastCommandSuccessful() {
  return (!CommandFailed() && !fServerConnection.DeathSignalReceived() &&
          nsImapGenericParser::LastCommandSuccessful());
}

// returns true if things look ok to continue
bool nsImapServerResponseParser::GetNextLineForParser(char** nextLine) {
  bool rv = true;
  *nextLine = fServerConnection.CreateNewLineFromSocket();
  if (fServerConnection.DeathSignalReceived() ||
      NS_FAILED(fServerConnection.GetConnectionStatus()))
    rv = false;
  // we'd really like to try to silently reconnect, but we shouldn't put this
  // message up just in the interrupt case
  if (NS_FAILED(fServerConnection.GetConnectionStatus()) &&
      !fServerConnection.DeathSignalReceived())
    fServerConnection.AlertUserEventUsingName("imapServerDisconnected");
  return rv;
}

bool nsImapServerResponseParser::CommandFailed() {
  return fCurrentCommandFailed;
}

void nsImapServerResponseParser::SetCommandFailed(bool failed) {
  fCurrentCommandFailed = failed;
}

bool nsImapServerResponseParser::UntaggedResponse() {
  return fUntaggedResponse;
}

void nsImapServerResponseParser::SetFlagState(nsIImapFlagAndUidState* state) {
  fFlagState = state;
}

uint32_t nsImapServerResponseParser::SizeOfMostRecentMessage() {
  return fSizeOfMostRecentMessage;
}

// Call this when adding a pipelined command to the session
void nsImapServerResponseParser::IncrementNumberOfTaggedResponsesExpected(
    const char* newExpectedTag) {
  fNumberOfTaggedResponsesExpected++;
  PR_Free(fCurrentCommandTag);
  fCurrentCommandTag = PL_strdup(newExpectedTag);
  if (!fCurrentCommandTag) HandleMemoryFailure();
}

void nsImapServerResponseParser::InitializeState() {
  fCurrentCommandFailed = false;
  fNumberOfRecentMessages = 0;
  fReceivedHeaderOrSizeForUID = nsMsgKey_None;
  fUntaggedResponse = false;
}

// RFC3501:  response = *(continue-req / response-data) response-done
//           response-data = "*" SP (resp-cond-state / resp-cond-bye /
//                           mailbox-data / message-data / capability-data) CRLF
//           continue-req    = "+" SP (resp-text / base64) CRLF
void nsImapServerResponseParser::ParseIMAPServerResponse(
    const char* aCurrentCommand, bool aIgnoreBadAndNOResponses,
    char* aGreetingWithCapability) {
  NS_ASSERTION(aCurrentCommand && *aCurrentCommand != '\r' &&
                   *aCurrentCommand != '\n' && *aCurrentCommand != ' ',
               "Invalid command string");
  bool sendingIdleDone = !strcmp(aCurrentCommand, "DONE" CRLF);
  if (sendingIdleDone) fWaitingForMoreClientInput = false;

  // Reinitialize the parser
  SetConnected(true);
  SetSyntaxError(false);

  // Reinitialize our state
  InitializeState();

  // the default is to not pipeline
  fNumberOfTaggedResponsesExpected = 1;
  int numberOfTaggedResponsesReceived = 0;

  nsCString copyCurrentCommand(aCurrentCommand);
  if (!fServerConnection.DeathSignalReceived()) {
    char* placeInTokenString = nullptr;
    char* tagToken = nullptr;
    const char* commandToken = nullptr;
    bool inIdle = false;
    if (!sendingIdleDone) {
      placeInTokenString = copyCurrentCommand.BeginWriting();
      tagToken = NS_strtok(WHITESPACE, &placeInTokenString);
      commandToken = NS_strtok(WHITESPACE, &placeInTokenString);
    } else
      commandToken = "DONE";
    if (tagToken) {
      PR_Free(fCurrentCommandTag);
      fCurrentCommandTag = PL_strdup(tagToken);
      if (!fCurrentCommandTag) HandleMemoryFailure();
      inIdle = commandToken && !strcmp(commandToken, "IDLE");
    }

    if (commandToken && ContinueParse())
      PreProcessCommandToken(commandToken, aCurrentCommand);

    if (ContinueParse()) {
      ResetLexAnalyzer();

      if (aGreetingWithCapability) {
        PR_FREEIF(fCurrentLine);
        fCurrentLine = aGreetingWithCapability;
      }

      // When inIdle, only one pass through "do" and "while" below occurs.
      do {
        AdvanceToNextToken();

        // untagged responses [RFC3501, Sec. 2.2.2]
        while (ContinueParse() && fNextToken && *fNextToken == '*') {
          response_data();
          if (ContinueParse()) {
            if (!fAtEndOfLine)
              SetSyntaxError(true);
            else if (!inIdle && !fCurrentCommandFailed &&
                     !aGreetingWithCapability)
              AdvanceToNextToken();
          }
          // For checking expected response to IDLE command below and
          // for checking if an untagged response occurred by the caller.
          fUntaggedResponse = true;
        }

        // command continuation request [RFC3501, Sec. 7.5]
        if (ContinueParse() && fNextToken &&
            *fNextToken == '+')  // never pipeline APPEND or AUTHENTICATE
        {
          NS_ASSERTION(
              (fNumberOfTaggedResponsesExpected -
               numberOfTaggedResponsesReceived) == 1,
              " didn't get the number of tagged responses we expected");
          numberOfTaggedResponsesReceived = fNumberOfTaggedResponsesExpected;
          if (commandToken && !PL_strcasecmp(commandToken, "authenticate") &&
              placeInTokenString &&
              (!PL_strncasecmp(placeInTokenString, "CRAM-MD5",
                               strlen("CRAM-MD5")) ||
               !PL_strncasecmp(placeInTokenString, "NTLM", strlen("NTLM")) ||
               !PL_strncasecmp(placeInTokenString, "GSSAPI",
                               strlen("GSSAPI")) ||
               !PL_strncasecmp(placeInTokenString, "MSN", strlen("MSN")))) {
            // we need to store the challenge from the server if we are using
            // CRAM-MD5 or NTLM.
            authChallengeResponse_data();
          }
        } else
          numberOfTaggedResponsesReceived++;

        if (numberOfTaggedResponsesReceived < fNumberOfTaggedResponsesExpected)
          response_tagged();

      } while (
          ContinueParse() && !inIdle &&
          (numberOfTaggedResponsesReceived < fNumberOfTaggedResponsesExpected));

      // check and see if the server is waiting for more input
      // it's possible that we ate this + while parsing certain responses (like
      // cram data), in these cases, the parsing routine for that specific
      // command will manually set fWaitingForMoreClientInput so we don't lose
      // that information....
      if ((fNextToken && *fNextToken == '+') || inIdle) {
        if (inIdle &&
            !((fNextToken && *fNextToken == '+') || fUntaggedResponse)) {
          // IDLE "response" + will not be "eaten" as described above since it
          // is not an authentication response. So if IDLE response does not
          // begin with '+' (continuation) or '*' (untagged and probably useful
          // response) then something is wrong and it is probably a tagged
          // NO or BAD due to transient error or bad configuration of the
          // server.
          if (!PL_strcmp(fCurrentCommandTag, fNextToken)) {
            response_tagged();
          } else {
            // Expected tag doesn't match the received tag. Not good, start
            // over.
            response_fatal();
          }
          // Show an alert notification containing the server response to bad
          // IDLE.
          fServerConnection.AlertUserEventFromServer(fCurrentLine, true);
        } else {
          fWaitingForMoreClientInput = true;
        }
      }
      // if we aren't still waiting for more input....
      else if (!fWaitingForMoreClientInput && !aGreetingWithCapability) {
        if (ContinueParse()) response_done();

        if (ContinueParse() && !CommandFailed()) {
          // a successful command may change the eIMAPstate
          ProcessOkCommand(commandToken);
        } else if (CommandFailed()) {
          // a failed command may change the eIMAPstate
          ProcessBadCommand(commandToken);
          if (fReportingErrors && !aIgnoreBadAndNOResponses)
            fServerConnection.AlertUserEventFromServer(fCurrentLine, false);
        }
      }
    }
  } else
    SetConnected(false);
}

void nsImapServerResponseParser::HandleMemoryFailure() {
  fServerConnection.AlertUserEventUsingName("imapOutOfMemory");
  nsImapGenericParser::HandleMemoryFailure();
}

// SEARCH is the only command that requires pre-processing for now.
// others will be added here.
void nsImapServerResponseParser::PreProcessCommandToken(
    const char* commandToken, const char* currentCommand) {
  fCurrentCommandIsSingleMessageFetch = false;
  fWaitingForMoreClientInput = false;

  if (!PL_strcasecmp(commandToken, "SEARCH"))
    fSearchResults->ResetSequence();
  else if (!PL_strcasecmp(commandToken, "SELECT") && currentCommand) {
    // the mailbox name must be quoted, so strip the quotes
    const char* openQuote = PL_strchr(currentCommand, '"');
    NS_ASSERTION(openQuote, "expected open quote in imap server response");
    if (!openQuote) {  // ill formed select command
      openQuote = PL_strchr(currentCommand, ' ');
    }
    {
      mozilla::MutexAutoLock mon(mLock);
      PR_Free(fSelectedMailboxName);
      fSelectedMailboxName = PL_strdup(openQuote + 1);
      if (fSelectedMailboxName) {
        // strip the escape chars and the ending quote
        char* currentChar = fSelectedMailboxName;
        while (*currentChar) {
          if (*currentChar == '\\') {
            PL_strcpy(currentChar, currentChar + 1);
            currentChar++;  // skip what we are escaping
          } else if (*currentChar == '\"')
            *currentChar = 0;  // end quote
          else
            currentChar++;
        }
      } else {
        HandleMemoryFailure();
      }
    }

    // we don't want bogus info for this new box
    // delete fFlagState;  // not our object
    // fFlagState = nullptr;
  } else if (!PL_strcasecmp(commandToken, "CLOSE")) {
    return;  // just for debugging
    // we don't want bogus info outside the selected state
    // delete fFlagState;  // not our object
    // fFlagState = nullptr;
  } else if (!PL_strcasecmp(commandToken, "UID")) {
    nsCString copyCurrentCommand(currentCommand);
    if (!fServerConnection.DeathSignalReceived()) {
      char* placeInTokenString = copyCurrentCommand.BeginWriting();
      (void)NS_strtok(WHITESPACE, &placeInTokenString);  // skip tag token
      (void)NS_strtok(WHITESPACE, &placeInTokenString);  // skip uid token
      char* fetchToken = NS_strtok(WHITESPACE, &placeInTokenString);
      if (!PL_strcasecmp(fetchToken, "FETCH")) {
        char* uidStringToken = NS_strtok(WHITESPACE, &placeInTokenString);
        // , and : are uid delimiters
        if (!PL_strchr(uidStringToken, ',') && !PL_strchr(uidStringToken, ':'))
          fCurrentCommandIsSingleMessageFetch = true;
      }
    }
  }
}

const char* nsImapServerResponseParser::GetSelectedMailboxName() {
  mozilla::MutexAutoLock mon(mLock);
  return fSelectedMailboxName;
}

nsImapSearchResultIterator*
nsImapServerResponseParser::CreateSearchResultIterator() {
  return new nsImapSearchResultIterator(*fSearchResults);
}

nsImapServerResponseParser::eIMAPstate
nsImapServerResponseParser::GetIMAPstate() {
  return fIMAPstate;
}

void nsImapServerResponseParser::PreauthSetAuthenticatedState() {
  fIMAPstate = kAuthenticated;
}

void nsImapServerResponseParser::ProcessOkCommand(const char* commandToken) {
  if (!PL_strcasecmp(commandToken, "LOGIN") ||
      !PL_strcasecmp(commandToken, "AUTHENTICATE"))
    fIMAPstate = kAuthenticated;
  else if (!PL_strcasecmp(commandToken, "LOGOUT"))
    fIMAPstate = kNonAuthenticated;
  else if (!PL_strcasecmp(commandToken, "SELECT") ||
           !PL_strcasecmp(commandToken, "EXAMINE"))
    fIMAPstate = kFolderSelected;
  else if (!PL_strcasecmp(commandToken, "CLOSE")) {
    mozilla::MutexAutoLock mon(mLock);
    fIMAPstate = kAuthenticated;
    // we no longer have a selected mailbox.
    PR_FREEIF(fSelectedMailboxName);
    fSelectedMailboxName = nullptr;
  } else if ((!PL_strcasecmp(commandToken, "LIST")) ||
             (!PL_strcasecmp(commandToken, "LSUB")) ||
             (!PL_strcasecmp(commandToken, "XLIST"))) {
    // fServerConnection.MailboxDiscoveryFinished();
    // This used to be reporting that we were finished
    // discovering folders for each time we issued a
    // LIST or LSUB.  So if we explicitly listed the
    // INBOX, or Trash, or namespaces, we would get multiple
    // "done" states, even though we hadn't finished.
    // Move this to be called from the connection object
    // itself.
  } else if (!PL_strcasecmp(commandToken, "FETCH")) {
    if (!fZeroLengthMessageUidString.IsEmpty()) {
      // "Deleting zero length message");
      fServerConnection.Store(fZeroLengthMessageUidString, "+Flags (\\Deleted)",
                              true);
      if (LastCommandSuccessful()) fServerConnection.Expunge();

      fZeroLengthMessageUidString.Truncate();
    }
  } else if (!PL_strcasecmp(commandToken, "GETQUOTAROOT")) {
    if (LastCommandSuccessful()) {
      nsCString str;
      fServerConnection.UpdateFolderQuotaData(kValidateQuota, str, 0, 0);
    }
  }
}

void nsImapServerResponseParser::ProcessBadCommand(const char* commandToken) {
  if (!PL_strcasecmp(commandToken, "LOGIN") ||
      !PL_strcasecmp(commandToken, "AUTHENTICATE"))
    fIMAPstate = kNonAuthenticated;
  else if (!PL_strcasecmp(commandToken, "LOGOUT"))
    fIMAPstate = kNonAuthenticated;  // ??
  else if (!PL_strcasecmp(commandToken, "SELECT") ||
           !PL_strcasecmp(commandToken, "EXAMINE"))
    fIMAPstate = kAuthenticated;  // nothing selected
  else if (!PL_strcasecmp(commandToken, "CLOSE"))
    fIMAPstate = kAuthenticated;  // nothing selected
}

// RFC3501:  response-data = "*" SP (resp-cond-state / resp-cond-bye /
//                           mailbox-data / message-data / capability-data) CRLF
// These are ``untagged'' responses [RFC3501, Sec. 2.2.2]
/*
 The RFC1730 grammar spec did not allow one symbol look ahead to determine
 between mailbox_data / message_data so I combined the numeric possibilities
 of mailbox_data and all of message_data into numeric_mailbox_data.

 It is assumed that the initial "*" is already consumed before calling this
 method. The production implemented here is
         response_data   ::= (resp_cond_state / resp_cond_bye /
                              mailbox_data / numeric_mailbox_data /
                              capability_data)
                              CRLF
*/
void nsImapServerResponseParser::response_data() {
  AdvanceToNextToken();

  if (ContinueParse()) {
    // Instead of comparing lots of strings and make function calls, try to
    // pre-flight the possibilities based on the first letter of the token.
    switch (NS_ToUpper(fNextToken[0])) {
      case 'O':  // OK
        if (NS_ToUpper(fNextToken[1]) == 'K')
          resp_cond_state(false);
        else
          SetSyntaxError(true);
        break;
      case 'N':  // NO
        if (NS_ToUpper(fNextToken[1]) == 'O')
          resp_cond_state(false);
        else if (!PL_strcasecmp(fNextToken, "NAMESPACE"))
          namespace_data();
        else
          SetSyntaxError(true);
        break;
      case 'B':  // BAD
        if (!PL_strcasecmp(fNextToken, "BAD"))
          resp_cond_state(false);
        else if (!PL_strcasecmp(fNextToken, "BYE"))
          resp_cond_bye();
        else
          SetSyntaxError(true);
        break;
      case 'F':
        if (!PL_strcasecmp(fNextToken, "FLAGS"))
          mailbox_data();
        else
          SetSyntaxError(true);
        break;
      case 'P':
        if (PL_strcasecmp(fNextToken, "PERMANENTFLAGS"))
          mailbox_data();
        else
          SetSyntaxError(true);
        break;
      case 'L':
        if (!PL_strcasecmp(fNextToken, "LIST") ||
            !PL_strcasecmp(fNextToken, "LSUB"))
          mailbox_data();
        else if (!PL_strcasecmp(fNextToken, "LANGUAGE"))
          language_data();
        else
          SetSyntaxError(true);
        break;
      case 'M':
        if (!PL_strcasecmp(fNextToken, "MAILBOX"))
          mailbox_data();
        else if (!PL_strcasecmp(fNextToken, "MYRIGHTS"))
          myrights_data(false);
        else
          SetSyntaxError(true);
        break;
      case 'S':
        if (!PL_strcasecmp(fNextToken, "SEARCH"))
          mailbox_data();
        else if (!PL_strcasecmp(fNextToken, "STATUS")) {
          AdvanceToNextToken();
          if (fNextToken) {
            char* mailboxName = CreateAstring();
            PL_strfree(mailboxName);
          }
          while (ContinueParse() && !fAtEndOfLine) {
            AdvanceToNextToken();
            if (!fNextToken) break;

            if (*fNextToken == '(') fNextToken++;
            if (!PL_strcasecmp(fNextToken, "UIDNEXT")) {
              AdvanceToNextToken();
              if (fNextToken) {
                fStatusNextUID = strtoul(fNextToken, nullptr, 10);
                // if this token ends in ')', then it is the last token
                // else we advance
                if (*(fNextToken + strlen(fNextToken) - 1) == ')')
                  fNextToken += strlen(fNextToken) - 1;
              }
            } else if (!PL_strcasecmp(fNextToken, "MESSAGES")) {
              AdvanceToNextToken();
              if (fNextToken) {
                fStatusExistingMessages = strtoul(fNextToken, nullptr, 10);
                // if this token ends in ')', then it is the last token
                // else we advance
                if (*(fNextToken + strlen(fNextToken) - 1) == ')')
                  fNextToken += strlen(fNextToken) - 1;
              }
            } else if (!PL_strcasecmp(fNextToken, "UNSEEN")) {
              AdvanceToNextToken();
              if (fNextToken) {
                fStatusUnseenMessages = strtoul(fNextToken, nullptr, 10);
                // if this token ends in ')', then it is the last token
                // else we advance
                if (*(fNextToken + strlen(fNextToken) - 1) == ')')
                  fNextToken += strlen(fNextToken) - 1;
              }
            } else if (!PL_strcasecmp(fNextToken, "RECENT")) {
              AdvanceToNextToken();
              if (fNextToken) {
                fStatusRecentMessages = strtoul(fNextToken, nullptr, 10);
                // if this token ends in ')', then it is the last token
                // else we advance
                if (*(fNextToken + strlen(fNextToken) - 1) == ')')
                  fNextToken += strlen(fNextToken) - 1;
              }
            } else if (*fNextToken == ')')
              break;
            else if (!fAtEndOfLine)
              SetSyntaxError(true);
          }
        } else
          SetSyntaxError(true);
        break;
      case 'C':
        if (!PL_strcasecmp(fNextToken, "CAPABILITY"))
          capability_data();
        else
          SetSyntaxError(true);
        break;
      case 'V':
        if (!PL_strcasecmp(fNextToken, "VERSION")) {
          // figure out the version of the Netscape server here
          PR_FREEIF(fNetscapeServerVersionString);
          AdvanceToNextToken();
          if (!fNextToken)
            SetSyntaxError(true);
          else {
            fNetscapeServerVersionString = CreateAstring();
            AdvanceToNextToken();
            if (fNetscapeServerVersionString) {
              fServerIsNetscape3xServer =
                  (*fNetscapeServerVersionString == '3');
            }
          }
          skip_to_CRLF();
        } else
          SetSyntaxError(true);
        break;
      case 'A':
        if (!PL_strcasecmp(fNextToken, "ACL")) {
          acl_data();
        } else if (!PL_strcasecmp(fNextToken, "ACCOUNT-URL")) {
          fMailAccountUrl.Truncate();
          AdvanceToNextToken();
          if (!fNextToken)
            SetSyntaxError(true);
          else {
            fMailAccountUrl.Adopt(CreateAstring());
            AdvanceToNextToken();
          }
        } else
          SetSyntaxError(true);
        break;
      case 'E':
        if (!PL_strcasecmp(fNextToken, "ENABLED")) enable_data();
        break;
      case 'X':
        if (!PL_strcasecmp(fNextToken, "XSERVERINFO"))
          xserverinfo_data();
        else if (!PL_strcasecmp(fNextToken, "XMAILBOXINFO"))
          xmailboxinfo_data();
        else if (!PL_strcasecmp(fNextToken, "XLIST"))
          mailbox_data();
        else {
          // check if custom command
          nsAutoCString customCommand;
          fServerConnection.GetCurrentUrl()->GetCommand(customCommand);
          if (customCommand.Equals(fNextToken)) {
            nsAutoCString customCommandResponse;
            while (Connected() && !fAtEndOfLine) {
              AdvanceToNextToken();
              customCommandResponse.Append(fNextToken);
              customCommandResponse.Append(' ');
            }
            fServerConnection.GetCurrentUrl()->SetCustomCommandResult(
                customCommandResponse);
          } else
            SetSyntaxError(true);
        }
        break;
      case 'Q':
        if (!PL_strcasecmp(fNextToken, "QUOTAROOT") ||
            !PL_strcasecmp(fNextToken, "QUOTA"))
          quota_data();
        else
          SetSyntaxError(true);
        break;
      case 'I':
        id_data();
        break;
      default:
        if (IsNumericString(fNextToken))
          numeric_mailbox_data();
        else
          SetSyntaxError(true);
        break;
    }

    if (ContinueParse()) PostProcessEndOfLine();
  }
}

void nsImapServerResponseParser::PostProcessEndOfLine() {
  // for now we only have to do one thing here
  // a fetch response to a 'uid store' command might return the flags
  // before it returns the uid of the message.  So we need both before
  // we report the new flag info to the front end

  // also check and be sure that there was a UID in the current response
  if (fCurrentLineContainedFlagInfo && CurrentResponseUID()) {
    fCurrentLineContainedFlagInfo = false;
    nsCString customFlags;
    fFlagState->GetCustomFlags(CurrentResponseUID(),
                               getter_Copies(customFlags));
    fServerConnection.NotifyMessageFlags(fSavedFlagInfo, customFlags,
                                         CurrentResponseUID(), fHighestModSeq);
  }
}

/*
 mailbox_data    ::=  "FLAGS" SPACE flag_list /
                               "LIST" SPACE mailbox_list /
                               "LSUB" SPACE mailbox_list /
                               "XLIST" SPACE mailbox_list /
                               "MAILBOX" SPACE text /
                               "SEARCH" [SPACE 1#nz_number] /
                               number SPACE "EXISTS" / number SPACE "RECENT"

This production was changed to accommodate predictive parsing

 mailbox_data    ::=  "FLAGS" SPACE flag_list /
                               "LIST" SPACE mailbox_list /
                               "LSUB" SPACE mailbox_list /
                               "XLIST" SPACE mailbox_list /
                               "MAILBOX" SPACE text /
                               "SEARCH" [SPACE 1#nz_number]
*/
void nsImapServerResponseParser::mailbox_data() {
  if (!PL_strcasecmp(fNextToken, "FLAGS")) {
    // this handles the case where we got the permanent flags response
    // before the flags response, in which case, we want to ignore these flags.
    if (fGotPermanentFlags)
      skip_to_CRLF();
    else
      parse_folder_flags(true);
  } else if (!PL_strcasecmp(fNextToken, "LIST") ||
             !PL_strcasecmp(fNextToken, "XLIST")) {
    AdvanceToNextToken();
    if (ContinueParse()) mailbox_list(false);
  } else if (!PL_strcasecmp(fNextToken, "LSUB")) {
    AdvanceToNextToken();
    if (ContinueParse()) mailbox_list(true);
  } else if (!PL_strcasecmp(fNextToken, "MAILBOX"))
    skip_to_CRLF();
  else if (!PL_strcasecmp(fNextToken, "SEARCH")) {
    fSearchResults->AddSearchResultLine(fCurrentLine);
    fServerConnection.NotifySearchHit(fCurrentLine);
    skip_to_CRLF();
  }
}

/*
 mailbox_list    ::= "(" #("\Marked" / "\Noinferiors" /
                              "\Noselect" / "\Unmarked" / flag_extension) ")"
                              SPACE (<"> QUOTED_CHAR <"> / nil) SPACE mailbox
*/

void nsImapServerResponseParser::mailbox_list(bool discoveredFromLsub) {
  RefPtr<nsImapMailboxSpec> boxSpec = new nsImapMailboxSpec;
  boxSpec->mFolderSelected = false;
  boxSpec->mBoxFlags = kNoFlags;
  boxSpec->mAllocatedPathName.Truncate();
  boxSpec->mHostName.Truncate();
  boxSpec->mConnection = &fServerConnection;
  boxSpec->mFlagState = nullptr;
  boxSpec->mDiscoveredFromLsub = discoveredFromLsub;
  boxSpec->mOnlineVerified = true;
  boxSpec->mBoxFlags &= ~kNameSpace;

  bool endOfFlags = false;
  fNextToken++;  // eat the first "("
  do {
    if (!PL_strncasecmp(fNextToken, "\\Marked", 7))
      boxSpec->mBoxFlags |= kMarked;
    else if (!PL_strncasecmp(fNextToken, "\\Unmarked", 9))
      boxSpec->mBoxFlags |= kUnmarked;
    else if (!PL_strncasecmp(fNextToken, "\\Noinferiors", 12)) {
      boxSpec->mBoxFlags |= kNoinferiors;
      // RFC 5258 \Noinferiors implies \HasNoChildren
      if (fCapabilityFlag & kHasListExtendedCapability)
        boxSpec->mBoxFlags |= kHasNoChildren;
    } else if (!PL_strncasecmp(fNextToken, "\\Noselect", 9))
      boxSpec->mBoxFlags |= kNoselect;
    else if (!PL_strncasecmp(fNextToken, "\\Drafts", 7))
      boxSpec->mBoxFlags |= kImapDrafts;
    else if (!PL_strncasecmp(fNextToken, "\\Trash", 6))
      boxSpec->mBoxFlags |= kImapXListTrash;
    else if (!PL_strncasecmp(fNextToken, "\\Sent", 5))
      boxSpec->mBoxFlags |= kImapSent;
    else if (!PL_strncasecmp(fNextToken, "\\Spam", 5) ||
             !PL_strncasecmp(fNextToken, "\\Junk", 5))
      boxSpec->mBoxFlags |= kImapSpam;
    else if (!PL_strncasecmp(fNextToken, "\\Archive", 8))
      boxSpec->mBoxFlags |= kImapArchive;
    else if (!PL_strncasecmp(fNextToken, "\\All", 4) ||
             !PL_strncasecmp(fNextToken, "\\AllMail", 8))
      boxSpec->mBoxFlags |= kImapAllMail;
    else if (!PL_strncasecmp(fNextToken, "\\Inbox", 6))
      boxSpec->mBoxFlags |= kImapInbox;
    else if (!PL_strncasecmp(fNextToken, "\\NonExistent", 11)) {
      boxSpec->mBoxFlags |= kNonExistent;
      // RFC 5258 \NonExistent implies \Noselect
      boxSpec->mBoxFlags |= kNoselect;
    } else if (!PL_strncasecmp(fNextToken, "\\Subscribed", 10))
      boxSpec->mBoxFlags |= kSubscribed;
    else if (!PL_strncasecmp(fNextToken, "\\Remote", 6))
      boxSpec->mBoxFlags |= kRemote;
    else if (!PL_strncasecmp(fNextToken, "\\HasChildren", 11))
      boxSpec->mBoxFlags |= kHasChildren;
    else if (!PL_strncasecmp(fNextToken, "\\HasNoChildren", 13))
      boxSpec->mBoxFlags |= kHasNoChildren;
    // we ignore flag other extensions

    endOfFlags = *(fNextToken + strlen(fNextToken) - 1) == ')';
    AdvanceToNextToken();
  } while (!endOfFlags && ContinueParse());

  if (ContinueParse()) {
    if (*fNextToken == '"') {
      fNextToken++;
      if (*fNextToken == '\\')  // handle escaped char
        boxSpec->mHierarchySeparator = *(fNextToken + 1);
      else
        boxSpec->mHierarchySeparator = *fNextToken;
    } else  // likely NIL.  Discovered late in 4.02 that we do not handle
            // literals here (e.g. {10} <10 chars>), although this is almost
            // impossibly unlikely
      boxSpec->mHierarchySeparator = kOnlineHierarchySeparatorNil;
    AdvanceToNextToken();
    if (ContinueParse()) mailbox(boxSpec);
  }
}

/* mailbox         ::= "INBOX" / astring
 */
void nsImapServerResponseParser::mailbox(nsImapMailboxSpec* boxSpec) {
  nsCString boxname;
  const char* serverKey = fServerConnection.GetImapServerKey();
  bool xlistInbox = boxSpec->mBoxFlags & kImapInbox;

  if (!PL_strcasecmp(fNextToken, "INBOX") || xlistInbox) {
    boxname = "INBOX"_ns;
    if (xlistInbox) PR_Free(CreateAstring());
    AdvanceToNextToken();
  } else {
    boxname.Adopt(CreateAstring());
    AdvanceToNextToken();
  }

  if (!boxname.IsEmpty() && fHostSessionList) {
    fHostSessionList->SetNamespaceHierarchyDelimiterFromMailboxForHost(
        serverKey, boxname.get(), boxSpec->mHierarchySeparator);

    nsImapNamespace* ns = nullptr;
    fHostSessionList->GetNamespaceForMailboxForHost(serverKey, boxname.get(),
                                                    ns);
    if (ns) {
      switch (ns->GetType()) {
        case kPersonalNamespace:
          boxSpec->mBoxFlags |= kPersonalMailbox;
          break;
        case kPublicNamespace:
          boxSpec->mBoxFlags |= kPublicMailbox;
          break;
        case kOtherUsersNamespace:
          boxSpec->mBoxFlags |= kOtherUsersMailbox;
          break;
        default:  // (kUnknownNamespace)
          break;
      }
      boxSpec->mNamespaceForFolder = ns;
    }
  }

  if (boxname.IsEmpty()) {
    if (!fServerConnection.DeathSignalReceived()) HandleMemoryFailure();
  } else if (boxSpec->mConnection && boxSpec->mConnection->GetCurrentUrl()) {
    boxSpec->mConnection->GetCurrentUrl()->AllocateCanonicalPath(
        boxname, boxSpec->mHierarchySeparator, boxSpec->mAllocatedPathName);
    nsIURI* aURL = nullptr;
    boxSpec->mConnection->GetCurrentUrl()->QueryInterface(NS_GET_IID(nsIURI),
                                                          (void**)&aURL);
    if (aURL) aURL->GetHost(boxSpec->mHostName);

    NS_IF_RELEASE(aURL);
    // storage for the boxSpec is now owned by server connection
    fServerConnection.DiscoverMailboxSpec(boxSpec);

    // if this was cancelled by the user,then we sure don't want to
    // send more mailboxes their way
    if (NS_FAILED(fServerConnection.GetConnectionStatus())) SetConnected(false);
  }
}

/*
 message_data    ::= nz_number SPACE ("EXPUNGE" /
                              ("FETCH" SPACE msg_fetch) / msg_obsolete)

was changed to

numeric_mailbox_data ::=  number SPACE "EXISTS" / number SPACE "RECENT"
 / nz_number SPACE ("EXPUNGE" /
                              ("FETCH" SPACE msg_fetch) / msg_obsolete)

*/
void nsImapServerResponseParser::numeric_mailbox_data() {
  int32_t tokenNumber = atoi(fNextToken);
  AdvanceToNextToken();

  if (ContinueParse()) {
    if (!PL_strcasecmp(fNextToken, "FETCH")) {
      fFetchResponseIndex = tokenNumber;
      AdvanceToNextToken();
      if (ContinueParse()) msg_fetch();
    } else if (!PL_strcasecmp(fNextToken, "EXISTS")) {
      fNumberOfExistingMessages = tokenNumber;
      AdvanceToNextToken();
    } else if (!PL_strcasecmp(fNextToken, "RECENT")) {
      fNumberOfRecentMessages = tokenNumber;
      AdvanceToNextToken();
    } else if (!PL_strcasecmp(fNextToken, "EXPUNGE")) {
      if (!fServerConnection.GetIgnoreExpunges())
        fFlagState->ExpungeByIndex((uint32_t)tokenNumber);
      skip_to_CRLF();
    } else
      msg_obsolete();
  }
}

/*
msg_fetch       ::= "(" 1#("BODY" SPACE body /
"BODYSTRUCTURE" SPACE body /
"BODY[" section "]" SPACE nstring /
"ENVELOPE" SPACE envelope /
"FLAGS" SPACE "(" #(flag / "\Recent") ")" /
"INTERNALDATE" SPACE date_time /
"MODSEQ" SPACE "(" nz_number ")" /
"RFC822" [".HEADER" / ".TEXT"] SPACE nstring /
"RFC822.SIZE" SPACE number /
"UID" SPACE uniqueid) ")"

*/

void nsImapServerResponseParser::msg_fetch() {
  bool bNeedEndMessageDownload = false;

  // we have not seen a uid response or flags for this fetch, yet
  fCurrentResponseUID = 0;
  fCurrentLineContainedFlagInfo = false;
  fSizeOfMostRecentMessage = 0;
  // show any incremental progress, for instance, for header downloading
  fServerConnection.ShowProgress();

  fNextToken++;  // eat the '(' character

  // some of these productions are ignored for now
  while (ContinueParse() && (*fNextToken != ')')) {
    if (!PL_strcasecmp(fNextToken, "FLAGS")) {
      if (fCurrentResponseUID == 0)
        fFlagState->GetUidOfMessage(fFetchResponseIndex - 1,
                                    &fCurrentResponseUID);

      AdvanceToNextToken();
      if (ContinueParse()) flags();

      if (ContinueParse()) {  // eat the closing ')'
        fNextToken++;
        // there may be another ')' to close out
        // msg_fetch.  If there is then don't advance
        if (*fNextToken != ')') AdvanceToNextToken();
      }
    } else if (!PL_strcasecmp(fNextToken, "UID")) {
      AdvanceToNextToken();
      if (ContinueParse()) {
        fCurrentResponseUID = strtoul(fNextToken, nullptr, 10);
        if (fCurrentResponseUID > fHighestRecordedUID)
          fHighestRecordedUID = fCurrentResponseUID;
        // size came before UID
        if (fSizeOfMostRecentMessage)
          fReceivedHeaderOrSizeForUID = CurrentResponseUID();
        // if this token ends in ')', then it is the last token
        // else we advance
        char lastTokenChar = *(fNextToken + strlen(fNextToken) - 1);
        if (lastTokenChar == ')')
          fNextToken += strlen(fNextToken) - 1;
        else if (lastTokenChar < '0' || lastTokenChar > '9') {
          // GIANT HACK
          // this is a corrupt uid - see if it's pre 5.08 Zimbra omitting
          // a space between the UID and MODSEQ
          if (strlen(fNextToken) > 6 &&
              !strcmp("MODSEQ", fNextToken + strlen(fNextToken) - 6))
            fNextToken += strlen(fNextToken) - 6;
        } else
          AdvanceToNextToken();
      }
    } else if (!PL_strcasecmp(fNextToken, "MODSEQ")) {
      AdvanceToNextToken();
      if (ContinueParse()) {
        fNextToken++;  // eat '('
        uint64_t modSeq = ParseUint64Str(fNextToken);
        if (modSeq > fHighestModSeq) fHighestModSeq = modSeq;

        if (PL_strcasestr(fNextToken, ")")) {
          // eat token chars until we get the ')'
          fNextToken = strchr(fNextToken, ')');
          if (fNextToken) {
            fNextToken++;
            if (*fNextToken != ')') AdvanceToNextToken();
          } else
            SetSyntaxError(true);
        } else {
          SetSyntaxError(true);
        }
      }
    } else if (!PL_strcasecmp(fNextToken, "RFC822") ||
               !PL_strcasecmp(fNextToken, "RFC822.HEADER") ||
               !PL_strncasecmp(fNextToken, "BODY[HEADER", 11) ||
               !PL_strncasecmp(fNextToken, "BODY[]", 6) ||
               !PL_strcasecmp(fNextToken, "RFC822.TEXT") ||
               (!PL_strncasecmp(fNextToken, "BODY[", 5) &&
                PL_strstr(fNextToken, "HEADER"))) {
      if (fCurrentResponseUID == 0)
        fFlagState->GetUidOfMessage(fFetchResponseIndex - 1,
                                    &fCurrentResponseUID);

      if (!PL_strcasecmp(fNextToken, "RFC822.HEADER") ||
          !PL_strcasecmp(fNextToken, "BODY[HEADER]")) {
        // all of this message's headers
        AdvanceToNextToken();
        fDownloadingHeaders = true;
        BeginMessageDownload(MESSAGE_RFC822);  // initialize header parser
        bNeedEndMessageDownload = false;
        if (ContinueParse()) msg_fetch_headers(nullptr);
      } else if (!PL_strncasecmp(fNextToken, "BODY[HEADER.FIELDS", 19)) {
        fDownloadingHeaders = true;
        BeginMessageDownload(MESSAGE_RFC822);  // initialize header parser
        // specific message header fields
        while (ContinueParse() && fNextToken[strlen(fNextToken) - 1] != ']')
          AdvanceToNextToken();
        if (ContinueParse()) {
          bNeedEndMessageDownload = false;
          AdvanceToNextToken();
          if (ContinueParse()) msg_fetch_headers(nullptr);
        }
      } else {
        char* whereHeader = PL_strstr(fNextToken, "HEADER");
        if (whereHeader) {
          const char* startPartNum = fNextToken + 5;
          if (whereHeader > startPartNum) {
            int32_t partLength =
                whereHeader - startPartNum - 1;  //-1 for the dot!
            char* partNum = (char*)PR_CALLOC((partLength + 1) * sizeof(char));
            if (partNum) {
              PL_strncpy(partNum, startPartNum, partLength);
              if (ContinueParse()) {
                if (PL_strstr(fNextToken, "FIELDS")) {
                  while (ContinueParse() &&
                         fNextToken[strlen(fNextToken) - 1] != ']')
                    AdvanceToNextToken();
                }
                if (ContinueParse()) {
                  AdvanceToNextToken();
                  if (ContinueParse()) msg_fetch_headers(partNum);
                }
              }
              PR_Free(partNum);
            }
          } else
            SetSyntaxError(true);
        } else {
          fDownloadingHeaders = false;

          bool chunk = false;
          int32_t origin = 0;
          if (!PL_strncasecmp(fNextToken, "BODY[]<", 7)) {
            char* tokenCopy = 0;
            tokenCopy = PL_strdup(fNextToken);
            if (tokenCopy) {
              char* originString =
                  tokenCopy + 7;  // where the byte number starts
              char* closeBracket = PL_strchr(tokenCopy, '>');
              if (closeBracket && originString && *originString) {
                *closeBracket = 0;
                origin = atoi(originString);
                chunk = true;
              }
              PR_Free(tokenCopy);
            }
          }

          AdvanceToNextToken();
          if (ContinueParse()) {
            msg_fetch_content(chunk, origin, MESSAGE_RFC822);
          }
        }
      }
    } else if (!PL_strcasecmp(fNextToken, "RFC822.SIZE")) {
      AdvanceToNextToken();
      if (ContinueParse()) {
        bool sendEndMsgDownload =
            (GetDownloadingHeaders() &&
             fReceivedHeaderOrSizeForUID == CurrentResponseUID());
        fSizeOfMostRecentMessage = strtoul(fNextToken, nullptr, 10);
        fReceivedHeaderOrSizeForUID = CurrentResponseUID();
        if (sendEndMsgDownload) {
          fServerConnection.NormalMessageEndDownload();
          fReceivedHeaderOrSizeForUID = nsMsgKey_None;
        }

        if (fSizeOfMostRecentMessage == 0 && CurrentResponseUID()) {
          // on no, bogus Netscape 2.0 mail server bug
          if (!fZeroLengthMessageUidString.IsEmpty())
            fZeroLengthMessageUidString += ",";

          fZeroLengthMessageUidString.AppendInt(CurrentResponseUID());
        }

        // if this token ends in ')', then it is the last token
        // else we advance
        if (*(fNextToken + strlen(fNextToken) - 1) == ')')
          fNextToken += strlen(fNextToken) - 1;
        else
          AdvanceToNextToken();
      }
    } else if (!PL_strcasecmp(fNextToken, "XSENDER")) {
      PR_FREEIF(fXSenderInfo);
      AdvanceToNextToken();
      if (!fNextToken)
        SetSyntaxError(true);
      else {
        fXSenderInfo = CreateAstring();
        AdvanceToNextToken();
      }
    } else if (!PL_strcasecmp(fNextToken, "X-GM-MSGID")) {
      AdvanceToNextToken();
      if (!fNextToken)
        SetSyntaxError(true);
      else {
        fMsgID = CreateAtom();
        AdvanceToNextToken();
        nsCString msgIDValue;
        msgIDValue.Assign(fMsgID);
        if (fCurrentResponseUID == 0)
          fFlagState->GetUidOfMessage(fFetchResponseIndex - 1,
                                      &fCurrentResponseUID);
        fFlagState->SetCustomAttribute(fCurrentResponseUID, "X-GM-MSGID"_ns,
                                       msgIDValue);
        PR_FREEIF(fMsgID);
      }
    } else if (!PL_strcasecmp(fNextToken, "X-GM-THRID")) {
      AdvanceToNextToken();
      if (!fNextToken)
        SetSyntaxError(true);
      else {
        fThreadID = CreateAtom();
        AdvanceToNextToken();
        nsCString threadIDValue;
        threadIDValue.Assign(fThreadID);
        if (fCurrentResponseUID == 0)
          fFlagState->GetUidOfMessage(fFetchResponseIndex - 1,
                                      &fCurrentResponseUID);
        fFlagState->SetCustomAttribute(fCurrentResponseUID, "X-GM-THRID"_ns,
                                       threadIDValue);
        PR_FREEIF(fThreadID);
      }
    } else if (!PL_strcasecmp(fNextToken, "X-GM-LABELS")) {
      AdvanceToNextToken();
      if (!fNextToken)
        SetSyntaxError(true);
      else {
        fLabels = CreateParenGroup();
        nsCString labelsValue;
        labelsValue.Assign(fLabels);
        labelsValue.Cut(0, 1);
        labelsValue.Cut(labelsValue.Length() - 1, 1);
        if (fCurrentResponseUID == 0)
          fFlagState->GetUidOfMessage(fFetchResponseIndex - 1,
                                      &fCurrentResponseUID);
        fFlagState->SetCustomAttribute(fCurrentResponseUID, "X-GM-LABELS"_ns,
                                       labelsValue);
        PR_FREEIF(fLabels);
      }
    }

    // I only fetch RFC822 so I should never see these BODY responses
    else if (!PL_strcasecmp(fNextToken, "BODY"))
      skip_to_CRLF();  // I never ask for this
    else if (!PL_strncasecmp(fNextToken, "BODY[TEXT", 9)) {
      // This parses the "preview" response (first 2048 bytes of body text).
      mime_part_data();  // Note: TEXT is not an actual mime part.
    } else if (!PL_strcasecmp(fNextToken, "ENVELOPE")) {
      fDownloadingHeaders = true;
      bNeedEndMessageDownload = true;
      BeginMessageDownload(MESSAGE_RFC822);
      envelope_data();
    } else if (!PL_strcasecmp(fNextToken, "INTERNALDATE")) {
      fDownloadingHeaders =
          true;  // we only request internal date while downloading headers
      if (!bNeedEndMessageDownload) BeginMessageDownload(MESSAGE_RFC822);
      bNeedEndMessageDownload = true;
      internal_date();
    } else {
      nsImapAction imapAction;
      if (!fServerConnection.GetCurrentUrl()) return;
      fServerConnection.GetCurrentUrl()->GetImapAction(&imapAction);
      nsAutoCString userDefinedFetchAttribute;
      fServerConnection.GetCurrentUrl()->GetCustomAttributeToFetch(
          userDefinedFetchAttribute);
      if ((imapAction == nsIImapUrl::nsImapUserDefinedFetchAttribute &&
           !strcmp(userDefinedFetchAttribute.get(), fNextToken)) ||
          imapAction == nsIImapUrl::nsImapUserDefinedMsgCommand) {
        AdvanceToNextToken();
        char* fetchResult;
        if (fNextToken[0] == '(')
          // look through the tokens until we find the closing ')'
          // we can have a result like the following:
          // ((A B) (C D) (E F))
          fetchResult = CreateParenGroup();
        else {
          fetchResult = CreateAstring();
          AdvanceToNextToken();
        }
        if (imapAction == nsIImapUrl::nsImapUserDefinedFetchAttribute)
          fServerConnection.GetCurrentUrl()->SetCustomAttributeResult(
              nsDependentCString(fetchResult));
        if (imapAction == nsIImapUrl::nsImapUserDefinedMsgCommand)
          fServerConnection.GetCurrentUrl()->SetCustomCommandResult(
              nsDependentCString(fetchResult));
        PR_Free(fetchResult);
      } else
        SetSyntaxError(true);
    }
  }

  if (ContinueParse()) {
    if (CurrentResponseUID() && CurrentResponseUID() != nsMsgKey_None &&
        fCurrentLineContainedFlagInfo && fFlagState) {
      fFlagState->AddUidFlagPair(CurrentResponseUID(), fSavedFlagInfo,
                                 fFetchResponseIndex - 1);
      for (uint32_t i = 0; i < fCustomFlags.Length(); i++)
        fFlagState->AddUidCustomFlagPair(CurrentResponseUID(),
                                         fCustomFlags[i].get());
      fCustomFlags.Clear();
    }

    if (fFetchingAllFlags)
      fCurrentLineContainedFlagInfo =
          false;  // do not fire if in PostProcessEndOfLine

    AdvanceToNextToken();  // eat the ')' ending token
    // should be at end of line
    if (bNeedEndMessageDownload) {
      if (ContinueParse()) {
        // complete the message download
        fServerConnection.NormalMessageEndDownload();
      } else
        fServerConnection.AbortMessageDownLoad();
    }
  }
}

typedef enum _envelopeItemType {
  envelopeString,
  envelopeAddress
} envelopeItemType;

typedef struct {
  const char* name;
  envelopeItemType type;
} envelopeItem;

// RFC3501:  envelope  = "(" env-date SP env-subject SP env-from SP
//                       env-sender SP env-reply-to SP env-to SP env-cc SP
//                       env-bcc SP env-in-reply-to SP env-message-id ")"
//           env-date    = nstring
//           env-subject = nstring
//           env-from    = "(" 1*address ")" / nil
//           env-sender  = "(" 1*address ")" / nil
//           env-reply-to= "(" 1*address ")" / nil
//           env-to      = "(" 1*address ")" / nil
//           env-cc      = "(" 1*address ")" / nil
//           env-bcc     = "(" 1*address ")" / nil
//           env-in-reply-to = nstring
//           env-message-id  = nstring

static const envelopeItem EnvelopeTable[] = {
    {"Date", envelopeString},        {"Subject", envelopeString},
    {"From", envelopeAddress},       {"Sender", envelopeAddress},
    {"Reply-to", envelopeAddress},   {"To", envelopeAddress},
    {"Cc", envelopeAddress},         {"Bcc", envelopeAddress},
    {"In-reply-to", envelopeString}, {"Message-id", envelopeString}};

void nsImapServerResponseParser::envelope_data() {
  AdvanceToNextToken();
  fNextToken++;  // eat '('
  for (int tableIndex = 0;
       tableIndex < (int)(sizeof(EnvelopeTable) / sizeof(EnvelopeTable[0]));
       tableIndex++) {
    if (!ContinueParse()) break;
    if (*fNextToken == ')') {
      SetSyntaxError(true);  // envelope too short
      break;
    }

    nsAutoCString headerLine(EnvelopeTable[tableIndex].name);
    headerLine += ": ";
    bool headerNonNil = true;
    if (EnvelopeTable[tableIndex].type == envelopeString) {
      nsAutoCString strValue;
      strValue.Adopt(CreateNilString());
      if (!strValue.IsEmpty())
        headerLine.Append(strValue);
      else
        headerNonNil = false;
    } else {
      nsAutoCString address;
      parse_address(address);
      headerLine += address;
      if (address.IsEmpty()) headerNonNil = false;
    }
    if (headerNonNil)
      fServerConnection.HandleMessageDownLoadLine(headerLine.get(), false);

    if (ContinueParse()) AdvanceToNextToken();
  }
  // Now we should be at the end of the envelope and have *fToken == ')'.
  // Skip this last parenthesis.
  AdvanceToNextToken();
}

void nsImapServerResponseParser::parse_address(nsAutoCString& addressLine) {
  // NOTE: Not sure this function correctly handling group address syntax.
  // See Bug 1609846.
  if (!strcmp(fNextToken, "NIL")) return;
  bool firstAddress = true;
  // should really look at chars here
  NS_ASSERTION(*fNextToken == '(', "address should start with '('");
  fNextToken++;  // eat the next '('
  while (ContinueParse() && *fNextToken == '(') {
    NS_ASSERTION(*fNextToken == '(', "address should start with '('");
    fNextToken++;  // eat the next '('

    if (!firstAddress) addressLine += ", ";

    firstAddress = false;
    char* personalName = CreateNilString();
    AdvanceToNextToken();
    char* atDomainList = CreateNilString();
    if (ContinueParse()) {
      AdvanceToNextToken();
      char* mailboxName = CreateNilString();
      if (ContinueParse()) {
        AdvanceToNextToken();
        char* hostName = CreateNilString();
        AdvanceToNextToken();
        if (mailboxName) {
          addressLine += mailboxName;
        }
        if (hostName) {
          addressLine += '@';
          addressLine += hostName;
          PR_Free(hostName);
        }
        if (personalName) {
          addressLine += " (";
          addressLine += personalName;
          addressLine += ')';
        }
      }
      PR_Free(mailboxName);
    }
    PR_Free(personalName);
    PR_Free(atDomainList);

    if (*fNextToken == ')') fNextToken++;
    // if the next token isn't a ')' for the address term,
    // then we must have another address pair left....so get the next
    // token and continue parsing in this loop...
    if (*fNextToken == '\0') AdvanceToNextToken();
  }
  if (*fNextToken == ')') fNextToken++;
  // AdvanceToNextToken();  // skip "))"
}

void nsImapServerResponseParser::internal_date() {
  AdvanceToNextToken();
  if (ContinueParse()) {
    nsAutoCString dateLine("Date: ");
    char* strValue = CreateNilString();
    if (strValue) {
      dateLine += strValue;
      free(strValue);
    }
    fServerConnection.HandleMessageDownLoadLine(dateLine.get(), false);
  }
  // advance the parser.
  AdvanceToNextToken();
}

void nsImapServerResponseParser::flags() {
  imapMessageFlagsType messageFlags = kNoImapMsgFlag;
  fCustomFlags.Clear();

  // clear the custom flags for this message
  // otherwise the old custom flags will stay around
  // see bug #191042
  if (fFlagState && CurrentResponseUID() != nsMsgKey_None)
    fFlagState->ClearCustomFlags(CurrentResponseUID());

  // eat the opening '('
  fNextToken++;
  while (ContinueParse() && (*fNextToken != ')')) {
    bool knownFlag = false;
    if (*fNextToken == '\\') {
      switch (NS_ToUpper(fNextToken[1])) {
        case 'S':
          if (!PL_strncasecmp(fNextToken, "\\Seen", 5)) {
            messageFlags |= kImapMsgSeenFlag;
            knownFlag = true;
          }
          break;
        case 'A':
          if (!PL_strncasecmp(fNextToken, "\\Answered", 9)) {
            messageFlags |= kImapMsgAnsweredFlag;
            knownFlag = true;
          }
          break;
        case 'F':
          if (!PL_strncasecmp(fNextToken, "\\Flagged", 8)) {
            messageFlags |= kImapMsgFlaggedFlag;
            knownFlag = true;
          }
          break;
        case 'D':
          if (!PL_strncasecmp(fNextToken, "\\Deleted", 8)) {
            messageFlags |= kImapMsgDeletedFlag;
            knownFlag = true;
          } else if (!PL_strncasecmp(fNextToken, "\\Draft", 6)) {
            messageFlags |= kImapMsgDraftFlag;
            knownFlag = true;
          }
          break;
        case 'R':
          if (!PL_strncasecmp(fNextToken, "\\Recent", 7)) {
            messageFlags |= kImapMsgRecentFlag;
            knownFlag = true;
          }
          break;
        default:
          break;
      }
    } else if (*fNextToken == '$') {
      switch (NS_ToUpper(fNextToken[1])) {
        case 'M':
          if ((fSupportsUserDefinedFlags &
               (kImapMsgSupportUserFlag | kImapMsgSupportMDNSentFlag)) &&
              !PL_strncasecmp(fNextToken, "$MDNSent", 8)) {
            messageFlags |= kImapMsgMDNSentFlag;
            knownFlag = true;
          }
          break;
        case 'F':
          if ((fSupportsUserDefinedFlags &
               (kImapMsgSupportUserFlag | kImapMsgSupportForwardedFlag)) &&
              !PL_strncasecmp(fNextToken, "$Forwarded", 10)) {
            messageFlags |= kImapMsgForwardedFlag;
            knownFlag = true;
          }
          break;
        default:
          break;
      }
    }
    if (!knownFlag && fFlagState) {
      nsAutoCString flag(fNextToken);
      int32_t parenIndex = flag.FindChar(')');
      if (parenIndex > 0) flag.SetLength(parenIndex);
      messageFlags |= kImapMsgCustomKeywordFlag;
      if (CurrentResponseUID() != nsMsgKey_None && CurrentResponseUID() != 0)
        fFlagState->AddUidCustomFlagPair(CurrentResponseUID(), flag.get());
      else
        fCustomFlags.AppendElement(flag);
    }
    if (PL_strcasestr(fNextToken, ")")) {
      // eat token chars until we get the ')'
      while (*fNextToken != ')') fNextToken++;
    } else
      AdvanceToNextToken();
  }

  if (ContinueParse())
    while (*fNextToken != ')') fNextToken++;

  fCurrentLineContainedFlagInfo = true;  // handled in PostProcessEndOfLine
  fSavedFlagInfo = messageFlags;
}

// RFC3501:  resp-cond-state = ("OK" / "NO" / "BAD") SP resp-text
//                             ; Status condition
void nsImapServerResponseParser::resp_cond_state(bool isTagged) {
  // According to RFC3501, Sec. 7.1, the untagged NO response "indicates a
  // warning; the command can still complete successfully."
  // However, the untagged BAD response "indicates a protocol-level error for
  // which the associated command can not be determined; it can also indicate an
  // internal server failure."
  // Thus, we flag an error for a tagged NO response and for any BAD response.
  if ((isTagged && !PL_strcasecmp(fNextToken, "NO")) ||
      !PL_strcasecmp(fNextToken, "BAD"))
    fCurrentCommandFailed = true;

  AdvanceToNextToken();
  if (ContinueParse()) resp_text();
}

/*
resp_text       ::= ["[" resp_text_code "]" SPACE] (text_mime2 / text)

  was changed to in order to enable a one symbol look ahead predictive
  parser.

    resp_text       ::= ["[" resp_text_code  SPACE] (text_mime2 / text)
*/
void nsImapServerResponseParser::resp_text() {
  if (ContinueParse() && (*fNextToken == '[')) resp_text_code();

  if (ContinueParse()) {
    if (!PL_strcmp(fNextToken, "=?"))
      text_mime2();
    else
      text();
  }
}
/*
 text_mime2       ::= "=?" <charset> "?" <encoding> "?"
                               <encoded-text> "?="
                               ;; Syntax defined in [MIME-2]
*/
void nsImapServerResponseParser::text_mime2() { skip_to_CRLF(); }

/*
 text            ::= 1*TEXT_CHAR

*/
void nsImapServerResponseParser::text() { skip_to_CRLF(); }

void nsImapServerResponseParser::parse_folder_flags(bool calledForFlags) {
  uint16_t junkNotJunkFlags = 0;

  do {
    AdvanceToNextToken();
    if (*fNextToken == '(') fNextToken++;
    if (!PL_strncasecmp(fNextToken, "\\Seen", 5))
      fSettablePermanentFlags |= kImapMsgSeenFlag;
    else if (!PL_strncasecmp(fNextToken, "\\Answered", 9))
      fSettablePermanentFlags |= kImapMsgAnsweredFlag;
    else if (!PL_strncasecmp(fNextToken, "\\Flagged", 8))
      fSettablePermanentFlags |= kImapMsgFlaggedFlag;
    else if (!PL_strncasecmp(fNextToken, "\\Deleted", 8))
      fSettablePermanentFlags |= kImapMsgDeletedFlag;
    else if (!PL_strncasecmp(fNextToken, "\\Draft", 6))
      fSettablePermanentFlags |= kImapMsgDraftFlag;
    else if (!PL_strncasecmp(fNextToken, "\\*", 2)) {
      // User defined and special keywords (tags) can be defined and set for
      // mailbox. Should only occur in PERMANENTFLAGS response.
      fSupportsUserDefinedFlags |= kImapMsgSupportUserFlag;
      fSupportsUserDefinedFlags |= kImapMsgSupportForwardedFlag;
      fSupportsUserDefinedFlags |= kImapMsgSupportMDNSentFlag;
    }
    // Treat special and built-in $LabelX's as user defined and include
    // $Junk/$NotJunk too.
    else if (!PL_strncasecmp(fNextToken, "$MDNSent", 8))
      fSupportsUserDefinedFlags |= kImapMsgSupportMDNSentFlag;
    else if (!PL_strncasecmp(fNextToken, "$Forwarded", 10))
      fSupportsUserDefinedFlags |= kImapMsgSupportForwardedFlag;
    else if (!PL_strncasecmp(fNextToken, "$Junk", 5))
      junkNotJunkFlags |= 1;
    else if (!PL_strncasecmp(fNextToken, "$NotJunk", 8))
      junkNotJunkFlags |= 2;
  } while (!fAtEndOfLine && ContinueParse());

  if (fFlagState) fFlagState->OrSupportedUserFlags(fSupportsUserDefinedFlags);

  if (calledForFlags) {
    // Set true if both "$Junk" and "$NotJunk" appear in FLAGS.
    fStdJunkNotJunkUseOk = (junkNotJunkFlags == 3);
  }
}
/*
  resp_text_code  ::= ("ALERT" / "PARSE" /
                              "PERMANENTFLAGS" SPACE "(" #(flag / "\*") ")" /
                              "READ-ONLY" / "READ-WRITE" / "TRYCREATE" /
                              "UIDVALIDITY" SPACE nz_number /
                              "UNSEEN" SPACE nz_number /
                              "HIGHESTMODSEQ" SPACE nz_number /
                              "NOMODSEQ" /
                              atom [SPACE 1*<any TEXT_CHAR except "]">] )
                      "]"


*/
void nsImapServerResponseParser::resp_text_code() {
  // this is a special case way of advancing the token
  // strtok won't break up "[ALERT]" into separate tokens
  if (strlen(fNextToken) > 1)
    fNextToken++;
  else
    AdvanceToNextToken();

  if (ContinueParse()) {
    if (!PL_strcasecmp(fNextToken, "ALERT]") ||
        !PL_strcasecmp(fNextToken, "UNAVAILABLE]")) {
      // Treat ALERT and UNAVAILABLE response codes similarly. Show response
      // code string in pop-up. See RFC 5530 "IMAP Response Codes".
      char* alertMsg = fCurrentTokenPlaceHolder;  // advance past ALERT/UNAVAIL
      if (alertMsg && *alertMsg &&
          (!fLastAlert || PL_strcmp(fNextToken, fLastAlert))) {
        fServerConnection.AlertUserEvent(alertMsg);
        PR_Free(fLastAlert);
        fLastAlert = PL_strdup(alertMsg);
        // If UNAVAILABLE, flag this to prevent a possible password prompt
        fServerUnavailable = (NS_ToUpper(fNextToken[0]) == 'U');
      }
      AdvanceToNextToken();
    } else if (!PL_strcasecmp(fNextToken, "PARSE]")) {
      // do nothing for now
      AdvanceToNextToken();
    } else if (!PL_strcasecmp(fNextToken, "NETSCAPE]")) {
      skip_to_CRLF();
    } else if (!PL_strcasecmp(fNextToken, "PERMANENTFLAGS")) {
      uint32_t saveSettableFlags = fSettablePermanentFlags;
      fSupportsUserDefinedFlags = 0;  // assume no unless told
      fSettablePermanentFlags = 0;    // assume none, unless told otherwise.
      parse_folder_flags(false);
      // if the server tells us there are no permanent flags, we're
      // just going to pretend that the FLAGS response flags, if any, are
      // permanent in case the server is broken. This will allow us
      // to store delete and seen flag changes - if they're not permanent,
      // they're not permanent, but at least we'll try to set them.
      if (!fSettablePermanentFlags) fSettablePermanentFlags = saveSettableFlags;
      fGotPermanentFlags = true;
    } else if (!PL_strcasecmp(fNextToken, "READ-ONLY]")) {
      fCurrentFolderReadOnly = true;
      AdvanceToNextToken();
    } else if (!PL_strcasecmp(fNextToken, "READ-WRITE]")) {
      fCurrentFolderReadOnly = false;
      AdvanceToNextToken();
    } else if (!PL_strcasecmp(fNextToken, "TRYCREATE]")) {
      // do nothing for now
      AdvanceToNextToken();
    } else if (!PL_strcasecmp(fNextToken, "UIDVALIDITY")) {
      AdvanceToNextToken();
      if (ContinueParse()) {
        fFolderUIDValidity = strtoul(fNextToken, nullptr, 10);
        fHighestRecordedUID = 0;
        AdvanceToNextToken();
      }
    } else if (!PL_strcasecmp(fNextToken, "UNSEEN")) {
      AdvanceToNextToken();
      if (ContinueParse()) {
        // Note: As a response code, "UNSEEN" is NOT the number of
        // unseen/unread messages. It is the lowest sequence number of the first
        // unseen/unread message in the mailbox.
        fSeqNumOfFirstUnseenMsg = strtoul(fNextToken, nullptr, 10);
        AdvanceToNextToken();
      }
    } else if (!PL_strcasecmp(fNextToken, "UIDNEXT")) {
      AdvanceToNextToken();
      if (ContinueParse()) {
        fNextUID = strtoul(fNextToken, nullptr, 10);
        AdvanceToNextToken();
      }
    } else if (!PL_strcasecmp(fNextToken, "APPENDUID")) {
      AdvanceToNextToken();
      if (ContinueParse()) {
        // ** jt -- the returned uidvalidity is the destination folder
        // uidvalidity; don't use it for current folder
        // fFolderUIDValidity = atoi(fNextToken);
        // fHighestRecordedUID = 0; ??? this should be wrong
        AdvanceToNextToken();
        if (ContinueParse()) {
          fCurrentResponseUID = strtoul(fNextToken, nullptr, 10);
          AdvanceToNextToken();
        }
      }
    } else if (!PL_strcasecmp(fNextToken, "COPYUID")) {
      AdvanceToNextToken();
      if (ContinueParse()) {
        // ** jt -- destination folder uidvalidity
        // fFolderUIDValidity = atoi(fNextToken);
        // original message set; ignore it
        AdvanceToNextToken();
        if (ContinueParse()) {
          // the resulting message set; should be in the form of
          // either uid or uid1:uid2
          AdvanceToNextToken();
          // clear copy response uid
          fServerConnection.SetCopyResponseUid(fNextToken);
          fCopyUidSet = fNextToken;  // New UIDs for the copy destination
        }
        if (ContinueParse()) AdvanceToNextToken();
      }
    } else if (!PL_strcasecmp(fNextToken, "HIGHESTMODSEQ")) {
      AdvanceToNextToken();
      if (ContinueParse()) {
        fHighestModSeq = ParseUint64Str(fNextToken);
        fUseModSeq = true;
        AdvanceToNextToken();
      }
    } else if (!PL_strcasecmp(fNextToken, "NOMODSEQ]")) {
      fHighestModSeq = 0;
      fUseModSeq = false;
      skip_to_CRLF();
    } else if (!PL_strcasecmp(fNextToken, "CAPABILITY")) {
      capability_data();
    } else if (!PL_strcasecmp(fNextToken, "MYRIGHTS")) {
      myrights_data(true);
    } else  // just text
    {
      // do nothing but eat tokens until we see the ] or CRLF
      // we should see the ] but we don't want to go into an
      // endless loop if the CRLF is not there
      do {
        AdvanceToNextToken();
      } while (!PL_strcasestr(fNextToken, "]") && !fAtEndOfLine &&
               ContinueParse());
    }
  }
}

// RFC3501:  response-done = response-tagged / response-fatal
void nsImapServerResponseParser::response_done() {
  if (ContinueParse()) {
    if (!PL_strcmp(fCurrentCommandTag, fNextToken))
      response_tagged();
    else
      response_fatal();
  }
}

// RFC3501:  response-tagged = tag SP resp-cond-state CRLF
void nsImapServerResponseParser::response_tagged() {
  // eat the tag
  AdvanceToNextToken();
  if (ContinueParse()) {
    resp_cond_state(true);
    if (ContinueParse()) {
      if (!fAtEndOfLine)
        SetSyntaxError(true);
      else if (!fCurrentCommandFailed)
        ResetLexAnalyzer();
    }
  }
}

// RFC3501:  response-fatal = "*" SP resp-cond-bye CRLF
//                              ; Server closes connection immediately
void nsImapServerResponseParser::response_fatal() {
  // eat the "*"
  AdvanceToNextToken();
  if (ContinueParse()) resp_cond_bye();
}

// RFC3501:  resp-cond-bye = "BYE" SP resp-text
void nsImapServerResponseParser::resp_cond_bye() {
  SetConnected(false);
  fIMAPstate = kNonAuthenticated;
}

void nsImapServerResponseParser::msg_fetch_headers(const char* partNum) {
  msg_fetch_content(false, 0, MESSAGE_RFC822);
}

/* nstring         ::= string / nil
string          ::= quoted / literal
nil             ::= "NIL"

*/
void nsImapServerResponseParser::msg_fetch_content(bool chunk, int32_t origin,
                                                   const char* content_type) {
  // setup the stream for downloading this message.
  // Note: no longer concerned with body shell issues since now we only fetch
  // full message.
  if ((!chunk || (origin == 0)) && !GetDownloadingHeaders()) {
    if (NS_FAILED(BeginMessageDownload(content_type))) return;
  }

  if (PL_strcasecmp(fNextToken, "NIL")) {
    if (*fNextToken == '"')
      fLastChunk = msg_fetch_quoted();
    else
      fLastChunk = msg_fetch_literal(chunk, origin);
  } else
    AdvanceToNextToken();  // eat "NIL"

  if (fLastChunk) {
    // complete the message download
    if (ContinueParse()) {
      if (fReceivedHeaderOrSizeForUID == CurrentResponseUID()) {
        fServerConnection.NormalMessageEndDownload();
        fReceivedHeaderOrSizeForUID = nsMsgKey_None;
      } else
        fReceivedHeaderOrSizeForUID = CurrentResponseUID();
    } else
      fServerConnection.AbortMessageDownLoad();
  }
}

void nsImapServerResponseParser::mime_part_data() {
  char* checkOriginToken = PL_strdup(fNextToken);
  if (checkOriginToken) {
    uint32_t origin = 0;
    bool originFound = false;
    char* whereStart = PL_strchr(checkOriginToken, '<');
    if (whereStart) {
      char* whereEnd = PL_strchr(whereStart, '>');
      if (whereEnd) {
        *whereEnd = 0;
        whereStart++;
        origin = atoi(whereStart);
        originFound = true;
      }
    }
    PR_Free(checkOriginToken);
    AdvanceToNextToken();
    msg_fetch_content(originFound, origin,
                      MESSAGE_RFC822);  // keep content type as message/rfc822,
                                        // even though the
    // MIME part might not be, because then libmime will
    // still handle and decode it.
  } else
    HandleMemoryFailure();
}

/*
quoted          ::= <"> *QUOTED_CHAR <">

  QUOTED_CHAR     ::= <any TEXT_CHAR except quoted_specials> /
  "\" quoted_specials

    quoted_specials ::= <"> / "\"
*/

bool nsImapServerResponseParser::msg_fetch_quoted() {
  // *Should* never get a quoted string in response to a chunked download,
  // but the RFCs don't forbid it
  char* q = CreateQuoted();
  if (q) {
    numberOfCharsInThisChunk = PL_strlen(q);
    fServerConnection.HandleMessageDownLoadLine(q, false, q);
    PR_Free(q);
  } else
    numberOfCharsInThisChunk = 0;

  AdvanceToNextToken();
  bool lastChunk =
      ((fServerConnection.GetCurFetchSize() == 0) ||
       (numberOfCharsInThisChunk != fServerConnection.GetCurFetchSize()));
  return lastChunk;
}

/* msg_obsolete    ::= "COPY" / ("STORE" SPACE msg_fetch)
;; OBSOLETE untagged data responses */
void nsImapServerResponseParser::msg_obsolete() {
  if (!PL_strcasecmp(fNextToken, "COPY"))
    AdvanceToNextToken();
  else if (!PL_strcasecmp(fNextToken, "STORE")) {
    AdvanceToNextToken();
    if (ContinueParse()) msg_fetch();
  } else
    SetSyntaxError(true);
}

void nsImapServerResponseParser::capability_data() {
  int32_t endToken = -1;
  fCapabilityFlag = kCapabilityDefined | kHasAuthOldLoginCapability;
  do {
    AdvanceToNextToken();
    if (fNextToken) {
      nsCString token(fNextToken);
      endToken = token.FindChar(']');
      if (endToken >= 0) token.SetLength(endToken);

      if (token.Equals("AUTH=LOGIN", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasAuthLoginCapability;
      else if (token.Equals("AUTH=PLAIN", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasAuthPlainCapability;
      else if (token.Equals("AUTH=CRAM-MD5",
                            nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasCRAMCapability;
      else if (token.Equals("AUTH=NTLM", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasAuthNTLMCapability;
      else if (token.Equals("AUTH=GSSAPI", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasAuthGssApiCapability;
      else if (token.Equals("AUTH=MSN", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasAuthMSNCapability;
      else if (token.Equals("AUTH=EXTERNAL",
                            nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasAuthExternalCapability;
      else if (token.Equals("AUTH=XOAUTH2", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasXOAuth2Capability;
      else if (token.Equals("STARTTLS", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasStartTLSCapability;
      else if (token.Equals("LOGINDISABLED",
                            nsCaseInsensitiveCStringComparator))
        fCapabilityFlag &= ~kHasAuthOldLoginCapability;  // remove flag
      else if (token.Equals("XSENDER", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasXSenderCapability;
      else if (token.Equals("IMAP4", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kIMAP4Capability;
      else if (token.Equals("IMAP4rev1", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kIMAP4rev1Capability;
      else if (Substring(token, 0, 5)
                   .Equals("IMAP4", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kIMAP4other;
      else if (token.Equals("X-NO-ATOMIC-RENAME",
                            nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kNoHierarchyRename;
      else if (token.Equals("X-NON-HIERARCHICAL-RENAME",
                            nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kNoHierarchyRename;
      else if (token.Equals("NAMESPACE", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kNamespaceCapability;
      else if (token.Equals("ID", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasIDCapability;
      else if (token.Equals("ACL", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kACLCapability;
      else if (token.Equals("XSERVERINFO", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kXServerInfoCapability;
      else if (token.Equals("UIDPLUS", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kUidplusCapability;
      else if (token.Equals("LITERAL+", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kLiteralPlusCapability;
      else if (token.Equals("X-GM-EXT-1", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kGmailImapCapability;
      else if (token.Equals("QUOTA", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kQuotaCapability;
      else if (token.Equals("LANGUAGE", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasLanguageCapability;
      else if (token.Equals("IDLE", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasIdleCapability;
      else if (token.Equals("CONDSTORE", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasCondStoreCapability;
      else if (token.Equals("ENABLE", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasEnableCapability;
      else if (token.Equals("LIST-EXTENDED",
                            nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasListExtendedCapability;
      else if (token.Equals("XLIST", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasXListCapability;
      else if (token.Equals("SPECIAL-USE", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasSpecialUseCapability;
      else if (token.Equals("COMPRESS=DEFLATE",
                            nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasCompressDeflateCapability;
      else if (token.Equals("MOVE", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasMoveCapability;
      else if (token.Equals("HIGHESTMODSEQ",
                            nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasHighestModSeqCapability;
      else if (token.Equals("CLIENTID", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasClientIDCapability;
      else if (token.Equals("UTF8=ACCEPT",
                            nsCaseInsensitiveCStringComparator) ||
               token.Equals("UTF8=ONLY", nsCaseInsensitiveCStringComparator))
        fCapabilityFlag |= kHasUTF8AcceptCapability;
    }
  } while (fNextToken && endToken < 0 && !fAtEndOfLine && ContinueParse());

  nsImapProtocol* navCon = &fServerConnection;
  NS_ASSERTION(navCon,
               "null imap protocol connection while parsing capability "
               "response");  // we should always have this
  if (navCon) {
    navCon->CommitCapability();
    fServerConnection.SetCapabilityResponseOccurred();
  }
  skip_to_CRLF();
}

void nsImapServerResponseParser::xmailboxinfo_data() {
  AdvanceToNextToken();
  if (!fNextToken) return;

  char* mailboxName = CreateAstring();  // PL_strdup(fNextToken);
  if (mailboxName) {
    do {
      AdvanceToNextToken();
      if (fNextToken) {
        if (!PL_strcmp("MANAGEURL", fNextToken)) {
          AdvanceToNextToken();
          fFolderAdminUrl = CreateAstring();
        } else if (!PL_strcmp("POSTURL", fNextToken)) {
          AdvanceToNextToken();
          // ignore this for now...
        }
      }
    } while (fNextToken && !fAtEndOfLine && ContinueParse());
  }
  PR_FREEIF(mailboxName);
}

void nsImapServerResponseParser::xserverinfo_data() {
  do {
    AdvanceToNextToken();
    if (!fNextToken) break;
    if (!PL_strcmp("MANAGEACCOUNTURL", fNextToken)) {
      AdvanceToNextToken();
      fMailAccountUrl.Adopt(CreateNilString());
    } else if (!PL_strcmp("MANAGELISTSURL", fNextToken)) {
      AdvanceToNextToken();
      fManageListsUrl.Adopt(CreateNilString());
    } else if (!PL_strcmp("MANAGEFILTERSURL", fNextToken)) {
      AdvanceToNextToken();
      fManageFiltersUrl.Adopt(CreateNilString());
    }
  } while (fNextToken && !fAtEndOfLine && ContinueParse());
}

void nsImapServerResponseParser::enable_data() {
  do {
    // eat each enable response;
    AdvanceToNextToken();
    if (!PL_strcasecmp("UTF8=ACCEPT", fNextToken)) fUtf8AcceptEnabled = true;
  } while (fNextToken && !fAtEndOfLine && ContinueParse());
}

void nsImapServerResponseParser::language_data() {
  // we may want to go out and store the language returned to us
  // by the language command in the host info session stuff.

  // for now, just eat the language....
  do {
    // eat each language returned to us
    AdvanceToNextToken();
  } while (fNextToken && !fAtEndOfLine && ContinueParse());
}

// cram/auth response data ::= "+" SPACE challenge CRLF
// the server expects more client data after issuing its challenge

void nsImapServerResponseParser::authChallengeResponse_data() {
  AdvanceToNextToken();
  fAuthChallenge = strdup(fNextToken);
  fWaitingForMoreClientInput = true;

  skip_to_CRLF();
}

void nsImapServerResponseParser::namespace_data() {
  EIMAPNamespaceType namespaceType = kPersonalNamespace;
  bool namespacesCommitted = false;
  const char* serverKey = fServerConnection.GetImapServerKey();
  while ((namespaceType != kUnknownNamespace) && ContinueParse()) {
    AdvanceToNextToken();
    while (fAtEndOfLine && ContinueParse()) AdvanceToNextToken();
    if (!PL_strcasecmp(fNextToken, "NIL")) {
      // No namespace for this type.
      // Don't add anything to the Namespace object.
    } else if (fNextToken[0] == '(') {
      // There may be multiple namespaces of the same type.
      // Go through each of them and add them to our Namespace object.

      fNextToken++;
      while (fNextToken[0] == '(' && ContinueParse()) {
        // we have another namespace for this namespace type
        fNextToken++;
        if (fNextToken[0] != '"') {
          SetSyntaxError(true);
        } else {
          char* namespacePrefix = CreateQuoted(false);

          AdvanceToNextToken();
          const char* quotedDelimiter = fNextToken;
          char namespaceDelimiter = '\0';

          if (quotedDelimiter[0] == '"') {
            quotedDelimiter++;
            namespaceDelimiter = quotedDelimiter[0];
          } else if (!PL_strncasecmp(quotedDelimiter, "NIL", 3)) {
            // NIL hierarchy delimiter.  Leave namespace delimiter nullptr.
          } else {
            // not quoted or NIL.
            SetSyntaxError(true);
          }
          if (ContinueParse()) {
            // Add code to parse the TRANSLATE attribute if it is present....
            // we'll also need to expand the name space code to take in the
            // translated prefix name.

            // Add it to a temporary list in the host.
            if (fHostSessionList) {
              nsImapNamespace* newNamespace = new nsImapNamespace(
                  namespaceType, namespacePrefix, namespaceDelimiter, false);
              fHostSessionList->AddNewNamespaceForHost(serverKey, newNamespace);
            }

            skip_to_close_paren();  // Ignore any extension data

            bool endOfThisNamespaceType = (fNextToken[0] == ')');
            if (!endOfThisNamespaceType &&
                fNextToken[0] !=
                    '(')  // no space between namespaces of the same type
            {
              SetSyntaxError(true);
            }
          }
          PR_Free(namespacePrefix);
        }
      }
    } else {
      SetSyntaxError(true);
    }
    switch (namespaceType) {
      case kPersonalNamespace:
        namespaceType = kOtherUsersNamespace;
        break;
      case kOtherUsersNamespace:
        namespaceType = kPublicNamespace;
        break;
      default:
        namespaceType = kUnknownNamespace;
        break;
    }
  }
  if (ContinueParse()) {
    nsImapProtocol* navCon = &fServerConnection;
    NS_ASSERTION(
        navCon,
        "null protocol connection while parsing namespace");  // we should
                                                              // always have
                                                              // this
    if (navCon) {
      navCon->CommitNamespacesForHostEvent();
      namespacesCommitted = true;
    }
  }
  skip_to_CRLF();

  if (!namespacesCommitted && fHostSessionList) {
    bool success;
    fHostSessionList->FlushUncommittedNamespacesForHost(serverKey, success);
  }
}

void nsImapServerResponseParser::myrights_data(bool unsolicited) {
  AdvanceToNextToken();
  if (ContinueParse() && !fAtEndOfLine) {
    char* mailboxName;
    // an unsolicited myrights response won't have the mailbox name in
    // the response, so we use the selected mailbox name.
    if (unsolicited) {
      mozilla::MutexAutoLock mon(mLock);
      mailboxName = strdup(fSelectedMailboxName);
    } else {
      mailboxName = CreateAstring();
      if (mailboxName) AdvanceToNextToken();
    }
    if (mailboxName) {
      if (ContinueParse()) {
        char* myrights = CreateAstring();
        if (myrights) {
          nsImapProtocol* navCon = &fServerConnection;
          NS_ASSERTION(
              navCon, "null connection parsing my rights");  // we should always
                                                             // have this
          if (navCon)
            navCon->AddFolderRightsForUser(mailboxName,
                                           nullptr /* means "me" */, myrights);
          PR_Free(myrights);
        } else {
          HandleMemoryFailure();
        }
        if (ContinueParse()) AdvanceToNextToken();
      }
      PR_Free(mailboxName);
    } else {
      HandleMemoryFailure();
    }
  } else {
    SetSyntaxError(true);
  }
}

void nsImapServerResponseParser::acl_data() {
  AdvanceToNextToken();
  if (ContinueParse() && !fAtEndOfLine) {
    char* mailboxName = CreateAstring();  // PL_strdup(fNextToken);
    if (mailboxName && ContinueParse()) {
      AdvanceToNextToken();
      while (ContinueParse() && !fAtEndOfLine) {
        char* userName = CreateAstring();  // PL_strdup(fNextToken);
        if (userName && ContinueParse()) {
          AdvanceToNextToken();
          if (ContinueParse()) {
            char* rights = CreateAstring();  // PL_strdup(fNextToken);
            if (rights) {
              fServerConnection.AddFolderRightsForUser(mailboxName, userName,
                                                       rights);
              PR_Free(rights);
            } else
              HandleMemoryFailure();

            if (ContinueParse()) AdvanceToNextToken();
          }
          PR_Free(userName);
        } else
          HandleMemoryFailure();
      }
      PR_Free(mailboxName);
    } else
      HandleMemoryFailure();
  }
}

// RFC2087:  quotaroot_response = "QUOTAROOT" SP astring *(SP astring)
//           quota_response = "QUOTA" SP astring SP quota_list
//           quota_list     = "(" [quota_resource *(SP quota_resource)] ")"
//           quota_resource = atom SP number SP number
// draft-melnikov-extra-quota-00 proposes some additions to RFC2087 and
// improves the documentation. We still only support RFC2087 capability QUOTA
// and command GETQUOTAROOT and its untagged QUOTAROOT and QUOTA responses.
void nsImapServerResponseParser::quota_data() {
  if (!PL_strcasecmp(fNextToken, "QUOTAROOT")) {
    // Ignore QUOTAROOT response (except to invalidate previously stored data).
    nsCString quotaroot;
    AdvanceToNextToken();
    while (ContinueParse() && !fAtEndOfLine) {
      quotaroot.Adopt(CreateAstring());
      AdvanceToNextToken();
    }
    // Invalidate any previously stored quota data. Updated QUOTA data follows.
    fServerConnection.UpdateFolderQuotaData(kInvalidateQuota, quotaroot, 0, 0);
  } else if (!PL_strcasecmp(fNextToken, "QUOTA")) {
    // Should have one QUOTA response per QUOTAROOT.
    uint64_t usage, limit;
    AdvanceToNextToken();
    if (ContinueParse()) {
      nsCString quotaroot;
      quotaroot.Adopt(CreateAstring());
      nsCString resource;
      AdvanceToNextToken();
      if (fNextToken) {
        if (fNextToken[0] == '(') fNextToken++;
        // Should have zero or more "resource|usage|limit" triplet per quotaroot
        // name. See draft-melnikov-extra-quota-00 for specific examples. Well
        // known resources are STORAGE (in Kbytes), number of MESSAGEs and
        // number of MAILBOXes. However, servers typically only set a quota on
        // STORAGE in KBytes. A mailbox can have multiple quotaroots but
        // typically only one and with a single resource.
        while (ContinueParse() && !fAtEndOfLine) {
          resource.Adopt(CreateAstring());
          AdvanceToNextToken();
          usage = atoll(fNextToken);
          AdvanceToNextToken();
          nsAutoCString limitToken(fNextToken);
          if (fNextToken[strlen(fNextToken) - 1] == ')')
            limitToken.SetLength(strlen(fNextToken) - 1);
          limit = atoll(limitToken.get());
          // Some servers don't define a quotaroot name which we displays as
          // blank.
          nsCString quotaRootResource(quotaroot);
          if (!quotaRootResource.IsEmpty()) {
            quotaRootResource.AppendLiteral(" / ");
          }
          quotaRootResource.Append(resource);
          fServerConnection.UpdateFolderQuotaData(
              kStoreQuota, quotaRootResource, usage, limit);
          AdvanceToNextToken();
        }
      }
    }
  } else {
    SetSyntaxError(true);
  }
}

void nsImapServerResponseParser::id_data() {
  AdvanceToNextToken();
  if (!PL_strcasecmp(fNextToken, "NIL"))
    AdvanceToNextToken();
  else
    fServerIdResponse.Adopt(CreateParenGroup());
  skip_to_CRLF();
}

bool nsImapServerResponseParser::GetDownloadingHeaders() {
  return fDownloadingHeaders;
}

void nsImapServerResponseParser::ResetCapabilityFlag() {}

/*
   literal ::= "{" number "}" CRLF *CHAR8
   Number represents the number of CHAR8 octets
 */

// Processes a message body, header or message part fetch response. Typically
// the full message, header or part are processed in one call (effectively, one
// chunk), and parameter `chunk` is false and `origin` (offset into the
// response) is 0. But under some conditions and larger messages, multiple calls
// will occur to process the message in multiple chunks and parameter `chunk`
// will be true and parameter `origin` will increase by the chunk size from
// initially 0 with each call. This function returns true if this is the last or
// only chunk. This signals the caller that the stream should be closed since
// the message response has been processed.
bool nsImapServerResponseParser::msg_fetch_literal(bool chunk, int32_t origin) {
  numberOfCharsInThisChunk = atoi(fNextToken + 1);
  // If we didn't request a specific size, or the server isn't returning exactly
  // as many octets as we requested, this must be the last or only chunk
  bool lastChunk = (!chunk || (numberOfCharsInThisChunk !=
                               fServerConnection.GetCurFetchSize()));

  // clang-format off
  if (lastChunk)
    MOZ_LOG(IMAP, mozilla::LogLevel::Debug,
            ("PARSER: msg_fetch_literal() chunking=%s, requested=%d, receiving=%d",
             chunk ? "true":"false", fServerConnection.GetCurFetchSize(),
             numberOfCharsInThisChunk));
  // clang-format on

  charsReadSoFar = 0;

  while (ContinueParse() && !fServerConnection.DeathSignalReceived() &&
         (charsReadSoFar < numberOfCharsInThisChunk)) {
    AdvanceToNextLine();
    if (ContinueParse()) {
      // When "\r\n" (CRLF) is split across two chunks, the '\n' at the
      // beginning of the next chunk might be set to an empty line consisting
      // only of "\r\n". This is observed while running unit tests with the imap
      // "fake" server. The unexpected '\r' is discarded here. However, with
      // several real world servers tested, e.g., Dovecot, Gmail, Outlook, Yahoo
      // etc., the leading
      // '\r' is not inserted so the beginning line of the next chunk remains
      // just '\n' and no discard is required.
      // In any case, this "orphan" line is ignored and not processed below.
      if (fNextChunkStartsWithNewline && (*fCurrentLine == '\r')) {
        // Cause fCurrentLine to point to '\n' which discards the '\r'.
        char* usableCurrentLine = PL_strdup(fCurrentLine + 1);
        PR_Free(fCurrentLine);
        fCurrentLine = usableCurrentLine;
      }

      // strlen() *would* fail on data containing \0, but the above
      // AdvanceToNextLine() in nsMsgLineStreamBuffer::ReadNextLine() we replace
      // '\0' with ' ' (blank) because who cares about binary transparency, and
      // anyway \0 in this context violates RFCs.
      charsReadSoFar += strlen(fCurrentLine);
      if (!fDownloadingHeaders && fCurrentCommandIsSingleMessageFetch) {
        fServerConnection.ProgressEventFunctionUsingName(
            "imapDownloadingMessage");
        if (fTotalDownloadSize > 0)
          fServerConnection.PercentProgressUpdateEvent(
              ""_ns, charsReadSoFar + origin, fTotalDownloadSize);
      }
      if (charsReadSoFar > numberOfCharsInThisChunk) {
        // This is the last line of a chunk. "Literal" here means actual email
        // data and its EOLs, without imap protocol elements and their EOLs. End
        // of line is defined by two characters \r\n (i.e., CRLF, 0xd,0xa)
        // specified by RFC822. Here is an example the most typical last good
        // line of a chunk: "1s8AA5i4AAvF4QAG6+sAAD0bAPsAAAAA1OAAC)\r\n", where
        // ")\r\n" are non-literals. This an example of the last "good" line of
        // a chunk that terminates with \r\n
        // "FxcA/wAAAALN2gADu80ACS0nAPpVVAD1wNAABF5YAPhAJgD31+QABAAAAP8oMQD+HBwA/umj\r\n"
        // followed by another line of non-literal data:
        // " UID 1004)\r\n". These two are concatenated into a single string
        // pointed to by fCurrentLine.  The extra "non-literal data" on the last
        // chunk line makes the charsReadSoFar greater than
        // numberOfCharsInThisChunk (the configured chunk size). A problem
        // occurs if the \r\n of the long line above is split between chunks and
        // \n is contained in the next chunk. For example, if last lines of
        // chunk X are:
        // "/gAOC/wA/QAAAAAAAAAA8wACCvz+AgIEAAD8/P4ABQUAAPoAAAD+AAEA/voHAAQGBQD/BAQA\r"
        // ")\r\n"
        // and the first two lines of chunk X+1 are:
        // "\n"
        // "APwAAAAAmZkA/wAAAAAREQD/AAAAAquVAAbk8QAHCBAAAPD0AAP5+wABRCoA+0BgAP0AAAAA\r\n"
        // The missing '\n' on the last line of chunk X must be added back and
        // the line consisting only of "\n" in chunk X+1 must be ignored in
        // order to produce the the correct output. This is needed to insure
        // that the signature verification of cryptographically signed emails
        // does not fail due to missing or extra EOL characters. Otherwise, the
        // extra or missing \n or \r  doesn't really matter.
        //
        // Special case observed only with the "fake" imap server used with TB
        // unit test.  When the "\r\n" at the end of a chunk is split as
        // described above, the \n at the beginning of the next chunk may
        // actually be "\r\n" like this example: Last lines of chunk X
        // "/gAOC/wA/QAAAAAAAAAA8wACCvz+AgIEAAD8/P4ABQUAAPoAAAD+AAEA/voHAAQGBQD/BAQA\r"
        // ")\r\n"
        // and the first two lines of chunk X+1:
        // "\r\n"   <-- The code changes this to just "\n" like it should be.
        // "APwAAAAAmZkA/wAAAAAREQD/AAAAAquVAAbk8QAHCBAAAPD0AAP5+wABRCoA+0BgAP0AAAAA\r\n"
        //
        // Implementation:
        // Obtain pointer to last literal in chunk X, e.g., 'C' in 1st example
        // above, or to the \n or \r in the other examples.
        char* displayEndOfLine =
            (fCurrentLine + strlen(fCurrentLine) -
             (charsReadSoFar - numberOfCharsInThisChunk + 1));
        // Save so original unmodified fCurrentLine is restored below.
        char saveit1 = displayEndOfLine[1];
        char saveit2 = 0;  // Keep compiler happy.
        // Determine if EOL is split such that Chunk X has the \r and chunk
        // X+1 has the \n.
        fNextChunkStartsWithNewline = (displayEndOfLine[0] == '\r');
        if (fNextChunkStartsWithNewline) {
          saveit2 = displayEndOfLine[2];
          // Add the missing newline and terminate the string.
          displayEndOfLine[1] = '\n';
          displayEndOfLine[2] = 0;
          // This is a good thing to log.
          MOZ_LOG(IMAP, mozilla::LogLevel::Info,
                  ("PARSER: CR/LF split at chunk boundary"));
        } else {
          // Typical case where EOLs are not split. Terminate the string.
          displayEndOfLine[1] = 0;
        }
        // Process this modified string pointed to by fCurrentLine.
        fServerConnection.HandleMessageDownLoadLine(fCurrentLine, !lastChunk);
        // Restore fCurrentLine's original content.
        displayEndOfLine[1] = saveit1;
        if (fNextChunkStartsWithNewline) displayEndOfLine[2] = saveit2;
      } else {
        // Not the last line of a chunk.
        bool processTheLine = true;
        if (fNextChunkStartsWithNewline && origin > 0) {
          // A split of the \r\n between chunks was detected. Ignore orphan \n
          // on line by itself which can occur on the first line of a 2nd or
          // later chunk. Line length should be 1 and the only character should
          // be \n. Note: If previous message ended with just \r, don't expect
          // the first chunk of a message (origin == 0) to begin with \n.
          // (Typically, there is only one chunk required for a message or
          // header response unless its size exceeds the chunking threshold.)
          if (strlen(fCurrentLine) > 1 || fCurrentLine[0] != '\n') {
            // In case expected orphan \n is not really there, go ahead and
            // process the line. This should theoretically not occur but rarely,
            // and for yet to be determined reasons, it does. Logging may help.
            NS_WARNING(
                "'\\n' is not the only character in this line as expected!");
            MOZ_LOG(IMAP, mozilla::LogLevel::Debug,
                    ("PARSER: expecting just '\\n' but line is = |%s|",
                     fCurrentLine));
          } else {
            // Discard the line containing only \n.
            processTheLine = false;
            MOZ_LOG(IMAP, mozilla::LogLevel::Debug,
                    ("PARSER: discarding lone '\\n'"));
          }
        }
        if (processTheLine) {
          fServerConnection.HandleMessageDownLoadLine(
              fCurrentLine,
              !lastChunk && (charsReadSoFar == numberOfCharsInThisChunk),
              fCurrentLine);
        }
        fNextChunkStartsWithNewline = false;
      }
    }
  }

  if (ContinueParse()) {
    if (charsReadSoFar > numberOfCharsInThisChunk) {
      // move the lexical analyzer state to the end of this message because this
      // message fetch ends in the middle of this line.
      AdvanceTokenizerStartingPoint(
          strlen(fCurrentLine) - (charsReadSoFar - numberOfCharsInThisChunk));
      AdvanceToNextToken();
    } else {
      skip_to_CRLF();
      AdvanceToNextToken();
    }
  } else {
    // Don't typically (maybe never?) see this.
    fNextChunkStartsWithNewline = false;
  }
  return lastChunk;
}

bool nsImapServerResponseParser::CurrentFolderReadOnly() {
  return fCurrentFolderReadOnly;
}

int32_t nsImapServerResponseParser::NumberOfMessages() {
  return fNumberOfExistingMessages;
}

int32_t nsImapServerResponseParser::NumberOfRecentMessages() {
  return fNumberOfRecentMessages;
}

int32_t nsImapServerResponseParser::FolderUID() { return fFolderUIDValidity; }

void nsImapServerResponseParser::SetCurrentResponseUID(uint32_t uid) {
  if (uid > 0) fCurrentResponseUID = uid;
}

uint32_t nsImapServerResponseParser::CurrentResponseUID() {
  return fCurrentResponseUID;
}

uint32_t nsImapServerResponseParser::HighestRecordedUID() {
  return fHighestRecordedUID;
}

void nsImapServerResponseParser::ResetHighestRecordedUID() {
  fHighestRecordedUID = 0;
}

bool nsImapServerResponseParser::IsNumericString(const char* string) {
  int i;
  for (i = 0; i < (int)PL_strlen(string); i++) {
    if (!isdigit(string[i])) {
      return false;
    }
  }

  return true;
}

// Capture the mailbox state for folder select/update and for status.
// If mailboxName is null, we've done imap SELECT; otherwise STATUS.
already_AddRefed<nsImapMailboxSpec>
nsImapServerResponseParser::CreateCurrentMailboxSpec(
    const char* mailboxName /* = nullptr */) {
  RefPtr<nsImapMailboxSpec> returnSpec = new nsImapMailboxSpec;
  const char* mailboxNameToConvert;
  if (mailboxName) {
    mailboxNameToConvert = mailboxName;
  } else {
    mozilla::MutexAutoLock mon(mLock);
    mailboxNameToConvert = fSelectedMailboxName;
  }
  if (mailboxNameToConvert) {
    const char* serverKey = fServerConnection.GetImapServerKey();
    nsImapNamespace* ns = nullptr;
    if (serverKey && fHostSessionList)
      fHostSessionList->GetNamespaceForMailboxForHost(
          serverKey, mailboxNameToConvert, ns);  // for
    // delimiter
    returnSpec->mHierarchySeparator = (ns) ? ns->GetDelimiter() : '/';
  }

  returnSpec->mFolderSelected = !mailboxName;
  returnSpec->mFolder_UIDVALIDITY = fFolderUIDValidity;
  returnSpec->mHighestModSeq = fHighestModSeq;
  // clang-format off
  returnSpec->mNumOfMessages =
      (mailboxName) ? fStatusExistingMessages : fNumberOfExistingMessages;
  returnSpec->mNumOfUnseenMessages =
      (mailboxName) ? fStatusUnseenMessages : -1;
  returnSpec->mNumOfRecentMessages =
      (mailboxName) ? fStatusRecentMessages : fNumberOfRecentMessages;
  returnSpec->mNextUID =
      (mailboxName) ? fStatusNextUID : fNextUID;
  // clang-format on

  returnSpec->mSupportedUserFlags = fSupportsUserDefinedFlags;

  returnSpec->mBoxFlags = kNoFlags;     // stub
  returnSpec->mOnlineVerified = false;  // Fabricated. Flags aren't verified.
  returnSpec->mAllocatedPathName.Assign(mailboxNameToConvert);
  returnSpec->mConnection = &fServerConnection;
  if (returnSpec->mConnection) {
    nsIURI* aUrl = nullptr;
    nsresult rv = NS_OK;
    returnSpec->mConnection->GetCurrentUrl()->QueryInterface(NS_GET_IID(nsIURI),
                                                             (void**)&aUrl);
    if (NS_SUCCEEDED(rv) && aUrl) aUrl->GetHost(returnSpec->mHostName);

    NS_IF_RELEASE(aUrl);
  } else
    returnSpec->mHostName.Truncate();

  if (fFlagState)
    returnSpec->mFlagState = fFlagState;  // copies flag state
  else
    returnSpec->mFlagState = nullptr;

  return returnSpec.forget();
}
// Reset the flag state.
void nsImapServerResponseParser::ResetFlagInfo() {
  if (fFlagState) fFlagState->Reset();
}

bool nsImapServerResponseParser::GetLastFetchChunkReceived() {
  return fLastChunk;
}

void nsImapServerResponseParser::ClearLastFetchChunkReceived() {
  fLastChunk = false;
}

int32_t nsImapServerResponseParser::GetNumBytesFetched() {
  return numberOfCharsInThisChunk;
}

void nsImapServerResponseParser::ClearNumBytesFetched() {
  numberOfCharsInThisChunk = 0;
}

void nsImapServerResponseParser::SetHostSessionList(
    nsIImapHostSessionList* aHostSessionList) {
  fHostSessionList = aHostSessionList;
}

void nsImapServerResponseParser::SetSyntaxError(bool error, const char* msg) {
  nsImapGenericParser::SetSyntaxError(error, msg);
  if (error) {
    if (!fCurrentLine) {
      HandleMemoryFailure();
      fServerConnection.Log("PARSER", ("Internal Syntax Error: %s: <no line>"),
                            msg);
    } else {
      if (!strcmp(fCurrentLine, CRLF))
        fServerConnection.Log("PARSER", "Internal Syntax Error: %s: <CRLF>",
                              msg);
      else {
        if (msg)
          fServerConnection.Log("PARSER", "Internal Syntax Error: %s:", msg);
        fServerConnection.Log("PARSER", "Internal Syntax Error on line: %s",
                              fCurrentLine);
      }
    }
  }
}

nsresult nsImapServerResponseParser::BeginMessageDownload(
    const char* content_type) {
  nsresult rv = fServerConnection.BeginMessageDownLoad(fSizeOfMostRecentMessage,
                                                       content_type);
  if (NS_FAILED(rv)) {
    skip_to_CRLF();
    fServerConnection.PseudoInterrupt(true);
    fServerConnection.AbortMessageDownLoad();
  }
  return rv;
}
