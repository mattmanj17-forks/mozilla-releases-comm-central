/* -*- Mode: Objective-C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset:
 * 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsUserInfo.h"
#include "nsObjCExceptions.h"
#include "nsString.h"
#include "nsCocoaUtils.h"

#import <Cocoa/Cocoa.h>
#import <AddressBook/AddressBook.h>

NS_IMPL_ISUPPORTS(nsUserInfo, nsIUserInfo)

nsUserInfo::nsUserInfo() {}

nsUserInfo::~nsUserInfo() {}

NS_IMETHODIMP
nsUserInfo::GetFullname(nsAString& aFullname) {
  NS_OBJC_BEGIN_TRY_IGNORE_BLOCK

  nsCocoaUtils::GetStringForNSString(NSFullUserName(), aFullname);

  NS_OBJC_END_TRY_IGNORE_BLOCK
  return NS_OK;
}

NS_IMETHODIMP
nsUserInfo::GetUsername(nsAString& aUsername) {
  NS_OBJC_BEGIN_TRY_IGNORE_BLOCK

  nsCocoaUtils::GetStringForNSString(NSUserName(), aUsername);

  NS_OBJC_END_TRY_IGNORE_BLOCK
  return NS_OK;
}

NS_IMETHODIMP
nsUserInfo::GetEmailAddress(nsAString& aEmailAddress) {
  NS_OBJC_BEGIN_TRY_IGNORE_BLOCK

  aEmailAddress.Truncate();
  // Try to get this user's primary email from the system addressbook's "me
  // card" (if they've filled it)
  ABPerson* me = [[ABAddressBook sharedAddressBook] me];
  ABMultiValue* emailAddresses = [me valueForProperty:kABEmailProperty];
  if ([emailAddresses count] > 0) {
    // get the index of the primary email, in case there are more than one
    int primaryEmailIndex =
        [emailAddresses indexForIdentifier:[emailAddresses primaryIdentifier]];
    nsCocoaUtils::GetStringForNSString(
        [emailAddresses valueAtIndex:primaryEmailIndex], aEmailAddress);
  }

  NS_OBJC_END_TRY_IGNORE_BLOCK

  return NS_OK;
}

NS_IMETHODIMP
nsUserInfo::GetDomain(nsAString& aDomain) {
  GetEmailAddress(aDomain);
  int32_t index = aDomain.FindChar('@');
  if (index != -1) {
    // chop off everything before, and including the '@'
    aDomain.Cut(0, index + 1);
  }
  return NS_OK;
}
