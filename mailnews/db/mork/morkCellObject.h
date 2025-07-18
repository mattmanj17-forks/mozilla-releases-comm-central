/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-  */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_MORK_MORKCELLOBJECT_H_
#define COMM_MAILNEWS_DB_MORK_MORKCELLOBJECT_H_

#ifndef _MORK_
#  include "mork.h"
#endif

#ifndef _MORKNODE_
#  include "morkNode.h"
#endif

#ifndef _MORKOBJECT_
#  include "morkObject.h"
#endif

// 456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789

#define morkDerived_kCellObject /*i*/ 0x634F /* ascii 'cO' */

class morkCellObject : public morkObject,
                       public nsIMdbCell {  // blob attribute in column scope

  // public: // slots inherited from morkObject (meant to inform only)
  // nsIMdbHeap*     mNode_Heap;
  // mork_able    mNode_Mutable; // can this node be modified?
  // mork_load    mNode_Load;    // is this node clean or dirty?
  // mork_base    mNode_Base;    // must equal morkBase_kNode
  // mork_derived mNode_Derived; // depends on specific node subclass
  // mork_access  mNode_Access;  // kOpen, kClosing, kShut, or kDead
  // mork_usage   mNode_Usage;   // kHeap, kStack, kMember, kGlobal, kNone
  // mork_uses    mNode_Uses;    // refcount for strong refs
  // mork_refs    mNode_Refs;    // refcount for strong refs + weak refs

  // mork_color   mBead_Color;   // ID for this bead
  // morkHandle*  mObject_Handle;  // weak ref to handle for this object

 public:  // state is public because the entire Mork system is private
  NS_DECL_ISUPPORTS_INHERITED

  morkRowObject* mCellObject_RowObject;  // strong ref to row's object
  morkRow* mCellObject_Row;              // cell's row if still in row object
  morkCell* mCellObject_Cell;            // cell in row if rowseed matches
  mork_column mCellObject_Col;           // col of cell last living in pos
  mork_u2 mCellObject_RowSeed;           // copy of row's seed
  mork_u2 mCellObject_Pos;               // position of cell in row

  // { ===== begin morkNode interface =====
 public:  // morkNode virtual methods
  virtual void CloseMorkNode(
      morkEnv* ev) override;  // CloseCellObject() only if open

 public:  // morkCellObject construction & destruction
  morkCellObject(morkEnv* ev, const morkUsage& inUsage, nsIMdbHeap* ioHeap,
                 morkRow* ioRow, morkCell* ioCell, mork_column inCol,
                 mork_pos inPos);
  void CloseCellObject(morkEnv* ev);  // called by CloseMorkNode();

  NS_IMETHOD SetBlob(nsIMdbEnv* ev,
                     nsIMdbBlob* ioBlob) override;  // reads inBlob slots
  // when inBlob is in the same suite, this might be fastest cell-to-cell

  NS_IMETHOD ClearBlob(  // make empty (so content has zero length)
      nsIMdbEnv* ev) override;
  // clearing a yarn is like SetYarn() with empty yarn instance content

  NS_IMETHOD GetBlobFill(nsIMdbEnv* ev,
                         mdb_fill* outFill) override;  // size of blob
  // Same value that would be put into mYarn_Fill, if one called GetYarn()
  // with a yarn instance that had mYarn_Buf==nil and mYarn_Size==0.

  NS_IMETHOD SetYarn(nsIMdbEnv* ev,
                     const mdbYarn* inYarn) override;  // reads from yarn slots
  // make this text object contain content from the yarn's buffer

  NS_IMETHOD GetYarn(nsIMdbEnv* ev,
                     mdbYarn* outYarn) override;  // writes some yarn slots
  // copy content into the yarn buffer, and update mYarn_Fill and mYarn_Form

  NS_IMETHOD AliasYarn(nsIMdbEnv* ev,
                       mdbYarn* outYarn) override;  // writes ALL yarn slots
  NS_IMETHOD SetColumn(nsIMdbEnv* ev, mdb_column inColumn) override;
  NS_IMETHOD GetColumn(nsIMdbEnv* ev, mdb_column* outColumn) override;

  NS_IMETHOD GetCellInfo(  // all cell metainfo except actual content
      nsIMdbEnv* ev,
      mdb_column* outColumn,              // the column in the containing row
      mdb_fill* outBlobFill,              // the size of text content in bytes
      mdbOid* outChildOid,                // oid of possible row or table child
      mdb_bool* outIsRowChild) override;  // nonzero if child, and a row child

  // Checking all cell metainfo is a good way to avoid forcing a large cell
  // in to memory when you don't actually want to use the content.

  NS_IMETHOD GetRow(nsIMdbEnv* ev,  // parent row for this cell
                    nsIMdbRow** acqRow) override;
  NS_IMETHOD GetPort(nsIMdbEnv* ev,  // port containing cell
                     nsIMdbPort** acqPort) override;
  // } ----- end attribute methods -----

  // { ----- begin children methods -----
  NS_IMETHOD HasAnyChild(  // does cell have a child instead of text?
      nsIMdbEnv* ev,
      mdbOid* outOid,  // out id of row or table (or unbound if no child)
      mdb_bool* outIsRow)
      override;  // nonzero if child is a row (rather than a table)

  NS_IMETHOD GetAnyChild(                // access table of specific attribute
      nsIMdbEnv* ev,                     // context
      nsIMdbRow** acqRow,                // child row (or null)
      nsIMdbTable** acqTable) override;  // child table (or null)

  NS_IMETHOD SetChildRow(  // access table of specific attribute
      nsIMdbEnv* ev,       // context
      nsIMdbRow* ioRow)
      override;  // inRow must be bound inside this same db port

  NS_IMETHOD GetChildRow(            // access row of specific attribute
      nsIMdbEnv* ev,                 // context
      nsIMdbRow** acqRow) override;  // acquire child row (or nil if no child)

  NS_IMETHOD SetChildTable(  // access table of specific attribute
      nsIMdbEnv* ev,         // context
      nsIMdbTable* inTable)
      override;  // table must be bound inside this same db port

  NS_IMETHOD GetChildTable(  // access table of specific attribute
      nsIMdbEnv* ev,         // context
      nsIMdbTable** acqTable)
      override;  // acquire child table (or nil if no child)

  // } ----- end children methods -----

  // } ===== end nsIMdbCell methods =====
 private:                     // copying is not allowed
  virtual ~morkCellObject();  // assert that CloseCellObject() executed earlier
  morkCellObject(const morkCellObject& other);
  morkCellObject& operator=(const morkCellObject& other);

 public:  // dynamic type identification
  mork_bool IsCellObject() const {
    return IsNode() && mNode_Derived == morkDerived_kCellObject;
  }
  // } ===== end morkNode methods =====

 public:  // other cell node methods
  morkEnv* CanUseCell(nsIMdbEnv* mev, mork_bool inMutable, nsresult* outErr,
                      morkCell** outCell);

  mork_bool ResyncWithRow(morkEnv* ev);  // return ev->Good()
  morkAtom* GetCellAtom(morkEnv* ev) const;

  static void MissingRowColumnError(morkEnv* ev);
  static void NilRowError(morkEnv* ev);
  static void NilCellError(morkEnv* ev);
  static void NilRowObjectError(morkEnv* ev);
  static void WrongRowObjectRowError(morkEnv* ev);
  static void NonCellObjectTypeError(morkEnv* ev);

  nsIMdbCell* AcquireCellHandle(morkEnv* ev);

 public:  // typesafe refcounting inlines calling inherited morkNode methods
  static void SlotWeakCellObject(morkCellObject* me, morkEnv* ev,
                                 morkCellObject** ioSlot) {
    morkNode::SlotWeakNode((morkNode*)me, ev, (morkNode**)ioSlot);
  }

  static void SlotStrongCellObject(morkCellObject* me, morkEnv* ev,
                                   morkCellObject** ioSlot) {
    morkNode::SlotStrongNode((morkNode*)me, ev, (morkNode**)ioSlot);
  }
};

// 456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789

#endif  // COMM_MAILNEWS_DB_MORK_MORKCELLOBJECT_H_
