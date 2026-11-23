import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ItemDto, PlaylistDefinition, PlaylistSummaryDto, Rule } from "@hibiki/contracts";
import { createApp } from "./app";
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
