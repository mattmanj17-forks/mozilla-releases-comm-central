/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

// XXX we need to know whether the gloda indexer is enabled for upsell reasons,
// but this should really just be exposed on the main Gloda public interface.
// we need to be able to create gloda message searcher instances for upsells.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  GlodaIndexer: "resource:///modules/gloda/GlodaIndexer.sys.mjs",
  GlodaMsgSearcher: "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs",
  TagUtils: "resource:///modules/TagUtils.sys.mjs",
  XULStoreUtils: "resource:///modules/XULStoreUtils.sys.mjs",
});

/**
 * Should the filter be visible when there's no previous state to propagate it
 * from? The idea is that when session persistence is working this should only
 * ever affect the first time Thunderbird is started up. Although opening
 * additional 3-panes will likely trigger this unless we go out of our way to
 * implement propagation across those boundaries (and we're not).
 */
var FILTER_VISIBILITY_DEFAULT = true;

/**
 * Represents the state of a quick filter bar. This mainly decorates the
 * manipulation of the filter states with support of tracking the filter most
 * recently manipulated so we can maintain a very limited undo stack of sorts.
 */
export class QuickFilterState {
  /**
   * @param {object} [aTemplateState]
   * @param {object} [aJsonedState] - State persisted as JSON as returned by
   *   persistToObj.
   */
  constructor(aTemplateState, aJsonedState) {
    if (aJsonedState) {
      this.filterValues = aJsonedState.filterValues;
      this.visible = aJsonedState.visible;
    } else if (aTemplateState) {
      this.filterValues = QuickFilterManager.propagateValues(
        aTemplateState.filterValues
      );
      this.visible = aTemplateState.visible;
    } else {
      this.filterValues = QuickFilterManager.getDefaultValues();
      this.visible = FILTER_VISIBILITY_DEFAULT;
    }
    this.#lastFilterAttr = null;
  }

  /**
   * Maps filter names to their current states. We rely on QuickFilterManager
   * to do most of the interesting manipulation of this value.
   *
   * @type {?Record<string, any>}
   */
  filterValues = null;
  /**
   * Is the filter bar visible? Always inherited from the template regardless
   * of stickyness.
   *
   * @type {?boolean}
   */
  visible = null;

  /**
   * Get a filter state and update lastFilterAttr appropriately. This is
   * intended for use when the filter state is a rich object whose state
   * cannot be updated just by clobbering as provided by |setFilterValue|.
   *
   * @param {string} aName - The name of the filter we are retrieving.
   * @param {boolean} [aNoChange=false] - Is this actually a change for the
   *   purposes of lastFilterAttr purposes?
   * @returns {any} Value of the filter.
   */
  getFilterValue(aName, aNoChange) {
    if (!aNoChange) {
      this.#lastFilterAttr = aName;
    }
    return this.filterValues[aName];
  }

  /**
   * Set a filter state and update lastFilterAttr appropriately.
   *
   * @param {string} aName - The name of the filter we are setting.
   * @param {?any} aValue - The value to set; null/undefined implies deletion.
   * @param {boolean} [aNoChange=false] Is this actually a change for the
   *   purposes of lastFilterAttr purposes?
   */
  setFilterValue(aName, aValue, aNoChange) {
    if (aValue == null) {
      delete this.filterValues[aName];
      return;
    }

    this.filterValues[aName] = aValue;
    if (!aNoChange) {
      this.#lastFilterAttr = aName;
    }
  }

  /**
   * Track the last filter that was affirmatively applied. If you hit escape
   * and this value is non-null, we clear the referenced filter constraint.
   * If you hit escape and the value is null, we clear all filters.
   */
  #lastFilterAttr = null;

  /**
   * The user hit escape; based on _lastFilterAttr and whether there are any
   * applied filters, change our constraints. First press clears the last
   * added constraint (if any), second press (or if no last constraint) clears
   * the state entirely.
   *
   * @returns {boolean} true if we relaxed the state, false if there was nothing
   *   to relax.
   */
  userHitEscape() {
    if (this.#lastFilterAttr) {
      // it's possible the UI state the last attribute has already been cleared,
      // in which case we want to fall through...
      if (
        QuickFilterManager.clearFilterValue(
          this.#lastFilterAttr,
          this.filterValues
        )
      ) {
        this.#lastFilterAttr = null;
        return true;
      }
    }

    return QuickFilterManager.clearAllFilterValues(this.filterValues);
  }

  /**
   * Clear the state without going through any undo-ish steps like
   * |userHitEscape| tries to do.
   */
  clear() {
    QuickFilterManager.clearAllFilterValues(this.filterValues);
  }

  /**
   * Create the search terms appropriate to the current filter states.
   *
   * @param {nsIMsgSearchSession} aTermCreator
   */
  createSearchTerms(aTermCreator) {
    return QuickFilterManager.createSearchTerms(
      this.filterValues,
      aTermCreator
    );
  }

  /**
   * @returns {object} State of the filter as an object.
   */
  persistToObj() {
    return {
      filterValues: this.filterValues,
      visible: this.visible,
    };
  }
}

/**
 * @typedef {object} SearchListener
 * @property {function(object): object} onSearchStart - Takes the current
 *   state and returns the scratch.
 *   This function should initialize the scratch object that will be passed to
 *   onSearchMessage and onSearchDone. This is an attempt to provide a
 *   friendly API that provides debugging support by dumping the state of
 *   said object when things go wrong.
 * @property {function(object, nsIMsgDBHdr, nsIFolder): undefined} onSearchMessage -
 *   Processes messages reported as search hits. Its only context is the
 *   object you returned from onSearchStart passed in as first parameter. Take
 *   the hint and try and keep this method efficient! We will catch all
 *   exceptions for you and report errors. We will also handle forcing GCs as
 *   appropriate.
 * @property {function(object, object, boolean): object} onSearchDone -
 *   Takes the current state, the scratch object and the success value,
 *   returning [new state for your filter, should call reflectInDOM, should
 *   treat the state as if it is a result of user action].
 *   This ends up looking exactly the same as the postFilterProcess handler.
 */

/**
 * An nsIMsgSearchNotify listener wrapper to facilitate faceting of messages
 * being returned by a search. We have to use a listener because the
 * nsMsgDBView includes presentation logic and unless we force all of its
 * results to be fully expanded (and dummy headers ignored), we can't get
 * at all the messages reliably.
 *
 * We need to provide a wrapper so that:
 * - We can provide better error handling support.
 * - We can provide better GC support.
 * - We can ensure the right life-cycle stuff happens (unregister ourselves as
 *   a listener, namely.)
 *
 * It is nice that we have a wrapper so that:
 * - We can provide context to the thing we are calling that it does not need
 *   to maintain.
 */
export class QuickFilterSearchListener {
  /**
   *
   * @param {DBViewWrapper} aViewWrapper
   * @param {QuickFilterState} aFilterer - The QuickFilterState instance.
   * @param {FilterDefinition} aFilterDef - The filter definition.
   * @param {SearchListener} aListener - The thing on which we invoke methods.
   * @param {object} aMuxer - The frontend handler for the quick filter bar (
   *   quickFilterBar in quickFilterBar.js).
   */
  constructor(aViewWrapper, aFilterer, aFilterDef, aListener, aMuxer) {
    this.filterer = aFilterer;
    this.filterDef = aFilterDef;
    this.listener = aListener;
    this.muxer = aMuxer;

    this.session = aViewWrapper.search.session;

    this.scratch = null;
    this.count = 0;
    this.started = false;

    this.session.registerListener(
      this,
      Ci.nsIMsgSearchSession.allNotifications
    );
  }

  onNewSearch() {
    this.started = true;
    const curState =
      this.filterDef.name in this.filterer.filterValues
        ? this.filterer.filterValues[this.filterDef.name]
        : null;
    this.scratch = this.listener.onSearchStart(curState);
  }

  onSearchHit(aMsgHdr, aFolder) {
    // GC sanity demands that we trigger a GC if we have seen a large number
    // of headers. Because we are driven by the search mechanism which likes
    // to time-slice when it has a lot of messages on its plate, it is
    // conceivable something else may trigger a GC for us. Unfortunately,
    // we can't guarantee it, as XPConnect does not inform memory pressure,
    // so it's us to stop-gap it.
    this.count++;
    if (!(this.count % 4096)) {
      Cu.forceGC();
    }

    try {
      this.listener.onSearchMessage(this.scratch, aMsgHdr, aFolder);
    } catch (ex) {
      console.error(ex);
    }
  }

  onSearchDone(aStatus) {
    // It's possible we will see the tail end of an existing search. Ignore.
    if (!this.started) {
      return;
    }

    this.session.unregisterListener(this);

    const curState =
      this.filterDef.name in this.filterer.filterValues
        ? this.filterer.filterValues[this.filterDef.name]
        : null;
    const [newState, update, treatAsUserAction] = this.listener.onSearchDone(
      curState,
      this.scratch,
      aStatus
    );

    this.filterer.setFilterValue(
      this.filterDef.name,
      newState,
      !treatAsUserAction
    );
    if (update) {
      this.muxer.reflectFiltererState(this.filterDef.name);
    }
  }
}

/**
 * @typedef {object} FilterDefinition
 * @property {string} name - The name of your filter. This is the name
 *   of the attribute we cram your state into the state dictionary as, so
 *   the key thing is that it doesn't conflict with other id's.
 * @property {string} domId The id of the DOM node that you have
 *   overlaid into the quick filter bar.
 * @property {function(nsIMsgSearchSession, object, object): ?SearchListener} appendTerms -
 *   Third parameter is the state.
 *   The function to invoke to contribute your terms to the list of
 *   search terms in the second parameter. Your function will not be
 *   invoked if you do
 *   not have any currently persisted state (as is the case if null or
 *   undefined was set). If you have nothing to add, then don't do
 *   anything. If you do add terms, the first term you add needs to have
 *   the booleanAnd flag set to true. You may optionally return a SearchListener
 *   if you want to process all of the messages returned by the filter; doing
 *   so is not cheap, so don't do that lightly. (Tag faceting uses this.)
 * @property {function(): undefined} [getDefaults] - Function that returns the
 *   default state for the filter. If the function is not defined or the
 *   returned value is == undefined/null, no state is set.
 * @property {function(object, boolean): ?object} [propagateState] - A
 *   function that takes the state from another QuickFilterState instance
 *   for this definition and propagates it to a new state which it returns.
 *   You would use this to keep the 'sticky' bits of state that you want to
 *   persist between folder changes and when new tabs are opened. The
 *   second argument tells you if the user wants all the filters still
 *   applied or not. When false, the idea is you might keep things like
 *   which text fields to filter on, but not the text to filter. When true,
 *   you would keep the text to filter on too. Return undefined if you do
 *   not want any state stored in the new filter state. If you do not
 *   define this function and the second argument would be true, we will
 *   propagate your state verbatim; accordingly functions using rich object
 *   state must implement this method.
 * @property {function(object): Array.<object, boolean>} [clearState] - Function to reset the
 *   the filter's value for the given state, returning a tuple of the new
 *   state and a boolean flag indicating whether there was actually state to
 *   clear. This is used when the user decides to reset the state of the
 *   filter bar or (just one specific filter). If omitted, we just delete
 *   the filter state entirely, so you only need to define this if you have
 *   some sticky meta-state you want to maintain. Return undefined for the
 *   state value if you do not need any state kept around.
 * @property {function(Document, object, Node): undefined} [domBindExtra] -
 *   Function invoked at initial UI binding of the quick filter bar after
 *   we add a command listener to whatever is identified by domId (the third
 *   argument). If you have additional widgets to hook up, this is where you
 *   do it. The document and muxer (second argument) are provided to assist in
 *   this endeavor. Use the muxer's getFilterValueForMutation/setFilterValue/
 *   updateSearch methods from any event handlers you register.
 * @property {function(object, Node, Event, Document): Array.<object, boolean>} [onCommand] -
 *   The first argument is the state.
 *   If omitted, the default handler assumes your widget has a "checked"
 *   state that should set your state value to true when checked and delete
 *   the state when unchecked. Implement this function if that is not what
 *   you need. The function should return a tuple of [new state, should
 *   update the search] as its result.
 * @property {function(Node, any, Document, object, any): undefined} [reflectInDOM] -
 *   If omitted, we assume the widget referenced by domId has a checked
 *   attribute and assign the filter value coerced to a boolean to the
 *   checked attribute. Otherwise we call your function and it's up to you
 *   to reflect your state. The first argument is the node referred to by domId.
 *   This function will be called when the tab changes, folder changes, or
 *   if we called postFilterProcess and you returned a value != undefined. The
 *   second argument is the filter value, followed by the document, muxer and
 *   call ID.
 * @property {function(object, DBViewWrapper, boolean): Array.<object, boolean, boolean>} [postFilterProcess] -
 *   Invoked after all of the message headers for the view have been
 *   displayed, allowing your code to perform some kind of faceting or other
 *   clever logic. Return a tuple of [new state, should call reflectInDOM,
 *   should treat as if the user modified the state]. We call this _even
 *   when there is no filter_ applied. The first argument is the state. We
 *   tell you what's happening via the third argument; true means we have
 *   applied some terms, false means not. It's vitally important that you do
 *   not just facet things willy nilly unless there is expected user payoff
 *   and they opted in. Our tagging UI only facets when the user clicked the
 *   tag facet. If you write an extension that provides really sweet
 *   visualizations or something like that and the user installs you knowing
 *   what's what, that is also cool, we just can't do it in core for now.
 */

/**
 * Extensible mechanism for defining filters for the quick filter bar. This
 * is the spiritual successor to the mailViewManager and quickSearchManager.
 *
 * The manager includes and requires UI-relevant metadata for use by its
 * counterparts in quickFilterBar.js. New filters are expected to contribute
 * DOM nodes to the overlay and tell us about them using their id during
 * registration.
 *
 * We support two types of filtery things.
 * - Filters via defineFilter.
 * - Text filters via defineTextFilter. These always take the filter text as
 *   a parameter.
 */
export var QuickFilterManager = {
  /**
   * List of filter definitions, potentially prioritized.
   *
   * @type {FilterDefinition[]}
   */
  filterDefs: [],
  /**
   * Keys are filter definition names, values are the filter defs.
   *
   * @type {Record<string, FilterDefinition>}
   */
  filterDefsByName: {},
  /**
   * The DOM id of the text widget that should get focused when the user hits
   * control-f or the equivalent. This is here so it can get clobbered.
   *
   * @type {?string}
   */
  textBoxDomId: null,

  /**
   * Define a new filter.
   *
   * Filter states must always be JSON serializable. A state of undefined means
   * that we are not persisting any state for your filter.
   *
   * @param {FilterDefinition} aFilterDef - Filter definition.
   */
  defineFilter(aFilterDef) {
    this.filterDefs.push(aFilterDef);
    this.filterDefsByName[aFilterDef.name] = aFilterDef;
  },

  /**
   * Remove a filter from existence by name. This is for extensions to disable
   * existing filters and not a dynamic jetpack-like lifecycle. It falls to the
   * code calling killFilter to deal with the DOM nodes themselves for now.
   *
   * @param {string} aName - The name of the filter to kill.
   */
  killFilter(aName) {
    const filterDef = this.filterDefsByName[aName];
    this.filterDefs.splice(this.filterDefs.indexOf(filterDef), 1);
    delete this.filterDefsByName[aName];
  },

  /**
   * Propagate values from an existing state into a new state based on
   * propagation rules. For use by QuickFilterState.
   *
   * @param {object} aTemplValues - A set of existing filterValues.
   * @returns {object} The new filterValues state.
   */
  propagateValues(aTemplValues) {
    const values = {};
    const sticky = "sticky" in aTemplValues ? aTemplValues.sticky : false;

    for (const filterDef of this.filterDefs) {
      if ("propagateState" in filterDef) {
        const curValue =
          filterDef.name in aTemplValues
            ? aTemplValues[filterDef.name]
            : undefined;
        const newValue = filterDef.propagateState(curValue, sticky);
        if (newValue != null) {
          values[filterDef.name] = newValue;
        }
      } else if (sticky) {
        // Always propagate the value if sticky and there was no handler.
        if (filterDef.name in aTemplValues) {
          values[filterDef.name] = aTemplValues[filterDef.name];
        }
      }
    }

    return values;
  },
  /**
   * Get the set of default filterValues for the current set of defined filters.
   *
   * @returns {object} The new filterValues state.
   */
  getDefaultValues() {
    const values = {};
    for (const filterDef of this.filterDefs) {
      if ("getDefaults" in filterDef) {
        const newValue = filterDef.getDefaults();
        if (newValue != null) {
          values[filterDef.name] = newValue;
        }
      }
    }
    return values;
  },

  /**
   * Reset the state of a single filter given the provided values.
   *
   * @param {string} aFilterName - Name of the filter to clear values for.
   * @param {object} aValues - Values to clear for each filter. Must have a key
   *   for aFilterName.
   * @returns {boolean} true if we actually cleared some state, false if there
   *   was nothing to clear.
   */
  clearFilterValue(aFilterName, aValues) {
    const filterDef = this.filterDefsByName[aFilterName];
    if (!("clearState" in filterDef)) {
      if (aFilterName in aValues) {
        delete aValues[aFilterName];
        return true;
      }
      return false;
    }

    const curValue = aFilterName in aValues ? aValues[aFilterName] : undefined;
    // Yes, we want to call it to clear its state even if it has no state.
    const [newValue, didClear] = filterDef.clearState(curValue);
    if (newValue != null) {
      aValues[aFilterName] = newValue;
    } else {
      delete aValues[aFilterName];
    }
    return didClear;
  },

  /**
   * Reset the state of all filters given the provided values.
   *
   * @param {object} aFilterValues - The values to clear by filter.
   * @returns {boolean} true if we actually cleared something, false if there
   *   was nothing to clear.
   */
  clearAllFilterValues(aFilterValues) {
    let didClearSomething = false;
    for (const filterDef of this.filterDefs) {
      if (this.clearFilterValue(filterDef.name, aFilterValues)) {
        didClearSomething = true;
      }
    }
    return didClearSomething;
  },

  /**
   * Populate and return a list of search terms given the provided state.
   *
   * We only invoke appendTerms on filters that have state in aFilterValues,
   * as per the contract.
   *
   * @param {object} aFilterValues - The values to clear by filter.
   * @param {nsIMsgSearchSession} aTermCreator
   * @returns {Array.<?string[], Array.<Array.<SearchListener, FilterDefinition>>>}
   */
  createSearchTerms(aFilterValues, aTermCreator) {
    const searchTerms = [],
      listeners = [];
    for (const filterName in aFilterValues) {
      const filterValue = aFilterValues[filterName];
      const filterDef = this.filterDefsByName[filterName];
      try {
        const listener = filterDef.appendTerms(
          aTermCreator,
          searchTerms,
          filterValue
        );
        if (listener) {
          listeners.push([listener, filterDef]);
        }
      } catch (ex) {
        console.error(ex);
      }
    }
    return searchTerms.length ? [searchTerms, listeners] : [null, listeners];
  },
};

/**
 * Meta-filter, just handles whether or not things are sticky.
 */
QuickFilterManager.defineFilter({
  name: "sticky",
  domId: "qfb-sticky",
  appendTerms() {},
  /**
   * This should not cause an update, otherwise default logic.
   */
  onCommand(aState, aNode) {
    const checked = aNode.pressed;
    return [checked, false];
  },
});

/**
 * true: must be unread, false: must be read.
 */
QuickFilterManager.defineFilter({
  name: "unread",
  domId: "qfb-unread",
  menuItemID: "quickFilterButtonsContextUnreadToggle",
  appendTerms(aTermCreator, aTerms, aFilterValue) {
    const term = aTermCreator.createTerm();
    term.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
    const value = term.value;
    value.attrib = term.attrib;
    value.status = Ci.nsMsgMessageFlags.Read;
    term.value = value;
    term.op = aFilterValue ? Ci.nsMsgSearchOp.Isnt : Ci.nsMsgSearchOp.Is;
    term.booleanAnd = true;
    aTerms.push(term);
  },
});

/**
 * true: must be starred, false: must not be starred.
 */
QuickFilterManager.defineFilter({
  name: "starred",
  domId: "qfb-starred",
  menuItemID: "quickFilterButtonsContextStarredToggle",
  appendTerms(aTermCreator, aTerms, aFilterValue) {
    const term = aTermCreator.createTerm();
    term.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
    const value = term.value;
    value.attrib = term.attrib;
    value.status = Ci.nsMsgMessageFlags.Marked;
    term.value = value;
    term.op = aFilterValue ? Ci.nsMsgSearchOp.Is : Ci.nsMsgSearchOp.Isnt;
    term.booleanAnd = true;
    aTerms.push(term);
  },
});

/**
 * true: sender must be in a local address book, false: sender must not be.
 */
QuickFilterManager.defineFilter({
  name: "addrBook",
  domId: "qfb-inaddrbook",
  menuItemID: "quickFilterButtonsContextInaddrbookToggle",
  appendTerms(aTermCreator, aTerms, aFilterValue) {
    let value;
    let firstBook = true;
    let term = null;
    for (const addrbook of MailServices.ab.directories) {
      if (!addrbook.isRemote) {
        term = aTermCreator.createTerm();
        term.attrib = Ci.nsMsgSearchAttrib.Sender;
        value = term.value;
        value.attrib = term.attrib;
        value.str = addrbook.URI;
        term.value = value;
        term.op = aFilterValue
          ? Ci.nsMsgSearchOp.IsInAB
          : Ci.nsMsgSearchOp.IsntInAB;
        // It's an AND if we're the first book (so the boolean affects the
        // group as a whole.)
        // It's the negation of whether we're filtering otherwise; demorgans.
        term.booleanAnd = firstBook || !aFilterValue;
        term.beginsGrouping = firstBook;
        aTerms.push(term);
        firstBook = false;
      }
    }
    if (term) {
      term.endsGrouping = true;
    }
  },
});

/**
 * It's a tag filter that sorta facets! Stealing gloda's thunder! Woo!
 *
 * Filter on message tags? Meanings:
 * - true: Yes, must have at least one tag on it.
 * - false: No, no tags on it!
 * - dictionary where keys are tag keys and values are tri-state with null
 *    meaning don't constraint, true meaning yes should be present, false
 *    meaning no, don't be present
 */
var TagFacetingFilter = {
  name: "tags",
  domId: "qfb-tags",
  menuItemID: "quickFilterButtonsContextTagsToggle",
  callID: "",

  /**
   * @returns {boolean} true if the constaint is only on has tags/does not have
   *   tags, false if there are specific tag constraints in play.
   */
  isSimple(aFilterValue) {
    // it's the simple case if the value is just a boolean
    if (typeof aFilterValue != "object") {
      return true;
    }
    // but also if the object contains no non-null values
    let simpleCase = true;
    for (const key in aFilterValue.tags) {
      const value = aFilterValue.tags[key];
      if (value !== null) {
        simpleCase = false;
        break;
      }
    }
    return simpleCase;
  },

  /**
   * Because we support both inclusion and exclusion we can produce up to two
   * groups. One group for inclusion, one group for exclusion. To get listed
   * the message must have any/all of the tags marked for inclusion,
   * (depending on mode), but it cannot have any of the tags marked for
   * exclusion.
   */
  appendTerms(aTermCreator, aTerms, aFilterValue) {
    if (aFilterValue == null) {
      return null;
    }

    let term, value;

    // just the true/false case
    if (this.isSimple(aFilterValue)) {
      term = aTermCreator.createTerm();
      term.attrib = Ci.nsMsgSearchAttrib.Keywords;
      value = term.value;
      value.str = "";
      term.value = value;
      term.op = aFilterValue
        ? Ci.nsMsgSearchOp.IsntEmpty
        : Ci.nsMsgSearchOp.IsEmpty;
      term.booleanAnd = true;
      aTerms.push(term);

      // we need to perform faceting if the value is literally true.
      if (aFilterValue === true) {
        return this;
      }
    } else {
      let firstIncludeClause = true,
        firstExcludeClause = true;
      let lastIncludeTerm = null;
      term = null;

      const excludeTerms = [];

      const mode = aFilterValue.mode;
      for (const key in aFilterValue.tags) {
        const shouldFilter = aFilterValue.tags[key];
        if (shouldFilter !== null) {
          term = aTermCreator.createTerm();
          term.attrib = Ci.nsMsgSearchAttrib.Keywords;
          value = term.value;
          value.attrib = term.attrib;
          value.str = key;
          term.value = value;
          if (shouldFilter) {
            term.op = Ci.nsMsgSearchOp.Contains;
            // AND for the group. Inside the group we also want AND if the
            // mode is set to "All of".
            term.booleanAnd = firstIncludeClause || mode === "AND";
            term.beginsGrouping = firstIncludeClause;
            aTerms.push(term);
            firstIncludeClause = false;
            lastIncludeTerm = term;
          } else {
            term.op = Ci.nsMsgSearchOp.DoesntContain;
            // you need to not include all of the tags marked excluded.
            term.booleanAnd = true;
            term.beginsGrouping = firstExcludeClause;
            excludeTerms.push(term);
            firstExcludeClause = false;
          }
        }
      }
      if (lastIncludeTerm) {
        lastIncludeTerm.endsGrouping = true;
      }

      // if we have any exclude terms:
      // - we might need to add a "has a tag" clause if there were no explicit
      //   inclusions.
      // - extend the exclusions list in.
      if (excludeTerms.length) {
        // (we need to add has a tag)
        if (!lastIncludeTerm) {
          term = aTermCreator.createTerm();
          term.attrib = Ci.nsMsgSearchAttrib.Keywords;
          value = term.value;
          value.str = "";
          term.value = value;
          term.op = Ci.nsMsgSearchOp.IsntEmpty;
          term.booleanAnd = true;
          aTerms.push(term);
        }

        // (extend in the exclusions)
        excludeTerms[excludeTerms.length - 1].endsGrouping = true;
        aTerms.push.apply(aTerms, excludeTerms);
      }
    }
    return null;
  },

  onSearchStart() {
    // this becomes aKeywordMap; we want to start with an empty one
    return {};
  },
  onSearchMessage(aKeywordMap, aMsgHdr) {
    const keywords = aMsgHdr.getStringProperty("keywords");
    const keywordList = keywords.split(" ");
    for (let iKeyword = 0; iKeyword < keywordList.length; iKeyword++) {
      const keyword = keywordList[iKeyword];
      aKeywordMap[keyword] = null;
    }
  },
  onSearchDone(aCurState, aKeywordMap) {
    // we are an async operation; if the user turned off the tag facet already,
    // then leave that state intact...
    if (aCurState == null) {
      return [null, false, false];
    }

    // only propagate things that are actually tags though!
    const outKeyMap = { tags: {} };
    const tags = MailServices.tags.getAllTags();
    const tagCount = tags.length;
    for (let iTag = 0; iTag < tagCount; iTag++) {
      const tag = tags[iTag];

      if (tag.key in aKeywordMap) {
        outKeyMap.tags[tag.key] = aKeywordMap[tag.key];
      }
    }
    return [outKeyMap, true, false];
  },

  /**
   * We need to clone our state if it's an object to avoid bad sharing.
   */
  propagateState(aOld, aSticky) {
    // stay disabled when disabled, get disabled when not sticky
    if (aOld == null || !aSticky) {
      return null;
    }
    if (this.isSimple(aOld)) {
      // Could be an object, need to convert.
      return !!aOld;
    }
    return Object.assign({}, aOld);
  },

  /**
   * Default behaviour but:
   * - We collapse our expando if we get unchecked.
   * - We want to initiate a faceting pass if we just got checked.
   */
  onCommand(aState, aNode, aEvent, aDocument) {
    let checked;
    if (aNode.tagName == "button") {
      checked = aNode.pressed ? true : null;
    } else {
      checked = aNode.hasAttribute("checked") ? true : null;
    }

    if (!checked) {
      aDocument.getElementById("quickFilterBarTagsContainer").hidden = true;
    }

    // return ourselves if we just got checked to have
    //  onSearchStart/onSearchMessage/onSearchDone get to do their thing.
    return [checked, true];
  },

  domBindExtra(aDocument, aMuxer) {
    // Tag filtering mode menu (All of/Any of)
    function commandHandler(aEvent) {
      const filterValue = aMuxer.getFilterValueForMutation(
        TagFacetingFilter.name
      );
      filterValue.mode = aEvent.target.value;
      aMuxer.updateSearch();
    }
    aDocument
      .getElementById("qfb-boolean-mode")
      .addEventListener("ValueChange", commandHandler);
  },

  reflectInDOM(aNode, aFilterValue, aDocument, aMuxer, aCallId) {
    if (aCallId !== null && aCallId == "menuItem") {
      aFilterValue
        ? aNode.setAttribute("checked", aFilterValue)
        : aNode.removeAttribute("checked");
    } else {
      aNode.pressed = aFilterValue;
    }
    if (aFilterValue != null && typeof aFilterValue == "object") {
      this._populateTagBar(aFilterValue, aDocument, aMuxer);
    } else {
      aDocument.getElementById("quickFilterBarTagsContainer").hidden = true;
    }
  },

  _populateTagBar(aState, aDocument, aMuxer) {
    const tagbar = aDocument.getElementById("quickFilterBarTagsContainer");
    const keywordMap = aState.tags;

    // If we have a mode stored use that. If we don't have a mode, then update
    // our state to agree with what the UI is currently displaying;
    // this will happen for fresh profiles.
    const qbm = aDocument.getElementById("qfb-boolean-mode");
    if (aState.mode) {
      qbm.value = aState.mode;
    } else {
      aState.mode = qbm.value;
    }

    function clickHandler() {
      const tagKey = this.getAttribute("value");
      const state = aMuxer.getFilterValueForMutation(TagFacetingFilter.name);
      state.tags[tagKey] = this.pressed ? true : null;
      this.removeAttribute("inverted");
      aMuxer.updateSearch();
    }

    function rightClickHandler(aEvent) {
      if (aEvent.button == 2) {
        // Toggle isn't triggered by a contextmenu event, so do it here.
        this.pressed = !this.pressed;

        const tagKey = this.getAttribute("value");
        const state = aMuxer.getFilterValueForMutation(TagFacetingFilter.name);
        state.tags[tagKey] = this.pressed ? false : null;
        if (this.pressed) {
          this.setAttribute("inverted", "true");
        } else {
          this.removeAttribute("inverted");
        }
        aMuxer.updateSearch();
        aEvent.preventDefault();
      }
    }

    // -- nuke existing exposed tags, but not the mode selector (which is first)
    while (tagbar.children.length > 1) {
      tagbar.lastElementChild.remove();
    }

    let addCount = 0;

    // -- create an element for each tag
    const tags = MailServices.tags.getAllTags();
    const tagCount = tags.length;
    for (let iTag = 0; iTag < tagCount; iTag++) {
      const tag = tags[iTag];

      if (tag.key in keywordMap) {
        addCount++;

        // Keep in mind that the XBL does not get built for dynamically created
        //  elements such as these until they get displayed, which definitely
        //  means not before we append it into the tree.
        const button = aDocument.createElement("button", {
          is: "toggle-button",
        });

        button.setAttribute("id", "qfb-tag-" + tag.key);
        button.addEventListener("click", clickHandler);
        button.addEventListener("contextmenu", rightClickHandler);
        if (keywordMap[tag.key] !== null) {
          button.pressed = true;
          if (!keywordMap[tag.key]) {
            button.setAttribute("inverted", "true");
          }
        }
        button.textContent = tag.tag;
        button.setAttribute("value", tag.key);
        const color = tag.color;
        const contrast = lazy.TagUtils.isColorContrastEnough(color)
          ? "black"
          : "white";
        // everybody always gets to be an qfb-tag-button.
        button.setAttribute("class", "button qfb-tag-button");
        if (color) {
          button.setAttribute(
            "style",
            `--tag-color: ${color}; --tag-contrast-color: ${contrast};`
          );
        }
        tagbar.appendChild(button);
      }
    }
    tagbar.hidden = !addCount;
  },
};
QuickFilterManager.defineFilter(TagFacetingFilter);

/**
 * true: must have attachment, false: must not have attachment.
 */
QuickFilterManager.defineFilter({
  name: "attachment",
  domId: "qfb-attachment",
  menuItemID: "quickFilterButtonsContextAttachmentToggle",
  appendTerms(aTermCreator, aTerms, aFilterValue) {
    const term = aTermCreator.createTerm();
    term.attrib = Ci.nsMsgSearchAttrib.MsgStatus;
    const value = term.value;
    value.attrib = term.attrib;
    value.status = Ci.nsMsgMessageFlags.Attachment;
    term.value = value;
    term.op = aFilterValue ? Ci.nsMsgSearchOp.Is : Ci.nsMsgSearchOp.Isnt;
    term.booleanAnd = true;
    aTerms.push(term);
  },
});

/**
 * The traditional quick-search text filter now with added gloda upsell! We
 * are mildly extensible in case someone wants to add more specific text filter
 * criteria to toggle, but otherwise are intended to be taken out of the
 * picture entirely by extensions implementing more featureful text searches.
 *
 * Our state looks like {text: "", states: {a: true, b: false}} where a and b
 * are text filters.
 */
export var MessageTextFilter = {
  name: "text",
  domId: "qfb-qs-textbox",
  /**
   * Parse the string into terms/phrases by finding matching double-quotes. If
   * we find a quote that doesn't have a friend, we assume the user was going
   * to put a quote at the end of the string. (This is important because we
   * update using a timer and this results in stable behavior.)
   *
   * This code is cloned from gloda's GlodaMsgSearcher.sys.mjs and known good (enough :).
   * I did change the friendless quote situation, though.
   *
   * @param {string} aSearchString The phrase to parse up.
   * @returns {string[]} A list of terms.
   */
  _parseSearchString(aSearchString) {
    aSearchString = aSearchString.trim();
    const terms = [];

    /*
     * Add the term as long as the trim on the way in didn't obliterate it.
     *
     * In the future this might have other helper logic; it did once before.
     */
    function addTerm(aTerm) {
      if (aTerm) {
        terms.push(aTerm);
      }
    }

    /**
     * Look for spaces around | (OR operator) and remove them.
     */
    aSearchString = aSearchString.replace(/\s*\|\s*/g, "|");
    while (aSearchString) {
      if (aSearchString.startsWith('"')) {
        let endIndex = aSearchString.indexOf('"', 1);
        // treat a quote without a friend as making a phrase containing the
        // rest of the string...
        if (endIndex == -1) {
          endIndex = aSearchString.length;
        }

        addTerm(aSearchString.substring(1, endIndex).trim());
        aSearchString = aSearchString.substring(endIndex + 1);
        continue;
      }

      const searchTerms = aSearchString.split(" ");
      searchTerms.forEach(searchTerm => addTerm(searchTerm));
      break;
    }

    return terms;
  },

  /**
   * For each search phrase, build a group that contains all our active text
   * filters OR'ed together. So if the user queries for 'foo bar' with
   * sender and recipient enabled, we build:
   * ("foo" sender OR "foo" recipient) AND ("bar" sender OR "bar" recipient)
   */
  appendTerms(aTermCreator, aTerms, aFilterValue) {
    let term, value;

    if (aFilterValue.text) {
      const phrases = this._parseSearchString(aFilterValue.text);
      for (const groupedPhrases of phrases) {
        let firstClause = true;
        term = null;
        const splitPhrases = groupedPhrases.split("|");
        for (const phrase of splitPhrases) {
          for (const [tfName, tfValue] of Object.entries(aFilterValue.states)) {
            if (!tfValue) {
              continue;
            }
            const tfDef = this.textFilterDefs[tfName];

            term = aTermCreator.createTerm();
            term.attrib = tfDef.attrib;
            value = term.value;
            value.attrib = tfDef.attrib;
            value.str = phrase;
            term.value = value;
            term.op = Ci.nsMsgSearchOp.Contains;
            // AND for the group, but OR inside the group
            term.booleanAnd = firstClause;
            term.beginsGrouping = firstClause;
            aTerms.push(term);
            firstClause = false;
          }
        }
        if (term) {
          term.endsGrouping = true;
        }
      }
    }
  },
  getDefaults() {
    const states = Object.assign({}, this._defaultStates);
    return {
      text: null,
      states,
    };
  },
  propagateState(aOld, aSticky) {
    return {
      text: aSticky ? aOld.text : null,
      states: Object.assign({}, aOld.states),
    };
  },
  clearState(aState) {
    const hadState = Boolean(aState.text);
    aState.text = null;
    return [aState, hadState];
  },

  /**
   * We need to create and bind our expando-bar toggle buttons. We also need to
   * add a special down keypress handler that escapes the textbox into the
   * thread pane.
   */
  domBindExtra(aDocument, aMuxer, aNode) {
    // -- Keypresses for focus transferral and upsell
    aNode.addEventListener("keypress", function (aEvent) {
      // - Down key into the thread pane. Calls `preventDefault` to stop the
      // event from causing scrolling, but that prevents the tree from
      // selecting a message if necessary, so we must do it here.
      if (aEvent.keyCode == aEvent.DOM_VK_DOWN) {
        const threadTree = aDocument.getElementById("threadTree");
        threadTree.table.body.focus();
        if (threadTree.selectedIndex == -1) {
          threadTree.selectedIndex = 0;
        }
        aEvent.preventDefault();
      }
    });

    // -- Blurring kills upsell.
    aNode.addEventListener(
      "blur",
      function () {
        const panel = aDocument.getElementById("qfb-text-search-upsell");
        if (
          (Services.focus.activeWindow != aDocument.defaultView ||
            aDocument.commandDispatcher.focusedElement != aNode.inputField) &&
          panel.state == "open"
        ) {
          panel.hidePopup();
        }
      },
      true
    );

    // -- Expando Buttons!
    function commandHandler() {
      const state = aMuxer.getFilterValueForMutation(MessageTextFilter.name);
      const filterDef = MessageTextFilter.textFilterDefsByDomId[this.id];
      state.states[filterDef.name] = this.pressed;
      aMuxer.updateSearch();
      lazy.XULStoreUtils.setValue(
        "messenger",
        "quickFilter",
        "textFilters",
        JSON.stringify(state.states)
      );
    }

    for (const name in this.textFilterDefs) {
      const textFilter = this.textFilterDefs[name];
      aDocument
        .getElementById(textFilter.domId)
        .addEventListener("click", commandHandler);
    }
  },

  onCommand(aState, aNode, aEvent, aDocument) {
    const text = aEvent.detail || null;
    const isSearch = aEvent.type === "search";
    if (isSearch) {
      const upsell = aDocument.getElementById("qfb-text-search-upsell");
      if (upsell.state == "open") {
        upsell.hidePopup();
      }
      const tabmail =
        aDocument.ownerGlobal.top.document.getElementById("tabmail");
      tabmail.openTab("glodaFacet", {
        searcher: new lazy.GlodaMsgSearcher(null, aState.text),
      });
      aEvent.preventDefault();
    }

    aState.text = text;
    aDocument.getElementById("quick-filter-bar-filter-text-bar").hidden = !text;
    return [aState, !isSearch];
  },

  reflectInDOM(aNode, aFilterValue, aDocument, aMuxer, aFromPFP) {
    const panel = aDocument.getElementById("qfb-text-search-upsell");

    if (aFromPFP == "nosale") {
      if (panel.state != "closed") {
        panel.hidePopup();
      }
      return;
    }

    if (aFromPFP == "upsell") {
      const line2 = aDocument.getElementById("qfb-upsell-line-two");
      aDocument.l10n.setAttributes(
        line2,
        "quick-filter-bar-gloda-upsell-line2",
        { text: aFilterValue.text }
      );

      if (panel.state == "closed" && aDocument.activeElement == aNode) {
        aDocument.ownerGlobal.setTimeout(() => {
          panel.openPopup(
            aDocument.getElementById("quick-filter-bar"),
            "after_end",
            -7,
            7,
            false,
            true
          );
        });
      }
      return;
    }

    // Make sure we have no visible upsell on state change while our textbox
    // retains focus.
    if (panel.state != "closed") {
      panel.hidePopup();
    }

    // Propagate a cleared text filter to the search bar input.
    const desiredValue = aFilterValue.text || "";
    if (!desiredValue) {
      aNode.reset();
    }

    // Update our expanded filters buttons.
    const states = aFilterValue.states;
    for (const name in this.textFilterDefs) {
      const textFilter = this.textFilterDefs[name];
      aDocument.getElementById(textFilter.domId).pressed =
        states[textFilter.name];
    }

    // Toggle the expanded filters visibility.
    aDocument.getElementById("quick-filter-bar-filter-text-bar").hidden =
      aFilterValue.text == null;
  },

  /**
   * In order to do our upsell we need to know when we are not getting any
   * results.
   */
  postFilterProcess(aState, aViewWrapper, aFiltering) {
    // If we're not filtering, not filtering on text, there are results, or
    // gloda is not enabled so upselling makes no sense, then bail.
    // (Currently we always return "nosale" to make sure our panel is closed;
    // this might be overkill but unless it becomes a performance problem, it
    // keeps us safe from weird stuff.)
    if (
      !aFiltering ||
      !aState.text ||
      aViewWrapper.dbView.numMsgsInView ||
      !lazy.GlodaIndexer.enabled
    ) {
      return [aState, "nosale", false];
    }

    // since we're filtering, filtering on text, and there are no results, tell
    // the upsell code to get bizzay
    return [aState, "upsell", false];
  },

  /**
   * Maps text filter names to whether they are enabled by default.
   *
   * @type {Record<string, boolean>}
   */
  _defaultStates: {},
  /**
   * Maps text filter name to text filter def.
   *
   * @type {Record<string, object>}
   */
  textFilterDefs: {},
  /**
   * Maps dom id to text filter def.
   *
   * @type {Record<string, object>}
   */
  textFilterDefsByDomId: {},
  /**
   * Add a message field available for text filtering.
   *
   * @param {object} aTextDef - Text filter definition.
   * @param {string} aTextDef.name - Name of the filter.
   * @param {string} aTextDef.domId - ID of the filter control in the quick
   *   filter bar.
   * @param {boolean} aTextDef.defaultState - Default state of the filter.
   * @param {nsMsgSearchAttrib} aTextDef.attrib - Attribute to filter by.
   */
  defineTextFilter(aTextDef) {
    this.textFilterDefs[aTextDef.name] = aTextDef;
    this.textFilterDefsByDomId[aTextDef.domId] = aTextDef;
    if (aTextDef.defaultState) {
      this._defaultStates[aTextDef.name] = true;
    }
  },
};

// Note that we definitely want this filter defined AFTER the cheap message
// status filters, so don't reorder this invocation willy nilly.
QuickFilterManager.defineFilter(MessageTextFilter);
QuickFilterManager.textBoxDomId = "qfb-qs-textbox";

MessageTextFilter.defineTextFilter({
  name: "sender",
  domId: "qfb-qs-sender",
  attrib: Ci.nsMsgSearchAttrib.Sender,
  defaultState: true,
});
MessageTextFilter.defineTextFilter({
  name: "recipients",
  domId: "qfb-qs-recipients",
  attrib: Ci.nsMsgSearchAttrib.ToOrCC,
  defaultState: true,
});
MessageTextFilter.defineTextFilter({
  name: "subject",
  domId: "qfb-qs-subject",
  attrib: Ci.nsMsgSearchAttrib.Subject,
  defaultState: true,
});
MessageTextFilter.defineTextFilter({
  name: "body",
  domId: "qfb-qs-body",
  attrib: Ci.nsMsgSearchAttrib.Body,
  defaultState: false,
});

/**
 * The results label says whether there were any matches and, if so, how many.
 */
QuickFilterManager.defineFilter({
  name: "results",
  domId: "qfb-results-label",
  appendTerms() {},

  /**
   * Our state is meaningless; we implement this to avoid clearState ever
   * thinking we were a facet.
   */
  clearState() {
    return [null, false];
  },

  /**
   * We never have any state to propagate!
   */
  propagateState() {
    return null;
  },

  reflectInDOM(aNode, aFilterValue, aDocument) {
    if (aFilterValue == null) {
      aNode.removeAttribute("data-l10n-id");
      aNode.removeAttribute("data-l10n-attrs");
      aNode.textContent = "";
      aNode.style.visibility = "hidden";
    } else if (aFilterValue == 0) {
      aDocument.l10n.setAttributes(aNode, "quick-filter-bar-no-results");
      aNode.style.visibility = "visible";
    } else {
      aDocument.l10n.setAttributes(aNode, "quick-filter-bar-results", {
        count: aFilterValue,
      });
      aNode.style.visibility = "visible";
    }
  },
  /**
   * We slightly abuse the filtering hook to figure out how many messages there
   * are and whether a filter is active. What makes this reasonable is that
   * a more complicated widget that visualized the results as a timeline would
   * definitely want to be hooked up like this. (Although they would want
   * to implement propagateState since the state they store would be pretty
   * expensive.)
   */
  postFilterProcess(aState, aViewWrapper, aFiltering) {
    return [aFiltering ? aViewWrapper.dbView.numMsgsInView : null, true, false];
  },
});
