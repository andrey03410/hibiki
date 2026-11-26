ALTER TABLE "Item" ADD COLUMN "visualRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "VisualTrack" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "ownerId" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "fileId" TEXT NOT NULL REFERENCES "MediaFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "streamIndex" INTEGER,
  "duration" REAL NOT NULL
);
CREATE UNIQUE INDEX "VisualTrack_ownerId_signature_key" ON "VisualTrack"("ownerId", "signature");
CREATE INDEX "VisualTrack_fileId_idx" ON "VisualTrack"("fileId");
CREATE TABLE "ItemVisual" (
  "itemId" TEXT PRIMARY KEY NOT NULL REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "soundSourceId" TEXT NOT NULL REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "soundFileId" TEXT REFERENCES "MediaFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "visualTrackId" TEXT NOT NULL REFERENCES "VisualTrack"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ItemVisual_visualTrackId_idx" ON "ItemVisual"("visualTrackId");
CREATE INDEX "ItemVisual_soundFileId_idx" ON "ItemVisual"("soundFileId");
CREATE TABLE "VisualOperation" (
  "itemId" TEXT NOT NULL REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "key" TEXT NOT NULL, "request" TEXT NOT NULL, "result" TEXT NOT NULL,
  PRIMARY KEY ("itemId", "key")
);

CREATE TABLE "VisualPreparation" (
  "ownerId" TEXT NOT NULL, "fileHash" TEXT NOT NULL, "streamIndex" INTEGER NOT NULL, "profile" INTEGER NOT NULL,
  "visualTrackId" TEXT NOT NULL REFERENCES "VisualTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("ownerId", "fileHash", "streamIndex", "profile")
);
CREATE INDEX "VisualPreparation_visualTrackId_idx" ON "VisualPreparation"("visualTrackId");
