/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * An implemention of |nsITreeView| for a tree whose elements have no children.
 *
 * Code using BasicOView can override |getRowProperties|, |getColumnProperties|,
 * |getCellProperties|, etc., as needed.
 *
 * Code using |BasicOView| will need to make the appropriate |myTree.tree
 * .invalidate| calls when |myTree.data| changes.
 *
 * @syntax
 *   var myTree = new BasicOView()
 *   myTree.setColumnNames(["col 1", "col 2"]);
 *   myTree.data = [["row 1, col 1", "row 1, col 2"],
 *                  ["row 2, col 1", "row 2, col 2"]];
 *   treeBoxObject.view = myTree;
 */
function BasicOView() {
  this.tree = null;
}

/* functions *you* should call to initialize and maintain the tree state */

/* scroll the line specified by |line| to the center of the tree */
BasicOView.prototype.centerLine = function (line) {
  var first = this.tree.getFirstVisibleRow();
  var last = this.tree.getLastVisibleRow();
  this.scrollToRow(line - (last - first + 1) / 2);
};

/* call this to set the association between column names and data columns */
BasicOView.prototype.setColumnNames = function (aryNames) {
  this.columnNames = {};
  for (var i = 0; i < aryNames.length; ++i) {
    this.columnNames[aryNames[i]] = i;
  }
};

/*
 * scroll the source so |line| is at either the top, center, or bottom
 * of the view, depending on the value of |align|.
 *
 * line is the one based target line.
 * if align is negative, the line will be scrolled to the top, if align is
 * zero the line will be centered, and if align is greater than 0 the line
 * will be scrolled to the bottom.  0 is the default.
 */
BasicOView.prototype.scrollTo = function (line, align) {
  if (!this.tree) {
    return;
  }

  var headerRows = 1;

  var first = this.tree.getFirstVisibleRow();
  var last = this.tree.getLastVisibleRow();
  var viz = last - first + 1 - headerRows; /* total number of visible rows */

  /* all rows are visible, nothing to scroll */
  if (first == 0 && last >= this.rowCount) {
    return;
  }

  /* tree lines are 0 based, we accept one based lines, deal with it */
  --line;

  /* safety clamp */
  if (line < 0) {
    line = 0;
  }
  if (line >= this.rowCount) {
    line = this.rowCount - 1;
  }

  if (align < 0) {
    if (line > this.rowCount - viz) {
      /* overscroll, can't put a row from */
      line = this.rowCount - viz;
    } /* last page at the top. */
    this.tree.scrollToRow(line);
  } else if (align > 0) {
    if (line < viz) {
      /* underscroll, can't put a row from the first page */
      line = 0;
    } /* at the bottom. */ else {
      line = line - viz + headerRows;
    }

    this.tree.scrollToRow(line);
  } else {
    var half_viz = viz / 2;
    /* lines past this line can't be centered without causing the tree
     * to show more rows than we have. */
    var lastCenterable = this.rowCount - half_viz;
    if (line > half_viz) {
      line = lastCenterable;
    } else if (line < half_viz) {
      /* lines before this can't be centered without causing the tree
       * to attempt to display negative rows. */
      line = half_viz;
    } else {
      /* round the vizible rows down to a whole number, or we try to end up
       * on a N + 0.5 row! */
      half_viz = Math.floor(half_viz);
    }

    this.tree.scrollToRow(line - half_viz);
  }
};

BasicOView.prototype.__defineGetter__("selectedIndex", bov_getsel);
function bov_getsel() {
  if (!this.tree || this.tree.view.selection.getRangeCount() < 1) {
    return -1;
  }

  var min = {};
  this.tree.view.selection.getRangeAt(0, min, {});
  return min.value;
}

BasicOView.prototype.__defineSetter__("selectedIndex", bov_setsel);
function bov_setsel(i) {
  if (i == -1) {
    this.tree.view.selection.clearSelection();
  } else {
    this.tree.view.selection.timedSelect(i, 500);
  }
  return i;
}

/*
 * functions the tree will call to retrieve the list state (nsITreeView.)
 */

BasicOView.prototype.rowCount = 0;

BasicOView.prototype.getCellProperties = function (row, col, properties) {
  return "";
};

BasicOView.prototype.getColumnProperties = function (col, properties) {
  return "";
};

BasicOView.prototype.getRowProperties = function (index, properties) {
  return "";
};

BasicOView.prototype.isContainer = function (index) {
  return false;
};

BasicOView.prototype.isContainerOpen = function (index) {
  return false;
};

BasicOView.prototype.isContainerEmpty = function (index) {
  return false;
};

BasicOView.prototype.isSeparator = function (index) {
  return false;
};

BasicOView.prototype.isSorted = function (index) {
  return false;
};

BasicOView.prototype.canDrop = function (index, orientation) {
  return false;
};

BasicOView.prototype.drop = function (index, orientation) {
  return false;
};

BasicOView.prototype.getParentIndex = function (index) {
  if (index < 0) {
    return -1;
  }

  return 0;
};

BasicOView.prototype.hasNextSibling = function (rowIndex, afterIndex) {
  return afterIndex < this.rowCount - 1;
};

BasicOView.prototype.getLevel = function (index) {
  return 0;
};

BasicOView.prototype.getImageSrc = function (row, col) {};

BasicOView.prototype.getProgressMode = function (row, col) {};

BasicOView.prototype.getCellValue = function (row, col) {};

BasicOView.prototype.getCellText = function (row, col) {
  if (!this.columnNames) {
    return "";
  }

  if (typeof col == "object") {
    col = col.id;
  }

  var ary = col.match(/:(.*)/);
  if (ary) {
    col = ary[1];
  }

  var colName = this.columnNames[col];

  if (typeof colName == "undefined") {
    return "";
  }

  return this.data[row][colName];
};

BasicOView.prototype.setTree = function (tree) {
  this.tree = tree;
};

BasicOView.prototype.toggleOpenState = function (index) {};

BasicOView.prototype.cycleHeader = function (col) {};

BasicOView.prototype.selectionChanged = function () {};

BasicOView.prototype.cycleCell = function (row, col) {};

BasicOView.prototype.isEditable = function (row, col) {
  return false;
};

BasicOView.prototype.isSelectable = function (row, col) {
  return false;
};

BasicOView.prototype.setCellValue = function (row, col, value) {};

BasicOView.prototype.setCellText = function (row, col, value) {};

BasicOView.prototype.onRouteFocus = function (event) {
  if ("onFocus" in this) {
    this.onFocus(event);
  }
};

BasicOView.prototype.onRouteBlur = function (event) {
  if ("onBlur" in this) {
    this.onBlur(event);
  }
};

BasicOView.prototype.onRouteDblClick = function (event) {
  if (!("onRowCommand" in this) || event.target.localName != "treechildren") {
    return;
  }

  var rowIndex = this.tree.view.selection.currentIndex;
  if (rowIndex == -1 || rowIndex > this.rowCount) {
    return;
  }
  var rec = this.childData.locateChildByVisualRow(rowIndex);
  if (!rec) {
    ASSERT(0, "bogus row index " + rowIndex);
    return;
  }

  this.onRowCommand(rec, event);
};

BasicOView.prototype.onRouteKeyPress = function (event) {
  var rec;
  var rowIndex;

  if ("onRowCommand" in this && (event.keyCode == 13 || event.charCode == 32)) {
    if (!this.selection) {
      return;
    }

    rowIndex = this.tree.view.selection.currentIndex;
    if (rowIndex == -1 || rowIndex > this.rowCount) {
      return;
    }
    rec = this.childData.locateChildByVisualRow(rowIndex);
    if (!rec) {
      ASSERT(0, "bogus row index " + rowIndex);
      return;
    }

    this.onRowCommand(rec, event);
  } else if ("onKeyPress" in this) {
    rowIndex = this.tree.view.selection.currentIndex;
    if (rowIndex != -1 && rowIndex < this.rowCount) {
      rec = this.childData.locateChildByVisualRow(rowIndex);
      if (!rec) {
        ASSERT(0, "bogus row index " + rowIndex);
        return;
      }
    } else {
      rec = null;
    }

    this.onKeyPress(rec, event);
  }
};

BasicOView.prototype.performAction = function (action) {};

BasicOView.prototype.performActionOnRow = function (action) {};

BasicOView.prototype.performActionOnCell = function (action) {};

/**
 * A single entry in an |XULTreeView|.
 *
 * These things take care of keeping the |XULTreeView| properly informed of
 * changes in value and child count. You shouldn't have to maintain tree state
 * at all - just update the |XULTreeViewRecord| objects.
 *
 * @param share An otherwise empty object to store cache data. You should use
 *              the same object as the |share| for the |XULTreeView| that you
 *              indend to contain these records.
 *
 */
function XULTreeViewRecord(share) {
  this._share = share;
  this.visualFootprint = 1;
  this.isHidden = true;
  /* records are considered hidden until they are
   * inserted into a live tree */
}

XULTreeViewRecord.prototype.isContainerOpen = false;

/*
 * walk the parent tree to find our tree container.  return null if there is
 * none
 */
XULTreeViewRecord.prototype.findContainerTree = function () {
  if (!("parentRecord" in this)) {
    return null;
  }
  var parent = this.parentRecord;

  while (parent) {
    if ("_treeView" in parent) {
      return parent._treeView;
    }
    if ("parentRecord" in parent) {
      parent = parent.parentRecord;
    } else {
      parent = null;
    }
  }

  return null;
};

XULTreeViewRecord.prototype.__defineGetter__("childIndex", xtvr_getChildIndex);
function xtvr_getChildIndex() {
  //dd ("getChildIndex {");

  if (!("parentRecord" in this)) {
    delete this._childIndex;
    //dd ("} -1");
    return -1;
  }

  if ("_childIndex" in this) {
    if (
      "childData" in this &&
      this._childIndex in this.childData &&
      this.childData[this._childIndex] == this
    ) {
      //dd ("} " + this._childIndex);
      return this._childIndex;
    }
  }

  var childData = this.parentRecord.childData;
  var len = childData.length;
  for (var i = 0; i < len; ++i) {
    if (childData[i] == this) {
      this._childIndex = i;
      //dd ("} " + this._childIndex);
      return i;
    }
  }

  delete this._childIndex;
  //dd ("} -1");
  return -1;
}

XULTreeViewRecord.prototype.__defineSetter__("childIndex", xtvr_setChildIndex);
function xtvr_setChildIndex() {
  dd("xtvr: childIndex is read only, ignore attempt to write to it\n");
  if (typeof getStackTrace == "function") {
    dd(getStackTrace());
  }
}

/* count the number of parents, not including the root node */
XULTreeViewRecord.prototype.__defineGetter__("level", xtvr_getLevel);
function xtvr_getLevel() {
  if (!("parentRecord" in this)) {
    return -1;
  }

  var rv = 0;
  var parentRecord = this.parentRecord;
  while (
    "parentRecord" in parentRecord &&
    (parentRecord = parentRecord.parentRecord)
  ) {
    ++rv;
  }
  return rv;
}

/*
 * associates a property name on this record, with a column in the tree.  This
 * method will set up a get/set pair for the property name you specify which
 * will take care of updating the tree when the value changes.  DO NOT try
 * to change your mind later.  Do not attach a different name to the same colID,
 * and do not rename the colID.  You have been warned.
 */
XULTreeViewRecord.prototype.setColumnPropertyName = function (
  colID,
  propertyName
) {
  function xtvr_getValueShim() {
    return this._colValues[colID];
  }
  function xtvr_setValueShim(newValue) {
    this._colValues[colID] = newValue;
    return newValue;
  }

  if (!("_colValues" in this)) {
    this._colValues = {};
  }

  this.__defineGetter__(propertyName, xtvr_getValueShim);
  this.__defineSetter__(propertyName, xtvr_setValueShim);
};

XULTreeViewRecord.prototype.setColumnPropertyValue = function (colID, value) {
  this._colValues[colID] = value;
};

/*
 * set the default sort column and reSort.
 */
XULTreeViewRecord.prototype.setSortColumn = function (colID, dir) {
  //dd ("setting sort column to " + colID);
  this._share.sortColumn = colID;
  this._share.sortDirection = typeof dir == "undefined" ? 1 : dir;
  this.reSort();
};

/*
 * set the default sort direction.  1 is ascending, -1 is descending, 0 is no
 * sort.  setting this to 0 will *not* recover the natural insertion order,
 * it will only affect newly added items.
 */
XULTreeViewRecord.prototype.setSortDirection = function (dir) {
  this._share.sortDirection = dir;
};

/*
 * invalidate this row in the tree
 */
XULTreeViewRecord.prototype.invalidate = function () {
  var tree = this.findContainerTree();
  if (tree) {
    var row = this.calculateVisualRow();
    if (row != -1) {
      tree.tree.invalidateRow(row);
    }
  }
};

/*
 * invalidate any data in the cache.
 */
XULTreeViewRecord.prototype.invalidateCache = function () {
  this._share.rowCache = {};
  this._share.lastComputedIndex = -1;
  this._share.lastIndexOwner = null;
};

/*
 * default comparator function for sorts.  if you want a custom sort, override
 * this method.  We declare xtvr_sortcmp as a top level function, instead of
 * a function expression so we can refer to it later.
 */
XULTreeViewRecord.prototype.sortCompare = xtvr_sortcmp;
function xtvr_sortcmp(a, b) {
  var sc = a._share.sortColumn;
  var sd = a._share.sortDirection;

  a = a[sc];
  b = b[sc];

  if (a < b) {
    return -1 * sd;
  }

  if (a > b) {
    return 1 * sd;
  }

  return 0;
}

/*
 * this method will cause all child records to be reSorted.  any records
 * with the default sortCompare method will be sorted by the colID passed to
 * setSortColumn.
 *
 * the local parameter is used internally to control whether or not the
 * sorted rows are invalidated.  don't use it yourself.
 */
XULTreeViewRecord.prototype.reSort = function (leafSort) {
  if (
    !("childData" in this) ||
    this.childData.length < 1 ||
    (this.childData[0].sortCompare == xtvr_sortcmp &&
      !("sortColumn" in this._share)) ||
    this._share.sortDirection == 0
  ) {
    /* if we have no children, or we have the default sort compare and no
     * sort flags, then just exit */
    return;
  }

  this.childData.sort(this.childData[0].sortCompare);

  for (var i = 0; i < this.childData.length; ++i) {
    if (
      "isContainerOpen" in this.childData[i] &&
      this.childData[i].isContainerOpen
    ) {
      this.childData[i].reSort(true);
    } else {
      this.childData[i].sortIsInvalid = true;
    }
  }

  if (!leafSort) {
    this.invalidateCache();
    var tree = this.findContainerTree();
    if (tree && tree.tree) {
      var rowIndex = this.calculateVisualRow();
      /*
            dd ("invalidating " + rowIndex + " - " +
                (rowIndex + this.visualFootprint - 1));
            */
      tree.tree.invalidateRange(rowIndex, rowIndex + this.visualFootprint - 1);
    }
  }
  delete this.sortIsInvalid;
};

/*
 * call this to indicate that this node may have children at one point.  make
 * sure to call it before adding your first child.
 */
XULTreeViewRecord.prototype.reserveChildren = function (always) {
  if (!("childData" in this)) {
    this.childData = [];
  }
  if (!("isContainerOpen" in this)) {
    this.isContainerOpen = false;
  }
  if (always) {
    this.alwaysHasChildren = true;
  } else {
    delete this.alwaysHasChildren;
  }
};

/*
 * add a child to the end of the child list for this record.  takes care of
 * updating the tree as well.
 */
XULTreeViewRecord.prototype.appendChild = function (child) {
  if (!isinstance(child, XULTreeViewRecord)) {
    throw Components.Exception("", Cr.NS_ERROR_INVALID_ARG);
  }

  child.isHidden = false;
  child.parentRecord = this;
  this.childData.push(child);

  if ("isContainerOpen" in this && this.isContainerOpen) {
    //dd ("appendChild: " + xtv_formatRecord(child, ""));
    if (this.calculateVisualRow() >= 0) {
      var tree = this.findContainerTree();
      if (tree && tree.frozen) {
        this.needsReSort = true;
      } else {
        this.reSort(true);
      }
      /* reSort, don't invalidate.  we're going
       * to do that in the
       * onVisualFootprintChanged call. */
    }
    this.onVisualFootprintChanged(
      child.calculateVisualRow(),
      child.visualFootprint
    );
  }
};

/*
 * add a list of children to the end of the child list for this record.
 * faster than multiple appendChild() calls.
 */
XULTreeViewRecord.prototype.appendChildren = function (children) {
  var delta = 0;
  for (var i = 0; i < children.length; ++i) {
    var child = children[i];
    child.isHidden = false;
    child.parentRecord = this;
    this.childData.push(child);
    delta += child.visualFootprint;
  }

  if ("isContainerOpen" in this && this.isContainerOpen) {
    if (this.calculateVisualRow() >= 0) {
      this.reSort(true);
      /* reSort, don't invalidate.  we're going to do
       * that in the onVisualFootprintChanged call. */
    }
    this.onVisualFootprintChanged(
      this.childData[0].calculateVisualRow(),
      delta
    );
  }
};

/*
 * Removes a single child from this record by index.
 * @param index Index of the child record to remove.
 */
XULTreeViewRecord.prototype.removeChildAtIndex = function (index) {
  var len = this.childData.length;
  if (!ASSERT(index >= 0 && index < len, "index out of bounds")) {
    return;
  }

  var orphan = this.childData[index];
  var delta = -orphan.visualFootprint;
  var changeStart = orphan.calculateVisualRow();
  delete orphan.parentRecord;
  this.childData.splice(index, 1);

  if (!orphan.isHidden && "isContainerOpen" in this && this.isContainerOpen) {
    this.onVisualFootprintChanged(changeStart, delta);
  }
};

/*
 * Removes a range of children from this record by index. Faster than multiple
 * removeChildAtIndex() calls.
 * @param index Index of the first child record to remove.
 * @param count Number of child records to remove.
 */
XULTreeViewRecord.prototype.removeChildrenAtIndex = function (index, count) {
  var len = this.childData.length;
  if (!ASSERT(index >= 0 && index < len, "index out of bounds")) {
    return;
  }
  if (!ASSERT(count > 0 && index + count <= len, "count out of bounds")) {
    return;
  }

  var delta = 0;
  var changeStart = this.childData[index].calculateVisualRow();
  for (var i = 0; i < count; ++i) {
    var orphan = this.childData[index + i];
    if (!orphan.isHidden) {
      delta -= orphan.visualFootprint;
    }
    delete orphan.parentRecord;
  }
  this.childData.splice(index, count);

  if ("isContainerOpen" in this && this.isContainerOpen) {
    this.onVisualFootprintChanged(changeStart, delta);
  }
};

/*
 * hide this record and all descendants.
 */
XULTreeViewRecord.prototype.hide = function () {
  if (this.isHidden) {
    return;
  }

  var tree = this.findContainerTree();
  if (tree && tree.frozen) {
    this.isHidden = true;
    if ("parentRecord" in this) {
      this.parentRecord.onVisualFootprintChanged(0, -this.visualFootprint);
    }
    return;
  }

  /* get the row before hiding */
  var row = this.calculateVisualRow();
  this.invalidateCache();
  this.isHidden = true;
  /* go right to the parent so we don't muck with our own visualFootprint
   * record, we'll need it to be correct if we're ever unHidden. */
  if ("parentRecord" in this) {
    this.parentRecord.onVisualFootprintChanged(row, -this.visualFootprint);
  }
};

/*
 * unhide this record and all descendants.
 */
XULTreeViewRecord.prototype.unHide = function () {
  if (!this.isHidden) {
    return;
  }

  var tree = this.findContainerTree();
  if (tree && tree.frozen) {
    this.isHidden = false;
    if ("parentRecord" in this) {
      this.parentRecord.onVisualFootprintChanged(0, this.visualFootprint);
    }
    return;
  }

  this.isHidden = false;
  this.invalidateCache();
  var row = this.calculateVisualRow();
  if (this.parentRecord) {
    this.parentRecord.onVisualFootprintChanged(row, this.visualFootprint);
  }
};

/*
 * open this record, exposing it's children.  DONT call this method if the
 * record has no children.
 */
XULTreeViewRecord.prototype.open = function () {
  if (this.isContainerOpen) {
    return;
  }

  if ("onPreOpen" in this) {
    this.onPreOpen();
  }

  this.isContainerOpen = true;
  var delta = 0;
  for (var i = 0; i < this.childData.length; ++i) {
    if (!this.childData[i].isHidden) {
      delta += this.childData[i].visualFootprint;
    }
  }

  /* this reSort should only happen if the sort column changed */
  this.reSort(true);
  this.visualFootprint += delta;
  if ("parentRecord" in this) {
    this.parentRecord.onVisualFootprintChanged(this.calculateVisualRow(), 0);
    this.parentRecord.onVisualFootprintChanged(
      this.calculateVisualRow() + 1,
      delta
    );
  }
};

/*
 * close this record, hiding it's children.  DONT call this method if the record
 * has no children, or if it is already closed.
 */
XULTreeViewRecord.prototype.close = function () {
  if (!this.isContainerOpen) {
    return;
  }

  this.isContainerOpen = false;
  var delta = 1 - this.visualFootprint;
  this.visualFootprint += delta;
  if ("parentRecord" in this) {
    this.parentRecord.onVisualFootprintChanged(this.calculateVisualRow(), 0);
    this.parentRecord.onVisualFootprintChanged(
      this.calculateVisualRow() + 1,
      delta
    );
  }

  if ("onPostClose" in this) {
    this.onPostClose();
  }
};

/*
 * called when a node above this one grows or shrinks.  we need to adjust
 * our own visualFootprint to match the change, and pass the message on.
 */
XULTreeViewRecord.prototype.onVisualFootprintChanged = function (
  start,
  amount
) {
  /* if we're not hidden, but this notification came from a hidden node
   * (start == -1), ignore it, it doesn't affect us. */
  if (start == -1 && !this.isHidden) {
    //dd ("vfp change (" + amount + ") from hidden node ignored.");
    return;
  }

  this.visualFootprint += amount;

  if ("parentRecord" in this) {
    this.parentRecord.onVisualFootprintChanged(start, amount);
  }
};

/*
 * calculate the "visual" row for this record.  If the record isn't actually
 * visible return -1.
 * eg.
 * Name        Visual Row
 * node1       0
 *   node11    1
 *   node12    2
 * node2       3
 *   node21    4
 * node3       5
 */
XULTreeViewRecord.prototype.calculateVisualRow = function () {
  /* if this is the second time in a row that someone asked us, fetch the last
   * result from the cache. */
  if (this._share.lastIndexOwner == this) {
    return this._share.lastComputedIndex;
  }

  var vrow;

  /* if this is an uninserted or hidden node, or... */
  if (
    !("parentRecord" in this) ||
    this.isHidden ||
    /* if parent isn't open, or... */
    !this.parentRecord.isContainerOpen ||
    /* parent isn't visible */
    (vrow = this.parentRecord.calculateVisualRow()) == -1
  ) {
    /* then we're not visible, return -1 */
    //dd ("cvr: returning -1");
    return -1;
  }

  /* parent is the root node XXX parent is not visible */
  if (vrow == null) {
    vrow = 0;
  } else {
    /* parent is not the root node, add one for the space they take up. */
    ++vrow;
  }

  /* add in the footprint for all of the earlier siblings */
  var ci = this.childIndex;
  for (var i = 0; i < ci; ++i) {
    if (!this.parentRecord.childData[i].isHidden) {
      vrow += this.parentRecord.childData[i].visualFootprint;
    }
  }

  /* save this calculation to the cache. */
  this._share.lastIndexOwner = this;
  this._share.lastComputedIndex = vrow;

  return vrow;
};

/*
 * locates the child record for the visible row |targetRow|.  DO NOT call this
 * with a targetRow less than this record's visual row, or greater than this
 * record's visual row + the number of visible children it has.
 */
XULTreeViewRecord.prototype.locateChildByVisualRow = function (
  targetRow,
  myRow
) {
  if (targetRow in this._share.rowCache) {
    return this._share.rowCache[targetRow];
  }

  /* if this is true, we *are* the index */
  if (targetRow == myRow) {
    return (this._share.rowCache[targetRow] = this);
  }

  /* otherwise, we've got to search the kids */
  var childStart = myRow;
  /* childStart represents the starting visual row
   * for the child we're examining. */
  for (var i = 0; i < this.childData.length; ++i) {
    var child = this.childData[i];
    /* ignore hidden children */
    if (child.isHidden) {
      continue;
    }
    /* if this kid is the targetRow, we're done */
    if (childStart == targetRow) {
      return (this._share.rowCache[targetRow] = child);
    } else if (targetRow <= childStart + child.visualFootprint) {
      /* if this kid contains the index, ask *it* to find the record */
      /* this *has* to succeed */
      var rv = child.locateChildByVisualRow(targetRow, childStart + 1);
      //XXXASSERT (rv, "Can't find a row that *has* to be there.");
      /* don't cache this, the previous call to locateChildByVisualRow
       * just did. */
      return rv;
    }

    /* otherwise, get ready to ask the next kid */
    childStart += child.visualFootprint;
  }

  return null;
};

// @internal
function XTRootRecord(tree, share) {
  this._share = share;
  this._treeView = tree;
  this.visualFootprint = 0;
  this.isHidden = false;
  this.reserveChildren();
  this.isContainerOpen = true;
}

/* no cache passed in here, we set it in the XTRootRecord contructor instead. */
XTRootRecord.prototype = new XULTreeViewRecord(null);

XTRootRecord.prototype.open = XTRootRecord.prototype.close = function () {
  /* don't do this on a root node */
};

XTRootRecord.prototype.calculateVisualRow = function () {
  return null;
};

XTRootRecord.prototype.reSort = function () {
  if ("_treeView" in this && this._treeView.frozen) {
    this._treeView.needsReSort = true;
    return;
  }

  if (
    !("childData" in this) ||
    this.childData.length < 1 ||
    (this.childData[0].sortCompare == xtvr_sortcmp &&
      !("sortColumn" in this._share)) ||
    this._share.sortDirection == 0
  ) {
    /* if we have no children, or we have the default sort compare but we're
     * missing a sort flag, then just exit */
    return;
  }

  this.childData.sort(this.childData[0].sortCompare);

  for (var i = 0; i < this.childData.length; ++i) {
    if (
      "isContainerOpen" in this.childData[i] &&
      this.childData[i].isContainerOpen
    ) {
      this.childData[i].reSort(true);
    } else {
      this.childData[i].sortIsInvalid = true;
    }
  }

  if ("_treeView" in this && this._treeView.tree) {
    /*
        dd ("root node: invalidating 0 - " + this.visualFootprint +
            " for sort");
        */
    this.invalidateCache();
    this._treeView.tree.invalidateRange(0, this.visualFootprint);
  }
};

XTRootRecord.prototype.locateChildByVisualRow = function (targetRow) {
  if (targetRow in this._share.rowCache) {
    return this._share.rowCache[targetRow];
  }

  var childStart = -1;
  /* childStart represents the starting visual row
   * for the child we're examining. */
  for (var i = 0; i < this.childData.length; ++i) {
    var child = this.childData[i];
    /* ignore hidden children */
    if (child.isHidden) {
      continue;
    }
    /* if this kid is the targetRow, we're done */
    if (childStart == targetRow) {
      return (this._share.rowCache[targetRow] = child);
    } else if (targetRow <= childStart + child.visualFootprint) {
      /* if this kid contains the index, ask *it* to find the record */
      /* this *has* to succeed */
      var rv = child.locateChildByVisualRow(targetRow, childStart + 1);
      //XXXASSERT (rv, "Can't find a row that *has* to be there.");
      /* don't cache this, the previous call to locateChildByVisualRow
       * just did. */
      return rv;
    }

    /* otherwise, get ready to ask the next kid */
    childStart += child.visualFootprint;
  }

  return null;
};

XTRootRecord.prototype.onVisualFootprintChanged = function (start, amount) {
  if (!this._treeView.frozen) {
    this.invalidateCache();
    this.visualFootprint += amount;
    if (
      "_treeView" in this &&
      "tree" in this._treeView &&
      this._treeView.tree
    ) {
      if (amount != 0) {
        this._treeView.tree.rowCountChanged(start, amount);
      } else {
        this._treeView.tree.invalidateRow(start);
      }
    }
  } else {
    if ("changeAmount" in this._treeView) {
      this._treeView.changeAmount += amount;
    } else {
      this._treeView.changeAmount = amount;
    }
    if ("changeStart" in this._treeView) {
      this._treeView.changeStart = Math.min(start, this._treeView.changeStart);
    } else {
      this._treeView.changeStart = start;
    }
  }
};

/**
 * An implemention of |nsITreeView| for a tree whose elements have multiple
 * levels of children.
 *
 * Code using |XULTreeView| can override |getRowProperties|, |getColumnProperties|,
 * |getCellProperties|, etc., as needed.
 *
 * @param share An otherwise empty object to store cache data.
 */
function XULTreeView(share) {
  if (!share) {
    share = {};
  }
  this.childData = new XTRootRecord(this, share);
  this.childData.invalidateCache();
  this.tree = null;
  this.share = share;
  this.frozen = 0;
}

/* functions *you* should call to initialize and maintain the tree state */

/*
 * Changes to the tree contents will not cause the tree to be invalidated
 * until |thaw()| is called.  All changes will be pooled into a single invalidate
 * call.
 *
 * Freeze/thaws are nestable, the tree will not update until the number of
 * |thaw()| calls matches the number of freeze() calls.
 */
XULTreeView.prototype.freeze = function () {
  if (++this.frozen == 1) {
    this.changeStart = 0;
    this.changeAmount = 0;
  }
};

/*
 * Reflect any changes to the tree content since the last freeze.
 */
XULTreeView.prototype.thaw = function () {
  if (this.frozen == 0) {
    ASSERT(0, "not frozen");
    return;
  }

  if (--this.frozen == 0 && "changeStart" in this) {
    this.childData.onVisualFootprintChanged(
      this.changeStart,
      this.changeAmount
    );
  }

  if ("needsReSort" in this) {
    this.childData.reSort();
    delete this.needsReSort;
  }

  delete this.changeStart;
  delete this.changeAmount;
};

XULTreeView.prototype.saveBranchState = function (target, source, recurse) {
  var len = source.length;
  for (var i = 0; i < len; ++i) {
    if (source[i].isContainerOpen) {
      target[i] = {};
      target[i].name = source[i]._colValues["col-0"];
      if (recurse) {
        this.saveBranchState(target[i], source[i].childData, true);
      }
    }
  }
};

XULTreeView.prototype.restoreBranchState = function (target, source, recurse) {
  for (var i in source) {
    if (typeof source[i] == "object") {
      var name = source[i].name;
      var len = target.length;
      for (var j = 0; j < len; ++j) {
        if (target[j]._colValues["col-0"] == name && "childData" in target[j]) {
          //dd ("opening " + name);
          target[j].open();
          if (recurse) {
            this.restoreBranchState(target[j].childData, source[i], true);
          }
          break;
        }
      }
    }
  }
};

/* scroll the line specified by |line| to the center of the tree */
XULTreeView.prototype.centerLine = function (line) {
  var first = this.tree.getFirstVisibleRow();
  var last = this.tree.getLastVisibleRow();
  this.scrollToRow(line - (last - first + 1) / 2);
};

/*
 * functions the tree will call to retrieve the list state (nsITreeView.)
 */

// @internal
XULTreeView.prototype.__defineGetter__("rowCount", xtv_getRowCount);
function xtv_getRowCount() {
  if (!this.childData) {
    return 0;
  }

  return this.childData.visualFootprint;
}

// @internal
XULTreeView.prototype.isContainer = function (index) {
  var row = this.childData.locateChildByVisualRow(index);

  return Boolean(row && ("alwaysHasChildren" in row || "childData" in row));
};

// @internal
XULTreeView.prototype.__defineGetter__("selectedIndex", xtv_getsel);
function xtv_getsel() {
  if (!this.tree || this.tree.view.selection.getRangeCount() < 1) {
    return -1;
  }

  var min = {};
  this.tree.view.selection.getRangeAt(0, min, {});
  return min.value;
}

// @internal
XULTreeView.prototype.__defineSetter__("selectedIndex", xtv_setsel);
function xtv_setsel(i) {
  this.tree.view.selection.clearSelection();
  if (i != -1) {
    this.tree.view.selection.timedSelect(i, 500);
  }
  return i;
}

// @internal
XULTreeView.prototype.scrollTo = BasicOView.prototype.scrollTo;

// @internal
XULTreeView.prototype.isContainerOpen = function (index) {
  var row = this.childData.locateChildByVisualRow(index);
  return row && row.isContainerOpen;
};

// @internal
XULTreeView.prototype.toggleOpenState = function (index) {
  var row = this.childData.locateChildByVisualRow(index);
  //ASSERT(row, "bogus row");
  if (row) {
    if (row.isContainerOpen) {
      row.close();
    } else {
      row.open();
    }
  }
};

// @internal
XULTreeView.prototype.isContainerEmpty = function (index) {
  var row = this.childData.locateChildByVisualRow(index);
  if ("alwaysHasChildren" in row) {
    return false;
  }

  if (!row || !("childData" in row)) {
    return true;
  }

  return !row.childData.length;
};

// @internal
XULTreeView.prototype.isSeparator = function (index) {
  return false;
};

// @internal
XULTreeView.prototype.getParentIndex = function (index) {
  if (index < 0) {
    return -1;
  }

  var row = this.childData.locateChildByVisualRow(index);

  var rv = row.parentRecord.calculateVisualRow();
  //dd ("getParentIndex: row " + index + " returning " + rv);
  return rv != null ? rv : -1;
};

// @internal
XULTreeView.prototype.hasNextSibling = function (rowIndex, afterIndex) {
  var row = this.childData.locateChildByVisualRow(rowIndex);
  return row.childIndex < row.parentRecord.childData.length - 1;
};

// @internal
XULTreeView.prototype.getLevel = function (index) {
  var row = this.childData.locateChildByVisualRow(index);
  if (!row) {
    return 0;
  }

  return row.level;
};

// @internal
XULTreeView.prototype.getImageSrc = function (index, col) {};

// @internal
XULTreeView.prototype.getProgressMode = function (index, col) {};

// @internal
XULTreeView.prototype.getCellValue = function (index, col) {};

// @internal
XULTreeView.prototype.getCellText = function (index, col) {
  var row = this.childData.locateChildByVisualRow(index);
  //ASSERT(row, "bogus row " + index);

  if (typeof col == "object") {
    col = col.id;
  }

  var ary = col.match(/:(.*)/);
  if (ary) {
    col = ary[1];
  }

  if (row && row._colValues && col in row._colValues) {
    return row._colValues[col];
  }
  return "";
};

// @internal
XULTreeView.prototype.getCellProperties = function (row, col, properties) {
  return "";
};

// @internal
XULTreeView.prototype.getColumnProperties = function (col, properties) {
  return "";
};

// @internal
XULTreeView.prototype.getRowProperties = function (index, properties) {
  return "";
};

// @internal
XULTreeView.prototype.isSorted = function (index) {
  return false;
};

// @internal
XULTreeView.prototype.canDrop = function (index, orientation) {
  var row = this.childData.locateChildByVisualRow(index);
  //ASSERT(row, "bogus row " + index);
  return row && "canDrop" in row && row.canDrop(orientation);
};

// @internal
XULTreeView.prototype.drop = function (index, orientation) {
  var row = this.childData.locateChildByVisualRow(index);
  //ASSERT(row, "bogus row " + index);
  return row && "drop" in row && row.drop(orientation);
};

// @internal
XULTreeView.prototype.setTree = function (tree) {
  this.childData.invalidateCache();
  this.tree = tree;
};

// @internal
XULTreeView.prototype.cycleHeader = function (col) {};

// @internal
XULTreeView.prototype.selectionChanged = function () {};

// @internal
XULTreeView.prototype.cycleCell = function (row, col) {};

// @internal
XULTreeView.prototype.isEditable = function (row, col) {
  return false;
};

// @internal
XULTreeView.prototype.isSelectable = function (row, col) {
  return false;
};

// @internal
XULTreeView.prototype.setCellValue = function (row, col, value) {};

// @internal
XULTreeView.prototype.setCellText = function (row, col, value) {};

// @internal
XULTreeView.prototype.performAction = function (action) {};

// @internal
XULTreeView.prototype.performActionOnRow = function (action) {};

// @internal
XULTreeView.prototype.performActionOnCell = function (action) {};

// @internal
XULTreeView.prototype.onRouteFocus = function (event) {
  if ("onFocus" in this) {
    this.onFocus(event);
  }
};

// @internal
XULTreeView.prototype.onRouteBlur = function (event) {
  if ("onBlur" in this) {
    this.onBlur(event);
  }
};

// @internal
XULTreeView.prototype.onRouteDblClick = function (event) {
  if (!("onRowCommand" in this) || event.target.localName != "treechildren") {
    return;
  }

  var rowIndex = this.tree.view.selection.currentIndex;
  if (rowIndex == -1 || rowIndex > this.rowCount) {
    return;
  }
  var rec = this.childData.locateChildByVisualRow(rowIndex);
  if (!rec) {
    ASSERT(0, "bogus row index " + rowIndex);
    return;
  }

  this.onRowCommand(rec, event);
};

// @internal
XULTreeView.prototype.onRouteKeyPress = function (event) {
  var rec;
  var rowIndex;

  if ("onRowCommand" in this && (event.keyCode == 13 || event.charCode == 32)) {
    if (!this.selection) {
      return;
    }

    rowIndex = this.tree.view.selection.currentIndex;
    if (rowIndex == -1 || rowIndex > this.rowCount) {
      return;
    }
    rec = this.childData.locateChildByVisualRow(rowIndex);
    if (!rec) {
      ASSERT(0, "bogus row index " + rowIndex);
      return;
    }

    this.onRowCommand(rec, event);
  } else if ("onKeyPress" in this) {
    rowIndex = this.tree.view.selection.currentIndex;
    if (rowIndex != -1 && rowIndex < this.rowCount) {
      rec = this.childData.locateChildByVisualRow(rowIndex);
      if (!rec) {
        ASSERT(0, "bogus row index " + rowIndex);
        return;
      }
    } else {
      rec = null;
    }

    this.onKeyPress(rec, event);
  }
};

/******************************************************************************/

function xtv_formatRecord(rec, indent) {
  var str = "";

  for (var i in rec._colValues) {
    str += rec._colValues[i] + ", ";
  }

  str += "[";

  str += rec.calculateVisualRow() + ", ";
  str += rec.childIndex + ", ";
  str += rec.level + ", ";
  str += rec.visualFootprint + ", ";
  str += rec.isHidden + "]";

  return indent + str;
}

function xtv_formatBranch(rec, indent, recurse) {
  var str = "";
  for (var i = 0; i < rec.childData.length; ++i) {
    str += xtv_formatRecord(rec.childData[i], indent) + "\n";
    if (recurse) {
      if ("childData" in rec.childData[i]) {
        str += xtv_formatBranch(rec.childData[i], indent + "  ", --recurse);
      }
    }
  }

  return str;
}
