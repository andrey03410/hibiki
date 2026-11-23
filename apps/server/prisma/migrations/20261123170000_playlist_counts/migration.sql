BEGIN IMMEDIATE;

ALTER TABLE "Playlist" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Playlist" ADD COLUMN "trackCount" INTEGER;
CREATE TABLE "PlaylistCountWork" (
  "ownerId" TEXT NOT NULL PRIMARY KEY REFERENCES "User" ("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL DEFAULT 0,
  "dueAt" BIGINT,
  "watchHistory" BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX "PlaylistCountWork_dueAt_ownerId_idx" ON "PlaylistCountWork" ("dueAt", "ownerId");

-- Backfill only the catalog badge here. The worker computes existing memberships.
UPDATE "Playlist" SET "manual" = COALESCE(json_extract("definitionJson", '$.rule.type') = 'items', 0)
WHERE json_valid("definitionJson");
INSERT INTO "PlaylistCountWork" ("ownerId", "dueAt") SELECT DISTINCT "ownerId", 0 FROM "Playlist";

CREATE TRIGGER "playlist_counts_create" AFTER INSERT ON "Playlist" BEGIN
  UPDATE "Playlist" SET "manual" = CASE WHEN json_valid(NEW."definitionJson")
    THEN COALESCE(json_extract(NEW."definitionJson", '$.rule.type') = 'items', 0) ELSE 0 END WHERE id = NEW.id;
  INSERT INTO "PlaylistCountWork" ("ownerId", "dueAt") VALUES (NEW."ownerId", 0)
  ON CONFLICT ("ownerId") DO UPDATE SET "dueAt" = 0, "version" = "version" + 1, "watchHistory" = 1;
END;

CREATE TRIGGER "playlist_counts_edit" AFTER UPDATE OF "definitionJson" ON "Playlist"
WHEN NEW."definitionJson" <> OLD."definitionJson" BEGIN
  UPDATE "Playlist" SET "manual" = CASE WHEN json_valid(NEW."definitionJson")
    THEN COALESCE(json_extract(NEW."definitionJson", '$.rule.type') = 'items', 0) ELSE 0 END WHERE id = NEW.id;
  UPDATE "PlaylistCountWork" SET "dueAt" = 0, "version" = "version" + 1, "watchHistory" = 1 WHERE "ownerId" = NEW."ownerId";
END;

CREATE TRIGGER "playlist_counts_delete" AFTER DELETE ON "Playlist" BEGIN
  UPDATE "PlaylistCountWork" SET "dueAt" = 0, "version" = "version" + 1 WHERE "ownerId" = OLD."ownerId";
END;

-- All library writers already advance this revision, including imports, tag edits and source changes.
CREATE TRIGGER "playlist_counts_library" AFTER UPDATE OF "libraryRevision" ON "User" BEGIN
  UPDATE "PlaylistCountWork" SET "dueAt" = 0, "version" = "version" + 1 WHERE "ownerId" = NEW.id
    AND EXISTS (SELECT 1 FROM "Playlist" WHERE "ownerId" = NEW.id);
END;

CREATE TRIGGER "playlist_counts_history_insert" AFTER INSERT ON "ListeningSummary" BEGIN
  UPDATE "PlaylistCountWork" SET "dueAt" = 0, "version" = "version" + 1 WHERE "ownerId" = NEW."ownerId" AND "watchHistory";
END;

CREATE TRIGGER "playlist_counts_history_update" AFTER UPDATE ON "ListeningSummary"
WHEN NEW.launches <> OLD.launches OR NEW.completed <> OLD.completed OR NEW.skipped <> OLD.skipped
  OR NEW."lastStartedAt" IS NOT OLD."lastStartedAt" BEGIN
  UPDATE "PlaylistCountWork" SET "dueAt" = 0, "version" = "version" + 1 WHERE "ownerId" = NEW."ownerId" AND "watchHistory";
END;

CREATE TRIGGER "playlist_counts_history_delete" AFTER DELETE ON "ListeningSummary" BEGIN
  UPDATE "PlaylistCountWork" SET "dueAt" = 0, "version" = "version" + 1 WHERE "ownerId" = OLD."ownerId" AND "watchHistory";
END;

COMMIT;
