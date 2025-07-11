/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsMsgMailViewList.h"
#include "nsArray.h"
#include "nsIMsgFilterService.h"
#include "nsIMsgMailSession.h"
#include "nsIMsgSearchTerm.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIFile.h"
#include "nsComponentManagerUtils.h"
#include "mozilla/Components.h"
#include "nsIMsgFilter.h"

#define kDefaultViewPeopleIKnow "People I Know"
#define kDefaultViewRecent "Recent Mail"
#define kDefaultViewFiveDays "Last 5 Days"
#define kDefaultViewNotJunk "Not Junk"
#define kDefaultViewHasAttachments "Has Attachments"

nsMsgMailView::nsMsgMailView() {}

NS_IMPL_ADDREF(nsMsgMailView)
NS_IMPL_RELEASE(nsMsgMailView)
NS_IMPL_QUERY_INTERFACE(nsMsgMailView, nsIMsgMailView)

nsMsgMailView::~nsMsgMailView() {}

NS_IMETHODIMP nsMsgMailView::GetMailViewName(char16_t** aMailViewName) {
  NS_ENSURE_ARG_POINTER(aMailViewName);

  *aMailViewName = ToNewUnicode(mName);
  return NS_OK;
}

NS_IMETHODIMP nsMsgMailView::SetMailViewName(const char16_t* aMailViewName) {
  mName = aMailViewName;
  return NS_OK;
}

NS_IMETHODIMP nsMsgMailView::GetPrettyName(char16_t** aMailViewName) {
  NS_ENSURE_ARG_POINTER(aMailViewName);

  nsresult rv = NS_OK;
  if (!mBundle) {
    nsCOMPtr<nsIStringBundleService> bundleService =
        mozilla::components::StringBundle::Service();
    NS_ENSURE_TRUE(bundleService, NS_ERROR_UNEXPECTED);
    bundleService->CreateBundle(
        "chrome://messenger/locale/mailviews.properties",
        getter_AddRefs(mBundle));
  }

  NS_ENSURE_TRUE(mBundle, NS_ERROR_FAILURE);

  // see if mName has an associated pretty name inside our string bundle and if
  // so, use that as the pretty name otherwise just return mName
  nsAutoString mailViewName;
  if (mName.EqualsLiteral(kDefaultViewPeopleIKnow)) {
    rv = mBundle->GetStringFromName("mailViewPeopleIKnow", mailViewName);
    *aMailViewName = ToNewUnicode(mailViewName);
  } else if (mName.EqualsLiteral(kDefaultViewRecent)) {
    rv = mBundle->GetStringFromName("mailViewRecentMail", mailViewName);
    *aMailViewName = ToNewUnicode(mailViewName);
  } else if (mName.EqualsLiteral(kDefaultViewFiveDays)) {
    rv = mBundle->GetStringFromName("mailViewLastFiveDays", mailViewName);
    *aMailViewName = ToNewUnicode(mailViewName);
  } else if (mName.EqualsLiteral(kDefaultViewNotJunk)) {
    rv = mBundle->GetStringFromName("mailViewNotJunk", mailViewName);
    *aMailViewName = ToNewUnicode(mailViewName);
  } else if (mName.EqualsLiteral(kDefaultViewHasAttachments)) {
    rv = mBundle->GetStringFromName("mailViewHasAttachments", mailViewName);
    *aMailViewName = ToNewUnicode(mailViewName);
  } else {
    *aMailViewName = ToNewUnicode(mName);
  }

  return rv;
}

NS_IMETHODIMP nsMsgMailView::GetSearchTerms(
    nsTArray<RefPtr<nsIMsgSearchTerm>>& terms) {
  terms = mViewSearchTerms.Clone();
  return NS_OK;
}

NS_IMETHODIMP nsMsgMailView::SetSearchTerms(
    nsTArray<RefPtr<nsIMsgSearchTerm>> const& terms) {
  mViewSearchTerms = terms.Clone();
  return NS_OK;
}

NS_IMETHODIMP nsMsgMailView::AppendTerm(nsIMsgSearchTerm* aTerm) {
  NS_ENSURE_TRUE(aTerm, NS_ERROR_NULL_POINTER);

  mViewSearchTerms.AppendElement(aTerm);
  return NS_OK;
}

NS_IMETHODIMP nsMsgMailView::CreateTerm(nsIMsgSearchTerm** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  nsCOMPtr<nsIMsgSearchTerm> searchTerm =
      do_CreateInstance("@mozilla.org/messenger/searchTerm;1");
  searchTerm.forget(aResult);
  return NS_OK;
}

/////////////////////////////////////////////////////////////////////////////
// nsMsgMailViewList implementation
/////////////////////////////////////////////////////////////////////////////
nsMsgMailViewList::nsMsgMailViewList() { LoadMailViews(); }

NS_IMPL_ADDREF(nsMsgMailViewList)
NS_IMPL_RELEASE(nsMsgMailViewList)
NS_IMPL_QUERY_INTERFACE(nsMsgMailViewList, nsIMsgMailViewList)

nsMsgMailViewList::~nsMsgMailViewList() {}

NS_IMETHODIMP nsMsgMailViewList::GetMailViewCount(uint32_t* aCount) {
  NS_ENSURE_ARG_POINTER(aCount);

  *aCount = m_mailViews.Length();
  return NS_OK;
}

NS_IMETHODIMP nsMsgMailViewList::GetMailViewAt(uint32_t aMailViewIndex,
                                               nsIMsgMailView** aMailView) {
  NS_ENSURE_ARG_POINTER(aMailView);

  uint32_t mailViewCount = m_mailViews.Length();

  NS_ENSURE_ARG(mailViewCount > aMailViewIndex);

  NS_IF_ADDREF(*aMailView = m_mailViews[aMailViewIndex]);
  return NS_OK;
}

NS_IMETHODIMP nsMsgMailViewList::AddMailView(nsIMsgMailView* aMailView) {
  NS_ENSURE_ARG_POINTER(aMailView);

  m_mailViews.AppendElement(aMailView);
  return NS_OK;
}

NS_IMETHODIMP nsMsgMailViewList::RemoveMailView(nsIMsgMailView* aMailView) {
  NS_ENSURE_ARG_POINTER(aMailView);

  m_mailViews.RemoveElement(aMailView);
  return NS_OK;
}

NS_IMETHODIMP nsMsgMailViewList::CreateMailView(nsIMsgMailView** aMailView) {
  NS_ENSURE_ARG_POINTER(aMailView);
  NS_ADDREF(*aMailView = new nsMsgMailView);
  return NS_OK;
}

NS_IMETHODIMP nsMsgMailViewList::Save() {
  // brute force...remove all the old filters in our filter list, then we'll
  // re-add our current list
  nsCOMPtr<nsIMsgFilter> msgFilter;
  uint32_t numFilters = 0;
  if (mFilterList) mFilterList->GetFilterCount(&numFilters);
  while (numFilters) {
    mFilterList->RemoveFilterAt(numFilters - 1);
    numFilters--;
  }

  // now convert our mail view list into a filter list and save it
  ConvertMailViewListToFilterList();

  // now save the filters to our file
  return mFilterList ? mFilterList->SaveToDefaultFile() : NS_ERROR_FAILURE;
}

nsresult nsMsgMailViewList::ConvertMailViewListToFilterList() {
  uint32_t mailViewCount = m_mailViews.Length();
  nsCOMPtr<nsIMsgMailView> mailView;
  nsCOMPtr<nsIMsgFilter> newMailFilter;
  nsString mailViewName;
  for (uint32_t index = 0; index < mailViewCount; index++) {
    GetMailViewAt(index, getter_AddRefs(mailView));
    if (!mailView) continue;
    mailView->GetMailViewName(getter_Copies(mailViewName));
    mFilterList->CreateFilter(mailViewName, getter_AddRefs(newMailFilter));
    if (!newMailFilter) continue;

    nsTArray<RefPtr<nsIMsgSearchTerm>> searchTerms;
    mailView->GetSearchTerms(searchTerms);
    newMailFilter->SetSearchTerms(searchTerms);
    mFilterList->InsertFilterAt(index, newMailFilter);
  }

  return NS_OK;
}

nsresult nsMsgMailViewList::LoadMailViews() {
  nsCOMPtr<nsIFile> file;
  nsresult rv =
      NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR, getter_AddRefs(file));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = file->AppendNative("mailViews.dat"_ns);

  // if the file doesn't exist, we should try to get it from the defaults
  // directory and copy it over
  bool exists = false;
  file->Exists(&exists);
  if (!exists) {
    nsCOMPtr<nsIMsgMailSession> mailSession =
        mozilla::components::MailSession::Service();
    nsCOMPtr<nsIFile> defaultMessagesFile;
    nsCOMPtr<nsIFile> profileDir;
    rv = mailSession->GetDataFilesDir("messenger",
                                      getter_AddRefs(defaultMessagesFile));
    rv = defaultMessagesFile->AppendNative("mailViews.dat"_ns);

    // get the profile directory
    rv = NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                getter_AddRefs(profileDir));

    // now copy the file over to the profile directory
    defaultMessagesFile->CopyToNative(profileDir, EmptyCString());
  }
  // this is kind of a hack but I think it will be an effective hack. The filter
  // service already knows how to take a nsIFile and parse the contents into
  // filters which are very similar to mail views. Instead of re-writing all of
  // that dirty parsing code, let's just re-use it then convert the results into
  // a data structure we wish to give to our consumers.

  nsCOMPtr<nsIMsgFilterService> filterService =
      mozilla::components::Filter::Service();
  nsCOMPtr<nsIMsgFilterList> mfilterList;

  rv = filterService->OpenFilterList(file, nullptr, nullptr,
                                     getter_AddRefs(mFilterList));
  NS_ENSURE_SUCCESS(rv, rv);

  return ConvertFilterListToMailViews();
}
/**
 * Converts the filter list into our mail view objects,
 * stripping out just the info we need.
 */
nsresult nsMsgMailViewList::ConvertFilterListToMailViews() {
  nsresult rv = NS_OK;
  m_mailViews.Clear();

  // iterate over each filter in the list
  uint32_t numFilters = 0;
  mFilterList->GetFilterCount(&numFilters);
  for (uint32_t index = 0; index < numFilters; index++) {
    nsCOMPtr<nsIMsgFilter> msgFilter;
    rv = mFilterList->GetFilterAt(index, getter_AddRefs(msgFilter));
    if (NS_FAILED(rv) || !msgFilter) continue;

    // create a new nsIMsgMailView for this item
    nsCOMPtr<nsIMsgMailView> newMailView;
    rv = CreateMailView(getter_AddRefs(newMailView));
    NS_ENSURE_SUCCESS(rv, rv);

    nsString filterName;
    msgFilter->GetFilterName(filterName);
    newMailView->SetMailViewName(filterName.get());

    nsTArray<RefPtr<nsIMsgSearchTerm>> filterSearchTerms;
    rv = msgFilter->GetSearchTerms(filterSearchTerms);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = newMailView->SetSearchTerms(filterSearchTerms);
    NS_ENSURE_SUCCESS(rv, rv);

    // now append this new mail view to our global list view
    m_mailViews.AppendElement(newMailView);
  }

  return rv;
}
