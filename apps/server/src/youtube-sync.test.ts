import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./errors";
import { testContext } from "./test-utils";
import { registerYoutubeSync, YoutubeSyncService } from "./youtube-sync";
import type { YoutubeCollection } from "./youtube";

const url = "https://www.youtube.com/playlist?list=PLtest";
const a = "aaaaaaaaaaa";
const b = "bbbbbbbbbbb";
const c = "ccccccccccc";
const d = "ddddddddddd";
const e = "eeeeeeeeeee";
const collection = (...ids: string[]): YoutubeCollection => ({
  title: "Плейлист YouTube",
  entries: ids.map((externalId) => ({ externalId, title: externalId })),
  warnings: [],
});

describe("linked YouTube playlists", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  let result: YoutubeCollection;
  let now: Date;
  let discover: ReturnType<
    typeof vi.fn<
      (url: string, signal?: AbortSignal) => Promise<YoutubeCollection>
    >
  >;
  let sync: YoutubeSyncService;

  beforeEach(async () => {
    ctx = await testContext();
    result = collection(a, b, c);
    now = new Date("2026-11-18T12:00:00Z");
    discover = vi.fn(async () => result);
    sync = new YoutubeSyncService(ctx.db, { discover, now: () => now });
  });

  afterEach(async () => {
    await ctx?.close();
  });

  function advance(minutes: number) {
    now = new Date(now.getTime() + minutes * 60_000);
  }

  async function resolved(playlistId: string) {
    return (await ctx.library.resolve(ctx.userId, playlistId)).items.map(
      (item) => item.id,
    );
  }

  it("returns the original linked playlist when the owner retries an equivalent URL", async () => {
    const owner = ctx.userId;
    const playlist = await sync.create(owner, url);
    await sync.updateLocal(owner, playlist.id, { type: "hide", externalId: b });
    const retry = await sync.create(
      owner,
      `https://m.youtube.com/watch?v=${a}&list=PLtest&t=30`,
    );

    expect(retry).toMatchObject({
      id: playlist.id,
      youtubeLinked: true,
      revision: playlist.revision + 1,
    });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(await ctx.db.youtubeLink.count({ where: { ownerId: owner } })).toBe(
      1,
    );
    expect(await ctx.db.playlist.count({ where: { ownerId: owner } })).toBe(1);
  });

  it("returns the winning link when two requests both reach YouTube", async () => {
    let finish!: (value: YoutubeCollection) => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    discover.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
          start();
        }),
    );

    const first = sync.create(ctx.userId, url);
    await started;
    const second = await sync.create(ctx.userId, url);
    finish(collection(d));

    expect(await first).toEqual(second);
    expect(
      await ctx.db.playlist.count({ where: { ownerId: ctx.userId } }),
    ).toBe(1);
    expect(
      await ctx.db.youtubeLink.count({ where: { ownerId: ctx.userId } }),
    ).toBe(1);
    expect(
      await ctx.db.source.count({
        where: { ownerId: ctx.userId, externalId: d },
      }),
    ).toBe(0);
    expect(await resolved(second.id)).toHaveLength(3);
  });

  it("publishes the external-ID diff, reuses items and retains local additions and hides", async () => {
    const owner = ctx.userId;
    const original = await ctx.library.upsertYoutube(owner, {
      externalId: a,
      title: "Редкое исполнение",
    });
    const local = await ctx.library.upsertYoutube(owner, {
      externalId: e,
      title: "Локальное дополнение",
    });
    const known = await ctx.library.upsertYoutube(owner, {
      externalId: d,
      title: "Знакомая запись",
    });
    const tag = await ctx.db.tag.create({
      data: { id: "sync-tag", ownerId: owner, name: "YouTube" },
    });
    const playlist = await sync.create(owner, url);
    const initial = await sync.get(owner, playlist.id);
    const bId = initial!.snapshot[1]!.itemId;
    const cId = initial!.snapshot[2]!.itemId;
    expect(await resolved(playlist.id)).toEqual([original.item.id, bId, cId]);

    // The playlist can still identify the record after the YouTube source is gone.
    await ctx.db.source.deleteMany({ where: { itemId: original.item.id } });
    await sync.updateLocal(owner, playlist.id, {
      type: "add",
      itemId: local.item.id,
    });
    await sync.updateLocal(owner, playlist.id, { type: "hide", externalId: c });
    await sync.updateLocal(owner, playlist.id, { type: "tag", tagId: tag.id });

    result = collection(c, d, a, c);
    result.entries[0] = { externalId: c, available: false };
    advance(5);
    const updated = await sync.check(owner, playlist.id);
    expect(await resolved(playlist.id)).toEqual([
      known.item.id,
      original.item.id,
      local.item.id,
    ]);
    expect(await ctx.db.item.count({ where: { ownerId: owner } })).toBe(5);
    expect(await ctx.db.item.findUnique({ where: { id: bId } })).not.toBeNull();
    expect(
      await ctx.db.itemTag.findMany({ select: { tagId: true, itemId: true } }),
    ).toEqual([{ tagId: tag.id, itemId: known.item.id }]);
    expect(updated.snapshot.map((entry) => entry.externalId)).toEqual([
      c,
      d,
      a,
    ]);
    expect(updated.report?.added).toMatchObject([{ externalId: d, to: 2 }]);
    expect(updated.report?.removed).toMatchObject([{ externalId: b, from: 2 }]);
    expect(updated.report?.moved).toMatchObject([
      { externalId: c, from: 3, to: 1 },
      { externalId: a, from: 1, to: 3 },
    ]);
    expect(await sync.notices(owner)).toHaveLength(1);
    await sync.check(owner, playlist.id);
    expect(await sync.notices(owner)).toHaveLength(1);
    expect(await sync.notices(ctx.otherUserId)).toEqual([]);
  });

  it("keeps the applied snapshot and records errors after partial, truncated and failed checks", async () => {
    const owner = ctx.userId;
    const playlist = await sync.create(owner, url);
    const original = await resolved(playlist.id);
    const initial = await sync.get(owner, playlist.id);

    for (const partial of [
      { ...collection(a), warnings: ["Часть ответа не получена"] },
      collection(...Array<string>(10_001).fill(a)),
    ]) {
      result = partial;
      advance(5);
      const link = await sync.check(owner, playlist.id);
      expect(link.error).toBeTruthy();
      expect(link.lastCheckedAt).toBe(now.toISOString());
      expect(link.lastAppliedAt).toEqual(initial!.lastAppliedAt);
      expect(await resolved(playlist.id)).toEqual(original);
    }
    discover.mockRejectedValueOnce(new Error("YouTube недоступен"));
    const failure = await sync.check(owner, playlist.id);
    expect(failure.error).toContain("YouTube недоступен");
    expect(failure.snapshot).toEqual(initial!.snapshot);
    expect(await sync.notices(owner)).toEqual([]);
  });

  it("lets local edits work during an outage and never untags an item on remote removal", async () => {
    const owner = ctx.userId;
    const playlist = await sync.create(owner, url);
    const tag = await ctx.db.tag.create({
      data: { id: "keep-tag", ownerId: owner, name: "Импорт" },
    });
    await sync.updateLocal(owner, playlist.id, { type: "tag", tagId: tag.id });
    result = collection(a, b, c, d);
    const afterAdd = await sync.check(owner, playlist.id);
    const itemId = afterAdd.snapshot[3]!.itemId;

    discover.mockRejectedValueOnce(new Error("Сеть недоступна"));
    await sync.check(owner, playlist.id);
    await sync.updateLocal(owner, playlist.id, { type: "hide", externalId: d });
    expect(await resolved(playlist.id)).not.toContain(itemId);
    await sync.updateLocal(owner, playlist.id, { type: "show", externalId: d });
    expect(await resolved(playlist.id)).toContain(itemId);

    result = collection(a, b, c);
    await sync.check(owner, playlist.id);
    expect(await resolved(playlist.id)).not.toContain(itemId);
    expect(
      await ctx.db.itemTag.findUnique({
        where: { itemId_tagId: { itemId, tagId: tag.id } },
      }),
    ).not.toBeNull();
  });

  it("checks only due links and honors both background modes and manual-only mode", async () => {
    const owner = ctx.userId;
    const playlist = await sync.create(owner, url);
    const original = await resolved(playlist.id);
    const other = await sync.create(ctx.otherUserId, url);
    const otherOriginal = await ctx.library.resolve(ctx.otherUserId, other.id);
    expect(await sync.preference(owner)).toBe("auto");
    await sync.setPreference(owner, "review");
    await sync.setPreference(ctx.otherUserId, "manual");
    result = collection(a, d, b, c);
    expect(await sync.runDue()).toBe(false);

    advance(24 * 60);
    expect(await sync.runDue()).toBe(true);
    expect(await sync.runDue()).toBe(false);
    const preview = (await sync.get(owner, playlist.id))!.preview!;
    expect(preview.added).toMatchObject([{ externalId: d, to: 2 }]);
    expect(preview.moved).toEqual([]);
    expect(await resolved(playlist.id)).toEqual(original);
    const [notice] = await sync.notices(owner);
    expect(notice).toMatchObject({
      kind: "preview",
      report: { id: preview.id },
      readAt: null,
    });
    expect(await sync.markRead(ctx.otherUserId, notice!.id)).toBe(false);
    expect(await sync.markRead(owner, notice!.id)).toBe(true);

    advance(24 * 60);
    expect(await sync.runDue()).toBe(true);
    expect(await sync.runDue()).toBe(false);
    const persisted = await new YoutubeSyncService(ctx.db).notices(owner);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.readAt).not.toBeNull();
    expect(
      (await ctx.library.resolve(ctx.otherUserId, other.id)).items,
    ).toEqual(otherOriginal.items);

    await sync.setPreference(owner, "auto");
    advance(24 * 60);
    expect(await sync.runDue()).toBe(true);
    expect(await resolved(playlist.id)).toHaveLength(4);
    expect((await sync.notices(owner)).map((item) => item.kind)).toEqual([
      "applied",
      "preview",
    ]);
  });

  it("refreshes stale previews and requires confirmation again if the candidate changed", async () => {
    const owner = ctx.userId;
    await sync.setPreference(owner, "manual");
    const playlist = await sync.create(owner, url);
    const original = await resolved(playlist.id);
    result = collection(a, d);
    const first = (await sync.check(owner, playlist.id)).preview!;
    expect(first.removed).toHaveLength(2);
    expect(await resolved(playlist.id)).toEqual(original);
    advance(24 * 60);
    result = collection(b);
    const refreshed = await sync.apply(owner, playlist.id, first.id);
    expect(refreshed.preview?.id).not.toBe(first.id);
    expect(await resolved(playlist.id)).toEqual(original);
    await expect(
      sync.apply(owner, playlist.id, first.id),
    ).rejects.toMatchObject({ status: 409 });

    await sync.apply(owner, playlist.id, refreshed.preview!.id);
    expect(await resolved(playlist.id)).toEqual([original[1]]);
    expect(await sync.notices(owner)).toEqual([]);
  });

  it("rejects invalid targets and leaves the database untouched after a failed creation", async () => {
    await expect(
      sync.create(ctx.userId, `https://youtu.be/${a}`),
    ).rejects.toMatchObject({ status: 400 });
    expect(discover).not.toHaveBeenCalled();
    result = { ...collection(a), warnings: ["Недоступен"] };
    await expect(sync.create(ctx.userId, url)).rejects.toMatchObject({
      status: 502,
    });
    expect(await ctx.db.playlist.count()).toBe(0);
    expect(await ctx.db.item.count()).toBe(0);
  });

  it("discards an older check after a newer check has published", async () => {
    const owner = ctx.userId;
    const playlist = await sync.create(owner, url);
    let pending!: (value: YoutubeCollection) => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    discover.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          pending = resolve;
          start();
        }),
    );
    const earlier = sync.check(owner, playlist.id);
    await started;
    result = collection(b, c, d);
    await sync.check(owner, playlist.id);
    pending(collection(a));
    await earlier;
    expect(
      (await sync.get(owner, playlist.id))!.snapshot.map(
        (entry) => entry.externalId,
      ),
    ).toEqual([b, c, d]);
    expect(await sync.notices(owner)).toHaveLength(1);
  });

  it("rolls back newly created records when publishing the definition fails", async () => {
    const owner = ctx.userId;
    const playlist = await sync.create(owner, url);
    const original = await resolved(playlist.id);
    await ctx.db.$executeRaw`
      CREATE TEMP TRIGGER reject_definition
      BEFORE UPDATE OF definitionJson ON Playlist
      BEGIN SELECT RAISE(ABORT, 'definition rejected'); END
    `;
    result = collection(d);

    await expect(sync.check(owner, playlist.id)).rejects.toMatchObject({
      code: "P2003",
    });
    expect(await resolved(playlist.id)).toEqual(original);
    expect(await ctx.db.source.count({ where: { externalId: d } })).toBe(0);
    expect(await ctx.db.item.count({ where: { ownerId: owner } })).toBe(3);
    expect(await sync.notices(owner)).toEqual([]);
  });

  it("cancels an in-flight scheduled check and skips publication if mode becomes manual", async () => {
    const owner = ctx.userId;
    const playlist = await sync.create(owner, url);
    const original = await resolved(playlist.id);
    const initial = await sync.get(owner, playlist.id);
    advance(24 * 60);

    const controller = new AbortController();
    let sent!: () => void;
    const called = new Promise<void>((resolve) => {
      sent = resolve;
    });
    discover.mockImplementationOnce(
      async (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          sent();
        }),
    );
    const running = sync.runDue(controller.signal);
    await called;
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect((await sync.get(owner, playlist.id))!.lastCheckedAt).toEqual(
      initial!.lastCheckedAt,
    );

    discover.mockImplementationOnce(async () => {
      await sync.setPreference(owner, "manual");
      return collection(d);
    });
    expect(await sync.runDue()).toBe(true);
    expect(await sync.runDue()).toBe(false);
    expect(await resolved(playlist.id)).toEqual(original);
    expect(await sync.notices(owner)).toEqual([]);
  });

  it("scopes local edits, linked data and settings to browser owners", async () => {
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      const id = request.headers["x-test-owner"] as string | undefined;
      request.user = id ? { id, login: id } : null;
    });
    app.setErrorHandler((error, _request, reply) => {
      reply
        .code(error instanceof HttpError ? error.status : 400)
        .send({ error });
    });
    registerYoutubeSync(app, ctx.db, ctx.library, discover);
    try {
      const { userId, otherUserId } = ctx;
      const owner = { "x-test-owner": userId };
      const other = { "x-test-owner": otherUserId };
      const created = await app.inject({
        method: "POST",
        url: "/api/youtube-sync/playlists",
        headers: owner,
        payload: { url },
      });
      expect(created.statusCode).toBe(201);
      const path = `/api/playlists/${created.json().id}/youtube-sync`;
      expect((await app.inject({ url: path, headers: other })).statusCode).toBe(
        404,
      );
      expect(
        (
          await app.inject({
            url: path,
            headers: { ...owner, authorization: "Bearer secret" },
          })
        ).statusCode,
      ).toBe(403);
      const foreign = await ctx.library.upsertYoutube(otherUserId, {
        externalId: d,
      });
      const patch = await app.inject({
        method: "PATCH",
        url: path,
        headers: owner,
        payload: { type: "add", itemId: foreign.item.id },
      });
      expect(patch.statusCode).toBe(404);
      expect(
        (await app.inject({ url: path, headers: owner })).json().link.additions,
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
