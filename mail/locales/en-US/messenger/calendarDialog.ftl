# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

calendar-dialog-close-button =
  .aria-label = Close
  .title = Close

calendar-dialog-back-button =
  .aria-label = Back
  .title = Back

calendar-dialog-date-row-icon =
  .alt = Date and time

calendar-dialog-date-row-recurring-icon =
  .alt = Recurring

calendar-dialog-location-row-icon =
  .alt = Location

calendar-dialog-description-row-icon =
  .alt = Description

calendar-dialog-description-label = Description

calendar-dialog-description-expand-icon =
  .alt = Show full description

# Variables:
#   $additionalCategories (Number): Number of categoires not shown.
#   $categories (String): List of all categories.
calendar-dialog-more-categories =
  { $additionalCategories ->
    *[other] +{ $additionalCategories } more
  }
  .title = { $categories }
