import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { sqliteAdapter } from "./sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ItemDto, PlaylistDefinition, PlaylistSummaryDto, Rule } from "@hibiki/contracts";
import { createApp } from "./app";
import { hydrateLibraryItems } from "./library";
import { testContext } from "./test-utils";

let ctx: Awaited<ReturnType<typeof testContext>>;
let app: Awaited<ReturnType<typeof createApp>>;
let cookie: string;
let foreignCookie: string;
let bearer: string;

beforeEach(async () => {
  ctx = await testContext();
  app = await createApp({ db: ctx.db, storageRoot: ctx.root });
  cookie = `hibiki_session=${await app.auth.createSession(ctx.userId)}`;
  foreignCookie = `hibiki_session=${await app.auth.createSession(ctx.otherUserId)}`;
  bearer = `Bearer ${(await app.auth.createToken(ctx.userId, "fixture")).token}`;
});
afterEach(async () => {
  await app.close();
  await ctx.close();
});

const post = (path: string, payload: Record<string, unknown>, session = cookie) =>
  app.inject({ method: "POST", url: `/api/library/${path}`, payload, headers: { cookie: session } });
const overview = () => app.inject({ url: "/api/library/overview?playlists=summary", headers: { cookie } });
function track(id: string, ownerId = ctx.userId) {
  return { id, ownerId, kind: "audio", title: id, originalTitle: id, createdAt: new Date("2025-01-01T12:00:00Z") };
}

it("returns one owner's playlist and ordered, freshly explained members together", async () => {
  await ctx.db.item.createMany({ data: [track("a"), track("b"), track("other", ctx.otherUserId)] });
  const child = await ctx.library.savePlaylist(ctx.userId, { title: "Manual", definition: {
    version: 1, sort: "source", rule: { type: "items", ids: ["a", "b", "a"] }, manualOrder: ["b"],
  } });
  const detail = (id: string, headers = { cookie }) => app.inject({ url: `/api/playlists/${id}/detail`, headers });
  const first = await detail(child.id);
  expect(first.statusCode).toBe(200);
  expect(first.headers["cache-control"]).toBe("private, no-store");
  expect(first.json()).toMatchObject({
    playlist: { id: child.id, title: "Manual", definition: child.definition }, usesHistory: false,
    resolved: { total: 2, items: [{ id: "b" }, { id: "a" }], reasons: { b: ["Добавлено вручную"] }, excluded: [] },
  });
  const firstRow = await app.inject({ url: `/api/playlists/${child.id}/detail?limit=1`, headers: { cookie } });
  expect(firstRow.json()).toMatchObject({ ids: ["b", "a"], resolved: { total: 2, items: [{ id: "b" }] } });
  expect((await ctx.library.resolve(ctx.userId, child.id)).items.map(i => i.id)).toEqual(["b", "a"]);
  await expect(ctx.library.preview(ctx.userId, {
    version: 1, sort: "source", rule: { type: "favorite" }, manualOrder: ["other"],
  })).rejects.toMatchObject({ code: "invalid_playlist" });
  const rows = () => app.inject({ method: "POST", url: `/api/playlists/${child.id}/rows`, headers: { cookie },
    payload: { offset: 1, changeToken: firstRow.json().changeToken, validUntil: firstRow.json().validUntil } });
  expect((await rows()).json()).toMatchObject({ items: [{ id: "a" }] });
  const parent = await ctx.library.savePlaylist(ctx.userId, { title: "Nested", definition: {
    version: 1, sort: "source", rule: { type: "playlist", id: child.id },
  } });
  await ctx.library.savePlaylist(ctx.userId, { title: "History", definition: {
    version: 1, sort: "source", rule: { type: "history", condition: "never-started" },
  } }, child.id);
  expect((await rows()).statusCode).toBe(409);
  await ctx.db.listeningSummary.create({ data: { itemId: "b", ownerId: ctx.userId, launches: 1 } });
  expect((await detail(parent.id)).json()).toMatchObject({ usesHistory: true,
    resolved: { total: 1, items: [{ id: "a" }], reasons: { a: ["Ещё не слушал", "Плейлист «History»"] } },
  });
  expect((await detail(parent.id, { cookie: foreignCookie })).statusCode).toBe(404);
  expect((await app.inject({ url: `/api/playlists/${parent.id}/detail`, headers: { authorization: bearer } })).statusCode).toBe(403);
});

it("returns an owner's archived display names separately from the active tag directory", async () => {
  const ownerId = ctx.userId;
  await ctx.db.tag.createMany({data:[
    {id:"saved", ownerId, name:"internal.key", label:"Прежнее имя", archived:true},
    {id:"active", ownerId, name:"Текущий тег"},
    {id:"other", ownerId:ctx.otherUserId, name:"Чужой архив", archived:true},
  ]});
  const response = await overview();
  expect(response.statusCode).toBe(200);
  const result = response.json();
  expect(result.archivedTagNames).toEqual({saved:"Прежнее имя"});
  expect(result.tags.map((t:{id:string}) => t.id)).toEqual(["active"]);
});

it("pages an owned selection in stable groups of 100 and rejects stale cursors", async () => {
  const ids = Array.from({ length: 203 }, (_, n) => `a${String(n).padStart(3, "0")}`);
  await ctx.db.item.createMany({ data: [...ids.toReversed().map((id) => track(id)), track("foreign", ctx.otherUserId)] });
  const first = await post("page", { filters: {} });
  expect(first.statusCode).toBe(200);
  expect(first.headers["cache-control"]).toBe("private, no-store");
  expect(first.json().total).toBe(203);
  expect(first.json().items.map((i: ItemDto) => i.id)).toEqual(ids.slice(0, 100));
  const next = await post("page", { filters: {}, cursor: first.json().nextCursor });
  expect(next.json().items.map((i: ItemDto) => i.id)).toEqual(ids.slice(100, 200));
  const last = await post("page", { filters: {}, cursor: next.json().nextCursor });
  expect(last.json().items.map((i: ItemDto) => i.id)).toEqual(ids.slice(200));
  expect(last.json().nextCursor).toBeNull();
  expect((await post("ids", { filters: {} })).json()).toEqual({ ids });
  expect((await post("page", { filters: { favoriteOnly: true }, cursor: first.json().nextCursor })).statusCode).toBe(400);
  await ctx.db.item.update({ where: { id: ids[0] }, data: { favorite: true } });
  const stale = await post("page", { filters: {}, cursor: first.json().nextCursor });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.code).toBe("library_changed");
});

it("hydrates owned IDs in requested order, leaves gaps out, and enforces the batch limit", async () => {
  await ctx.db.item.createMany({ data: [track("a"), track("b"), track("foreign", ctx.otherUserId)] });
  const result = await post("items", { ids: ["b", "foreign", "missing", "a"] });
  expect(result.statusCode).toBe(200);
  expect(result.json().items.map((i: ItemDto) => i.id)).toEqual(["b", "a"]);
  expect((await post("items", { ids: Array(101).fill("a") })).statusCode).toBe(400);
});

it("reports whole-library tag counts and invalidates only the affected account's pages", async () => {
  await ctx.db.item.createMany({ data: [track("a"), track("b"), track("c", ctx.otherUserId)] });
  await ctx.db.tag.create({ data: { id: "t", ownerId: ctx.userId, name: "Эхо" } });
  await ctx.db.itemTag.createMany({ data: [{ itemId: "a", tagId: "t" }, { itemId: "b", tagId: "t" }] });
  const first = await overview();
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({ total: 2, tags: [{ id: "t" }], tagCounts: { t: 2 }, jobs: [], playlists: [] });
  expect(first.json()).not.toHaveProperty("items");
  const rev = async () => (await overview()).json().revision;
  let prior = first.json().revision;
  expect(prior).toEqual(expect.any(String));
  await ctx.db.item.update({ where: { id: "c" }, data: { title: "foreign edit" } });
  expect(await rev()).toBe(prior);
  for (const write of [
    () => ctx.db.item.update({ where: { id: "a" }, data: { note: "after" } }),
    () => ctx.db.source.create({ data: { id: "s", key: "copy", itemId: "a", ownerId: ctx.userId, provider: "local" } }),
    () => ctx.db.source.update({ where: { id: "s" }, data: { status: "available" } }),
    () => ctx.db.tag.update({ where: { id: "t" }, data: { name: "Шум" } }),
    () => ctx.db.itemTag.delete({ where: { itemId_tagId: { itemId: "b", tagId: "t" } } }),
  ]) {
    await write();
    const current = await rev();
    expect(current).not.toBe(prior);
    prior = current;
  }
  expect((await overview()).json().tagCounts).toEqual({ t: 1 });
});

it("combines filters, local calendar bounds, Unicode terms across private fields, and natural title order", async () => {
  const ownerId = ctx.userId;
  await ctx.db.tag.createMany({ data: [
    { id: "t", ownerId, name: "Осень" }, { id: "u", ownerId, name: "Дождь" },
  ] });
  await ctx.db.mediaFile.create({ data: { id: "file", ownerId, hash: "h", path: "unused", mime: "audio/wav", bytes: 1n, kind: "audio" } });
  for (const [id, title, createdAt, duration] of [
    ["a", "Песня 11", "2025-03-09T08:00:00Z", 30],
    ["b", "песня 2", "2025-03-10T06:59:59Z", 10],
    ["c", "Песня 1", "2025-03-10T07:00:00Z", null],
    ["d", "Песня 5", "2025-03-09T07:59:59Z", 10],
  ] as const) {
    await ctx.db.item.create({ data: {
      ...track(id), title, originalTitle: "Концерт", favorite: id !== "c", note: "Личная", createdAt: new Date(createdAt), duration,
      tags: { create: (id === "d" ? ["t"] : ["t", "u"]).map((tagId) => ({ tagId })) },
      sources: { create: [
        { ownerId, id: id + "y", key: id + "y", provider: "youtube", status: "unknown", note: "СЕКРЕТ" },
        ...(id === "c" ? [] : [{ ownerId, id: id + "l", key: id + "l", provider: "local", status: "available", fileId: "file" }]),
      ] },
    } });
  }
  await ctx.db.item.create({ data: track("empty") });
  const filters = {
    query: "КОНЦЕРТ  осЕНь личн секре пес", tagIds: ["t", "u"], favoriteOnly: true, kind: "audio",
    provider: "working-local", availability: "available", minDuration: "10", maxDuration: "30",
    addedFrom: "2025-03-09", addedThrough: "2025-03-09", sort: "title-asc",
  };
  const input = { filters, timeZone: "America/Los_Angeles" };
  const result = await post("page", input);
  expect(result.statusCode).toBe(200);
  expect(result.json().items.map((i: ItemDto) => i.id)).toEqual(["b", "a"]);
  expect(result.body).not.toContain("СЕКРЕТ");
  expect((await post("ids", input)).json()).toEqual({ ids: ["b", "a"] });
  expect((await post("ids", input, foreignCookie)).json()).toEqual({ ids: [] });
  for (const [filters, ids] of [
    [{ addedFrom: "2025-03-09", addedThrough: "2025-03-09", sort: "added-asc" }, ["a", "b"]],
    [{ availability: "unknown" }, ["c"]],
    [{ availability: "unavailable" }, ["empty"]],
    [{ tagIds: ["t", "u"], sort: "duration-desc" }, ["a", "b", "c"]],
    [{ provider: "youtube", sort: "title-desc" }, ["a", "d", "b", "c"]],
  ] as const) expect((await post("ids", { filters, timeZone: input.timeZone })).json()).toEqual({ ids });
});

it.each(["overview", "page", "ids", "items"])("keeps %s private to a browser session", async (path) => {
  const request = { method: path === "overview" ? "GET" : "POST", url: `/api/library/${path}` } as const;
  const forbidden = await app.inject({ ...request, headers: { cookie, authorization: bearer } });
  expect(forbidden.statusCode).toBe(403);
  expect(forbidden.headers["cache-control"]).toBe("private, no-store");
  expect((await app.inject(request)).statusCode).toBe(401);
});

it("requires every selected tag even when the selection exceeds SQLite's expression limit", async () => {
  await ctx.db.item.createMany({ data: [track("all"), track("partial")] });
  const tagIds = Array.from({ length: 1100 }, (_, i) => "t" + i);
  await ctx.db.tag.createMany({ data: tagIds.map((id) => ({ id, ownerId: ctx.userId, name: id })) });
  await ctx.db.itemTag.createMany({ data: [
    ...tagIds.map((tagId) => ({ itemId: "all", tagId })),
    ...tagIds.slice(1).map((tagId) => ({ itemId: "partial", tagId })),
  ] });
  const result = await post("page", { filters: { tagIds: [...tagIds, tagIds[0]] } });
  expect(result.statusCode).toBe(200);
  expect(result.json().items.map((i: ItemDto) => i.id)).toEqual(["all"]);
});

it("excludes foreign nested records even if a stored link crosses account boundaries", async () => {
  await ctx.db.item.create({ data: track("a") });
  const ownerId = ctx.otherUserId;
  await ctx.db.tag.create({ data: { id: "foreign-tag", ownerId, name: "Hidden" } });
  await ctx.db.itemTag.create({ data: { itemId: "a", tagId: "foreign-tag" } });
  await ctx.db.source.create({ data: { ownerId, itemId: "a", id: "foreign-source", key: "hidden", provider: "youtube" } });
  const response = await post("items", { ids: ["a"] });
  expect(response.json().items[0]).toMatchObject({ id: "a", sources: [], tags: [] });
});

it("asks a stale tab to reopen its workspace before reading pages or saving into another account", async () => {
  const headers = {cookie, "x-hibiki-workspace": ctx.otherUserId};
  const page = await app.inject({method:"GET",url:"/api/library/overview",headers});
  expect(page.statusCode).toBe(409);
  expect(page.json().error.code).toBe("workspace_changed");
  const save = await app.inject({method:"PUT",url:"/api/settings",headers,payload:{volume:0.123}});
  expect(save.statusCode).toBe(409);
  expect((await ctx.library.getSettings(ctx.userId)).volume).not.toBe(0.123);
});

const tagWrite = (method: "POST" | "PATCH", payload: Record<string, unknown>, id?: string, session = cookie) =>
  app.inject({ method, url: "/api/tags" + (id ? "/" + id : ""), headers: { cookie: session }, payload });
async function createTag(name: string, group: string, extra: Record<string, unknown> = {}) {
  const result = await tagWrite("POST", { name, group, ...extra });
  expect(result.statusCode, result.body).toBe(200);
  return result.json().id as string;
}
const editTrack = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: "/api/items/" + id, headers: { cookie }, payload });

it("allows homonyms only at distinct paths, rejects cycles, cross-owner parents and hierarchical flat groups", async () => {
  const anime = await createTag("Anime", "source");
  const novel = await createTag("VN", "source");
  const first = await createTag("CLANNAD", "source", { parentIds: [anime], aliases: ["  Clann  "] });
  const second = await createTag("CLANNAD", "source", { parentIds: [novel] });
  expect(second).not.toBe(first);
  expect((await tagWrite("POST", { name: " clannad ", group: "source", parentIds: [anime, novel] })).statusCode).toBe(409);
  expect((await tagWrite("PATCH", { parentIds: [first] }, anime)).statusCode).toBe(409);
  expect((await tagWrite("PATCH", { group: "artist" }, anime)).statusCode).toBe(409);
  expect((await tagWrite("POST", { name: "wrong", group: "mood", parentIds: [anime] })).statusCode).toBe(409);
  expect((await tagWrite("POST", { name: "foreign", group: "source", parentIds: [anime] }, undefined, foreignCookie)).statusCode).toBe(404);
  expect((await app.inject({ method: "DELETE", url: "/api/tags/" + anime, headers: {cookie} })).statusCode).toBe(409);
  expect((await overview()).json().tags).toContainEqual(expect.objectContaining({ id: first, name: "CLANNAD", aliases: ["Clann"], parentIds: [anime] }));
});

it("filters a DAG and counts unique tracks under text and performance independently of selected tags", async () => {
  const anime = await createTag("Аниме", "source");
  const studio = await createTag("Kyoto Animation", "source", { aliases: ["KyoAni"], parentIds: [anime] });
  const partner = await createTag("Studio Two", "source", { parentIds: [anime] });
  const work = await createTag("Work", "source", { parentIds: [studio, partner] });
  const mood = await createTag("Slow", "mood");
  const ownerId = ctx.userId;
  await ctx.db.item.createMany({ data: ["a", "b", "c", "d", "e"].map((id) => track(id)) });
  for (const [id, tagIds, performance, voices] of [
    ["a", [work, mood], "ost", []], ["b", [work], "vocal", []],
    ["c", [mood], "vocal", ["male", "female"]], ["d", [work], "vocal", ["female"]],
    ["e", [], "unknown", []],
  ] as const) expect((await editTrack(id, { tagIds, performance, voices })).statusCode).toBe(200);
  expect((await overview()).json().tagCounts).toMatchObject({ [anime]: 3, [mood]: 2 });
  for (const [filters, ids] of [
    [{ tagIds: [anime, mood] }, ["a"]],
    [{ tagIds: [anime, mood], tagMode: "or", performanceFilter: "vocal" }, ["b", "c", "d"]],
    [{ tagIds: [anime, mood], tagMode: "or", performanceFilter: "male" }, ["c"]],
    [{ performanceFilter: "female" }, ["c", "d"]], [{ performanceFilter: "ost" }, ["a"]],
    [{ query: "  KyOaNi  " }, ["a", "b", "d"]],
    [{ missingGroup: "voice" }, ["b"]], [{ missingGroup: "performance" }, ["e"]],
  ] as const) {
    const input = {filters: { ...filters, sort: "title-asc" }};
    expect((await post("ids", input)).json()).toEqual({ids});
    expect((await post("page", input)).json().items.map((i: ItemDto) => i.id)).toEqual(ids);
  }
  const counts = (await post("page", {filters: { query: "kyoani", tagIds: [mood], performanceFilter: "vocal" }})).json();
  expect(counts).toMatchObject({total: 0, tagCounts: { [anime]: 2, [mood]: 0 }});
  expect(await ctx.db.item.count({where:{ownerId}})).toBe(5);
});

it("preserves archived links when completing classification and rolls back a batch with a missing field", async () => {
  await ctx.db.item.createMany({ data: [track("a"), track("b")] });
  const legacy = await createTag("Legacy", "extra");
  expect((await editTrack("a", {tagIds: [legacy]})).statusCode).toBe(200);
  expect((await tagWrite("PATCH", {archived: true}, legacy)).statusCode).toBe(200);
  const tagIds = await Promise.all(["source", "artist", "genre", "mood"].map(group => createTag(group, group)));
  const result = await editTrack("a", {tagIds, performance: "vocal", voices: ["female"], completeClassification: true});
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().tags).toContainEqual(expect.objectContaining({ id: legacy, archived: true }));
  const playlist = await ctx.library.savePlaylist(ctx.userId, {
    title: "Legacy", definition: { version: 1, sort: "source", rule: {type: "tag", id: legacy} },
  });
  expect((await ctx.library.resolve(ctx.userId, playlist.id)).items.map(item => item.id)).toEqual(["a"]);
  expect((await overview()).json().tags.map((t: {id:string}) => t.id)).not.toContain(legacy);
  expect((await post("ids", {filters: {needsClassification:true}})).json()).toEqual({ids:["b"]});
  const batch = await app.inject({method:"POST",url:"/api/items/batch",headers:{cookie},payload:{changes:[
    {id:"a",title:"changed"}, {id:"b",tagIds,performance:"vocal",completeClassification:true},
  ]}});
  expect(batch.statusCode).toBe(422);
  expect((await ctx.library.getItem(ctx.userId, "a")).title).toBe("a");
  expect((await editTrack("a", {performance: "ost"})).json()).toMatchObject({performance:"ost",voices:[]});
});

it("rejects a stale batch preview and applies a larger reviewed selection as one transaction", async () => {
  const ids = Array.from({length: 201}, (_, i) => "item-" + i);
  await ctx.db.item.createMany({data: ids.map(id => track(id))});
  const before = (await overview()).json().revision;
  await ctx.db.item.update({where: {id:ids[0]},data:{title:"newer"}});
  const apply = (expectedRevision: string) => app.inject({method:"POST",url:"/api/items/batch", headers:{cookie},
    payload:{expectedRevision,changes:ids.map(id => ({id,performance:"ost"}))}});
  expect((await apply(before)).statusCode).toBe(409);
  expect((await ctx.library.getItem(ctx.userId,ids[1])).performance).toBe("unknown");
  const applied = await apply((await overview()).json().revision);
  expect(applied.statusCode,applied.body).toBe(200);
  expect(await ctx.db.item.count({where:{ownerId:ctx.userId,performance:"ost"}})).toBe(201);
});

it("lists lightweight playlist cards with an unknown count before the first worker pass", async () => {
  const list = await ctx.library.savePlaylist(ctx.userId, {
    title: "Первый", definition: { version: 1, sort: "source", rule: { type: "items", ids: [] } },
  });
  const cards = (await overview()).json().playlists;
  expect(cards).toMatchObject([{ id: list.id, manual: true, trackCount: null }]);
  expect(cards[0]).not.toHaveProperty("definition");
  expect((await overview()).json().playlists).toEqual(cards);
});

it("refreshes unique nested counts after rule, item and tag changes without changing playlist revisions", async () => {
  const { db, library, userId: ownerId } = ctx;
  await db.item.createMany({ data: [track("a"), { ...track("b"), kind: "video" }] });
  const tag = await library.createTag(ownerId, { name: "Море" });
  const create = (title: string, rule: Rule, id?: string) =>
    library.savePlaylist(ownerId, { title, definition: { version: 1, sort: "source", rule } }, id);
  const manual = await create("ручной", { type: "items", ids: ["a", "a"] });
  const parent = await create("общий", { type: "union", rules: [
    { type: "playlist", id: manual.id }, { type: "tag", id: tag.id },
  ] });
  const empty = await create("исключения", { type: "difference", include: { type: "playlist", id: parent.id }, exclude: { type: "items", ids: ["a", "b"] } });
  const original = await db.playlist.findUniqueOrThrow({ where: { id: parent.id } });
  const counts = async () => Object.fromEntries((await overview()).json().playlists.map(
    (p: PlaylistSummaryDto) => [p.id, p.trackCount]));
  expect(await counts()).toEqual({ [manual.id]: null, [parent.id]: null, [empty.id]: null });
  expect(await library.refreshDuePlaylistCounts()).toBe(true);
  expect(await counts()).toEqual({ [manual.id]: 1, [parent.id]: 1, [empty.id]: 0 });
  expect(await library.refreshDuePlaylistCounts()).toBe(false);
  await db.itemTag.create({ data: { itemId: "b", tagId: tag.id } });
  await library.refreshDuePlaylistCounts();
  expect(await counts()).toEqual({ [manual.id]: 1, [parent.id]: 2, [empty.id]: 0 });
  await db.itemTag.deleteMany({ where: { tagId: tag.id } });
  await create("ручной", { type: "items", ids: ["a", "b"] }, manual.id);
  await library.refreshDuePlaylistCounts();
  expect(await counts()).toEqual({ [manual.id]: 2, [parent.id]: 2, [empty.id]: 0 });
  expect(await db.playlist.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({
    revision: original.revision, updatedAt: original.updatedAt,
  });
});

it("wakes at the strict history cutoff and reacts to new listening and history cleanup", async () => {
  const { db, library, userId: ownerId } = ctx;
  const start = new Date("2026-01-01T00:00:00Z");
  await db.item.createMany({ data: [track("a"), track("b")] });
  const child = await library.savePlaylist(ownerId, { title: "давно", definition: {
    version: 1, sort: "source", rule: { type: "history", condition: "last-started-before", days: 1 },
  } });
  await library.savePlaylist(ownerId, { title: "родитель", definition: {
    version: 1, sort: "source", rule: { type: "playlist", id: child.id },
  } });
  const counts = async () => (await overview()).json().playlists.map((p: PlaylistSummaryDto) => p.trackCount);
  expect(await counts()).toEqual([null, null]);
  await db.listeningSummary.create({ data: { itemId: "a", ownerId, launches: 1, lastStartedAt: start } });
  await library.refreshDuePlaylistCounts(start);
  expect(await counts()).toEqual([0, 0]);
  const boundary = new Date(+start + 86_400_000);
  expect(await library.refreshDuePlaylistCounts(boundary)).toBe(false);
  const past = new Date(+boundary + 1);
  expect(await library.refreshDuePlaylistCounts(past)).toBe(true);
  expect(await counts()).toEqual([1, 1]);
  await db.listeningSummary.update({ where: { itemId: "a" }, data: { lastStartedAt: past } });
  expect(await library.refreshDuePlaylistCounts(past)).toBe(true);
  expect(await counts()).toEqual([0, 0]);
  await db.listeningSummary.deleteMany({ where: { ownerId } });
  expect(await library.refreshDuePlaylistCounts(past)).toBe(true);
  expect(await library.refreshDuePlaylistCounts(new Date(+past + 2 * 86_400_000))).toBe(false);
});

it("rejects stale counts if a writer changes the rules during the worker's evaluation", async () => {
  const { db, library, userId: ownerId } = ctx;
  await db.item.create({ data: track("one") });
  const manual = await library.savePlaylist(ownerId, { title: "ручной", definition: {
    version: 1, sort: "source", rule: { type: "items", ids: ["one"] },
  } });
  const readSnapshot = library.snapshot.bind(library);
  vi.spyOn(library, "snapshot").mockImplementationOnce(async owner => {
    const snapshot = await readSnapshot(owner);
    await library.savePlaylist(owner, { title: manual.title, definition: {
      version: 1, sort: "source", rule: { type: "items", ids: [] },
    } }, manual.id);
    return snapshot;
  });
  await library.refreshDuePlaylistCounts();
  expect((await overview()).json().playlists[0].trackCount).toBeNull();
  await library.refreshDuePlaylistCounts();
  expect((await overview()).json().playlists[0].trackCount).toBe(0);
  await db.listeningSummary.create({ data: { ownerId, itemId: "one", launches: 1 } });
  expect(await library.refreshDuePlaylistCounts()).toBe(false);
});

it("keeps definitions in overview responses for tabs opened before summary cards shipped", async () => {
  const definition: PlaylistDefinition = { version: 1, sort: "source", rule: { type: "items", ids: [] } };
  await ctx.library.savePlaylist(ctx.userId, { title: "Ручной", definition });
  const oldTab = await app.inject({ url: "/api/library/overview", headers: { cookie } });
  expect(oldTab.json().playlists[0].definition).toEqual(definition);
});

it("keeps unrelated counts fresh when editing a child pushes a parent beyond the depth limit", async () => {
  const { db, library, userId: ownerId } = ctx;
  await db.item.create({ data: track("a") });
  const definition = (rule: Rule): PlaylistDefinition => ({ version: 1, sort: "source", rule });
  await db.playlist.createMany({ data: Array.from({ length: 40 }, (_, i) => ({
    id: "chain-" + i, ownerId, title: "chain-" + i, definitionJson: JSON.stringify(definition(
      i === 0 ? { type: "items", ids: [] } : { type: "playlist", id: "chain-" + (i - 1) })),
  })) });
  const healthy = await library.savePlaylist(ownerId, { title: "Вся медиатека", definition: definition({ type: "filter" }) });
  const counts = async () => Object.fromEntries((await overview()).json().playlists.map(
    (p: PlaylistSummaryDto) => [p.id, p.trackCount]));
  await library.refreshDuePlaylistCounts();
  expect(await counts()).toMatchObject({ "chain-39": 0, [healthy.id]: 1 });
  await library.savePlaylist(ownerId, { title: "Нижний", definition: definition({
    type: "union", rules: [{ type: "items", ids: ["a"] }] }),
  }, "chain-0");
  await db.item.create({ data: track("b") });
  await library.refreshDuePlaylistCounts();
  expect(await counts()).toMatchObject({ "chain-38": 1, "chain-39": null, [healthy.id]: 2 });
  expect(await library.refreshDuePlaylistCounts()).toBe(false);
  await library.savePlaylist(ownerId, { title: "Нижний", definition: definition({ type: "items", ids: ["b"] }) }, "chain-0");
  await library.refreshDuePlaylistCounts();
  expect(await counts()).toMatchObject({ "chain-39": 1, [healthy.id]: 2 });
});

it.each(["{", "{}"])("isolates an unreadable stored definition and its parents until repaired (%s)", async json => {
  const { db, library, userId: ownerId } = ctx;
  const definition: PlaylistDefinition = { version: 1, sort: "source", rule: { type: "filter" } };
  const good = await library.savePlaylist(ownerId, { title: "Обычный", definition });
  const bad = await library.savePlaylist(ownerId, { title: "Испорченный", definition });
  const parent = await library.savePlaylist(ownerId, { title: "Родитель", definition: {
    ...definition, rule: { type: "playlist", id: bad.id },
  } });
  const counts = async () => Object.fromEntries((await overview()).json().playlists.map(
    (p: PlaylistSummaryDto) => [p.id, p.trackCount]));
  await library.refreshDuePlaylistCounts();
  expect(await counts()).toEqual({ [good.id]: 0, [bad.id]: 0, [parent.id]: 0 });
  await db.playlist.update({ where: { id: bad.id }, data: { definitionJson: json } });
  await db.item.create({ data: track("a") });
  await library.refreshDuePlaylistCounts();
  expect(await counts()).toEqual({ [good.id]: 1, [bad.id]: null, [parent.id]: null });
  await db.playlist.update({ where: { id: bad.id }, data: { definitionJson: JSON.stringify(definition) } });
  await library.refreshDuePlaylistCounts();
  expect(await counts()).toEqual({ [good.id]: 1, [bad.id]: 1, [parent.id]: 1 });
});

it("serves card-sized URLs for cover candidates published before the artwork upgrade", async () => {
  const { db, library, userId } = ctx;
  const playlist = await library.savePlaylist(userId, { title: "Старые обложки", definition: {
    version: 1, sort: "source", rule: { type: "items", ids: [] },
  } });
  await db.playlist.update({ where: { id: playlist.id }, data: { coverUrlsJson: JSON.stringify([
    "/api/items/old-file/artwork?size=thumb", "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg",
  ]) } });
  expect((await overview()).json().playlists).toMatchObject([{ id: playlist.id, coverUrls: [
    "/api/items/old-file/artwork?size=cover", "https://i.ytimg.com/vi/abcdefghijk/sddefault.jpg",
  ] }]);
});

it("publishes bounded cover candidates with card counts and refreshes them after source changes", async () => {
  const { db, library, userId: ownerId } = ctx;
  await db.item.createMany({ data: ["a", "b", "c", "d"].map(id => track(id)) });
  await db.source.createMany({ data: ["a", "b", "c", "d"].map(id => ({
    id: "source-" + id, key: "youtube:" + id, ownerId, itemId: id, provider: "youtube",
    externalId: id.repeat(11), status: "available", thumbnail: "https://i.ytimg.com/vi/" + id.repeat(11) + "/hqdefault.jpg",
  })) });
  const playlist = await library.savePlaylist(ownerId, { title: "Обложки", definition: {
    version: 1, sort: "source", rule: { type: "items", ids: ["d", "c", "b", "a"] },
  } });
  const summary = async () => (await overview()).json().playlists.find((card: PlaylistSummaryDto) => card.id === playlist.id);
  await library.refreshDuePlaylistCounts();
  const urls = (order: string) => [...order].map(id => "https://i.ytimg.com/vi/" + id.repeat(11) + "/sddefault.jpg");
  expect(await summary()).toMatchObject({ trackCount: 4, coverUrls: urls("dcb") });
  await db.source.delete({ where: { id: "source-d" } });
  await library.refreshDuePlaylistCounts();
  expect(await summary()).toMatchObject({ trackCount: 4, coverUrls: urls("cba") });
});

it("starts with a bounded payload, keeps owned queue order, and reads edits before the next worker pass", async () => {
  const { db, library, userId: ownerId } = ctx;
  const ids = Array.from({ length: 120 }, (_, i) => "track-" + i);
  await db.item.createMany({ data: ids.map(id => track(id)) });
  const child = await library.savePlaylist(ownerId, { title: "Исходный", definition: {
    version: 1, sort: "source", rule: { type: "items", ids },
  } });
  const parent = await library.savePlaylist(ownerId, { title: "Составной", definition: {
    version: 1, sort: "source", rule: { type: "playlist", id: child.id },
  } });
  const url = `/api/playlists/${parent.id}/playback`;
  const start = () => app.inject({ url, headers: { cookie } });
  for (const cached of [false, true]) {
    if (cached) await library.refreshDuePlaylistCounts();
    const result = await start();
    expect(result.statusCode, result.body).toBe(200);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    const payload = result.json();
    expect(Object.keys(payload).sort()).toEqual(["ids", "items"]);
    expect(payload.ids).toEqual(ids);
    expect(payload.items.map((item: ItemDto) => item.id)).toEqual(ids.slice(0, 8));
  }
  await library.savePlaylist(ownerId, { title: child.title, definition: {
    ...child.definition, rule: { type: "items", ids: [ids[119]!, ids[0]!] },
  } }, child.id);
  expect((await start()).json().ids).toEqual([ids[119], ids[0]]);
  await library.savePlaylist(ownerId, { title: child.title, definition: {
    ...child.definition, rule: { type: "items", ids: [] },
  } }, child.id);
  expect((await start()).json()).toEqual({ ids: [], items: [] });
  expect((await app.inject({ url, headers: { cookie: foreignCookie } })).statusCode).toBe(404);
  expect((await app.inject({ url, headers: { authorization: bearer } })).statusCode).toBe(403);
});

it("uses the current history cutoff even if the worker has not refreshed its playlist yet", async () => {
  const { db, library, userId: ownerId } = ctx;
  const now = new Date("2026-11-23T12:00:00.000Z");
  await db.item.create({ data: track("a") });
  await db.listeningSummary.create({ data: { itemId: "a", ownerId, launches: 1, lastStartedAt: new Date(+now - 86400000) } });
  const list = await library.savePlaylist(ownerId, { title: "Давние", definition: {
    version: 1, sort: "last-started", rule: { type: "history", condition: "last-started-before", days: 1 },
  } });
  await library.refreshDuePlaylistCounts(now);
  const start = () => app.inject({ url: `/api/playlists/${list.id}/playback`, headers: { cookie } });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(now);
    expect((await start()).json().ids).toEqual([]);
    vi.setSystemTime(new Date(+now + 1));
    expect((await start()).json().ids).toEqual(["a"]);
  } finally {
    vi.useRealTimers();
  }
});

it("ranks by owned completions and last actual start, including private text and independent tag facets", async () => {
  const ownerId = ctx.userId;
  await ctx.db.item.createMany({ data: ["a", "b", "c", "d", "e"].map(id => ({ ...track(id), note: "Личное" })) });
  await ctx.db.tag.createMany({ data: ["one", "two"].map(id => ({ id, name: id, ownerId })) });
  await ctx.db.itemTag.createMany({ data: ["a", "b", "c", "e"].map(itemId => ({ itemId, tagId: "one" })).concat({itemId: "d", tagId: "two"}) });
  const started = new Date("2025-01-02");
  await ctx.db.listeningSummary.createMany({ data: [
    { ownerId, itemId: "b", completed: 2, lastStartedAt: started },
    { ownerId, itemId: "a", completed: 2, lastStartedAt: started },
    { ownerId, itemId: "d", completed: 0, launches: 15, lastStartedAt: new Date("2025-01-03") },
    { ownerId, itemId: "e", completed: 0, lastStartedAt: started },
    { ownerId: ctx.otherUserId, itemId: "c", completed: 10, lastStartedAt: started },
  ] });
  const ranked = await post("page", { filters: { sort: "popular" } });
  expect(ranked.statusCode, ranked.body).toBe(200);
  expect(ranked.json().items.map((i: ItemDto) => i.id)).toEqual(["a", "b", "d", "e", "c"]);
  const filters = { sort: "recent", query: "ЛИЧН", tagIds: ["one"] };
  const first = await post("page", { filters });
  expect(first.json()).toMatchObject({ total: 3, tagCounts: { one: 3, two: 1 }, selectionId: expect.any(String) });
  expect(first.json().items.map((i: ItemDto) => i.id)).toEqual(["a", "b", "e"]);
  const selectionId = first.json().selectionId;
  expect((await post("ids", {filters, selectionId})).json()).toEqual({ ids: ["a", "b", "e"] });
  for (const response of [
    await post("ids", {filters, selectionId}, foreignCookie),
    await post("ids", {filters: { ...filters, query: "" }, selectionId}),
    await post("ids", {filters, selectionId: "unknown"}),
  ]) {
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe("library_changed");
  }
  const plain = await post("page", { filters: { sort: "recent" } });
  expect(plain.json().items.map((i: ItemDto) => i.id)).toEqual(["d", "a", "b", "e"]);
});

it.each(["popular", "recent", "random"])("keeps one %s order across three pages and the queue until invalidated", async sort => {
  const ids = Array.from({ length: 203 }, (_, n) => "song-" + String(n).padStart(3, "0"));
  const ownerId = ctx.userId;
  await ctx.db.item.createMany({ data: ids.toReversed().map(id => track(id)) });
  await ctx.db.listeningSummary.createMany({data: ids.map(itemId => ({ownerId, itemId, lastStartedAt: new Date("2025-01-01")}))});
  const filters = {sort, randomSeed: "fixture"};
  const first = await post("page", {filters});
  expect(first.statusCode, first.body).toBe(200);
  const selectionId = first.json().selectionId;
  expect(selectionId).toEqual(expect.any(String));
  await ctx.db.listeningSummary.update({where: {itemId: ids[202]!}, data: {completed: 99, lastStartedAt: new Date("2025-02-01")}});
  const second = await post("page", {filters, cursor: first.json().nextCursor});
  const third = await post("page", {filters, cursor: second.json().nextCursor});
  expect(second.json().selectionId).toBe(selectionId);
  expect(third.json()).toMatchObject({selectionId, nextCursor: null, total: 203});
  const displayed = [first, second, third].flatMap(page => page.json().items.map((i: ItemDto) => i.id));
  expect(displayed.toSorted()).toEqual(ids);
  expect((await post("ids", {filters, selectionId})).json().ids).toEqual(displayed);
  expect((await post("page", {filters, selectionId})).json().items).toEqual(first.json().items);
  const fresh = (await post("page", {filters})).json().items.map((i: ItemDto) => i.id);
  if (sort === "random") {
    expect(displayed).not.toEqual(ids);
    expect(fresh).toEqual(displayed.slice(0, 100));
    const again = (await post("page", {filters: {...filters, randomSeed: "new"}})).json();
    expect(again.items.map((i: ItemDto) => i.id)).not.toEqual(fresh);
  } else {
    expect(displayed).toEqual(ids);
    expect(fresh[0]).toBe(ids[202]);
    const beforeReset = (await overview()).json().revision;
    const reset = await app.inject({method: "POST", url: "/api/history/reset", headers: {cookie}, payload: {confirm: true}});
    expect(reset.statusCode, reset.body).toBe(200);
    expect((await overview()).json().revision).not.toBe(beforeReset);
    expect((await post("page", {filters, cursor: first.json().nextCursor})).statusCode).toBe(409);
    expect((await post("ids", {filters, selectionId})).json().error.code).toBe("library_changed");
    expect((await post("page", { filters: { sort: "recent" } })).json().total).toBe(0);
  }
  const beforeDelete = (await post("page", { filters: {sort: "popular"} })).json();
  await ctx.db.item.delete({where: {id: ids[0]!}});
  expect((await post("ids", {filters: {sort: "popular"}, selectionId: beforeDelete.selectionId})).statusCode).toBe(409);
});

it("expires a snapshot without reinterpreting its offset against the latest listening history", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const filters = {sort: "recent"};
    const first = await post("page", {filters});
    expect(first.statusCode, first.body).toBe(200);
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const stale = await post("ids", {filters, selectionId: first.json().selectionId});
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("library_changed");
  } finally { vi.useRealTimers(); }
});

it("keeps personal orders out of the MCP tool schema and rejects them at invocation", async () => {
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "library-search-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), {
      requestInit: { headers: { authorization: bearer } },
    }));
    const schema = (await client.listTools()).tools.find(tool => tool.name === "media_list")!.inputSchema;
    expect(schema.properties).not.toHaveProperty("randomSeed");
    for (const sort of ["recent", "popular", "random"]) {
      expect(schema.properties?.sort).toHaveProperty("enum", expect.not.arrayContaining([sort]));
      expect((await client.callTool({ name: "media_list", arguments: { sort } })).isError).toBe(true);
    }
  } finally {
    await client.close();
  }
});

it("preserves recent results through journal cleanup and recording opt-out", async () => {
  const at = Date.now() - 3600_000;
  await ctx.db.item.createMany({ data: ["a", "b"].map(id => ({ ...track(id), duration: 30 })) });
  const history = (url: string, payload: Record<string, unknown>, method: "POST" | "PUT" = "POST") =>
    app.inject({ method, url: "/api/history/" + url, headers: { cookie }, payload });
  const record = (itemId: string, start: number) => history("attempts", {
    id: start + "." + randomUUID(), ownerId: ctx.userId, itemId, trigger: "manual", reason: "ended",
    endedAt: new Date(start + 30_000).toISOString(), listened: 30, covered: 30, seeks: 0,
  });
  expect((await record("a", at)).json().recorded).toBe(true);
  const filters = { sort: "recent" };
  const open = (await post("page", { filters })).json();
  const preview = (await history("cleanup/preview", { to: new Date().toISOString() })).json();
  expect((await history("cleanup/confirm", { token: preview.token })).json()).toEqual({ deleted: 1 });
  expect((await history("preference", { enabled: false }, "PUT")).json().enabled).toBe(false);
  expect((await record("b", at + 60_000)).json().recorded).toBe(false);
  expect((await post("ids", { filters, selectionId: open.selectionId })).json()).toEqual({ ids: ["a"] });
  expect((await post("page", { filters })).json().items.map((i: ItemDto) => i.id)).toEqual(["a"]);
});

it("stops the current text search between batches when its HTTP client disconnects", async () => {
  await ctx.db.item.createMany({ data: Array.from({length: 4096}, (_, n) => track("song-" + n)) });
  const db = new PrismaClient({
    adapter: sqliteAdapter("file:" + join(ctx.root, "hibiki.db")), log: [{emit: "event", level: "query"}],
  });
  const server = await createApp({db, storageRoot: ctx.root});
  const controller = new AbortController();
  let finish!: (sql: string) => void;
  const transaction = new Promise<string>(resolve => { finish = resolve; });
  let batches = 0;
  db.$on("query", event => {
    if (event.query.includes(" AS assigned FROM Item i")) {
      batches++;
      if (batches === 1) controller.abort();
    }
    if (batches && /ROLLBACK|COMMIT/.test(event.query)) finish(event.query);
  });
  try {
    const base = await server.listen({host: "127.0.0.1", port: 0});
    const response = fetch(base + "/api/library/page", {
      method: "POST", headers: {cookie, "content-type": "application/json"},
      body: JSON.stringify({filters: {query: "song"}}), signal: controller.signal,
    });
    await expect(response).rejects.toHaveProperty("name", "AbortError");
    expect(await transaction).toBe("ROLLBACK");
    expect(batches).toBeLessThan(16);
  } finally {
    await server.close();
    await db.$disconnect();
  }
});

it("conditionally reads the overview after changes by other writers", async () => {
  const conditional = (token: string) => app.inject({ url: "/api/library/overview?playlists=summary&since=" + token, headers: {cookie} });
  let token = (await overview()).json().overviewToken;
  for (const write of [
    () => ctx.db.item.create({data: track("new")}),
    () => ctx.library.savePlaylist(ctx.userId, { title: "New", definition: {version: 1, sort: "source", rule: {type: "favorite"}} }),
    () => ctx.db.job.create({data:{id:"test-job",ownerId:ctx.userId,kind:"test",inputJson:"{}"}}),
  ]) {
    expect((await conditional(token)).statusCode).toBe(204);
    await write();
    const result = await conditional(token);
    expect(result.statusCode).toBe(200);
    expect(result.json().overviewToken).not.toBe(token);
    token = result.json().overviewToken;
  }
  expect((await conditional(token)).body).toBe("");
});

it("preserves the complete library projection and owner checks in a playlist or search window", async () => {
  const { db, library, userId: ownerId, otherUserId } = ctx;
  const ids = Array.from({ length: 105 }, (_, i) => `row-${i}`);
  await db.item.createMany({ data: ids.map(id => ({...track(id), note: "private", favorite: true})) });
  await db.item.create({data: track("foreign-item", otherUserId)});
  await db.tag.createMany({ data: [
    {id: "tag-z", ownerId, name: "old", label: "Алиас", archived: true, aliases: '["Alias"]', parentIds: '["tag-a"]'},
    {id: "tag-a", ownerId, name: "Родитель", legacyFlat: true}, {id: "tag-x", ownerId: otherUserId, name: "Чужой"},
  ] });
  await db.itemTag.createMany({data: ["tag-z", "tag-a", "tag-x"].map(tagId => ({itemId: ids[0]!, tagId}))});
  const file = { ownerId, id: "music", hash: "a".repeat(64), path: "unused", mime: "audio/mpeg", kind: "audio",
    bytes: 2048n, hintsVersion: 1, audioStart: 13n, tailStart: 120n, hasAudio: true };
  await db.mediaFile.createMany({data: [file, {...file, id: "foreign-file", ownerId: otherUserId}]});
  const source = {itemId: ids[0]!, ownerId, provider: "local", status: "available"};
  await db.source.createMany({data: [
    {...source, id: "s-z", key: "linked", provider: "youtube", externalId: "abcdefghijk", thumbnail: "image"},
    {...source, id: "s-a", key: "local", fileId: file.id},
    {...source, id: "s-foreign-file", key: "wrong-file", fileId: "foreign-file"},
    {...source, id: "s-foreign", key: "foreign", ownerId: otherUserId},
    {...source, itemId: ids[1]!, id: "plain", key: "plain", fileId: file.id},
    {...source, itemId: ids[2]!, id: "attached", key: "attached", fileId: file.id},
    {...source, itemId: ids[3]!, id: "detached", key: "detached", fileId: "foreign-file"},
  ]});
  await db.itemTag.createMany({data: ["tag-a", "tag-z", "tag-x"].map(tagId => ({itemId: ids[1]!, tagId}))});
  await db.visualTrack.create({data: {id: "clip", ownerId, signature: "test", fileId: file.id, duration: 8}});
  await db.itemVisual.create({data: {itemId: ids[2]!, soundSourceId: "attached", soundFileId: file.id, visualTrackId: "clip"}});
  const list = await library.savePlaylist(ownerId, {title: "Window", definition: {version: 1, sort: "source", rule: {type: "items", ids}}});
  const expected = (await library.resolve(ownerId, list.id)).items;
  expect(expected[0]?.sources.map(s => s.id).sort()).toEqual(["s-a", "s-z"]);
  expect(expected[0]?.tags.map(t => t.id)).toEqual(["tag-a", "tag-z"]);
  expect(expected[1]?.sources[0]).toMatchObject({bytes: 2048, hasAudio: true, hash: file.hash});
  expect(expected[2]?.visual?.soundSourceId).toBe("attached");
  expect(expected[3]?.sources).toEqual([]);
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
  expect(wire((await library.playlistDetail(ownerId, list.id, true, 24)).resolved.items)).toEqual(wire(expected.slice(0,24)));
  const small = await db.$transaction(tx => hydrateLibraryItems(tx, ownerId, ids.slice(0, 8), true, library));
  expect(wire((await library.playlistPlayback(ownerId, list.id)).items)).toEqual(wire(small));
  const duplicates = [ids[2]!, "foreign-item", ids[1]!, ids[2]!, "missing"];
  const previous = await db.$transaction(tx => hydrateLibraryItems(tx, ownerId, duplicates, true, library));
  expect((await post("items", {ids: duplicates})).json().items).toEqual(wire(previous));
  const first = (await post("page", { filters: {} })).json().items as ItemDto[];
  expect(first).toHaveLength(100);
  const byId = new Map(expected.map(item => [item.id, item]));
  expect(first).toEqual(wire(first.map(item => byId.get(item.id))));
});

it("reuses counts across tag choices and sends compact cards with playback metadata", async () => {
  const ownerId = ctx.userId;
  await ctx.db.item.create({data:track("entry")});
  await ctx.db.tag.create({data:{id:"tag",name:"Genre",ownerId}});
  await ctx.db.itemTag.create({data:{itemId:"entry",tagId:"tag"}});
  const file = await ctx.db.mediaFile.create({data:{id:"owned-file", ownerId, hash:"a".repeat(64), path:"unused", mime:"audio/wav", kind:"audio", bytes:100n}});
  await ctx.db.source.create({data:{id:"source", key:"local", ownerId,itemId:"entry",fileId:file.id, provider:"local", status:"available"}});
  const first = (await post("page", {filters:{},cards:true})).json();
  expect(first.countsKey).toEqual(expect.any(String));
  expect(first.items[0]).toMatchObject({id:"entry",tagRefs:["tag"]});
  expect(first.items[0]).not.toHaveProperty("tags");
  const next = (await post("page", {filters:{tagIds:["tag"]},cards:true,countsKey:first.countsKey})).json();
  expect(next.countsUnchanged).toBe(true);
  expect(next).not.toHaveProperty("tagCounts");
  const directory = (await overview()).json();
  const cardPage = (await post("page", {filters:{},cards:true,tagRevision:directory.revision,countsKey:directory.countsKey})).json();
  expect(cardPage).toMatchObject({countsUnchanged:true, tags:[], items:[{tagRefs:[0], sources:[{id:"source", bytes:100, streamUrl:"/files/owned-file", mime:"audio/wav"}]}]});
  expect(cardPage.items[0].sources[0]).not.toHaveProperty("hash");
  expect(cardPage.items[0].sources[0]).not.toHaveProperty("fileId");
  const narrowed = (await post("page", {filters:{query:"absent"},cards:true,countsKey:first.countsKey})).json();
  expect(narrowed.tagCounts).toEqual({tag:0});
});

it("reconstructs the compact directory and its indexed counts including legacy and archived tags", async () => {
  await ctx.db.tag.createMany({data:[
    {id:"old", ownerId:ctx.userId, name:"Архив", archived:true},
    {id:"p", ownerId:ctx.userId, name:"Студия", group:"source", aliases:JSON.stringify(["Мастерская"])},
    {id:"c", ownerId:ctx.userId, name:"Работа", group:"source", parentIds:JSON.stringify(["p","old"]), legacyFlat:true},
    {id:"unused", ownerId:ctx.userId, name:"Не используется"},
    {id:"foreign", ownerId:ctx.otherUserId, name:"Чужой"},
  ]});
  await ctx.db.item.create({data:{...track("song"),tags:{create:{tagId:"c"}}}});
  const full = (await overview()).json();
  const result = await app.inject({url:"/api/library/overview?playlists=summary&format=compact",headers:{cookie}});
  const compact = result.json();
  expect(compact.directory).toHaveLength(3);
  const {validateOverview} = await import("../../web/src/library-pages");
  expect(validateOverview(compact)).toEqual(full);
  expect(compact.archivedTagNames).toEqual({old:"Архив"});
  const body = {filters:{query:"мастЕрскАЯ"}, cards:true, indexedCounts:true, tagRevision:full.revision};
  const page = (await post("page",body)).json();
  expect(page.items.map((item: {id:string}) => item.id)).toEqual(["song"]);
  expect(page.countsByIndex).toEqual(full.tags.map((tag:{id:string}) => full.tagCounts[tag.id]));
  expect(page.tagCounts).toBeUndefined();
  const stale = (await post("page",{...body,tagRevision:"stale"})).json();
  expect(stale.tagCounts).toEqual(full.tagCounts);
  expect(stale.countsByIndex).toBeUndefined();
});
