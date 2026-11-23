-- Old SQLite catalogs used the exact, case-sensitive name as an identity.
ALTER TABLE "Tag" ADD COLUMN "legacyFlat" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Tag" SET "legacyFlat" = true
WHERE "label" IS NULL AND "group" = 'extra' AND json_array_length("parentIds") = 0;
