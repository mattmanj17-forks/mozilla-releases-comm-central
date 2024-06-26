/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-  */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef _MDB_
#  include "mdb.h"
#endif

#ifndef _MORK_
#  include "mork.h"
#endif

#ifndef _MORKNODE_
#  include "morkNode.h"
#endif

#ifndef _MORKENV_
#  include "morkEnv.h"
#endif

#ifndef _MORKFILE_
#  include "morkFile.h"
#endif

#ifdef MORK_WIN
#  include "io.h"
#  include <windows.h>
#endif

#include "mozilla/Unused.h"
#include "nsString.h"

// 456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789

// ````` ````` ````` ````` `````
// { ===== begin morkNode interface =====

/*public virtual*/ void morkFile::CloseMorkNode(
    morkEnv* ev)  // CloseFile() only if open
{
  if (this->IsOpenNode()) {
    this->MarkClosing();
    this->CloseFile(ev);
    this->MarkShut();
  }
}

/*public virtual*/
morkFile::~morkFile()  // assert CloseFile() executed earlier
{
  MORK_ASSERT(mFile_Frozen == 0);
  MORK_ASSERT(mFile_DoTrace == 0);
  MORK_ASSERT(mFile_IoOpen == 0);
  MORK_ASSERT(mFile_Active == 0);
}

/*public non-poly*/
morkFile::morkFile(morkEnv* ev, const morkUsage& inUsage, nsIMdbHeap* ioHeap,
                   nsIMdbHeap* ioSlotHeap)
    : morkObject(ev, inUsage, ioHeap, morkColor_kNone, (morkHandle*)0),
      mFile_Frozen(0),
      mFile_DoTrace(0),
      mFile_IoOpen(0),
      mFile_Active(0)

      ,
      mFile_SlotHeap(0),
      mFile_Name(0),
      mFile_Thief(0) {
  if (ev->Good()) {
    if (ioSlotHeap) {
      nsIMdbHeap_SlotStrongHeap(ioSlotHeap, ev, &mFile_SlotHeap);
      if (ev->Good()) mNode_Derived = morkDerived_kFile;
    } else
      ev->NilPointerError();
  }
}

NS_IMPL_ISUPPORTS_INHERITED(morkFile, morkObject, nsIMdbFile)
/*public non-poly*/ void morkFile::CloseFile(
    morkEnv* ev)  // called by CloseMorkNode();
{
  if (this->IsNode()) {
    mFile_Frozen = 0;
    mFile_DoTrace = 0;
    mFile_IoOpen = 0;
    mFile_Active = 0;

    if (mFile_Name) this->SetFileName(ev, nullptr);

    nsIMdbHeap_SlotStrongHeap((nsIMdbHeap*)0, ev, &mFile_SlotHeap);
    nsIMdbFile_SlotStrongFile((nsIMdbFile*)0, ev, &mFile_Thief);

    this->MarkShut();
  } else
    this->NonNodeError(ev);
}

// } ===== end morkNode methods =====
// ````` ````` ````` ````` `````

/*static*/ morkFile* morkFile::OpenOldFile(morkEnv* ev, nsIMdbHeap* ioHeap,
                                           const PathChar* inFilePath,
                                           mork_bool inFrozen)
// Choose some subclass of morkFile to instantiate, in order to read
// (and write if not frozen) the file known by inFilePath.  The file
// returned should be open and ready for use, and presumably positioned
// at the first byte position of the file.  The exact manner in which
// files must be opened is considered a subclass specific detail, and
// other portions or Mork source code don't want to know how it's done.
{
  return morkStdioFile::OpenOldStdioFile(ev, ioHeap, inFilePath, inFrozen);
}

/*static*/ morkFile* morkFile::CreateNewFile(morkEnv* ev, nsIMdbHeap* ioHeap,
                                             const PathChar* inFilePath)
// Choose some subclass of morkFile to instantiate, in order to read
// (and write if not frozen) the file known by inFilePath.  The file
// returned should be created and ready for use, and presumably positioned
// at the first byte position of the file.  The exact manner in which
// files must be opened is considered a subclass specific detail, and
// other portions or Mork source code don't want to know how it's done.
{
  return morkStdioFile::CreateNewStdioFile(ev, ioHeap, inFilePath);
}

void morkFile::NewMissingIoError(morkEnv* ev) const {
  ev->NewError("file missing io");
}

/*static*/ void morkFile::NonFileTypeError(morkEnv* ev) {
  ev->NewError("non morkFile");
}

/*static*/ void morkFile::NilSlotHeapError(morkEnv* ev) {
  ev->NewError("nil mFile_SlotHeap");
}

/*static*/ void morkFile::NilFileNameError(morkEnv* ev) {
  ev->NewError("nil mFile_Name");
}

void morkFile::SetThief(morkEnv* ev, nsIMdbFile* ioThief) {
  nsIMdbFile_SlotStrongFile(ioThief, ev, &mFile_Thief);
}

void morkFile::SetFileName(morkEnv* ev,
                           const PathChar* inName)  // inName can be nil
{
  nsIMdbHeap* heap = mFile_SlotHeap;
  if (heap) {
    PathChar* name = mFile_Name;
    if (name) {
      mFile_Name = 0;
      ev->FreeString(heap, name);
    }
    if (ev->Good() && inName) mFile_Name = ev->CopyString(heap, inName);
  } else
    this->NilSlotHeapError(ev);
}

void morkFile::NewFileDownError(morkEnv* ev) const
// call NewFileDownError() when either IsOpenAndActiveFile()
// is false, or when IsOpenActiveAndMutableFile() is false.
{
  if (this->IsOpenNode()) {
    if (this->FileActive()) {
      if (this->FileFrozen()) {
        ev->NewError("file frozen");
      } else
        ev->NewError("unknown file problem");
    } else
      ev->NewError("file not active");
  } else
    ev->NewError("file not open");
}

void morkFile::NewFileErrnoError(morkEnv* ev) const
// call NewFileErrnoError() to convert std C errno into AB fault
{
  const char* errnoString = strerror(errno);
  ev->NewError(errnoString);  // maybe pass value of strerror() instead
}

// ````` ````` ````` ````` newlines ````` ````` ````` `````

#if defined(MORK_MAC)
static const char morkFile_kNewlines[] =
    "\015\015\015\015\015\015\015\015\015\015\015\015\015\015\015\015";
#  define morkFile_kNewlinesCount 16
#else
#  if defined(MORK_WIN)
static const char morkFile_kNewlines[] =
    "\015\012\015\012\015\012\015\012\015\012\015\012\015\012\015\012";
#    define morkFile_kNewlinesCount 8
#  else
#    ifdef MORK_UNIX
static const char morkFile_kNewlines[] =
    "\012\012\012\012\012\012\012\012\012\012\012\012\012\012\012\012";
#      define morkFile_kNewlinesCount 16
#    endif /* MORK_UNIX */
#  endif   /* MORK_WIN */
#endif     /* MORK_MAC */

mork_size morkFile::WriteNewlines(morkEnv* ev, mork_count inNewlines)
// WriteNewlines() returns the number of bytes written.
{
  mork_size outSize = 0;
  while (inNewlines && ev->Good())  // more newlines to write?
  {
    mork_u4 quantum = inNewlines;
    if (quantum > morkFile_kNewlinesCount) quantum = morkFile_kNewlinesCount;

    mork_size quantumSize = quantum * mork_kNewlineSize;
    mdb_size bytesWritten;
    nsresult rc = this->Write(ev->AsMdbEnv(), morkFile_kNewlines, quantumSize,
                              &bytesWritten);
    if (NS_FAILED(rc)) {
      NS_WARNING("Write failed");
    }
    outSize += quantumSize;
    inNewlines -= quantum;
  }
  return outSize;
}

NS_IMETHODIMP
morkFile::Eof(nsIMdbEnv* mev, mdb_pos* outPos) {
  nsresult outErr = NS_OK;
  mdb_pos pos = -1;
  morkEnv* ev = morkEnv::FromMdbEnv(mev);
  pos = Length(ev);
  outErr = ev->AsErr();
  if (outPos) *outPos = pos;
  return outErr;
}

NS_IMETHODIMP
morkFile::Get(nsIMdbEnv* mev, void* outBuf, mdb_size inSize, mdb_pos inPos,
              mdb_size* outActualSize) {
  nsresult rv = NS_OK;
  morkEnv* ev = morkEnv::FromMdbEnv(mev);
  if (ev) {
    mdb_pos outPos;
    Seek(mev, inPos, &outPos);
    if (ev->Good()) rv = Read(mev, outBuf, inSize, outActualSize);
  }
  return rv;
}

NS_IMETHODIMP
morkFile::Put(nsIMdbEnv* mev, const void* inBuf, mdb_size inSize, mdb_pos inPos,
              mdb_size* outActualSize) {
  nsresult outErr = NS_OK;
  *outActualSize = 0;
  morkEnv* ev = morkEnv::FromMdbEnv(mev);
  if (ev) {
    mdb_pos outPos;

    Seek(mev, inPos, &outPos);
    if (ev->Good()) {
      nsresult rc = Write(mev, inBuf, inSize, outActualSize);
      if (NS_FAILED(rc)) {
        NS_WARNING("Write failed");
      }
    }
    outErr = ev->AsErr();
  }
  return outErr;
}

// { ----- begin path methods -----
NS_IMETHODIMP
morkFile::Path(nsIMdbEnv* mev, mdbYarn* outFilePath) {
  nsresult outErr = NS_OK;
  if (outFilePath) outFilePath->mYarn_Fill = 0;
  morkEnv* ev = morkEnv::FromMdbEnv(mev);
  if (ev) {
    ev->StringToYarn(GetFileNameString(), outFilePath);
    outErr = ev->AsErr();
  }
  return outErr;
}

// } ----- end path methods -----

// { ----- begin replacement methods -----

NS_IMETHODIMP
morkFile::Thief(nsIMdbEnv* mev, nsIMdbFile** acqThief) {
  nsresult outErr = NS_OK;
  nsIMdbFile* outThief = 0;
  morkEnv* ev = morkEnv::FromMdbEnv(mev);
  if (ev) {
    outThief = GetThief();
    NS_IF_ADDREF(outThief);
    outErr = ev->AsErr();
  }
  if (acqThief) *acqThief = outThief;
  return outErr;
}

// } ----- end replacement methods -----

// { ----- begin versioning methods -----

// ````` ````` ````` ````` `````
// { ===== begin morkNode interface =====

/*public virtual*/ void morkStdioFile::CloseMorkNode(
    morkEnv* ev)  // CloseStdioFile() only if open
{
  if (this->IsOpenNode()) {
    this->MarkClosing();
    this->CloseStdioFile(ev);
    this->MarkShut();
  }
}

/*public virtual*/
morkStdioFile::~morkStdioFile()  // assert CloseStdioFile() executed earlier
{
  if (mStdioFile_File) CloseStdioFile(mMorkEnv);
  MORK_ASSERT(mStdioFile_File == 0);
}

/*public non-poly*/ void morkStdioFile::CloseStdioFile(
    morkEnv* ev)  // called by CloseMorkNode();
{
  if (this->IsNode()) {
    if (mStdioFile_File && this->FileActive() && this->FileIoOpen()) {
      this->CloseStdio(ev);
    }

    mStdioFile_File = 0;

    // When we set mStdioFile_File to 0, we must call
    this->SetFileActive(morkBool_kFalse);
    this->SetFileIoOpen(morkBool_kFalse);
    // to set the file as not open and not active after a
    // MORK_FILECLOSE operation
    this->CloseFile(ev);
    this->MarkShut();
  } else {
    NS_WARNING("Non-node passed to CloseStdioFile");
    this->NonNodeError(ev);
  }
}

// } ===== end morkNode methods =====
// ````` ````` ````` ````` `````

// compatible with the morkFile::MakeFile() entry point

/*static*/ morkStdioFile* morkStdioFile::OpenOldStdioFile(
    morkEnv* ev, nsIMdbHeap* ioHeap, const PathChar* inFilePath,
    mork_bool inFrozen) {
  morkStdioFile* outFile = 0;
  if (ioHeap && inFilePath) {
    const char* mode = (inFrozen) ? "rb" : "rb+";
    outFile = new (*ioHeap, ev)
        morkStdioFile(ev, morkUsage::kHeap, ioHeap, ioHeap, inFilePath, mode);

    if (outFile) {
      outFile->SetFileFrozen(inFrozen);
    }
  } else
    ev->NilPointerError();

  return outFile;
}

/*static*/ morkStdioFile* morkStdioFile::CreateNewStdioFile(
    morkEnv* ev, nsIMdbHeap* ioHeap, const PathChar* inFilePath) {
  morkStdioFile* outFile = 0;
  if (ioHeap && inFilePath) {
    const char* mode = "wb+";
    outFile = new (*ioHeap, ev)
        morkStdioFile(ev, morkUsage::kHeap, ioHeap, ioHeap, inFilePath, mode);
  } else
    ev->NilPointerError();

  return outFile;
}

NS_IMETHODIMP
morkStdioFile::BecomeTrunk(nsIMdbEnv* ev)
// If this file is a file version branch created by calling AcquireBud(),
// BecomeTrunk() causes this file's content to replace the original
// file's content, typically by assuming the original file's identity.
{
  return Flush(ev);
}

NS_IMETHODIMP
morkStdioFile::AcquireBud(nsIMdbEnv* mdbev, nsIMdbHeap* ioHeap,
                          nsIMdbFile** acquiredFile)
// AcquireBud() starts a new "branch" version of the file, empty of content,
// so that a new version of the file can be written.  This new file
// can later be told to BecomeTrunk() the original file, so the branch
// created by budding the file will replace the original file.  Some
// file subclasses might initially take the unsafe but expedient
// approach of simply truncating this file down to zero length, and
// then returning the same morkFile pointer as this, with an extra
// reference count increment.  Note that the caller of AcquireBud() is
// expected to eventually call CutStrongRef() on the returned file
// in order to release the strong reference.  High quality versions
// of morkFile subclasses will create entirely new files which later
// are renamed to become the old file, so that better transactional
// behavior is exhibited by the file, so crashes protect old files.
// Note that AcquireBud() is an illegal operation on readonly files.

// We should not call this without setting mFile_Name.
{
  NS_ENSURE_ARG(acquiredFile);
  MORK_USED_1(ioHeap);
  nsresult rv = NS_OK;
  morkFile* outFile = 0;
  morkEnv* ev = morkEnv::FromMdbEnv(mdbev);

  if (this->IsOpenAndActiveFile()) {
    FILE* file = (FILE*)mStdioFile_File;
    if (file) {
      // #ifdef MORK_WIN
      //       truncate(file, /*eof*/ 0);
      // #else /*MORK_WIN*/
      PathChar* name = mFile_Name;
      if (name) {
        if (MORK_FILECLOSE(file) >= 0) {
          mStdioFile_File = 0;
          this->SetFileActive(morkBool_kFalse);
          this->SetFileIoOpen(morkBool_kFalse);

          file = MORK_FILEOPEN(
              name, "wb+");  // open for write, discarding old content
          if (file) {
            mStdioFile_File = file;
            this->SetFileActive(morkBool_kTrue);
            this->SetFileIoOpen(morkBool_kTrue);
            this->SetFileFrozen(morkBool_kFalse);
          } else {
            this->new_stdio_file_fault(ev);
            mStdioFile_File = 0;
            this->SetFileActive(morkBool_kFalse);
            this->SetFileIoOpen(morkBool_kFalse);
          }
        } else {
          this->new_stdio_file_fault(ev);
          mStdioFile_File = 0;
          this->SetFileActive(morkBool_kFalse);
          this->SetFileIoOpen(morkBool_kFalse);
        }
      } else {
        this->NilFileNameError(ev);
      }

      // #endif /*MORK_WIN*/

      if (ev->Good() && this->AddStrongRef(ev->AsMdbEnv())) {
        outFile = this;
        AddRef();
      }
    } else if (mFile_Thief) {
      rv = mFile_Thief->AcquireBud(ev->AsMdbEnv(), ioHeap, acquiredFile);
    } else
      this->NewMissingIoError(ev);
  } else
    this->NewFileDownError(ev);

  *acquiredFile = outFile;
  return rv;
}

mork_pos morkStdioFile::Length(morkEnv* ev) const {
  mork_pos outPos = 0;

  if (!this->IsOpenAndActiveFile()) {
    this->NewFileDownError(ev);
    return outPos;
  }
  FILE* file = (FILE*)mStdioFile_File;

  if (file) {
    long start, fore, eof, back;
    if ((start = MORK_FILETELL(file)) >= 0 &&
        (fore = MORK_FILESEEK(file, 0, SEEK_END)) >= 0 &&
        (eof = MORK_FILETELL(file)) >= 0 &&
        (back = MORK_FILESEEK(file, start, SEEK_SET)) >= 0) {
      outPos = eof;
    } else {
      this->new_stdio_file_fault(ev);
    }
  } else if (mFile_Thief)
    mFile_Thief->Eof(ev->AsMdbEnv(), &outPos);
  else {
    this->NewMissingIoError(ev);
  }
  return outPos;
}

NS_IMETHODIMP
morkStdioFile::Tell(nsIMdbEnv* ev, mork_pos* outPos) const {
  nsresult rv = NS_OK;
  NS_ENSURE_ARG(outPos);
  morkEnv* mev = morkEnv::FromMdbEnv(ev);
  if (this->IsOpenAndActiveFile()) {
    FILE* file = (FILE*)mStdioFile_File;
    if (file) {
      long where = MORK_FILETELL(file);
      if (where >= 0)
        *outPos = where;
      else
        this->new_stdio_file_fault(mev);
    } else if (mFile_Thief)
      mFile_Thief->Tell(ev, outPos);
    else
      this->NewMissingIoError(mev);
  } else
    this->NewFileDownError(mev);

  return rv;
}

NS_IMETHODIMP
morkStdioFile::Read(nsIMdbEnv* ev, void* outBuf, mork_size inSize,
                    mork_num* outCount) {
  nsresult rv = NS_OK;
  morkEnv* mev = morkEnv::FromMdbEnv(ev);
  if (this->IsOpenAndActiveFile()) {
    FILE* file = (FILE*)mStdioFile_File;
    if (file) {
      long count = (long)MORK_FILEREAD(outBuf, inSize, file);
      if (count >= 0) {
        *outCount = (mork_num)count;
      } else
        this->new_stdio_file_fault(mev);
    } else if (mFile_Thief)
      mFile_Thief->Read(ev, outBuf, inSize, outCount);
    else
      this->NewMissingIoError(mev);
  } else
    this->NewFileDownError(mev);

  return rv;
}

NS_IMETHODIMP
morkStdioFile::Seek(nsIMdbEnv* mdbev, mork_pos inPos, mork_pos* aOutPos) {
  mork_pos outPos = 0;
  nsresult rv = NS_OK;
  morkEnv* ev = morkEnv::FromMdbEnv(mdbev);

  if (this->IsOpenOrClosingNode() && this->FileActive()) {
    FILE* file = (FILE*)mStdioFile_File;
    if (file) {
      long where = MORK_FILESEEK(file, inPos, SEEK_SET);
      if (where >= 0)
        outPos = inPos;
      else
        this->new_stdio_file_fault(ev);
    } else if (mFile_Thief)
      mFile_Thief->Seek(mdbev, inPos, aOutPos);
    else
      this->NewMissingIoError(ev);
  } else
    this->NewFileDownError(ev);

  *aOutPos = outPos;
  return rv;
}

NS_IMETHODIMP
morkStdioFile::Write(nsIMdbEnv* mdbev, const void* inBuf, mork_size inSize,
                     mork_size* aOutSize) {
  mork_num outCount = 0;
  nsresult rv = NS_OK;
  morkEnv* ev = morkEnv::FromMdbEnv(mdbev);
  if (this->IsOpenActiveAndMutableFile()) {
    FILE* file = (FILE*)mStdioFile_File;
    if (file) {
      mozilla::Unused << fwrite(inBuf, 1, inSize, file);
      if (!ferror(file))
        outCount = inSize;
      else {
        NS_WARNING("fwrite failed");
        this->new_stdio_file_fault(ev);
      }
    } else if (mFile_Thief) {
      nsresult rc = mFile_Thief->Write(mdbev, inBuf, inSize, &outCount);
      // This error is not caught?
      if (NS_FAILED(rc)) {
        NS_WARNING("Write failed");
      }
    } else
      this->NewMissingIoError(ev);
  } else
    this->NewFileDownError(ev);

  *aOutSize = outCount;
  return rv;
}

NS_IMETHODIMP
morkStdioFile::Flush(nsIMdbEnv* mdbev) {
  morkEnv* ev = morkEnv::FromMdbEnv(mdbev);
  if (this->IsOpenOrClosingNode() && this->FileActive()) {
    FILE* file = (FILE*)mStdioFile_File;
    if (file) {
      MORK_FILEFLUSH(file);

    } else if (mFile_Thief)
      mFile_Thief->Flush(mdbev);
    else
      this->NewMissingIoError(ev);
  } else
    this->NewFileDownError(ev);
  return NS_OK;
}

// ````` ````` ````` `````   ````` ````` ````` `````
// protected: // protected non-poly morkStdioFile methods

// This is called when I/O error fails for stdio operation.
// E.g., network timeout for referencing a message storage on
// a remote network.
void morkStdioFile::new_stdio_file_fault(morkEnv* ev) const {
  FILE* file = (FILE*)mStdioFile_File;

  int copyErrno = errno;  // facilitate seeing error in debugger

  //  bunch of stuff not ported here
  if (!copyErrno && file) {
    copyErrno = ferror(file);
    errno = copyErrno;
  }

  this->NewFileErrnoError(ev);
}

// ````` ````` ````` `````   ````` ````` ````` `````
// public: // public non-poly morkStdioFile methods

/*public non-poly*/
morkStdioFile::morkStdioFile(morkEnv* ev, const morkUsage& inUsage,
                             nsIMdbHeap* ioHeap, nsIMdbHeap* ioSlotHeap)
    : morkFile(ev, inUsage, ioHeap, ioSlotHeap), mStdioFile_File(0) {
  if (ev->Good()) mNode_Derived = morkDerived_kStdioFile;
}

morkStdioFile::morkStdioFile(morkEnv* ev, const morkUsage& inUsage,
                             nsIMdbHeap* ioHeap, nsIMdbHeap* ioSlotHeap,
                             const PathChar* inName, const char* inMode)
    // calls OpenStdio() after construction
    : morkFile(ev, inUsage, ioHeap, ioSlotHeap), mStdioFile_File(0) {
  if (ev->Good()) this->OpenStdio(ev, inName, inMode);
}

morkStdioFile::morkStdioFile(morkEnv* ev, const morkUsage& inUsage,
                             nsIMdbHeap* ioHeap, nsIMdbHeap* ioSlotHeap,
                             void* ioFile, const PathChar* inName,
                             mork_bool inFrozen)
    // calls UseStdio() after construction
    : morkFile(ev, inUsage, ioHeap, ioSlotHeap), mStdioFile_File(0) {
  if (ev->Good()) this->UseStdio(ev, ioFile, inName, inFrozen);
}

void morkStdioFile::OpenStdio(morkEnv* ev, const PathChar* inName,
                              const char* inMode)
// Open a new FILE with name inName, using mode flags from inMode.
{
  if (ev->Good()) {
    if (!inMode) inMode = "";

    mork_bool frozen = (*inMode == 'r');  // cursory attempt to note readonly

    if (this->IsOpenNode()) {
      if (!this->FileActive()) {
        this->SetFileIoOpen(morkBool_kFalse);
        if (inName && *inName) {
          this->SetFileName(ev, inName);
          if (ev->Good()) {
            FILE* file = MORK_FILEOPEN(inName, inMode);
            if (file) {
              mStdioFile_File = file;
              this->SetFileActive(morkBool_kTrue);
              this->SetFileIoOpen(morkBool_kTrue);
              this->SetFileFrozen(frozen);
            } else {
              mStdioFile_File = 0;
              this->SetFileActive(morkBool_kFalse);
              this->SetFileIoOpen(morkBool_kFalse);
              this->new_stdio_file_fault(ev);
            }
          }
        } else
          ev->NewError("no file name");
      } else
        ev->NewError("file already active");
    } else
      this->NewFileDownError(ev);
  }
}

void morkStdioFile::UseStdio(morkEnv* ev, void* ioFile, const PathChar* inName,
                             mork_bool inFrozen)
// Use an existing file, like stdin/stdout/stderr, which should not
// have the io stream closed when the file is closed.  The ioFile
// parameter must actually be of type FILE (but we don't want to make
// this header file include the stdio.h header file).
{
  if (ev->Good()) {
    if (this->IsOpenNode()) {
      if (!this->FileActive()) {
        if (ioFile) {
          this->SetFileIoOpen(morkBool_kFalse);
          this->SetFileName(ev, inName);
          if (ev->Good()) {
            mStdioFile_File = ioFile;
            this->SetFileActive(morkBool_kTrue);
            this->SetFileFrozen(inFrozen);
          }
        } else {
          ev->NilPointerError();
        }
      } else
        ev->NewError("file already active");
    } else
      this->NewFileDownError(ev);
  }
}

void morkStdioFile::CloseStdio(morkEnv* ev)
// Close the stream io if both and FileActive() and FileIoOpen(), but
// this does not close this instances (like CloseStdioFile() does).
// If stream io was made active by means of calling UseStdio(),
// then this method does little beyond marking the stream inactive
// because FileIoOpen() is false.
{
  if (mStdioFile_File && this->FileActive() && this->FileIoOpen()) {
    FILE* file = (FILE*)mStdioFile_File;
    if (MORK_FILECLOSE(file) < 0) {
      NS_WARNING("MORK_FILECLOSE(file) failed");
      this->new_stdio_file_fault(ev);
    }
    mStdioFile_File = 0;
    this->SetFileActive(morkBool_kFalse);
    this->SetFileIoOpen(morkBool_kFalse);
  }
}

NS_IMETHODIMP
morkStdioFile::Steal(nsIMdbEnv* ev, nsIMdbFile* ioThief)
// If this file is a file version branch created by calling AcquireBud(),
// BecomeTrunk() causes this file's content to replace the original
// file's content, typically by assuming the original file's identity.
{
  morkEnv* mev = morkEnv::FromMdbEnv(ev);
  if (mStdioFile_File && FileActive() && FileIoOpen()) {
    FILE* file = (FILE*)mStdioFile_File;

    if (MORK_FILECLOSE(file) < 0) {
      NS_WARNING("MORK_FILECLOSE(file) failed");
      new_stdio_file_fault(mev);
    }

    mStdioFile_File = 0;
    this->SetFileActive(morkBool_kFalse);
    this->SetFileIoOpen(morkBool_kFalse);
  }
  SetThief(mev, ioThief);
  return NS_OK;
}

#if defined(MORK_WIN)

void mork_fileflush(FILE* file) { fflush(file); }

#endif /*MORK_WIN*/

// 456789_123456789_123456789_123456789_123456789_123456789_123456789_123456789
