import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { testContext, wav } from "./test-utils";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
describe("HTTP and MCP isolation", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeEach(async () => {
    ctx = await testContext();
    app = await createApp({ db: ctx.db, storageRoot: ctx.root });
  });
  afterEach(async () => {
    await app.close();
    await ctx.close();
  });
  async function session(login: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login, password: "test-password-123" },
    });
    expect(response.statusCode).toBe(200);
    return response.cookies[0].value;
  }
  it("requires authentication, rejects cross-origin writes and guards file Range access", async () => {
    expect((await app.inject("/api/library")).statusCode).toBe(401);
    const cookie = await session("listener");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/tags",
          cookies: { hibiki_session: cookie },
          headers: { origin: "https://evil.example" },
          payload: { name: "test" },
        })
      ).statusCode,
    ).toBe(403);
    const owner = await app.auth.userBySession(cookie);
    const file = join(ctx.root, "tone.wav");
    await writeFile(file, wav());
    const { item } = await ctx.library.importLocal(owner!.id, file);
    const url = item.sources[0].streamUrl!;
    expect((await app.inject(url)).statusCode).toBe(401);
    const range = await app.inject({
      url,
      cookies: { hibiki_session: cookie },
      headers: { range: "bytes=0-43" },
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.length).toBe(44);
    expect(range.headers["content-range"]).toMatch(/^bytes 0-43\//);
    const another = await session("another");
    expect(
      (await app.inject({ url, cookies: { hibiki_session: another } }))
        .statusCode,
    ).toBe(404);
  });
  it("exposes real MCP initialize/tools to a personal token and revokes it", async () => {
    const token = await app.auth.createToken(ctx.userId, "test-client");
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.serverInfo.name).toBe("hibiki");
    const tools = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(
      tools.json().result.tools.map((t: { name: string }) => t.name),
    ).toContain("playlist_preview");
    await app.auth.deleteToken(ctx.userId, token.id);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${token.token}` },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });
});
