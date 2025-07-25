/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-  */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_MORK_MORKBUILDER_H_
#define COMM_MAILNEWS_DB_MORK_MORKBUILDER_H_

#ifndef _MORK_
#  include "mork.h"
#endif

#ifndef _MORKPARSER_
#  include "morkParser.h"
#endif

// 456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789

/*| kCellsVecSize: length of cell vector buffer inside morkBuilder
|*/
#define morkBuilder_kCellsVecSize 64

#define morkBuilder_kDefaultBytesPerParseSegment 512 /* plausible to big */

#define morkDerived_kBuilder /*i*/ 0x4275 /* ascii 'Bu' */

class morkBuilder /*d*/ : public morkParser {
  // public: // slots inherited from morkParser (meant to inform only)
  // nsIMdbHeap*       mNode_Heap;

  // mork_base      mNode_Base;     // must equal morkBase_kNode
  // mork_derived   mNode_Derived;  // depends on specific node subclass

  // mork_access    mNode_Access;   // kOpen, kClosing, kShut, or kDead
  // mork_usage     mNode_Usage;    // kHeap, kStack, kMember, kGlobal, kNone
  // mork_able      mNode_Mutable;  // can this node be modified?
  // mork_load      mNode_Load;     // is this node clean or dirty?

  // mork_uses      mNode_Uses;     // refcount for strong refs
  // mork_refs      mNode_Refs;     // refcount for strong refs + weak refs

  // nsIMdbHeap*      mParser_Heap;   // refcounted heap used for allocation
  // morkStream*   mParser_Stream; // refcounted input stream

  // mork_u4       mParser_Tag; // must equal morkParser_kTag
  // mork_count    mParser_MoreGranularity; // constructor
  // inBytesPerParseSegment

  // mork_u4       mParser_State; // state where parser should resume

  // after finding ends of group transactions, we can re-seek the start:
  // mork_pos      mParser_GroupContentStartPos; // start of this group

  // mdbOid        mParser_TableOid; // table oid if inside a table
  // mdbOid        mParser_RowOid;   // row oid if inside a row
  // mork_gid      mParser_GroupId; // group ID if inside a group

  // mork_bool     mParser_InPort;  // called OnNewPort but not OnPortEnd?
  // mork_bool     mParser_InDict;  // called OnNewDict but not OnDictEnd?
  // mork_bool     mParser_InCell;  // called OnNewCell but not OnCellEnd?
  // mork_bool     mParser_InMeta;  // called OnNewMeta but not OnMetaEnd?

  // morkMid     mParser_Mid;   // current alias being parsed
  // note that mParser_Mid.mMid_Buf points at mParser_ScopeCoil below:

  // blob coils allocated in mParser_Heap
  // morkCoil     mParser_ScopeCoil;   // place to accumulate ID scope blobs
  // morkCoil     mParser_ValueCoil;   // place to accumulate value blobs
  // morkCoil     mParser_ColumnCoil;  // place to accumulate column blobs
  // morkCoil     mParser_StringCoil;  // place to accumulate string blobs

  // morkSpool    mParser_ScopeSpool;  // writes to mParser_ScopeCoil
  // morkSpool    mParser_ValueSpool;  // writes to mParser_ValueCoil
  // morkSpool    mParser_ColumnSpool; // writes to mParser_ColumnCoil
  // morkSpool    mParser_StringSpool; // writes to mParser_StringCoil

  // yarns allocated in mParser_Heap
  // morkYarn      mParser_MidYarn;   // place to receive from MidToYarn()

  // span showing current ongoing file position status:
  // morkSpan      mParser_PortSpan; // span of current db port file

  // various spans denoting nested subspaces inside the file's port span:
  // morkSpan      mParser_GroupSpan; // span of current transaction group
  // morkSpan      mParser_DictSpan;
  // morkSpan      mParser_AliasSpan;
  // morkSpan      mParser_MetaDictSpan;
  // morkSpan      mParser_TableSpan;
  // morkSpan      mParser_MetaTableSpan;
  // morkSpan      mParser_RowSpan;
  // morkSpan      mParser_MetaRowSpan;
  // morkSpan      mParser_CellSpan;
  // morkSpan      mParser_ColumnSpan;
  // morkSpan      mParser_SlotSpan;

  // ````` ````` ````` `````   ````` ````` ````` `````
 protected:  // protected morkBuilder members
  // weak refs that do not prevent closure of referenced nodes:
  morkStore* mBuilder_Store;  // weak ref to builder's store

  // strong refs that do indeed prevent closure of referenced nodes:
  morkTable* mBuilder_Table;  // current table being built (or nil)
  morkRow* mBuilder_Row;      // current row being built (or nil)
  morkCell* mBuilder_Cell;    // current cell within CellsVec (or nil)

  morkRowSpace* mBuilder_RowSpace;    // space for mBuilder_CellRowScope
  morkAtomSpace* mBuilder_AtomSpace;  // space for mBuilder_CellAtomScope

  morkAtomSpace* mBuilder_OidAtomSpace;    // ground atom space for oids
  morkAtomSpace* mBuilder_ScopeAtomSpace;  // ground atom space for scopes

  // scoped object ids for current objects under construction:
  mdbOid mBuilder_TableOid;  // full oid for current table
  mdbOid mBuilder_RowOid;    // full oid for current row

  // tokens that become set as the result of meta cells in port rows:
  mork_cscode mBuilder_PortForm;      // default port charset format
  mork_scope mBuilder_PortRowScope;   // port row scope
  mork_scope mBuilder_PortAtomScope;  // port atom scope

  // tokens that become set as the result of meta cells in meta tables:
  mork_cscode mBuilder_TableForm;      // default table charset format
  mork_scope mBuilder_TableRowScope;   // table row scope
  mork_scope mBuilder_TableAtomScope;  // table atom scope
  mork_kind mBuilder_TableKind;        // table kind

  mork_token mBuilder_TableStatus;  // dummy: priority/unique/verbose

  mork_priority mBuilder_TablePriority;  // table priority
  mork_bool mBuilder_TableIsUnique;      // table uniqueness
  mork_bool mBuilder_TableIsVerbose;     // table verboseness
  mork_u1 mBuilder_TablePadByte;         // for u4 alignment

  // tokens that become set as the result of meta cells in meta rows:
  mork_cscode mBuilder_RowForm;      // default row charset format
  mork_scope mBuilder_RowRowScope;   // row scope per row metainfo
  mork_scope mBuilder_RowAtomScope;  // row atom scope

  // meta tokens currently in force, driven by meta info slots above:
  mork_cscode mBuilder_CellForm;      // cell charset format
  mork_scope mBuilder_CellAtomScope;  // cell atom scope

  mork_cscode mBuilder_DictForm;      // dict charset format
  mork_scope mBuilder_DictAtomScope;  // dict atom scope

  mork_token* mBuilder_MetaTokenSlot;  // pointer to some slot above

  // If any of these 'cut' bools are true, it means a minus was seen in the
  // Mork source text to indicate removal of content from some container.
  // (Note there is no corresponding 'add' bool, since add is the default.)
  // CutRow implies the current row should be cut from the table.
  // CutCell implies the current column should be cut from the row.
  mork_bool mBuilder_DoCutRow;   // row with kCut change
  mork_bool mBuilder_DoCutCell;  // cell with kCut change
  mork_u1 mBuilder_row_pad;      // pad to u4 alignment
  mork_u1 mBuilder_cell_pad;     // pad to u4 alignment

  morkCell mBuilder_CellsVec[morkBuilder_kCellsVecSize + 1];
  mork_fill mBuilder_CellsVecFill;  // count used in CellsVec
  // Note when mBuilder_CellsVecFill equals morkBuilder_kCellsVecSize, and
  // another cell is added, this means all the cells in the vector above
  // must be flushed to the current row being built to create more room.

 protected:  // protected inlines
  mork_bool CellVectorIsFull() const {
    return (mBuilder_CellsVecFill == morkBuilder_kCellsVecSize);
  }

  // { ===== begin morkNode interface =====
 public:  // morkNode virtual methods
  virtual void CloseMorkNode(
      morkEnv* ev) override;  // CloseBuilder() only if open
  virtual ~morkBuilder();     // assert that CloseBuilder() executed earlier

 public:  // morkYarn construction & destruction
  morkBuilder(morkEnv* ev, const morkUsage& inUsage, nsIMdbHeap* ioHeap,
              morkStream* ioStream,  // the readonly stream for input bytes
              mdb_count inBytesPerParseSegment,  // target for ParseMore()
              nsIMdbHeap* ioSlotHeap, morkStore* ioStore);

  void CloseBuilder(morkEnv* ev);  // called by CloseMorkNode();

 private:  // copying is not allowed
  morkBuilder(const morkBuilder& other);
  morkBuilder& operator=(const morkBuilder& other);

 public:  // dynamic type identification
  mork_bool IsBuilder() const {
    return IsNode() && mNode_Derived == morkDerived_kBuilder;
  }
  // } ===== end morkNode methods =====

 public:  // errors
  static void NonBuilderTypeError(morkEnv* ev);
  static void NilBuilderCellError(morkEnv* ev);
  static void NilBuilderRowError(morkEnv* ev);
  static void NilBuilderTableError(morkEnv* ev);
  static void NonColumnSpaceScopeError(morkEnv* ev);

  void LogGlitch(morkEnv* ev, const morkGlitch& inGlitch, const char* inKind);

 public:  // other builder methods
  morkCell* AddBuilderCell(morkEnv* ev, const morkMid& inMid,
                           mork_change inChange);

  void FlushBuilderCells(morkEnv* ev);

  // ````` ````` ````` `````   ````` ````` ````` `````
 public:  // in virtual morkParser methods, data flow subclass to parser
  virtual void MidToYarn(
      morkEnv* ev,
      const morkMid& inMid,  // typically an alias to concat with strings
      mdbYarn* outYarn) override;
  // The parser might ask that some aliases be turned into yarns, so they
  // can be concatenated into longer blobs under some circumstances.  This
  // is an alternative to using a long and complex callback for many parts
  // for a single cell value.

  // ````` ````` ````` `````   ````` ````` ````` `````
 public:  // out virtual morkParser methods, data flow parser to subclass
  virtual void OnNewPort(morkEnv* ev, const morkPlace& inPlace) override;
  virtual void OnPortGlitch(morkEnv* ev, const morkGlitch& inGlitch) override;
  virtual void OnPortEnd(morkEnv* ev, const morkSpan& inSpan) override;

  virtual void OnNewGroup(morkEnv* ev, const morkPlace& inPlace,
                          mork_gid inGid) override;
  virtual void OnGroupGlitch(morkEnv* ev, const morkGlitch& inGlitch) override;
  virtual void OnGroupCommitEnd(morkEnv* ev, const morkSpan& inSpan) override;
  virtual void OnGroupAbortEnd(morkEnv* ev, const morkSpan& inSpan) override;

  virtual void OnNewPortRow(morkEnv* ev, const morkPlace& inPlace,
                            const morkMid& inMid,
                            mork_change inChange) override;
  virtual void OnPortRowGlitch(morkEnv* ev,
                               const morkGlitch& inGlitch) override;
  virtual void OnPortRowEnd(morkEnv* ev, const morkSpan& inSpan) override;

  virtual void OnNewTable(morkEnv* ev, const morkPlace& inPlace,
                          const morkMid& inMid,
                          mork_bool inCutAllRows) override;
  virtual void OnTableGlitch(morkEnv* ev, const morkGlitch& inGlitch) override;
  virtual void OnTableEnd(morkEnv* ev, const morkSpan& inSpan) override;

  virtual void OnNewMeta(morkEnv* ev, const morkPlace& inPlace) override;
  virtual void OnMetaGlitch(morkEnv* ev, const morkGlitch& inGlitch) override;
  virtual void OnMetaEnd(morkEnv* ev, const morkSpan& inSpan) override;

  virtual void OnMinusRow(morkEnv* ev) override;
  virtual void OnNewRow(morkEnv* ev, const morkPlace& inPlace,
                        const morkMid& inMid, mork_bool inCutAllCols) override;
  virtual void OnRowPos(morkEnv* ev, mork_pos inRowPos) override;
  virtual void OnRowGlitch(morkEnv* ev, const morkGlitch& inGlitch) override;
  virtual void OnRowEnd(morkEnv* ev, const morkSpan& inSpan) override;

  virtual void OnNewDict(morkEnv* ev, const morkPlace& inPlace) override;
  virtual void OnDictGlitch(morkEnv* ev, const morkGlitch& inGlitch) override;
  virtual void OnDictEnd(morkEnv* ev, const morkSpan& inSpan) override;

  virtual void OnAlias(morkEnv* ev, const morkSpan& inSpan,
                       const morkMid& inMid) override;

  virtual void OnAliasGlitch(morkEnv* ev, const morkGlitch& inGlitch) override;

  virtual void OnMinusCell(morkEnv* ev) override;
  virtual void OnNewCell(morkEnv* ev, const morkPlace& inPlace,
                         const morkMid* inMid, const morkBuf* inBuf) override;
  // Exactly one of inMid and inBuf is nil, and the other is non-nil.
  // When hex ID syntax is used for a column, then inMid is not nil, and
  // when a naked string names a column, then inBuf is not nil.

  virtual void OnCellGlitch(morkEnv* ev, const morkGlitch& inGlitch) override;
  virtual void OnCellForm(morkEnv* ev, mork_cscode inCharsetFormat) override;
  virtual void OnCellEnd(morkEnv* ev, const morkSpan& inSpan) override;

  virtual void OnValue(morkEnv* ev, const morkSpan& inSpan,
                       const morkBuf& inBuf) override;

  virtual void OnValueMid(morkEnv* ev, const morkSpan& inSpan,
                          const morkMid& inMid) override;

  virtual void OnRowMid(morkEnv* ev, const morkSpan& inSpan,
                        const morkMid& inMid) override;

  virtual void OnTableMid(morkEnv* ev, const morkSpan& inSpan,
                          const morkMid& inMid) override;

  // ````` ````` ````` `````   ````` ````` ````` `````
 public:  // public non-poly morkBuilder methods
 public:  // typesafe refcounting inlines calling inherited morkNode methods
  static void SlotWeakBuilder(morkBuilder* me, morkEnv* ev,
                              morkBuilder** ioSlot) {
    morkNode::SlotWeakNode((morkNode*)me, ev, (morkNode**)ioSlot);
  }

  static void SlotStrongBuilder(morkBuilder* me, morkEnv* ev,
                                morkBuilder** ioSlot) {
    morkNode::SlotStrongNode((morkNode*)me, ev, (morkNode**)ioSlot);
  }
};

// 456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789

#endif  // COMM_MAILNEWS_DB_MORK_MORKBUILDER_H_
