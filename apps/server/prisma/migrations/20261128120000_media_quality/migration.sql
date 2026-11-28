ALTER TABLE "MediaFile" ADD COLUMN "quality" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "audioClass" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "audioFormat" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "audioScore" INTEGER;
ALTER TABLE "MediaFile" ADD COLUMN "qualityVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MediaFile" ADD COLUMN "originFileId" TEXT;
CREATE INDEX "MediaFile_qualityVersion_id_idx" ON "MediaFile"("qualityVersion", "id");
