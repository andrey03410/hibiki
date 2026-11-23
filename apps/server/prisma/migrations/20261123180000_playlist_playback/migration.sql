BEGIN IMMEDIATE;

ALTER TABLE "Playlist" ADD COLUMN "coverUrlsJson" TEXT;
ALTER TABLE "Playlist" ADD COLUMN "queueIdsJson" TEXT;
ALTER TABLE "PlaylistCountWork" ADD COLUMN "publishedVersion" INTEGER;
ALTER TABLE "PlaylistCountWork" ADD COLUMN "validUntil" BIGINT;

UPDATE "PlaylistCountWork" SET "dueAt" = 0, "version" = "version" + 1;

COMMIT;
