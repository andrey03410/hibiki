import { afterEach, beforeEach, expect, it } from "vitest";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import Sqlite from "better-sqlite3";
import { ZipFile } from "yazl";
import { createApp } from "./app";
import { applyArchive, exportLibrary, inspectArchive } from "./portability";
import { testContext } from "./test-utils";

let ctx: Awaited<ReturnType<typeof testContext>>;
beforeEach(async () => {
  ctx = await testContext();
});
afterEach(async () => {
  await ctx.close();
});

it("upgrades case-sensitive SQLite identities and exact item links without changing either ID", async () => {
  const sqlite = new Sqlite(":memory:");
  const migrations = "apps/server/prisma/migrations";
  try {
    for (const migration of (await readdir(migrations))
      .filter((name) => /^\d/.test(name))
      .sort()) {
      if (migration === "20261123110000_tag_navigation") {
        sqlite.exec(`
          INSERT INTO User(id,login,passwordHash) VALUES ('owner','fixture','fixture');
          INSERT INTO Tag(id,ownerId,name) VALUES ('a','owner','Rock'),('b','owner','rock');
          INSERT INTO Item(id,ownerId,title,originalTitle,kind,updatedAt) VALUES ('i','owner','i','i','audio',CURRENT_TIMESTAMP);
          INSERT INTO ItemTag(itemId,tagId) VALUES ('i','a');
        `);
      }
      sqlite.exec(
        await readFile(join(migrations, migration, "migration.sql"), "utf8"),
      );
    }
    expect(
      sqlite
        .prepare("SELECT id,name,legacyFlat,archived FROM Tag ORDER BY id")
        .all(),
    ).toEqual([
      { id: "a", name: "Rock", legacyFlat: 1, archived: 0 },
      { id: "b", name: "rock", legacyFlat: 1, archived: 0 },
    ]);
    expect(
      sqlite
        .prepare("SELECT tagId FROM ItemTag WHERE itemId='i'")
        .pluck()
        .all(),
    ).toEqual(["a"]);
  } finally {
    sqlite.close();
  }
});

it("imports an old case-sensitive pair, retains both exact playlist memberships across re-export and permits unrelated edits", async () => {
  const { db, userId, otherUserId, root, library } = ctx;
  const stamp = new Date().toISOString();
  const archive = join(root, "base.zip");
  await exportLibrary(db, userId, root, archive, { includeFiles: false });
  const old = await inspectArchive(archive, join(root, "check-base"));
  const names = ["РОК", "рок"];
  old.manifest.tags = names.map((name, n) => ({
    id: "tag" + n,
    name,
    color: "#555555",
  }));
  old.manifest.items = names.map((name, n) => ({
    id: "item" + n,
    title: name,
    originalTitle: name,
    kind: "audio",
    duration: null,
    createdAt: stamp,
    tagIds: ["tag" + n],
    sources: [],
  }));
  old.manifest.playlists = names.map((title, n) => ({
    id: "list" + n,
    title,
    description: "",
    definition: {
      version: 1,
      sort: "source",
      rule: { type: "tag", id: "tag" + n },
    },
  }));
  const oldArchive = join(root, "old-v1.zip");
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(old.manifest)), "manifest.json");
  const written = pipeline(zip.outputStream, createWriteStream(oldArchive));
  zip.end();
  await written;
  const checked = await inspectArchive(oldArchive, join(root, "check-old-v1"));
  // Force a remap of one internal key. The second archive must retain its visible name and identity.
  await db.tag.create({
    data: {
      id: "unrelated",
      ownerId: otherUserId,
      name: "РОК",
      group: "artist",
      label: "Артист",
    },
  });
  await library.createTag(otherUserId, { name: "рок", group: "extra" });
  await applyArchive(db, otherUserId, root, checked);
  await applyArchive(db, otherUserId, root, checked);
  const live = (await library.listTags(otherUserId)).filter(
    (tag) => tag.group === "extra",
  );
  expect(live.map((t) => t.name).sort()).toEqual(names);
  expect(new Set(live.map((t) => t.id)).size).toBe(2);
  await library.updateTag(otherUserId, live[0].id, { color: "#334455" });
  await library.createTag(otherUserId, { name: "Джаз", group: "genre" });
  await expect(
    library.createTag(otherUserId, { name: "рОк", group: "extra" }),
  ).rejects.toThrow();
  await expect(
    library.updateTag(otherUserId, live[0].id, { name: "Рок" }),
  ).rejects.toThrow();
  await exportLibrary(db, otherUserId, root, archive, { includeFiles: false });
  const second = await inspectArchive(archive, join(root, "check-second"));
  await applyArchive(db, userId, root, second);
  const restored = await library.snapshot(userId);
  for (const name of names) {
    const playlist = restored.playlists.find((p) => p.title === name)!;
    expect(
      (await library.resolve(userId, playlist.id)).items.map((i) => i.title),
    ).toEqual([name]);
  }
});

it("honors an explicit archived filter by exact ID and keeps it out of counts and text search", async () => {
  const { db, userId, library } = ctx;
  const old = await library.createTag(userId, {
    name: "former",
    group: "extra",
  });
  const active = await library.createTag(userId, {
    name: "new",
    group: "mood",
  });
  await db.item.createMany({
    data: ["both", "old", "active"].map((id) => ({
      id,
      ownerId: userId,
      title: id,
      originalTitle: id,
      kind: "audio",
    })),
  });
  await db.itemTag.createMany({
    data: [
      { itemId: "both", tagId: old.id },
      { itemId: "both", tagId: active.id },
      { itemId: "old", tagId: old.id },
      { itemId: "active", tagId: active.id },
    ],
  });
  await library.updateTag(userId, old.id, { archived: true });
  const app = await createApp({ db, storageRoot: ctx.root });
  try {
    const cookie = "hibiki_session=" + (await app.auth.createSession(userId));
    async function page(filters: Record<string, unknown>) {
      const r = await app.inject({
        method: "POST",
        url: "/api/library/page",
        headers: { cookie },
        payload: { filters: { sort: "title-asc", ...filters } },
      });
      expect(r.statusCode).toBe(200);
      const page = r.json();
      expect(page.tagCounts).not.toHaveProperty(old.id);
      return page.items.map((i: { id: string }) => i.id);
    }
    expect(await page({ tagIds: [old.id] })).toEqual(["both", "old"]);
    expect(await page({ tagIds: [old.id, active.id] })).toEqual(["both"]);
    expect(await page({ tagIds: [old.id, active.id], tagMode: "or" })).toEqual([
      "active",
      "both",
      "old",
    ]);
    expect(await page({ query: "former" })).toEqual([]);
  } finally {
    await app.close();
  }
});
