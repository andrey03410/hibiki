CREATE TABLE "ClassificationBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
    "digest" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "packageJson" TEXT NOT NULL,
    "journalJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ClassificationBatch_ownerId_createdAt_idx" ON "ClassificationBatch"("ownerId","createdAt");
