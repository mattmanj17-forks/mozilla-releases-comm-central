/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-  */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_MORK_MORKSPACE_H_
#define COMM_MAILNEWS_DB_MORK_MORKSPACE_H_

#ifndef _MORK_
#  include "mork.h"
#endif

#ifndef _MORKNODE_
#  include "morkNode.h"
#endif

#ifndef _MORKBEAD_
#  include "morkBead.h"
#endif

#ifndef _MORKMAP_
#  include "morkMap.h"
#endif

// 456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789

#define morkSpace_kInitialSpaceSlots /*i*/ 1024 /* default */
#define morkDerived_kSpace /*i*/ 0x5370         /* ascii 'Sp' */

/*| morkSpace:
|*/
class morkSpace : public morkBead {  //

  // public: // slots inherited from morkNode (meant to inform only)
  // nsIMdbHeap*       mNode_Heap;

  // mork_base      mNode_Base;     // must equal morkBase_kNode
  // mork_derived   mNode_Derived;  // depends on specific node subclass

  // mork_access    mNode_Access;   // kOpen, kClosing, kShut, or kDead
  // mork_usage     mNode_Usage;    // kHeap, kStack, kMember, kGlobal, kNone
  // mork_able      mNode_Mutable;  // can this node be modified?
  // mork_load      mNode_Load;     // is this node clean or dirty?

  // mork_uses      mNode_Uses;     // refcount for strong refs
  // mork_refs      mNode_Refs;     // refcount for strong refs + weak refs

  // mork_color      mBead_Color;   // ID for this bead

 public:  // bead color setter & getter replace obsolete member mTable_Id:
  mork_tid SpaceScope() const { return mBead_Color; }
  void SetSpaceScope(mork_scope inScope) { mBead_Color = inScope; }

 public:  // state is public because the entire Mork system is private
  morkStore* mSpace_Store;  // weak ref to containing store

  mork_bool mSpace_DoAutoIDs;        // whether db should assign member IDs
  mork_bool mSpace_HaveDoneAutoIDs;  // whether actually auto assigned IDs
  mork_bool mSpace_CanDirty;         // changes imply the store becomes dirty?
  mork_u1 mSpace_Pad;                // pad to u4 alignment

 public:  // more specific dirty methods for space:
  void SetSpaceDirty() { this->SetNodeDirty(); }
  void SetSpaceClean() { this->SetNodeClean(); }

  mork_bool IsSpaceClean() const { return this->IsNodeClean(); }
  mork_bool IsSpaceDirty() const { return this->IsNodeDirty(); }

  // { ===== begin morkNode interface =====
 public:                                    // morkNode virtual methods
  virtual void CloseMorkNode(morkEnv* ev);  // CloseSpace() only if open
  virtual ~morkSpace();  // assert that CloseSpace() executed earlier

 public:  // morkMap construction & destruction
  // morkSpace(morkEnv* ev, const morkUsage& inUsage, nsIMdbHeap* ioNodeHeap,
  //  const morkMapForm& inForm, nsIMdbHeap* ioSlotHeap);

  morkSpace(morkEnv* ev, const morkUsage& inUsage, mork_scope inScope,
            morkStore* ioStore, nsIMdbHeap* ioNodeHeap, nsIMdbHeap* ioSlotHeap);
  void CloseSpace(morkEnv* ev);  // called by CloseMorkNode();

 public:  // dynamic type identification
  mork_bool IsSpace() const {
    return IsNode() && mNode_Derived == morkDerived_kSpace;
  }
  // } ===== end morkNode methods =====

 public:  // other space methods
  mork_bool MaybeDirtyStoreAndSpace();

  static void NonAsciiSpaceScopeName(morkEnv* ev);
  static void NilSpaceStoreError(morkEnv* ev);

  morkPool* GetSpaceStorePool() const;

 public:  // typesafe refcounting inlines calling inherited morkNode methods
  static void SlotWeakSpace(morkSpace* me, morkEnv* ev, morkSpace** ioSlot) {
    morkNode::SlotWeakNode((morkNode*)me, ev, (morkNode**)ioSlot);
  }

  static void SlotStrongSpace(morkSpace* me, morkEnv* ev, morkSpace** ioSlot) {
    morkNode::SlotStrongNode((morkNode*)me, ev, (morkNode**)ioSlot);
  }
};

// 456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789

#endif  // COMM_MAILNEWS_DB_MORK_MORKSPACE_H_
