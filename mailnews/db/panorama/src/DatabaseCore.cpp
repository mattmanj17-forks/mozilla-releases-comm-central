/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "DatabaseCore.h"

#include "FolderDatabase.h"
#include "Message.h"
#include "MessageDatabase.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/Logging.h"
#include "mozilla/ProfilerMarkers.h"
#include "mozilla/Services.h"
#include "mozilla/ScopeExit.h"
#include "mozIStorageBindingParams.h"
#include "mozIStorageBindingParamsArray.h"
#include "mozIStorageError.h"
#include "mozIStoragePendingStatement.h"
#include "mozIStorageResultSet.h"
#include "mozIStorageRow.h"
#include "mozIStorageService.h"
#include "mozIStorageStatementCallback.h"
#include "msgCore.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsIClassInfoImpl.h"
#include "nsIFile.h"
#include "nsIMimeConverter.h"
#include "nsIObserverService.h"
#include "nsMsgFolderFlags.h"
#include "PerFolderDatabase.h"
#include "xpcpublic.h"

using mozilla::LazyLogModule;
using mozilla::LogLevel;
using mozilla::dom::Promise;

namespace mozilla::mailnews {

LazyLogModule gPanoramaLog("panorama");

NS_IMPL_CLASSINFO(DatabaseCore, nullptr, nsIClassInfo::SINGLETON,
                  DATABASE_CORE_CID)
NS_IMPL_ISUPPORTS_CI(DatabaseCore, nsIDatabaseCore, nsIMsgDBService,
                     nsIObserver)

MOZ_RUNINIT nsCOMPtr<mozIStorageConnection> DatabaseCore::sConnection;
MOZ_RUNINIT nsTHashMap<nsCString, nsCOMPtr<mozIStorageStatement>>
    DatabaseCore::sStatements;

DatabaseCore::DatabaseCore() {
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore constructor"));
  MOZ_ASSERT(!sConnection, "creating a second DatabaseCore");

  // Bump up the refcount so it doesn't get freed too early. This is needed
  // because of the unusual dynamic component registration done in
  // `nsMsgAccountManager::Init`.
  NS_ADDREF_THIS();
  Startup();

  nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
  obs->AddObserver(this, "profile-before-change", false);
}

NS_IMETHODIMP
DatabaseCore::Startup() {
  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore starting up"));

  nsresult rv = EnsureConnection();
  NS_ENSURE_SUCCESS(rv, rv);

  mFolderDatabase = new FolderDatabase();
  rv = mFolderDatabase->Startup();
  NS_ENSURE_SUCCESS(rv, rv);

  mMessageDatabase = new MessageDatabase();
  mMessageDatabase->Startup();

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore startup complete"));
  return NS_OK;
}

NS_IMETHODIMP
DatabaseCore::Observe(nsISupports* aSubject, const char* aTopic,
                      const char16_t* aData) {
  if (strcmp(aTopic, "profile-before-change")) {
    return NS_OK;
  }

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore shutting down"));

  for (auto iter = sStatements.Iter(); !iter.Done(); iter.Next()) {
    iter.UserData()->Finalize();
  }
  sStatements.Clear();

  mFolderDatabase->Shutdown();
  mFolderDatabase = nullptr;

  mMessageDatabase->Shutdown();
  mMessageDatabase = nullptr;

  if (sConnection) {
    sConnection->AsyncClose(nullptr);
    sConnection = nullptr;
  }

  nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
  obs->RemoveObserver(this, "profile-before-change");

  MOZ_LOG(gPanoramaLog, LogLevel::Info, ("DatabaseCore shutdown complete"));

  return NS_OK;
}

/**
 * Ensures a mozIStorageConnection to panorama.sqlite in the profile folder.
 */
nsresult DatabaseCore::EnsureConnection() {
  if (sConnection) {
    return NS_OK;
  }

  MOZ_ASSERT(NS_IsMainThread(),
             "connection must be established on the main thread");

  nsCOMPtr<nsIFile> databaseFile;
  nsresult rv = NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                       getter_AddRefs(databaseFile));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIFile> file;
  rv = databaseFile->Append(u"panorama.sqlite"_ns);
  NS_ENSURE_SUCCESS(rv, rv);

  bool exists;
  rv = databaseFile->Exists(&exists);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<mozIStorageService> storage =
      do_GetService("@mozilla.org/storage/service;1");
  NS_ENSURE_STATE(storage);

  rv = storage->OpenUnsharedDatabase(databaseFile,
                                     mozIStorageService::CONNECTION_DEFAULT,
                                     getter_AddRefs(sConnection));
  NS_ENSURE_SUCCESS(rv, rv);

  if (!exists) {
    MOZ_LOG(gPanoramaLog, LogLevel::Warning,
            ("database file does not exist, creating"));
    // Please keep mailnews/db/panorama/test/xpcshell/head.js in sync with
    // changes to the following code.
    rv = sConnection->ExecuteSimpleSQL("PRAGMA journal_mode=WAL;"_ns);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = sConnection->ExecuteSimpleSQL("PRAGMA cache_size=-200000;"_ns);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = sConnection->ExecuteSimpleSQL(
        "CREATE TABLE folders ( \
          id INTEGER PRIMARY KEY, \
          parent INTEGER REFERENCES folders(id), \
          ordinal INTEGER DEFAULT NULL, \
          name TEXT, \
          flags INTEGER DEFAULT 0, \
          UNIQUE(parent, name) \
        );"_ns);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = sConnection->ExecuteSimpleSQL(
        "CREATE TABLE folder_properties ( \
          id INTEGER REFERENCES folders(id), \
          name TEXT, \
          value ANY, \
          PRIMARY KEY(id, name) \
        );"_ns);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = sConnection->ExecuteSimpleSQL(
        "CREATE TABLE messages ( \
          id INTEGER PRIMARY KEY, \
          folderId INTEGER REFERENCES folders(id), \
          messageId TEXT, \
          date INTEGER, \
          sender TEXT, \
          recipients TEXT, \
          ccList TEXT, \
          bccList TEXT, \
          subject TEXT, \
          flags INTEGER, \
          tags TEXT \
        );"_ns);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = sConnection->ExecuteSimpleSQL(
        "CREATE TABLE message_properties ( \
          id INTEGER REFERENCES messages(id), \
          name TEXT, \
          value ANY, \
          PRIMARY KEY(id, name) \
        );"_ns);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = sConnection->ExecuteSimpleSQL(
        "CREATE INDEX messages_folderId ON messages(folderId);"_ns);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = sConnection->ExecuteSimpleSQL(
        "CREATE INDEX messages_date ON messages(date);"_ns);
    NS_ENSURE_SUCCESS(rv, rv);
    rv = sConnection->ExecuteSimpleSQL(
        "CREATE INDEX messages_flags ON messages(flags);"_ns);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  RefPtr<TagsMatchFunction> tagsInclude = new TagsMatchFunction(true);
  sConnection->CreateFunction("tags_include"_ns, 2, tagsInclude);
  RefPtr<TagsMatchFunction> tagsExclude = new TagsMatchFunction(false);
  sConnection->CreateFunction("tags_exclude"_ns, 2, tagsExclude);
  RefPtr<AddressFormatFunction> addressFormat = new AddressFormatFunction();
  sConnection->CreateFunction("address_format"_ns, 1, addressFormat);

  return NS_OK;
}

/**
 * Create and cache an SQL statement.
 */
/* static */
nsresult DatabaseCore::GetStatement(const nsACString& aName,
                                    const nsACString& aSQL,
                                    mozIStorageStatement** aStmt) {
  NS_ENSURE_ARG_POINTER(aStmt);

  nsresult rv = EnsureConnection();
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<mozIStorageStatement> stmt;
  if (sStatements.Get(aName, &stmt)) {
    NS_IF_ADDREF(*aStmt = stmt);
    return NS_OK;
  }

  rv = sConnection->CreateStatement(aSQL, getter_AddRefs(stmt));
  NS_ENSURE_SUCCESS(rv, rv);
  sStatements.InsertOrUpdate(aName, stmt);
  NS_IF_ADDREF(*aStmt = stmt);

  return NS_OK;
}

/**
 * Functions for SQLite savepoints (https://sqlite.org/lang_savepoint.html).
 */

/**
 * Checks that the given string only contains a-z characters, for protection
 * against SQL injection. You should never call these savepoint functions with
 * a name that isn't hard-coded, but mistakes happen and that's how we get
 * security vulnerabilities.
 */
void assertStringIsSafeForSQL(const nsACString& str) {
  for (uint32_t i = 0; i < str.Length(); i++) {
    char c = str.CharAt(i);
    if (c < 'a' || c > 'z') {
      MOZ_CRASH(
          "Only a-z characters are allowed here. I see you, Bobby Tables!");
    }
  }
}

/* static */
nsresult DatabaseCore::CreateSavepoint(const nsACString& name) {
  assertStringIsSafeForSQL(name);
  return sConnection->ExecuteSimpleSQL("SAVEPOINT "_ns + name);
}

/* static */
nsresult DatabaseCore::ReleaseSavepoint(const nsACString& name) {
  assertStringIsSafeForSQL(name);
  return sConnection->ExecuteSimpleSQL("RELEASE "_ns + name);
}

/* static */
nsresult DatabaseCore::RollbackToSavepoint(const nsACString& name) {
  assertStringIsSafeForSQL(name);
  return sConnection->ExecuteSimpleSQL("ROLLBACK TO "_ns + name);
}

NS_IMETHODIMP
DatabaseCore::GetFolders(nsIFolderDatabase** aFolderDatabase) {
  NS_IF_ADDREF(*aFolderDatabase = mFolderDatabase);
  return NS_OK;
}

NS_IMETHODIMP
DatabaseCore::GetMessages(nsIMessageDatabase** aMessageDatabase) {
  NS_IF_ADDREF(*aMessageDatabase = mMessageDatabase);
  return NS_OK;
}

/**
 * Folder migration happens in three steps:
 *
 * 1. The existing summary file is opened and the messages are enumerated,
 *    collecting all of the data we need to copy into the new database. This
 *    happens on the main thread, but after every 100 messages we jump to the
 *    end of the main thread event queue so that the UI remains responsive
 *    (except while opening the summary file, which could take some time).
 *
 * 2. The messages are asynchronously inserted into the messages table.
 *    The keys of the inserted messages are collected.
 *
 * 3. Message properties are combined with the message keys and asynchronously
 *    inserted into the message_properties table.
 *
 * This object is an nsIRunnable that step 1 can keep pushing to the back of
 * the main thread event queue, and a mozIStorageStatementCallback to capture
 * the results of the SQL operations.
 */

class FolderMigrator final : public nsIRunnable, mozIStorageStatementCallback {
 public:
  FolderMigrator() {}

  NS_DECL_ISUPPORTS

  uint64_t mDestFolderId;
  nsAutoCString mDestFolderPath;
  nsMainThreadPtrHandle<Promise> mPromiseHolder;

  nsCOMPtr<nsIMsgEnumerator> mEnumerator;
  nsTArray<nsCString> mStoreTokens;
  nsTArray<int64_t> mMessageSizes;
  nsTArray<int64_t> mMessageKeys;

  nsCOMPtr<nsIMimeConverter> mMimeConverter;

  nsCOMPtr<mozIStorageStatement> mStmt;
  nsCOMPtr<mozIStorageBindingParamsArray> mParamsArray;
  uint32_t mCurrentStep = 0;

  nsresult SetupAndRun(nsIFile* summaryFile, nsIFolder* destFolder,
                       RefPtr<Promise> promise) {
    mDestFolderId = destFolder->GetId();
    mDestFolderPath = destFolder->GetPath();
    mPromiseHolder = new nsMainThreadPtrHolder<Promise>(__func__, promise);

    MOZ_LOG(gPanoramaLog, LogLevel::Info,
            ("migrating %s to the new database", mDestFolderPath.get()));
    PROFILER_MARKER_TEXT("Folder Migration", MAILNEWS,
                         MarkerOptions(MarkerTiming::IntervalStart()),
                         mDestFolderPath);

    nsCOMPtr<nsIMsgDatabase> db =
        do_CreateInstance("@mozilla.org/nsMsgDatabase/msgDB-mailbox");
    nsresult rv = db->OpenFromFile(summaryFile);
    NS_ENSURE_SUCCESS(rv, rv);

    rv = db->EnumerateMessages(getter_AddRefs(mEnumerator));
    NS_ENSURE_SUCCESS(rv, rv);

    bool hasMore;
    if (NS_FAILED(mEnumerator->HasMoreElements(&hasMore)) || !hasMore) {
      Complete(true);
      return NS_OK;
    }

    mMimeConverter = do_GetService("@mozilla.org/messenger/mimeconverter;1");

    DatabaseCore::GetStatement("AddMessage"_ns,
                               "INSERT INTO messages ( \
                                  folderId, messageId, date, sender, recipients, ccList, bccList, subject, flags, tags \
                                ) VALUES ( \
                                  :folderId, :messageId, :date, :sender, :recipients, :ccList, :bccList, :subject, :flags, :tags \
                                ) RETURNING "_ns MESSAGE_SQL_FIELDS,
                               getter_AddRefs(mStmt));
    mStmt->NewBindingParamsArray(getter_AddRefs(mParamsArray));
    NS_ENSURE_SUCCESS(rv, rv);

    NS_DispatchToMainThread(this);
    return NS_OK;
  }

  void Complete(bool success) {
    PROFILER_MARKER_TEXT("Folder Migration", MAILNEWS,
                         MarkerOptions(MarkerTiming::IntervalEnd()),
                         mDestFolderPath);
    nsresult rv;
    if (success) {
      MOZ_LOG(gPanoramaLog, LogLevel::Info, ("migration complete"));
      mPromiseHolder.get()->MaybeResolveWithUndefined();
      rv = DatabaseCore::ReleaseSavepoint("foldermigration"_ns);
    } else {
      MOZ_LOG(gPanoramaLog, LogLevel::Info, ("migration failed"));
      mPromiseHolder.get()->MaybeRejectWithUndefined();
      rv = DatabaseCore::RollbackToSavepoint("foldermigration"_ns);
    }
    NS_ENSURE_SUCCESS_VOID(rv);
  }

  NS_IMETHOD Run() override {
    auto guard = mozilla::MakeScopeExit([&] { Complete(false); });

    mCurrentStep = 1;
    bool hasMore;
    uint64_t count = 0;
    while (NS_SUCCEEDED(mEnumerator->HasMoreElements(&hasMore)) && hasMore) {
      nsCOMPtr<nsIMsgDBHdr> message;
      mEnumerator->GetNext(getter_AddRefs(message));

      nsAutoCString messageId;
      message->GetMessageId(messageId);
      PRTime date;
      message->GetDate(&date);
      nsAutoCString sender;
      message->GetAuthor(sender);
      nsAutoCString recipients;
      message->GetRecipients(recipients);
      nsAutoCString ccList;
      message->GetCcList(ccList);
      nsAutoCString bccList;
      message->GetBccList(bccList);
      nsAutoCString subject;
      message->GetSubject(subject);
      uint32_t flags;
      message->GetFlags(&flags);
      nsAutoCString tags;
      message->GetStringProperty("keywords", tags);
      nsAutoCString charset;
      message->GetCharset(charset);

      mMimeConverter->DecodeMimeHeaderToUTF8(sender, charset.get(), true, true,
                                             sender);
      mMimeConverter->DecodeMimeHeaderToUTF8(recipients, charset.get(), true,
                                             true, recipients);
      mMimeConverter->DecodeMimeHeaderToUTF8(ccList, charset.get(), true, true,
                                             ccList);
      mMimeConverter->DecodeMimeHeaderToUTF8(bccList, charset.get(), true, true,
                                             bccList);
      mMimeConverter->DecodeMimeHeaderToUTF8(subject, charset.get(), true, true,
                                             subject);

      nsCOMPtr<mozIStorageBindingParams> params;
      mParamsArray->NewBindingParams(getter_AddRefs(params));

      params->BindInt64ByName("folderId"_ns, mDestFolderId);
      params->BindUTF8StringByName("messageId"_ns,
                                   DatabaseUtils::Normalize(messageId));
      params->BindInt64ByName("date"_ns, date);
      params->BindUTF8StringByName("sender"_ns,
                                   DatabaseUtils::Normalize(sender));
      params->BindUTF8StringByName("recipients"_ns,
                                   DatabaseUtils::Normalize(recipients));
      params->BindUTF8StringByName("ccList"_ns,
                                   DatabaseUtils::Normalize(ccList));
      params->BindUTF8StringByName("bccList"_ns,
                                   DatabaseUtils::Normalize(bccList));
      params->BindUTF8StringByName("subject"_ns,
                                   DatabaseUtils::Normalize(subject));
      params->BindInt64ByName("flags"_ns, flags);
      params->BindUTF8StringByName("tags"_ns, DatabaseUtils::Normalize(tags));

      nsAutoCString storeToken;
      message->GetStoreToken(storeToken);
      mStoreTokens.AppendElement(storeToken);

      uint32_t messageSize;
      message->GetMessageSize(&messageSize);
      mMessageSizes.AppendElement((uint64_t)messageSize);

      mParamsArray->AddParams(params);

      if (++count == 100) {
        break;
      }
    }

    if (NS_SUCCEEDED(mEnumerator->HasMoreElements(&hasMore)) && hasMore) {
      // Push the remaining work to the end of the event loop.
      NS_DispatchToMainThread(this);
    } else {
      uint32_t length;
      mParamsArray->GetLength(&length);
      if (length > 0) {
        // Execute the query.
        mCurrentStep = 2;
        mStmt->BindParameters(mParamsArray);
        nsresult rv = DatabaseCore::CreateSavepoint("foldermigration"_ns);
        NS_ENSURE_SUCCESS(rv, rv);
        nsCOMPtr<mozIStoragePendingStatement> unused;
        mStmt->ExecuteAsync(this, getter_AddRefs(unused));
      } else {
        // No messages to migrate. Stop here.
        Complete(true);
      }
    }

    guard.release();
    return NS_OK;
  }

  NS_IMETHOD HandleError(mozIStorageError* error) override {
    nsAutoCString errorMessage;
    error->GetMessage(errorMessage);
    MOZ_LOG(gPanoramaLog, LogLevel::Error,
            ("migration failed, the database said: %s", errorMessage.get()));
    return NS_OK;
  }
  NS_IMETHOD HandleResult(mozIStorageResultSet* resultSet) override {
    if (mCurrentStep == 2) {
      // Collect the keys of inserted messages.
      nsCOMPtr<mozIStorageRow> row;
      while (NS_SUCCEEDED(resultSet->GetNextRow(getter_AddRefs(row))) && row) {
        mMessageKeys.AppendElement(row->AsInt64(0));
      }
    }
    return NS_OK;
  }
  NS_IMETHOD HandleCompletion(uint16_t reason) override {
    if (reason != mozIStorageStatementCallback::REASON_FINISHED) {
      Complete(false);
      return NS_OK;
    }
    if (mCurrentStep == 2) {
      // Now pair the message keys with the properties collected in step 1,
      // and insert them into the database.
      MOZ_ASSERT(mMessageKeys.Length() == mStoreTokens.Length());
      MOZ_ASSERT(mMessageKeys.Length() == mMessageSizes.Length());

      DatabaseCore::GetStatement(
          "SetMessageProperty"_ns,
          "REPLACE INTO message_properties (id, name, value) VALUES (:id, :name, :value)"_ns,
          getter_AddRefs(mStmt));
      mStmt->NewBindingParamsArray(getter_AddRefs(mParamsArray));

      for (size_t i = 0; i < mStoreTokens.Length(); i++) {
        if (!mStoreTokens[i].IsEmpty()) {
          nsCOMPtr<mozIStorageBindingParams> params;
          mParamsArray->NewBindingParams(getter_AddRefs(params));
          params->BindInt64ByName("id"_ns, mMessageKeys[i]);
          params->BindUTF8StringByName("name"_ns, "storeToken"_ns);
          params->BindUTF8StringByName("value"_ns, mStoreTokens[i]);
          mParamsArray->AddParams(params);
        }

        if (mMessageSizes[i] != 0) {
          nsCOMPtr<mozIStorageBindingParams> params;
          mParamsArray->NewBindingParams(getter_AddRefs(params));
          params->BindInt64ByName("id"_ns, mMessageKeys[i]);
          params->BindUTF8StringByName("name"_ns, "messageSize"_ns);
          params->BindInt64ByName("value"_ns, mMessageSizes[i]);
          mParamsArray->AddParams(params);
        }
      }

      uint32_t length;
      mParamsArray->GetLength(&length);
      if (length > 0) {
        mCurrentStep = 3;
        mStmt->BindParameters(mParamsArray);
        nsCOMPtr<mozIStoragePendingStatement> unused;
        mStmt->ExecuteAsync(this, getter_AddRefs(unused));
        return NS_OK;
      }
    }

    // Step 2 had no properties to insert, or step 3 is complete.
    Complete(true);
    return NS_OK;
  }

 private:
  ~FolderMigrator() = default;
};
NS_IMPL_ISUPPORTS(FolderMigrator, nsIRunnable, mozIStorageStatementCallback)

NS_IMETHODIMP
DatabaseCore::MigrateFolderDatabase(nsIMsgFolder* srcFolder, JSContext* aCx,
                                    Promise** aPromise) {
  AUTO_PROFILER_LABEL("DatabaseCore::MigrateFolderDatabase", MAILNEWS);

  nsCOMPtr<nsIFolder> destFolder;
  nsresult rv = mFolderDatabase->GetFolderForMsgFolder(
      srcFolder, getter_AddRefs(destFolder));
  NS_ENSURE_SUCCESS(rv, rv);

  ErrorResult err;
  RefPtr<Promise> promise = Promise::Create(xpc::CurrentNativeGlobal(aCx), err);

  nsCOMPtr<nsIFile> summaryFile;
  rv = srcFolder->GetSummaryFile(getter_AddRefs(summaryFile));
  NS_ENSURE_SUCCESS(rv, rv);

  FolderMigrator* migrator = new FolderMigrator();
  rv = migrator->SetupAndRun(summaryFile, destFolder, promise);
  NS_ENSURE_SUCCESS(rv, rv);

  promise.forget(aPromise);
  return NS_OK;
}

NS_IMETHODIMP
DatabaseCore::GetConnection(mozIStorageConnection** aConnection) {
  if (!xpc::IsInAutomation()) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  NS_ENSURE_ARG_POINTER(aConnection);

  nsresult rv = EnsureConnection();
  NS_ENSURE_SUCCESS(rv, rv);

  NS_IF_ADDREF(*aConnection = sConnection);
  return NS_OK;
}

NS_IMETHODIMP DatabaseCore::OpenFolderDB(nsIMsgFolder* aFolder,
                                         bool aLeaveInvalidDB,
                                         nsIMsgDatabase** _retval) {
  nsCOMPtr<nsIFolder> folder;
  nsresult rv =
      mFolderDatabase->GetFolderForMsgFolder(aFolder, getter_AddRefs(folder));
  NS_ENSURE_SUCCESS(rv, rv);
  if (!folder) {
    return NS_MSG_ERROR_FOLDER_SUMMARY_MISSING;
  }

  uint64_t folderId = folder->GetId();
  WeakPtr<PerFolderDatabase> existingDatabase = mOpenDatabases.Get(folderId);
  if (existingDatabase) {
    NS_IF_ADDREF(*_retval = existingDatabase);
    return NS_OK;
  }

  RefPtr<PerFolderDatabase> db =
      new PerFolderDatabase(mFolderDatabase, mMessageDatabase, folderId,
                            folder->GetFlags() & nsMsgFolderFlags::Newsgroup);
  NS_IF_ADDREF(*_retval = db);

  mOpenDatabases.InsertOrUpdate(folderId, db);

  nsCOMPtr<nsIFile> filePath;
  rv = aFolder->GetFilePath(getter_AddRefs(filePath));
  NS_ENSURE_SUCCESS(rv, rv);

  nsString path;
  rv = filePath->GetPath(path);
  NS_ENSURE_SUCCESS(rv, rv);
  mOpenDatabasesByFile.InsertOrUpdate(path, db);

  return NS_OK;
}
NS_IMETHODIMP DatabaseCore::CreateNewDB(nsIMsgFolder* aFolder,
                                        nsIMsgDatabase** _retval) {
  nsAutoCString name;
  aFolder->GetName(name);
  nsCOMPtr<nsIMsgFolder> msgParent;
  aFolder->GetParent(getter_AddRefs(msgParent));
  nsCOMPtr<nsIFolder> parent;
  mFolderDatabase->GetFolderForMsgFolder(msgParent, getter_AddRefs(parent));

  nsCOMPtr<nsIFolder> unused;
  mFolderDatabase->InsertFolder(parent, name, getter_AddRefs(unused));

  return OpenFolderDB(aFolder, false, _retval);
}
NS_IMETHODIMP DatabaseCore::OpenDBFromFile(nsIFile* aFile,
                                           nsIMsgFolder* aFolder, bool aCreate,
                                           bool aLeaveInvalidDB,
                                           nsIMsgDatabase** _retval) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP DatabaseCore::RegisterPendingListener(
    nsIMsgFolder* folder, nsIDBChangeListener* listener) {
  // This function was meant to wait for a database to open, but let's just
  // open it. They're not real anyway.
  nsCOMPtr<nsIMsgDatabase> database;
  nsresult rv = OpenFolderDB(folder, false, getter_AddRefs(database));
  NS_ENSURE_SUCCESS(rv, rv);

  return database->AddListener(listener);
}
NS_IMETHODIMP DatabaseCore::UnregisterPendingListener(
    nsIDBChangeListener* listener) {
  return NS_OK;
}
NS_IMETHODIMP DatabaseCore::CachedDBForFolder(nsIMsgFolder* aFolder,
                                              nsIMsgDatabase** _retval) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP DatabaseCore::CachedDBForFilePath(nsIFile* filePath,
                                                nsIMsgDatabase** _retval) {
  nsString path;
  nsresult rv = filePath->GetPath(path);
  NS_ENSURE_SUCCESS(rv, rv);

  WeakPtr<PerFolderDatabase> existingDatabase = mOpenDatabasesByFile.Get(path);
  if (existingDatabase) {
    NS_IF_ADDREF(*_retval = existingDatabase);
    return NS_OK;
  }

  return NS_ERROR_FAILURE;
}
NS_IMETHODIMP DatabaseCore::ForceFolderDBClosed(nsIMsgFolder* aFolder) {
  return NS_ERROR_NOT_IMPLEMENTED;
}
NS_IMETHODIMP DatabaseCore::GetOpenDBs(
    nsTArray<RefPtr<nsIMsgDatabase>>& aOpenDBs) {
  aOpenDBs.Clear();
  return NS_OK;
}

NS_IMPL_ISUPPORTS(DatabaseCoreFactory, nsIFactory)

NS_IMETHODIMP DatabaseCoreFactory::CreateInstance(const nsIID& aIID,
                                                  void** aResult) {
  nsresult rv;
  nsCOMPtr<nsIDatabaseCore> core =
      do_GetService("@mozilla.org/mailnews/database-core;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  *aResult = (void*)(core);
  return NS_OK;
}

}  // namespace mozilla::mailnews
