ALTER TABLE "User" ADD COLUMN "libraryRevision" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "Item_ownerId_id_idx" ON "Item"("ownerId", "id");
CREATE INDEX "Source_itemId_idx" ON "Source"("itemId");
CREATE INDEX "ItemTag_tagId_idx" ON "ItemTag"("tagId");

-- Keep browser cursors consistent across all writers, including a separate worker.
-- The counter changes atomically with the data and reads in constant time.

CREATE TRIGGER "library_revision_Item_insert"
AFTER INSERT ON "Item" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (NEW."ownerId");
END;

CREATE TRIGGER "library_revision_Item_update"
AFTER UPDATE ON "Item" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (NEW."ownerId", OLD."ownerId");
END;

CREATE TRIGGER "library_revision_Item_delete"
AFTER DELETE ON "Item" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (OLD."ownerId");
END;

CREATE TRIGGER "library_revision_Source_insert"
AFTER INSERT ON "Source" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (NEW."ownerId");
END;

CREATE TRIGGER "library_revision_Source_update"
AFTER UPDATE ON "Source" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (NEW."ownerId", OLD."ownerId");
END;

CREATE TRIGGER "library_revision_Source_delete"
AFTER DELETE ON "Source" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (OLD."ownerId");
END;

CREATE TRIGGER "library_revision_MediaFile_insert"
AFTER INSERT ON "MediaFile" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (NEW."ownerId");
END;

CREATE TRIGGER "library_revision_MediaFile_update"
AFTER UPDATE ON "MediaFile" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (NEW."ownerId", OLD."ownerId");
END;

CREATE TRIGGER "library_revision_MediaFile_delete"
AFTER DELETE ON "MediaFile" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (OLD."ownerId");
END;

CREATE TRIGGER "library_revision_Tag_insert"
AFTER INSERT ON "Tag" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (NEW."ownerId");
END;

CREATE TRIGGER "library_revision_Tag_update"
AFTER UPDATE ON "Tag" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (NEW."ownerId", OLD."ownerId");
END;

CREATE TRIGGER "library_revision_Tag_delete"
AFTER DELETE ON "Tag" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (OLD."ownerId");
END;

CREATE TRIGGER "library_revision_ItemTag_insert"
AFTER INSERT ON "ItemTag" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (SELECT "ownerId" FROM "Item" WHERE "id" IN (NEW."itemId"));
END;

CREATE TRIGGER "library_revision_ItemTag_update"
AFTER UPDATE ON "ItemTag" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (SELECT "ownerId" FROM "Item" WHERE "id" IN (NEW."itemId", OLD."itemId"));
END;

CREATE TRIGGER "library_revision_ItemTag_delete"
AFTER DELETE ON "ItemTag" BEGIN
  UPDATE "User" SET "libraryRevision" = "libraryRevision" + 1 WHERE "id" IN (SELECT "ownerId" FROM "Item" WHERE "id" IN (OLD."itemId"));
END;
