import { afterEach, beforeEach, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ItemDto } from "@hibiki/contracts";
import { hydrateLibraryItems } from "./library";
import { applyArchive, exportLibrary, inspectArchive } from "./portability";
import { testContext, wav } from "./test-utils";

let ctx: Awaited<ReturnType<typeof testContext>>;

beforeEach(async () => { ctx = await testContext(); });
afterEach(async () => { await ctx.close(); });

async function retainSharedTrack() {
  const { db, library, root, userId: originOwnerId, otherUserId: recipientId } = ctx;
  const path = join(root, "tone.wav");
  await writeFile(path, wav());
  const { item: original } = await library.importLocal(originOwnerId, path, { title: "Original" });
  const recipientItemId = "retained";
  await db.item.create({ data: {
    id: recipientItemId, ownerId: recipientId, kind: "audio", title: "My track", originalTitle: "Original", favorite: true,
  } });
  await db.shareLink.create({ data: {
    id: "link", token: "library-fixture", ownerId: originOwnerId, kind: "item", targetId: original.id, title: "Original",
  } });
  await db.sharedTrack.create({ data: {
    recipientItemId, recipientId, originItemId: original.id, originOwnerId, sharedBy: "alice",
    grants: { create: { shareLinkId: "link" } },
  } });
  return { recipientItemId, recipientId };
}

it("hydrates a retained borrowed track from the catalog, favorites and personal playlists", async () => {
  const { db, library, root } = ctx;
  const { recipientId, recipientItemId } = await retainSharedTrack();
  const active = {
    id: recipientItemId, title: "My track", favorite: true, shared: { sharedBy: "alice", available: true },
    sources: [{ provider: "local", shared: true, status: "available", streamUrl: expect.stringMatching(/^\/api\/shared-items\/retained\/sources\//) }],
  };
  expect((await library.snapshot(recipientId)).items).toMatchObject([active]);
  expect(await library.getItem(recipientId, recipientItemId)).toMatchObject(active);
  expect(await db.$transaction(tx => hydrateLibraryItems(tx, recipientId, [recipientItemId], false))).toMatchObject([{ sources: [] }]);
  const playlist = await library.savePlaylist(recipientId, { title: "Favorites", definition: {
    version: 1, sort: "source", rule: { type: "favorite" },
  } });
  const local = await library.savePlaylist(recipientId, { title: "Owned local", definition: {
    version: 1, sort: "source", rule: { type: "filter", local: true },
  } });

  const { createApp } = await import("./app");
  const app = await createApp({ db, storageRoot: root });
  try {
    const headers = { cookie: `hibiki_session=${await app.auth.createSession(recipientId)}` };
    const rendered = async (url: string, payload?: Record<string, unknown>) => {
      const response = await app.inject({ url, method: payload ? "POST" : "GET", headers, payload });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ items: ItemDto[] }>();
    };
    const pages = [
      await rendered("/api/items"),
      await rendered("/api/library/page", { filters: { favoriteOnly: true } }),
      await rendered("/api/library/items", { ids: [recipientItemId] }),
      await rendered(`/api/playlists/${playlist.id}/playback`),
      await rendered(`/api/playlists/${playlist.id}/resolve`),
    ];
    for (const { items } of pages) {
      expect(items).toMatchObject([active]);
      expect(items[0]?.sources[0]).not.toHaveProperty("fileId");
      expect(items[0]?.sources[0]).not.toHaveProperty("hash");
    }
    expect((await rendered(`/api/playlists/${local.id}/resolve`)).items).toEqual([]);
    expect((await rendered(`/api/playlists/${local.id}/playback`)).items).toEqual([]);
    expect(await db.mediaFile.count({ where: { ownerId: recipientId } })).toBe(0);

    const filter = async (availability: "available" | "unknown" | "unavailable") =>
      (await rendered("/api/library/page", { filters: { query: "My track", availability } })).items.map(item => item.id);
    expect(await filter("available")).toEqual([recipientItemId]);
    expect(await filter("unknown")).toEqual([]);
    expect(await filter("unavailable")).toEqual([]);

    await db.shareLink.update({ where: { id: "link" }, data: { revokedAt: new Date() } });
    expect(await filter("available")).toEqual([]);
    expect(await filter("unavailable")).toEqual([recipientItemId]);
    expect((await rendered(`/api/playlists/${playlist.id}/playback`)).items).toMatchObject([{
      id: recipientItemId, favorite: true, shared: { sharedBy: "alice", available: false }, sources: [],
    }]);
  } finally {
    await app.close();
  }
});

it("exports retained library metadata without borrowed files and grants", async () => {
  const { db, library, root } = ctx;
  const { recipientId, recipientItemId } = await retainSharedTrack();
  const path = join(root, "retained.zip");
  await exportLibrary(db, recipientId, root, path, { includeFiles: true });
  const archive = await inspectArchive(path, join(root, "retained"));

  expect(archive.preview.canApply).toBe(true);
  expect(archive.manifest?.items).toMatchObject([{ id: recipientItemId, title: "My track", favorite: true, sources: [] }]);
  expect(archive.manifest?.items[0]).not.toHaveProperty("shared");
  expect(archive.manifest?.files).toEqual([]);
  await db.user.create({ data: { id: "third", login: "charlie", passwordHash: "test" } });
  await applyArchive(db, "third", root, archive);
  expect((await library.snapshot("third")).items).toMatchObject([{ title: "My track", favorite: true, sources: [] }]);
  expect(await db.sharedTrack.count({ where: { recipientId: "third" } })).toBe(0);
});
