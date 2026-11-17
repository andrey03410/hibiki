-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MediaFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "duration" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_MediaFile" ("bytes", "createdAt", "duration", "hash", "id", "kind", "mime", "ownerId", "path") SELECT "bytes", "createdAt", "duration", "hash", "id", "kind", "mime", "ownerId", "path" FROM "MediaFile";
DROP TABLE "MediaFile";
ALTER TABLE "new_MediaFile" RENAME TO "MediaFile";
CREATE UNIQUE INDEX "MediaFile_ownerId_hash_key" ON "MediaFile"("ownerId", "hash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
