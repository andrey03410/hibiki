import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { createApp } from "./app";
import { testContext } from "./test-utils";

it("cleans only the token owner's applied import archives and shares the estimate with HTTP", async () => {
  const ctx = await testContext();
  const app = await createApp({ db: ctx.db, storageRoot: ctx.root });
  const client = new Client({ name: "storage-test", version: "1" });
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const { token } = await app.auth.createToken(ctx.userId, "storage-test");
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    const tools = (await client.listTools()).tools;
    expect(tools.find(t => t.name === "storage_cleanup")?.annotations?.destructiveHint).toBe(true);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const exported = await app.jobs.create(ctx.userId, "export", { includeFiles: false });
    await app.jobs.runOnce();
    const archive = await app.jobs.exportPath(ctx.userId, exported.id);
    const size = (await stat(archive)).size;
    const prepareLegacy = async (ownerId: string) => {
      const preview = await app.jobs.create(ownerId, "import", { archivePath: archive }, true);
      await app.jobs.runOnce();
      const input = await ctx.db.job.findUniqueOrThrow({ where: { id: preview.id } });
      // This completed apply predates automatic cleanup and shares the preview archive.
      await ctx.db.job.create({ data: { id: randomUUID(), kind: "import", ownerId, browserOnly: true, state: "done",
        inputJson: JSON.stringify({ ...JSON.parse(input.inputJson), apply: true, previewJobId: preview.id }),
      } });
      return join(ctx.root, "jobs", preview.id, "input.zip");
    };
    const ownPath = await prepareLegacy(ctx.userId);
    const otherPath = await prepareLegacy(ctx.otherUserId);
    const cookies = { hibiki_session: await app.auth.createSession(ctx.userId) };
    const info = await app.inject({ url: "/api/storage", cookies });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ importBytes: size, exportBytes: size, cleanable: { count: 1, bytes: size } });
    const result = await call("storage_usage");
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(info.json());
    expect((await call("storage_cleanup", { confirm: false })).isError).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/storage/cleanup", cookies,
      payload: { confirm: true, ownerId: ctx.otherUserId } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/storage" })).statusCode).toBe(401);
    const removed = await call("storage_cleanup", { confirm: true });
    expect(JSON.parse((removed.content as { text: string }[])[0].text)).toEqual({ count: 1, bytes: size, failedCount: 0 });
    await expect(stat(ownPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(otherPath)).size).toBe(size);
    expect((await stat(archive)).size).toBe(size);
    const again = await app.inject({ method: "POST", url: "/api/storage/cleanup", cookies, payload: { confirm: true } });
    expect(again.json()).toEqual({ count: 0, bytes: 0, failedCount: 0 });
  } finally {
    await client.close();
    await app.close();
    await ctx.close();
  }
});
