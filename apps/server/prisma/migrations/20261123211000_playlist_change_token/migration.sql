BEGIN IMMEDIATE;

ALTER TABLE "PlaylistCountWork" ADD COLUMN "changeToken" TEXT NOT NULL DEFAULT '';
UPDATE "PlaylistCountWork" SET "changeToken" = lower(hex(randomblob(16)));

-- A rolled back numeric version can be used again by a different write.
CREATE TRIGGER "playlist_count_token_insert" AFTER INSERT ON "PlaylistCountWork" BEGIN
  UPDATE "PlaylistCountWork" SET "changeToken" = lower(hex(randomblob(16))) WHERE "ownerId" = NEW."ownerId";
END;

CREATE TRIGGER "playlist_count_token_version" AFTER UPDATE OF "version" ON "PlaylistCountWork"
WHEN NEW."version" <> OLD."version" BEGIN
  UPDATE "PlaylistCountWork" SET "changeToken" = lower(hex(randomblob(16))) WHERE "ownerId" = NEW."ownerId";
END;

COMMIT;
