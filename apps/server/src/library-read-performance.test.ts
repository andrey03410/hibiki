import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { expect, it } from "vitest";
import { createApp } from "./app";
import { sqliteAdapter } from "./sqlite";
import { testContext } from "./test-utils";

it("reuses a current compact overview and narrows a completed search within the same library revision", async () => {
  const ctx = await testContext();
  const db = new PrismaClient({
    adapter: sqliteAdapter("file:" + join(ctx.root, "hibiki.db")), log: [{emit: "event", level: "query"}],
  });
  const queries: string[] = [];
  db.$on("query", event => queries.push(event.query));
  const app = await createApp({db, storageRoot: ctx.root});
  const headers = {cookie: "hibiki_session=" + await app.auth.createSession(ctx.userId)};
  const add = (title: string) => ctx.db.item.create({data: {id:title, ownerId:ctx.userId, title, originalTitle:title, kind:"audio"}});
  const overview = () => app.inject({url:"/api/library/overview?playlists=summary&format=compact", headers});
  const search = async (query: string) => {
    const r = await app.inject({method:"POST", url:"/api/library/page", headers, payload:{filters:{query}}});
    expect(r.statusCode).toBe(200);
    return r.json().items.map((i: {title: string}) => i.title);
  };
  try {
    await add("Wind song");
    await add("Rain song");
    const original = await overview();
    expect(original.json().total).toBe(2);
    queries.length = 0;
    expect((await overview()).json()).toEqual(original.json());
    expect(queries.some(sql => sql.includes("counts AS ("))).toBe(false);
    expect(await search("win")).toEqual(["Wind song"]);
    queries.length = 0;
    expect(await search("wind")).toEqual(["Wind song"]);
    expect(queries.find(sql => sql.includes(" AS assigned FROM Item i"))).toContain("i.id IN (SELECT value FROM json_each(?))");
    expect(await search("winter")).toEqual([]);
    await add("Winter rain");
    expect((await overview()).json().total).toBe(3);
    expect(await search("winter rain")).toEqual(["Winter rain"]);
    expect(await search("rain")).toHaveLength(2);
  } finally {
    await app.close();
    await db.$disconnect();
    await ctx.close();
  }
});
