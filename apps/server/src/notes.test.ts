import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "./app";
import { testContext } from "./test-utils";

let ctx: Awaited<ReturnType<typeof testContext>>;
let app: Awaited<ReturnType<typeof createApp>>;
let owner: string;
let other: string;
let bearer: string;

beforeEach(async () => {
  ctx = await testContext();
  app = await createApp({ db: ctx.db, storageRoot: ctx.root });
  const { auth } = app;
  owner = `hibiki_session=${await auth.createSession(ctx.userId)}`;
  other = `hibiki_session=${await auth.createSession(ctx.otherUserId)}`;
  bearer = `Bearer ${(await auth.createToken(ctx.userId, "test")).token}`;
  for (const [ownerId, key] of [[ctx.userId, "owner"], [ctx.otherUserId, "other"]] as const) {
    await ctx.db.item.create({
      data: {
        id: `${key}-item`, ownerId, title: "Track", originalTitle: "Track", kind: "audio",
        sources: { create: { id: `${key}-source`, ownerId, key: "track", provider: "youtube" } },
      },
    });
    await ctx.db.playlist.create({ data: { id: `${key}-playlist`, ownerId, title: "Set", definitionJson: '{"version":1,"rule":{"type":"items","ids":[]},"sort":"source"}' } });
    await ctx.db.tag.create({ data: { id: `${key}-tag`, ownerId, name: "Tag" } });
  }
});

afterEach(async () => {
  await app.close();
  await ctx.close();
});

it.each(["item", "source", "playlist", "tag"])("isolates %s notes by browser account", async (type) => {
  const url = `/api/notes/${type}/owner-${type}`;
  const save = (session: string, text: string | null) =>
    app.inject({ method: "PUT", url, headers: { cookie: session }, payload: { text } });
  expect((await save(owner, "Личная\nзапись")).statusCode).toBe(200);
  expect((await save(other, "Чужое изменение")).statusCode).toBe(404);
  const ownList = await app.inject({ url: "/api/notes", headers: { cookie: owner } });
  expect(ownList.headers["cache-control"]).toBe("private, no-store");
  expect(ownList.json()[type]).toEqual({ [`owner-${type}`]: "Личная\nзапись" });
  const otherList = await app.inject({ url: "/api/notes", headers: { cookie: other } });
  expect(otherList.json()[type]).toEqual({});
  expect((await save(owner, null)).statusCode).toBe(200);
  expect((await app.inject({ url: "/api/notes", headers: { cookie: owner } })).json()[type]).toEqual({});
});

it("requires a browser session even with the owner’s API token", async () => {
  expect((await app.inject({ url: "/api/notes" })).statusCode).toBe(401);
  expect((await app.inject({ url: "/api/notes", headers: { authorization: bearer } })).statusCode).toBe(403);
  expect((await app.inject({
    method: "PUT", url: "/api/notes/item/owner-item",
    headers: { cookie: owner, authorization: bearer }, payload: { text: "Token access" },
  })).statusCode).toBe(403);
});

it("keeps all note fields out of the library snapshot", async () => {
  for (const type of ["item", "source", "playlist", "tag"]) {
    const saved = await app.inject({
      method: "PUT",
      url: `/api/notes/${type}/owner-${type}`,
      headers: { cookie: owner },
      payload: { text: `Private ${type}` },
    });
    expect(saved.statusCode).toBe(200);
  }
  const response = await app.inject({ url: "/api/library", headers: { authorization: bearer } });
  expect(response.statusCode).toBe(200);
  const { items, playlists, tags } = response.json();
  expect(items[0]).not.toHaveProperty("note");
  expect(items[0].sources[0]).not.toHaveProperty("note");
  expect(playlists[0]).not.toHaveProperty("note");
  expect(tags[0]).not.toHaveProperty("note");
});

it("sets favorites only on owned records", async () => {
  const item = (id: string) => ctx.db.item.findUniqueOrThrow({ where: { id } });
  const favorite = (session: string, value: boolean) => app.inject({
    method: "PATCH", url: "/api/items/owner-item/favorite",
    headers: { cookie: session }, payload: { favorite: value },
  });
  expect((await favorite(other, true)).statusCode).toBe(404);
  expect((await item("owner-item")).favorite).toBe(false);
  expect((await favorite(owner, true)).statusCode).toBe(200);
  expect((await item("owner-item")).favorite).toBe(true);
  expect((await favorite(owner, false)).statusCode).toBe(200);
  expect((await item("owner-item")).favorite).toBe(false);
});
