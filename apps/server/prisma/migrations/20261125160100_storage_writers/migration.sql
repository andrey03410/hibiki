ALTER TABLE "KanameStorage" ADD COLUMN "writer" TEXT;
ALTER TABLE "KanameStorage" ADD COLUMN "workPaths" TEXT;
ALTER TABLE "KanameStorage" ADD COLUMN "measureOnDisk" BOOLEAN NOT NULL DEFAULT false;
UPDATE "KanameStorage" SET "writer" = 'legacy' WHERE "expiresAt" IS NOT NULL;
