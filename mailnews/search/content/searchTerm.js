/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// abSearchDialog.js
/* globals GetScopeForDirectoryURI */

var gTotalSearchTerms = 0;
var gSearchTermList;
var gSearchTerms = [];
var gSearchRemovedTerms = [];
var gSearchScope;
var gSearchBooleanRadiogroup;

var gUniqueSearchTermCounter = 0; // gets bumped every time we add a search term so we can always
// dynamically generate unique IDs for the terms.

// cache these so we don't have to hit the string bundle for them
var gMoreButtonTooltipText;
var gLessButtonTooltipText;
var gLoading = true;

function searchTermContainer() {}

searchTermContainer.prototype = {
  internalSearchTerm: "",
  internalBooleanAnd: "",

  // this.searchTerm: the actual nsIMsgSearchTerm object
  get searchTerm() {
    return this.internalSearchTerm;
  },
  set searchTerm(val) {
    this.internalSearchTerm = val;

    var term = val;
    // val is a nsIMsgSearchTerm
    var searchAttribute = this.searchattribute;
    var searchOperator = this.searchoperator;
    var searchValue = this.searchvalue;

    // now reflect all attributes of the searchterm into the widgets
    if (searchAttribute) {
      // for custom, the value is the custom id, not the integer attribute
      if (term.attrib == Ci.nsMsgSearchAttrib.Custom) {
        searchAttribute.value = term.customId;
      } else {
        searchAttribute.value = term.attrib;
      }
    }
    if (searchOperator) {
      searchOperator.value = val.op;
    }
    if (searchValue) {
      searchValue.value = term.value;
    }

    this.booleanAnd = val.booleanAnd;
    this.matchAll = val.matchAll;
  },

  // searchscope - just forward to the searchattribute
  get searchScope() {
    if (this.searchattribute) {
      return this.searchattribute.searchScope;
    }
    return undefined;
  },
  set searchScope(val) {
    var searchAttribute = this.searchattribute;
    if (searchAttribute) {
      searchAttribute.searchScope = val;
    }
  },

  saveId(element, slot) {
    this[slot] = element.id;
  },

  getElement(slot) {
    return document.getElementById(this[slot]);
  },

  // three well-defined properties:
  // searchattribute, searchoperator, searchvalue
  // the trick going on here is that we're storing the Element's Id,
  // not the element itself, because the XBL object may change out
  // from underneath us
  get searchattribute() {
    return this.getElement("internalSearchAttributeId");
  },
  set searchattribute(val) {
    this.saveId(val, "internalSearchAttributeId");
  },
  get searchoperator() {
    return this.getElement("internalSearchOperatorId");
  },
  set searchoperator(val) {
    this.saveId(val, "internalSearchOperatorId");
  },
  get searchvalue() {
    return this.getElement("internalSearchValueId");
  },
  set searchvalue(val) {
    this.saveId(val, "internalSearchValueId");
  },

  booleanNodes: null,
  get booleanAnd() {
    return this.internalBooleanAnd;
  },
  set booleanAnd(val) {
    this.internalBooleanAnd = val;
  },

  save() {
    var searchTerm = this.searchTerm;

    if (isNaN(this.searchattribute.value)) {
      // is this a custom term?
      searchTerm.attrib = Ci.nsMsgSearchAttrib.Custom;
      searchTerm.customId = this.searchattribute.value;
    } else {
      searchTerm.attrib = this.searchattribute.value;
    }

    if (
      this.searchattribute.value > Ci.nsMsgSearchAttrib.OtherHeader &&
      this.searchattribute.value < Ci.nsMsgSearchAttrib.kNumMsgSearchAttributes
    ) {
      searchTerm.arbitraryHeader = this.searchattribute.label;
    }
    searchTerm.op = this.searchoperator.value;
    if (this.searchvalue.value) {
      this.searchvalue.save();
    } else {
      this.searchvalue.saveTo(searchTerm.value);
    }
    searchTerm.value = this.searchvalue.value;
    searchTerm.booleanAnd = this.booleanAnd;
    searchTerm.matchAll = this.matchAll;
  },
  // if you have a search term element with no search term
  saveTo(searchTerm) {
    this.internalSearchTerm = searchTerm;
    this.save();
  },
};

function initializeSearchWidgets() {
  gSearchBooleanRadiogroup = document.getElementById("booleanAndGroup");
  gSearchTermList = document.getElementById("searchTermList");

  // initialize some strings
  var bundle = Services.strings.createBundle(
    "chrome://messenger/locale/search.properties"
  );
  gMoreButtonTooltipText = bundle.GetStringFromName("moreButtonTooltipText");
  gLessButtonTooltipText = bundle.GetStringFromName("lessButtonTooltipText");
}

function initializeBooleanWidgets() {
  var booleanAnd = true;
  var matchAll = false;
  // get the boolean value from the first term
  var firstTerm = gSearchTerms[0].searchTerm;
  if (firstTerm) {
    // If there is a second term, it should actually define whether we're
    //  using 'and' or not.  Note that our UI is not as rich as the
    //  underlying search model, so there's the potential to lose here when
    //  grouping is involved.
    booleanAnd =
      gSearchTerms.length > 1
        ? gSearchTerms[1].searchTerm.booleanAnd
        : firstTerm.booleanAnd;
    matchAll = firstTerm.matchAll;
  }
  // target radio items have value="and" or value="or" or "all"
  if (matchAll) {
    gSearchBooleanRadiogroup.value = "matchAll";
  } else if (booleanAnd) {
    gSearchBooleanRadiogroup.value = "and";
  } else {
    gSearchBooleanRadiogroup.value = "or";
  }
  var searchTerms = document.getElementById("searchTermList");
  if (searchTerms) {
    updateSearchTermsListbox(matchAll);
  }
}

function initializeSearchRows(scope, searchTerms) {
  for (let i = 0; i < searchTerms.length; i++) {
    const searchTerm = searchTerms[i];
    createSearchRow(i, scope, searchTerm, false);
    gTotalSearchTerms++;
  }
  initializeBooleanWidgets();
  updateRemoveRowButton();
}

/**
 * Enables/disables all the visible elements inside the search terms listbox.
 *
 * @param {boolean} matchAllValue - value from the first search term
 */
function updateSearchTermsListbox(matchAllValue) {
  var searchTerms = document.getElementById("searchTermList");
  searchTerms.setAttribute("disabled", matchAllValue);
  var searchAttributeList =
    searchTerms.getElementsByTagName("search-attribute");
  var searchOperatorList = searchTerms.getElementsByTagName("search-operator");
  var searchValueList = searchTerms.getElementsByTagName("search-value");
  for (let i = 0; i < searchAttributeList.length; i++) {
    searchAttributeList[i].setAttribute("disabled", matchAllValue);
    searchOperatorList[i].setAttribute("disabled", matchAllValue);
    searchValueList[i].setAttribute("disabled", matchAllValue);
    if (!matchAllValue) {
      searchValueList[i].removeAttribute("disabled");
    }
  }
  var moreOrLessButtonsList = searchTerms.getElementsByTagName("button");
  for (let i = 0; i < moreOrLessButtonsList.length; i++) {
    moreOrLessButtonsList[i].setAttribute("disabled", matchAllValue);
  }
  if (!matchAllValue) {
    updateRemoveRowButton();
  }
}

// enables/disables the less button for the first row of search terms.
function updateRemoveRowButton() {
  var firstListItem = gSearchTermList.getItemAtIndex(0);
  if (firstListItem) {
    firstListItem.lastElementChild.lastElementChild.setAttribute(
      "disabled",
      gTotalSearchTerms == 1
    );
  }
}

// Returns the actual list item row index in the list of search rows
// that contains the passed in element id.
function getSearchRowIndexForElement(aElement) {
  var listItem = aElement;

  while (listItem && listItem.localName != "richlistitem") {
    listItem = listItem.parentNode;
  }

  return gSearchTermList.getIndexOfItem(listItem);
}

function onMore(event) {
  // if we have an event, extract the list row index and use that as the row number
  // for our insertion point. If there is no event, append to the end....
  var rowIndex;

  if (event) {
    rowIndex = getSearchRowIndexForElement(event.target) + 1;
  } else {
    rowIndex = gSearchTermList.getRowCount();
  }

  createSearchRow(rowIndex, gSearchScope, null, event != null);
  gTotalSearchTerms++;
  updateRemoveRowButton();

  // the user just added a term, so scroll to it
  gSearchTermList.ensureIndexIsVisible(rowIndex);
}

function onLess(event) {
  if (event && gTotalSearchTerms > 1) {
    removeSearchRow(getSearchRowIndexForElement(event.target));
    --gTotalSearchTerms;
  }

  updateRemoveRowButton();
}

// set scope on all visible searchattribute tags
function setSearchScope(scope) {
  gSearchScope = scope;
  for (var i = 0; i < gSearchTerms.length; i++) {
    // don't set element attributes if XBL hasn't loaded
    if (!(gSearchTerms[i].obj.searchattribute.searchScope === undefined)) {
      gSearchTerms[i].obj.searchattribute.searchScope = scope;
      // act like the user "selected" this, see bug #202848
      gSearchTerms[i].obj.searchattribute.onSelect(null /* no event */);
    }
    gSearchTerms[i].scope = scope;
  }
}

function updateSearchAttributes() {
  for (var i = 0; i < gSearchTerms.length; i++) {
    gSearchTerms[i].obj.searchattribute.refreshList();
  }
}

function booleanChanged(event) {
  // when boolean changes, we have to update all the attributes on the search terms
  var newBoolValue = event.target.getAttribute("value") == "and";
  var matchAllValue = event.target.getAttribute("value") == "matchAll";
  if (document.getElementById("abPopup")) {
    var selectedAB = document.getElementById("abPopup").selectedItem.value;
    setSearchScope(GetScopeForDirectoryURI(selectedAB));
  }
  for (var i = 0; i < gSearchTerms.length; i++) {
    let searchTerm = gSearchTerms[i].obj;
    // If term is not yet initialized in the UI, change the original object.
    if (!searchTerm || !gSearchTerms[i].initialized) {
      searchTerm = gSearchTerms[i].searchTerm;
    }

    searchTerm.booleanAnd = newBoolValue;
    searchTerm.matchAll = matchAllValue;
  }
  var searchTerms = document.getElementById("searchTermList");
  if (searchTerms) {
    if (!matchAllValue && searchTerms.hidden && !gTotalSearchTerms) {
      // Fake to get empty row.
      onMore(null);
    }
    updateSearchTermsListbox(matchAllValue);
  }
}

/**
 * Create a new search row with all the needed elements.
 *
 * @param {integer} index - Index of the position in the menulist where to add the row.
 * @param {nsMsgSearchScope} scope - A nsMsgSearchScope constant indicating
 *   scope of this search rule.
 * @param {nsIMsgSearchTerm} searchTerm  - The search term.
 * @param {boolean} aUserAdded - Boolean indicating if the row addition was
 *   initiated by the user (e.g. via the '+' button).
 */
function createSearchRow(index, scope, searchTerm, aUserAdded) {
  var searchAttr = document.createXULElement("search-attribute");
  var searchOp = document.createXULElement("search-operator");
  var searchVal = document.createXULElement("search-value");

  var moreButton = document.createXULElement("button");
  var lessButton = document.createXULElement("button");
  moreButton.setAttribute("class", "small-button");
  moreButton.setAttribute("oncommand", "onMore(event);");
  moreButton.setAttribute("label", "+");
  moreButton.setAttribute("tooltiptext", gMoreButtonTooltipText);
  lessButton.setAttribute("class", "small-button");
  lessButton.setAttribute("oncommand", "onLess(event);");
  lessButton.setAttribute("label", "\u2212");
  lessButton.setAttribute("tooltiptext", gLessButtonTooltipText);

  // now set up ids:
  searchAttr.id = "searchAttr" + gUniqueSearchTermCounter;
  searchOp.id = "searchOp" + gUniqueSearchTermCounter;
  searchVal.id = "searchVal" + gUniqueSearchTermCounter;

  searchAttr.setAttribute("for", searchOp.id + "," + searchVal.id);
  searchOp.setAttribute("opfor", searchVal.id);

  var rowdata = [searchAttr, searchOp, searchVal, [moreButton, lessButton]];
  var searchrow = constructRow(rowdata);
  searchrow.id = "searchRow" + gUniqueSearchTermCounter;

  var searchTermObj = new searchTermContainer();
  searchTermObj.searchattribute = searchAttr;
  searchTermObj.searchoperator = searchOp;
  searchTermObj.searchvalue = searchVal;

  // now insert the new search term into our list of terms
  gSearchTerms.splice(index, 0, {
    obj: searchTermObj,
    scope,
    searchTerm,
    initialized: false,
  });

  var editFilter = window.gFilter || null;
  var editMailView = window.gMailView || null;

  if (
    (!editFilter && !editMailView) ||
    (editFilter && index == gTotalSearchTerms) ||
    (editMailView && index == gTotalSearchTerms)
  ) {
    gLoading = false;
  }

  // index is index of new row
  // gTotalSearchTerms has not been updated yet
  if (gLoading || index == gTotalSearchTerms) {
    gSearchTermList.appendChild(searchrow);
  } else {
    var currentItem = gSearchTermList.getItemAtIndex(index);
    gSearchTermList.insertBefore(searchrow, currentItem);
  }

  // If this row was added by user action, focus the value field.
  if (aUserAdded) {
    document.commandDispatcher.advanceFocusIntoSubtree(searchVal);
    searchrow.setAttribute("highlight", "true");
  }

  // bump our unique search term counter
  gUniqueSearchTermCounter++;
}

function initializeTermFromId(id) {
  initializeTermFromIndex(
    getSearchRowIndexForElement(document.getElementById(id))
  );
}

function initializeTermFromIndex(index) {
  var searchTermObj = gSearchTerms[index].obj;

  searchTermObj.searchScope = gSearchTerms[index].scope;
  // the search term will initialize the searchTerm element, including
  // .booleanAnd
  if (gSearchTerms[index].searchTerm) {
    searchTermObj.searchTerm = gSearchTerms[index].searchTerm;
    // here, we don't have a searchTerm, so it's probably a new element -
    // we'll initialize the .booleanAnd from the existing setting in
    // the UI
  } else {
    searchTermObj.booleanAnd = gSearchBooleanRadiogroup.value == "and";
    if (index) {
      // If we weren't pre-initialized with a searchTerm then steal the
      // search attribute and operator from the previous row.
      searchTermObj.searchattribute.value =
        gSearchTerms[index - 1].obj.searchattribute.value;
      searchTermObj.searchoperator.value =
        gSearchTerms[index - 1].obj.searchoperator.value;
    }
  }

  gSearchTerms[index].initialized = true;
}

/**
 * Creates a <richlistitem> using the array children as the children
 * of each listcell.
 *
 * @param {Element[]} aChildren - An array of XUL elements to put into the
 *   listitem. Each array member is put into a separate listcell. If the member
 *   itself is an array of elements, all of them are put into the same listcell.
 */
function constructRow(aChildren) {
  const cols = gSearchTermList.firstElementChild.children; // treecol elements
  const listitem = document.createXULElement("richlistitem");
  listitem.setAttribute("allowevents", "true");
  for (let i = 0; i < aChildren.length; i++) {
    const listcell = document.createXULElement("hbox");
    if (cols[i].hasAttribute("style")) {
      listcell.setAttribute("style", cols[i].getAttribute("style"));
    }
    const child = aChildren[i];

    if (child instanceof Array) {
      for (let j = 0; j < child.length; j++) {
        listcell.appendChild(child[j]);
      }
    } else {
      child.setAttribute("flex", "1");
      listcell.appendChild(child);
    }
    listitem.appendChild(listcell);
  }
  return listitem;
}

/**
 * @param {integer} index - Index of row to remove.
 */
function removeSearchRow(index) {
  var searchTermObj = gSearchTerms[index].obj;
  if (!searchTermObj) {
    return;
  }

  // if it is an existing (but offscreen) term,
  // make sure it is initialized before we remove it.
  if (!gSearchTerms[index].searchTerm && !gSearchTerms[index].initialized) {
    initializeTermFromIndex(index);
  }

  // need to remove row from list, so walk upwards from the
  // searchattribute to find the first <listitem>
  var listitem = searchTermObj.searchattribute;

  while (listitem) {
    if (listitem.localName == "richlistitem") {
      break;
    }
    listitem = listitem.parentNode;
  }

  if (!listitem) {
    dump("Error: couldn't find parent listitem!\n");
    return;
  }

  if (searchTermObj.searchTerm) {
    gSearchRemovedTerms.push(searchTermObj.searchTerm);
  } else {
    // dump("That wasn't real. ignoring \n");
  }

  listitem.remove();

  // now remove the item from our list of terms
  gSearchTerms.splice(index, 1);
}

/**
 * Save the search terms from the UI back to the actual search terms.
 *
 * @param {nsIMsgSearchTerm[]} searchTerms - Array of terms
 * @param {object} termOwner - Object which can contain and create the terms
 *   e.g. a nsIMsgSearchSession (will be unnecessary if we just make terms
 *   creatable via XPCOM).
 * @returns {nsIMsgSearchTerm[]} The filtered searchTerms.
 */
function saveSearchTerms(searchTerms, termOwner) {
  var matchAll = gSearchBooleanRadiogroup.value == "matchAll";
  var i;

  searchTerms = searchTerms.filter(t => !gSearchRemovedTerms.includes(t));

  for (i = 0; i < gSearchTerms.length; i++) {
    try {
      gSearchTerms[i].obj.matchAll = matchAll;
      var searchTerm = gSearchTerms[i].obj.searchTerm;
      if (searchTerm) {
        gSearchTerms[i].obj.save();
      } else if (!gSearchTerms[i].initialized) {
        // the term might be an offscreen one we haven't initialized yet
        searchTerm = gSearchTerms[i].searchTerm;
      } else {
        // need to create a new searchTerm, and somehow save it to that
        searchTerm = termOwner.createTerm();
        gSearchTerms[i].obj.saveTo(searchTerm);
        // this might not be the right place for the term,
        // but we need to make the array longer anyway
        termOwner.appendTerm(searchTerm);
      }
      searchTerms[i] = searchTerm;
    } catch (ex) {
      dump("** Error saving element " + i + ": " + ex + "\n");
    }
  }
  return searchTerms;
}

function onReset() {
  while (gTotalSearchTerms > 0) {
    removeSearchRow(--gTotalSearchTerms);
  }
  onMore(null);
}

function hideMatchAllItem() {
  var allItems = document.getElementById("matchAllItem");
  if (allItems) {
    allItems.hidden = true;
  }
}
