-- Republish cached local covers with a content version. The playlist definitions do not change.
UPDATE "PlaylistCountWork" SET "version" = "version" + 1, "dueAt" = 0
WHERE "ownerId" IN (
  SELECT "ownerId" FROM "Playlist" WHERE "coverUrlsJson" LIKE '%/artwork?size=%'
);
