ALTER TABLE "Job" ADD COLUMN "archiveState" TEXT;
CREATE INDEX "Job_archiveState_idx" ON "Job"("archiveState");
CREATE INDEX "Job_import_preview_idx" ON "Job"("ownerId", json_extract("inputJson", '$.previewJobId')) WHERE "kind" = 'import';
