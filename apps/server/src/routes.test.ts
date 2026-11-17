import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { testContext, wav } from "./test-utils";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exportLibrary, inspectArchive, applyArchive } from "./portability";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
function multipartBody(filename: string, bytes: Buffer) {
  return Buffer.concat([
    Buffer.from(
      `--hibiki-boundary\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from("\r\n--hibiki-boundary--\r\n"),
  ]);
}
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
  it("restores real bytes and Range access when reuploading an original after metadata-only transfer", async () => {
    const input = join(ctx.root, "original.wav");
    await writeFile(input, wav());
    await ctx.library.importLocal(ctx.userId, input);
    const archive = join(ctx.root, "metadata.zip");
    await exportLibrary(ctx.db, ctx.userId, ctx.root, archive, {
      includeFiles: false,
    });
    const checked = await inspectArchive(archive, join(ctx.root, "checked"));
    const cookie = await session("restored");
    const owner = (await app.auth.userBySession(cookie))!;
    await applyArchive(ctx.db, owner.id, ctx.root, checked);
    const before = (await ctx.library.snapshot(owner.id)).items[0]!;
    const imported = await ctx.library.importLocal(owner.id, input);
    expect(imported.item.id).toBe(before.id);
    expect(imported.item.sources[0]!.fileId).toBe(before.sources[0]!.fileId);
    expect((await ctx.library.snapshot(owner.id)).items).toHaveLength(1);
    const response = await app.inject({
      url: imported.item.sources[0]!.streamUrl!,
      cookies: { hibiki_session: cookie },
      headers: { range: "bytes=0-43" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.rawPayload).toEqual(wav().subarray(0, 44));
  });

  it("keeps the multipart filename fallback and prefers embedded metadata", async () => {
    const cookie = await session("uploads");
    const upload = async (filename: string, bytes: Buffer) =>
      app.inject({
        method: "POST",
        url: "/api/items/upload",
        cookies: { hibiki_session: cookie },
        headers: {
          "content-type": "multipart/form-data; boundary=hibiki-boundary",
        },
        payload: multipartBody(filename, bytes),
      });
    const plain = await upload("My Song.wav", wav());
    expect(plain.statusCode).toBe(200);
    expect(plain.json().items[0].title).toBe("My Song");
    const raw = join(ctx.root, "raw.wav"),
      tagged = join(ctx.root, "tagged.wav");
    await writeFile(raw, wav());
    await promisify(execFile)(String(ffmpeg), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      raw,
      "-metadata",
      "title=Embedded Title",
      tagged,
    ]);
    const embedded = await upload("Filename.wav", await readFile(tagged));
    expect(embedded.statusCode).toBe(200);
    expect(embedded.json().items[0].title).toBe("Embedded Title");
    const owner = (await app.auth.userBySession(cookie))!;
    expect(await readdir(join(ctx.root, "uploads", owner.id))).toEqual([]);
  });
  it("applies the archive multipart policy to authenticated and one-time MCP archive URLs", async () => {
    const observed: Array<{ url: string; limit: number }> = [];
    app.addHook("preValidation", async (request) => {
      const original = request.parts.bind(request);
      request.parts = ((options: any) => {
        observed.push({
          url: request.url,
          limit: options?.limits?.fileSize ?? 2 * 1024 ** 3,
        });
        return original(options);
      }) as typeof request.parts;
    });
    const cookie = await session("archiveuploads");
    const owner = (await app.auth.userBySession(cookie))!;
    const archive = join(ctx.root, "empty.zip");
    await exportLibrary(ctx.db, owner.id, ctx.root, archive, {
      includeFiles: false,
    });
    const token = await app.auth.createToken(owner.id, "archive-client");
    const grant = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "library_import_begin", arguments: {} },
      },
    });
    const result = grant.json().result;
    const upload = JSON.parse(result.content[0].text);
    for (const url of [
      "/api/imports/upload",
      new URL(upload.uploadUrl).pathname,
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        cookies: url.startsWith("/api/imports")
          ? { hibiki_session: cookie }
          : {},
        headers: {
          "content-type": "multipart/form-data; boundary=hibiki-boundary",
        },
        payload: multipartBody("library.zip", await readFile(archive)),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().kind).toBe("import");
      const policy = observed.find((entry) => entry.url === url)!;
      expect(policy.limit).toBeGreaterThanOrEqual(3 * 1024 ** 3);
      expect(policy.limit).toBe(20 * 1024 ** 3);
    }
    await app.inject({
      method: "POST",
      url: "/api/items/upload",
      cookies: { hibiki_session: cookie },
      headers: {
        "content-type": "multipart/form-data; boundary=hibiki-boundary",
      },
      payload: multipartBody("small.wav", wav()),
    });
    expect(
      observed.find((entry) => entry.url === "/api/items/upload")!.limit,
    ).toBe(2 * 1024 ** 3);
  });
});
