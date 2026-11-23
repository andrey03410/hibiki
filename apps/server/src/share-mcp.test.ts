import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobDto, ShareLinkDto } from "@hibiki/contracts";
import { createApp } from "./app";
import { testContext, wav } from "./test-utils";

describe("sharing through MCP and the copy worker", () => {
  let context: Awaited<ReturnType<typeof testContext>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let base: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    context = await testContext();
    app = await createApp({ db: context.db, storageRoot: context.root });
    base = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
    await app.close();
    await context.close();
  });

  async function connect(id: string) {
    const { token } = await app.auth.createToken(id, "share-test");
    const client = new Client({ name: "share-test", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return client;
  }

  async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { text: string }[];
    return { error: result.isError === true, data: JSON.parse(content[0].text) as T };
  }

  it("manages a link across accounts and preserves an explicitly copied file after revoke", async () => {
    const author = await connect(context.userId);
    const viewer = await connect(context.otherUserId);
    const names = (await author.listTools()).tools.map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining([
      "share_create", "share_list", "share_set_expiry", "share_revoke", "share_open", "share_save", "share_copy",
    ]));
    const path = join(context.root, "sample.wav");
    await writeFile(path, wav());
    const { item } = await context.library.importLocal(context.userId, path);
    const created = await call<ShareLinkDto>(author, "share_create", { kind: "item", targetId: item.id });
    expect(created.error).toBe(false);
    const link = created.data;
    expect(link.url).toMatch(/\/share\/[\w-]+$/);
    expect(link.expiresAt).toBeNull();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    expect((await call<ShareLinkDto>(author, "share_set_expiry", { id: link.id, expiresAt })).data)
      .toMatchObject({ id: link.id, url: link.url, expiresAt });
    expect((await call(viewer, "share_revoke", { id: link.id })).error).toBe(true);
    expect((await call(viewer, "share_open", { url: link.url })).data)
      .toMatchObject({ kind: "item", sharedBy: "alice" });
    const saved = await call<{ id: string }>(viewer, "share_save", { url: link.url });
    expect(saved.error).toBe(false);
    expect(await context.db.mediaFile.count({ where: { ownerId: context.otherUserId } })).toBe(0);

    const copy = await call<JobDto>(viewer, "share_copy", { itemId: saved.data.id });
    expect(copy.error).toBe(false);
    expect(copy.data.kind).toBe("shared-copy");
    expect(await app.jobs.runOnce()).toBe(true);
    expect(await app.jobs.get(context.otherUserId, copy.data.id)).toMatchObject({ state: "done" });
    expect((await call(author, "share_revoke", { id: link.id })).error).toBe(false);
    expect((await call(viewer, "share_open", { url: link.url })).error).toBe(true);
    const own = (await context.library.getItem(context.otherUserId, saved.data.id)).sources.find(source => source.fileId && !source.shared);
    expect(own?.hash).toBe(item.sources[0].hash);
    const session = await app.auth.createSession(context.otherUserId);
    const media = await app.inject({ url: own!.streamUrl!, cookies: { hibiki_session: session }, headers: { range: "bytes=0-43" } });
    expect(media.statusCode).toBe(206);
    expect(media.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
  });

  it("rechecks queued copies against revoked links before creating a file", async () => {
    const path = join(context.root, "queued.wav");
    await writeFile(path, wav());
    const { item } = await context.library.importLocal(context.userId, path);
    const author = await connect(context.userId);
    const viewer = await connect(context.otherUserId);
    const { data: link } = await call<ShareLinkDto>(author, "share_create", { kind: "item", targetId: item.id });
    const { data: saved } = await call<{ id: string }>(viewer, "share_save", { url: link.url });
    const { data: copy } = await call<JobDto>(viewer, "share_copy", { itemId: saved.id });
    await call(author, "share_revoke", { id: link.id });
    expect(await app.jobs.runOnce()).toBe(true);
    expect(await app.jobs.get(context.otherUserId, copy.id)).toMatchObject({ state: "failed" });
    expect(await context.db.mediaFile.count({ where: { ownerId: context.otherUserId } })).toBe(0);
  });

  it("reuses recipient storage on a repeated explicit copy", async () => {
    const path = join(context.root, "deduplicated.wav");
    await writeFile(path, wav());
    const [author, viewer] = await Promise.all([connect(context.userId), connect(context.otherUserId)]);
    const { item } = await context.library.importLocal(context.userId, path);
    const { data: link } = await call<ShareLinkDto>(author, "share_create", { kind: "item", targetId: item.id });
    const { data: saved } = await call<{ id: string }>(viewer, "share_save", { url: link.url });
    const cookie = await app.auth.createSession(context.otherUserId);
    for (let index = 0; index < 2; index++) {
      const res = await app.inject({ method: "POST", url: `/api/items/${saved.id}/shared-copy`, cookies: { hibiki_session: cookie }, payload: {} });
      expect(res.statusCode).toBe(200);
      await app.jobs.runOnce();
      expect(await app.jobs.get(context.otherUserId, res.json().id)).toMatchObject({ state: "done", result: { reused: index > 0 } });
    }
    expect(await context.db.mediaFile.count({ where: { ownerId: context.otherUserId } })).toBe(1);
  });
});
