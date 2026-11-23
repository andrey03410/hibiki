ALTER TABLE "User" ADD COLUMN "kanameIssuer" TEXT;
ALTER TABLE "User" ADD COLUMN "kanameSubject" TEXT;
ALTER TABLE "User" ADD COLUMN "suspended" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "User_kanameIssuer_kanameSubject_key" ON "User"("kanameIssuer","kanameSubject");
ALTER TABLE "Session" ADD COLUMN "kaname" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ApiToken" ADD COLUMN "kaname" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "KanameActivity" (
  "ownerId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "day" TEXT NOT NULL, "lastActiveAt" DATETIME NOT NULL,
  PRIMARY KEY ("ownerId", "day")
);
CREATE TABLE "KanameStorage" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "ownerId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "bytes" BIGINT NOT NULL, "expiresAt" DATETIME
);
CREATE INDEX "KanameStorage_ownerId_idx" ON "KanameStorage"("ownerId");
