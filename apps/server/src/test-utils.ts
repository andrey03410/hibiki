import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import Sqlite from "better-sqlite3";
import { createDb } from "./db";
import { LibraryService } from "./library";
export function wav(seconds = 1) {
  const n = seconds * 8000;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(
      Math.round(Math.sin((i * 440 * 2 * Math.PI) / 8000) * 4000),
      44 + i * 2,
    );
  return b;
}
export async function testContext() {
  const root = await mkdtemp(join(tmpdir(), "hibiki-test-"));
  const sqlite = new Sqlite(join(root, "hibiki.db"));
  const migrationRoot = resolve("apps/server/prisma/migrations");
  for (const folder of (await readdir(migrationRoot))
    .filter((n) => /^\d/.test(n))
    .sort())
    sqlite.exec(
      await readFile(join(migrationRoot, folder, "migration.sql"), "utf8"),
    );
  sqlite.close();
  // Tests never inherit a user's production DATABASE_URL.
  const db = createDb(root, { databaseUrl: `file:${join(root, "hibiki.db")}` });
  const userId = "test-owner";
  const otherUserId = "test-other";
  await db.user.createMany({
    data: [
      { id: userId, login: "alice", passwordHash: "test" },
      { id: otherUserId, login: "bob", passwordHash: "test" },
    ],
  });
  const library = new LibraryService(db, root);
  return {
    db,
    library,
    root,
    userId,
    otherUserId,
    async close() {
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    },
  };
}
