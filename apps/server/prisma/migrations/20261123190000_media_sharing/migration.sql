CREATE TABLE "ShareLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShareLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SharedTrack" (
    "recipientItemId" TEXT NOT NULL PRIMARY KEY,
    "recipientId" TEXT NOT NULL,
    "originItemId" TEXT NOT NULL,
    "originOwnerId" TEXT NOT NULL,
    "sharedBy" TEXT NOT NULL,
    CONSTRAINT "SharedTrack_recipientItemId_fkey" FOREIGN KEY ("recipientItemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SharedTrackGrant" (
    "recipientItemId" TEXT NOT NULL,
    "shareLinkId" TEXT NOT NULL,
    PRIMARY KEY ("recipientItemId", "shareLinkId"),
    CONSTRAINT "SharedTrackGrant_recipientItemId_fkey" FOREIGN KEY ("recipientItemId") REFERENCES "SharedTrack" ("recipientItemId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SharedTrackGrant_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "ShareLink" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SavedSharedPlaylist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipientId" TEXT NOT NULL,
    "shareLinkId" TEXT,
    "title" TEXT NOT NULL,
    "sharedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SavedSharedPlaylist_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SavedSharedPlaylist_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "ShareLink" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ShareLink_token_key" ON "ShareLink"("token");
CREATE INDEX "ShareLink_ownerId_createdAt_idx" ON "ShareLink"("ownerId", "createdAt");
CREATE UNIQUE INDEX "SharedTrack_recipientId_originItemId_key" ON "SharedTrack"("recipientId", "originItemId");
CREATE INDEX "SharedTrackGrant_shareLinkId_idx" ON "SharedTrackGrant"("shareLinkId");
CREATE UNIQUE INDEX "SavedSharedPlaylist_recipientId_shareLinkId_key" ON "SavedSharedPlaylist"("recipientId", "shareLinkId");
CREATE INDEX "SavedSharedPlaylist_recipientId_createdAt_idx" ON "SavedSharedPlaylist"("recipientId", "createdAt");
CREATE INDEX "SavedSharedPlaylist_shareLinkId_idx" ON "SavedSharedPlaylist"("shareLinkId");
