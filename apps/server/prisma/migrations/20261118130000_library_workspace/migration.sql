-- AlterTable
ALTER TABLE "Source" ADD COLUMN "note" TEXT;

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN "note" TEXT;

-- AlterTable
ALTER TABLE "Playlist" ADD COLUMN "note" TEXT;

-- CreateTable
CREATE TABLE "ListeningAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemTitle" TEXT NOT NULL DEFAULT '',
    "playlistId" TEXT,
    "playlistTitle" TEXT,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "listened" REAL NOT NULL,
    "seeks" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    CONSTRAINT "ListeningAttempt_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ListeningSummary" (
    "itemId" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "launches" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "partial" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "listened" REAL NOT NULL DEFAULT 0,
    "seeks" INTEGER NOT NULL DEFAULT 0,
    "fromPlaylist" INTEGER NOT NULL DEFAULT 0,
    "direct" INTEGER NOT NULL DEFAULT 0,
    "manual" INTEGER NOT NULL DEFAULT 0,
    "advance" INTEGER NOT NULL DEFAULT 0,
    "repeat" INTEGER NOT NULL DEFAULT 0,
    "lastStartedAt" DATETIME,
    "lastCompletedAt" DATETIME,
    CONSTRAINT "ListeningSummary_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HistoryPreference" (
    "ownerId" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "resetAt" DATETIME,
    "prunedJson" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "HistoryPreference_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT,
    "stagedPath" TEXT,
    "metadataJson" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceProposal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SourceProposal_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "YoutubeLink" (
    "playlistId" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL DEFAULT '[]',
    "additionsJson" TEXT NOT NULL DEFAULT '[]',
    "hiddenJson" TEXT NOT NULL DEFAULT '[]',
    "tagId" TEXT,
    "previewJson" TEXT,
    "lastCheckedAt" DATETIME,
    "lastAppliedAt" DATETIME,
    "error" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "YoutubeLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "YoutubeLink_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "YoutubeSyncPreference" (
    "ownerId" TEXT NOT NULL PRIMARY KEY,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    CONSTRAINT "YoutubeSyncPreference_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "YoutubeNotice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    CONSTRAINT "YoutubeNotice_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "YoutubeNotice_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "Item" ADD COLUMN "favorite" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Item" ADD COLUMN "note" TEXT;
ALTER TABLE "Item" ADD COLUMN "preferredSourceId" TEXT;
ALTER TABLE "Job" ADD COLUMN "browserOnly" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ListeningAttempt_ownerId_startedAt_id_idx" ON "ListeningAttempt"("ownerId", "startedAt", "id");

-- CreateIndex
CREATE INDEX "ListeningAttempt_ownerId_itemId_startedAt_id_idx" ON "ListeningAttempt"("ownerId", "itemId", "startedAt", "id");

-- CreateIndex
CREATE INDEX "ListeningAttempt_ownerId_playlistId_startedAt_id_idx" ON "ListeningAttempt"("ownerId", "playlistId", "startedAt", "id");

-- CreateIndex
CREATE INDEX "ListeningSummary_ownerId_idx" ON "ListeningSummary"("ownerId");

-- CreateIndex
CREATE INDEX "SourceProposal_ownerId_itemId_status_idx" ON "SourceProposal"("ownerId", "itemId", "status");

-- CreateIndex
CREATE INDEX "YoutubeLink_lastCheckedAt_playlistId_idx" ON "YoutubeLink"("lastCheckedAt", "playlistId");

-- CreateIndex
CREATE UNIQUE INDEX "YoutubeLink_ownerId_url_key" ON "YoutubeLink"("ownerId", "url");

-- CreateIndex
CREATE INDEX "YoutubeNotice_ownerId_readAt_createdAt_idx" ON "YoutubeNotice"("ownerId", "readAt", "createdAt");
