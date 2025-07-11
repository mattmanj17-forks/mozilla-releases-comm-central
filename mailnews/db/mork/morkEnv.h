/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-  */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_DB_MORK_MORKENV_H_
#define COMM_MAILNEWS_DB_MORK_MORKENV_H_

#ifndef _MORK_
#  include "mork.h"
#endif

#ifndef _MORKOBJECT_
#  include "morkObject.h"
#endif

#ifndef _MORKPOOL_
#  include "morkPool.h"
#endif

// sean was here
#include "mozilla/Path.h"
#include "nsError.h"

// 456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789

#define morkDerived_kEnv /*i*/ 0x4576 /* ascii 'Ev' */

// use NS error codes to make Mork easier to use with the rest of mozilla
#define morkEnv_kNoError NS_SUCCEEDED /* no error has happened */
#define morkEnv_kNonEnvTypeError \
  NS_ERROR_FAILURE /* morkEnv::IsEnv() is false */

#define morkEnv_kStubMethodOnlyError NS_ERROR_NO_INTERFACE
#define morkEnv_kOutOfMemoryError NS_ERROR_OUT_OF_MEMORY
#define morkEnv_kNilPointerError NS_ERROR_NULL_POINTER
#define morkEnv_kNewNonEnvError NS_ERROR_FAILURE
#define morkEnv_kNilEnvSlotError NS_ERROR_FAILURE

#define morkEnv_kBadFactoryError NS_ERROR_FACTORY_NOT_LOADED
#define morkEnv_kBadFactoryEnvError NS_ERROR_FACTORY_NOT_LOADED
#define morkEnv_kBadEnvError NS_ERROR_FAILURE

#define morkEnv_kNonHandleTypeError NS_ERROR_FAILURE
#define morkEnv_kNonOpenNodeError NS_ERROR_FAILURE

/* try NOT to leak all env instances */
#define morkEnv_kWeakRefCountEnvBonus 0

/*| morkEnv:
|*/
class morkEnv : public morkObject, public nsIMdbEnv {
  using PathChar = mozilla::filesystem::Path::value_type;
  NS_DECL_ISUPPORTS_INHERITED

  // public: // slots inherited from morkObject (meant to inform only)
  // nsIMdbHeap*       mNode_Heap;

  // mork_base      mNode_Base;     // must equal morkBase_kNode
  // mork_derived   mNode_Derived;  // depends on specific node subclass

  // mork_access    mNode_Access;   // kOpen, kClosing, kShut, or kDead
  // mork_usage     mNode_Usage;    // kHeap, kStack, kMember, kGlobal, kNone
  // mork_able      mNode_Mutable;  // can this node be modified?
  // mork_load      mNode_Load;     // is this node clean or dirty?

  // mork_uses      mNode_Uses;     // refcount for strong refs
  // mork_refs      mNode_Refs;     // refcount for strong refs + weak refs

  // mork_color   mBead_Color;   // ID for this bead
  // morkHandle*  mObject_Handle;  // weak ref to handle for this object

 public:  // state is public because the entire Mork system is private
  morkFactory* mEnv_Factory;  // NON-refcounted factory
  nsIMdbHeap* mEnv_Heap;      // NON-refcounted heap

  nsIMdbEnv* mEnv_SelfAsMdbEnv;
  nsIMdbErrorHook* mEnv_ErrorHook;

  morkPool* mEnv_HandlePool;  // pool for re-using handles

  mork_u2 mEnv_ErrorCount;
  mork_u2 mEnv_WarningCount;

  nsresult mEnv_ErrorCode;

  mork_bool mEnv_DoTrace;
  mork_able mEnv_AutoClear;
  mork_bool mEnv_ShouldAbort;
  mork_bool mEnv_BeVerbose;
  mork_bool mEnv_OwnsHeap;

  // { ===== begin morkNode interface =====
 public:                                             // morkNode virtual methods
  virtual void CloseMorkNode(morkEnv* ev) override;  // CloseEnv() only if open
  virtual ~morkEnv();  // assert that CloseEnv() executed earlier

  // { ----- begin attribute methods -----
  NS_IMETHOD GetErrorCount(mdb_count* outCount,
                           mdb_bool* outShouldAbort) override;
  NS_IMETHOD GetWarningCount(mdb_count* outCount,
                             mdb_bool* outShouldAbort) override;

  NS_IMETHOD GetEnvBeVerbose(mdb_bool* outBeVerbose) override;
  NS_IMETHOD SetEnvBeVerbose(mdb_bool inBeVerbose) override;

  NS_IMETHOD GetDoTrace(mdb_bool* outDoTrace) override;
  NS_IMETHOD SetDoTrace(mdb_bool inDoTrace) override;

  NS_IMETHOD GetAutoClear(mdb_bool* outAutoClear) override;
  NS_IMETHOD SetAutoClear(mdb_bool inAutoClear) override;

  NS_IMETHOD GetErrorHook(nsIMdbErrorHook** acqErrorHook) override;
  NS_IMETHOD SetErrorHook(
      nsIMdbErrorHook* ioErrorHook) override;  // becomes referenced

  NS_IMETHOD GetHeap(nsIMdbHeap** acqHeap) override;
  NS_IMETHOD SetHeap(nsIMdbHeap* ioHeap) override;  // becomes referenced
  // } ----- end attribute methods -----

  NS_IMETHOD ClearErrors() override;    // clear errors beore re-entering db API
  NS_IMETHOD ClearWarnings() override;  // clear warnings
  NS_IMETHOD ClearErrorsAndWarnings() override;  // clear both errors & warnings
  // } ===== end nsIMdbEnv methods =====
 public:  // morkEnv construction & destruction
  morkEnv(const morkUsage& inUsage, nsIMdbHeap* ioHeap, morkFactory* ioFactory,
          nsIMdbHeap* ioSlotHeap);
  morkEnv(morkEnv* ev, const morkUsage& inUsage, nsIMdbHeap* ioHeap,
          nsIMdbEnv* inSelfAsMdbEnv, morkFactory* ioFactory,
          nsIMdbHeap* ioSlotHeap);
  void CloseEnv(morkEnv* ev);  // called by CloseMorkNode();

 private:  // copying is not allowed
  morkEnv(const morkEnv& other);
  morkEnv& operator=(const morkEnv& other);

 public:  // dynamic type identification
  mork_bool IsEnv() const {
    return IsNode() && mNode_Derived == morkDerived_kEnv;
  }
  // } ===== end morkNode methods =====

 public:  // utility env methods
  mork_u1 HexToByte(mork_ch inFirstHex, mork_ch inSecondHex);

  mork_size TokenAsHex(void* outBuf, mork_token inToken);
  // TokenAsHex() is the same as sprintf(outBuf, "%lX", (long) inToken);

  mork_size OidAsHex(void* outBuf, const mdbOid& inOid);
  // sprintf(buf, "%lX:^%lX", (long) inOid.mOid_Id, (long) inOid.mOid_Scope);

  PathChar* CopyString(nsIMdbHeap* ioHeap, const PathChar* inString);
  void FreeString(nsIMdbHeap* ioHeap, PathChar* ioString);
  void StringToYarn(const PathChar* inString, mdbYarn* outYarn);

 public:  // other env methods
  morkHandleFace* NewHandle(mork_size inSize) {
    return mEnv_HandlePool->NewHandle(this, inSize, (morkZone*)0);
  }

  void ZapHandle(morkHandleFace* ioHandle) {
    mEnv_HandlePool->ZapHandle(this, ioHandle);
  }

  void EnableAutoClear() { mEnv_AutoClear = morkAble_kEnabled; }
  void DisableAutoClear() { mEnv_AutoClear = morkAble_kDisabled; }

  mork_bool DoAutoClear() const { return mEnv_AutoClear == morkAble_kEnabled; }

  void NewError(const char* inString);
  void NewWarning(const char* inString);

  void ClearMorkErrorsAndWarnings();      // clear both errors & warnings
  void AutoClearMorkErrorsAndWarnings();  // clear if auto is enabled

  void StubMethodOnlyError();
  void OutOfMemoryError();
  void NilPointerError();
  void NilPointerWarning();
  void CantMakeWhenBadError();
  void NewNonEnvError();
  void NilEnvSlotError();

  void NonEnvTypeError(morkEnv* ev);

  // canonical env convenience methods to check for presence of errors:
  mork_bool Good() const { return (mEnv_ErrorCount == 0); }
  mork_bool Bad() const { return (mEnv_ErrorCount != 0); }

  nsIMdbEnv* AsMdbEnv() { return (nsIMdbEnv*)this; }
  static morkEnv* FromMdbEnv(nsIMdbEnv* ioEnv);  // dynamic type checking

  nsresult AsErr() const { return mEnv_ErrorCode; }

 public:  // typesafe refcounting inlines calling inherited morkNode methods
  static void SlotWeakEnv(morkEnv* me, morkEnv* ev, morkEnv** ioSlot) {
    morkNode::SlotWeakNode((morkNode*)me, ev, (morkNode**)ioSlot);
  }

  static void SlotStrongEnv(morkEnv* me, morkEnv* ev, morkEnv** ioSlot) {
    morkNode::SlotStrongNode((morkNode*)me, ev, (morkNode**)ioSlot);
  }
};

#undef MOZ_ASSERT_TYPE_OK_FOR_REFCOUNTING
#ifdef MOZ_IS_DESTRUCTIBLE
#  define MOZ_ASSERT_TYPE_OK_FOR_REFCOUNTING(X)                              \
    static_assert(                                                           \
        !MOZ_IS_DESTRUCTIBLE(X) || mozilla::IsSame<X, morkEnv>::value,       \
        "Reference-counted class " #X                                        \
        " should not have a public destructor. "                             \
        "Try to make this class's destructor non-public. If that is really " \
        "not possible, you can whitelist this class by providing a "         \
        "HasDangerousPublicDestructor specialization for it.");
#else
#  define MOZ_ASSERT_TYPE_OK_FOR_REFCOUNTING(X)
#endif

// 456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789

#endif  // COMM_MAILNEWS_DB_MORK_MORKENV_H_
