import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InjectOptions } from "fastify";
import type { ShareLinkDto, SharedViewDto } from "@hibiki/contracts";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { createApp } from "./app";
import { storagePath } from "./media";
import { testContext, wav } from "./test-utils";

describe("media sharing", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let alice: Record<string, string>;
  let bob: Record<string, string>;

  beforeEach(async () => {
    ctx = await testContext();
    app = await createApp({ db: ctx.db, storageRoot: ctx.root });
    alice = { hibiki_session: await app.auth.createSession(ctx.userId) };
    bob = { hibiki_session: await app.auth.createSession(ctx.otherUserId) };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await app.close();
    await ctx.close();
  });

  async function share(kind: "item" | "playlist", targetId: string): Promise<ShareLinkDto> {
    const response = await app.inject({ method: "POST", url: "/api/share-links", cookies: alice, payload: { kind, targetId } });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  function preview(link: ShareLinkDto) {
    return "/api/shared/" + new URL(link.url!).pathname.split("/").at(-1);
  }
  async function song() {
    const path = join(ctx.root, "tone.wav");
    await writeFile(path, wav());
    return (await ctx.library.importLocal(ctx.userId, path, { title: "Owner title" })).item;
  }
  function asBob(options: InjectOptions) {
    return app.inject({ ...options, cookies: bob });
  }

  it("restricts and permanently closes links owned by one account", async () => {
    const original = (await ctx.library.upsertYoutube(ctx.userId, { externalId: "abcdefghijk" })).item;
    expect((await asBob({ method: "POST", url: "/api/share-links", payload: { kind: "item", targetId: original.id } })).statusCode).toBe(404);
    const link = await share("item", original.id);
    const manage = "/api/share-links/" + link.id;
    expect((await app.inject(preview(link))).statusCode).toBe(401);
    expect((await asBob({ url: manage })).statusCode).toBe(404);
    expect((await asBob({ method: "DELETE", url: manage })).statusCode).toBe(404);
    await ctx.db.item.update({ where: { id: original.id }, data: {
      originalTitle: "Private original", note: "Private note", favorite: true,
      createdAt: new Date("2020-01-01"), updatedAt: new Date("2021-01-01"),
    } });
    const view = (await asBob({ url: preview(link) })).json<SharedViewDto>();
    expect(view).toMatchObject({
      kind: "item", sharedBy: "alice", trackCount: 1,
      items: [{ id: original.id, originalTitle: original.title, createdAt: link.createdAt, updatedAt: link.createdAt, tags: [] }],
    });
    expect(view.items[0]).not.toHaveProperty("favorite");
    expect(view.items[0]).not.toHaveProperty("note");

    const now = Date.now();
    const expiresAt = new Date(now + 86_400_000).toISOString();
    const change = await app.inject({ method: "PATCH", url: manage, cookies: alice, payload: { expiresAt } });
    expect(change.json()).toMatchObject({ expiresAt, url: link.url, status: "active" });
    vi.spyOn(Date, "now").mockReturnValue(now + 86_400_000);
    expect((await asBob({ url: preview(link) })).statusCode).toBe(404);
    expect((await app.inject({ url: manage, cookies: alice })).json()).toMatchObject({ status: "expired" });
    expect((await app.inject({ method: "PATCH", url: manage, cookies: alice, payload: { expiresAt: null } })).statusCode).toBe(409);

    const next = await share("item", original.id);
    expect((await app.inject({ method: "DELETE", url: "/api/share-links/" + next.id, cookies: alice })).statusCode).toBe(200);
    expect((await asBob({ url: preview(next) })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/share-links", cookies: alice })).json().links).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: link.id, status: "expired" }),
      expect.objectContaining({ id: next.id, status: "revoked" }),
    ]));
  });

  it("only issues authenticated Range media through the original's link", async () => {
    const original = await song();
    const link = await share("item", original.id);
    const view = (await asBob({ url: preview(link) })).json<SharedViewDto>();
    const source = view.items[0].sources[0];
    expect(source).toMatchObject({ provider: "local", shared: true });
    expect(source).not.toHaveProperty("fileId");
    expect(source).not.toHaveProperty("hash");
    expect(source.streamUrl).toBeTruthy();
    expect((await app.inject(source.streamUrl!)).statusCode).toBe(401);
    expect((await asBob({ url: original.sources[0].streamUrl! })).statusCode).toBe(404);
    const range = await asBob({ url: source.streamUrl!, headers: { range: "bytes=0-43" } });
    expect(range.statusCode).toBe(206);
    expect(range.headers["content-range"]).toBe("bytes 0-43/16044");
    expect(range.headers["cache-control"]).toBe("private, no-store");
    expect(range.rawPayload).toEqual(wav().subarray(0, 44));
    expect((await asBob({ url: source.streamUrl!, headers: { range: "bytes=16044-" } })).statusCode).toBe(416);
    const head = await asBob({ method: "HEAD", url: source.streamUrl! });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe("16044");
    expect(head.rawPayload).toHaveLength(0);

    expect((await app.inject({ method: "DELETE", url: "/api/share-links/" + link.id, cookies: alice })).statusCode).toBe(200);
    expect((await asBob({ url: source.streamUrl!, headers: { range: "bytes=44-45" } })).statusCode).toBe(404);
  });

  it("serves virtual M4A ranges through owned and revocable shared URLs", async () => {
    const input = join(ctx.root, "video.mp4");
    await promisify(execFile)(String(ffmpeg), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:d=1",
      "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libx264", "-c:a", "aac", input]);
    const { item } = await ctx.library.importLocal(ctx.userId, input);
    const source = item.sources[0];
    expect(source).toMatchObject({ audioStreamUrl: source.streamUrl + "/audio", audioMime: "audio/mp4" });
    const url = source.audioStreamUrl!;
    expect((await app.inject(url)).statusCode).toBe(401);
    expect((await asBob({ url })).statusCode).toBe(404);
    const full = await app.inject({ url, cookies: alice });
    expect(full.headers).toMatchObject({
      "content-type": "audio/mp4", "content-length": String(source.audioBytes), etag: `"${source.hash}-a1"`,
      "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600",
    });
    const link = await share("item", item.id);
    const view = (await asBob({ url: preview(link) })).json<SharedViewDto>();
    const sharedUrl = view.items[0].sources[0].audioStreamUrl!;
    const head = await asBob({ method: "HEAD", url: sharedUrl });
    expect(head.statusCode).toBe(200);
    expect(head.headers["cache-control"]).toBe("private, no-store");
    expect(head.headers["content-length"]).toBe(String(source.audioBytes));
    expect(head.rawPayload).toHaveLength(0);
    const offset = source.audioViewStart! - 10;
    const range = await asBob({ url: sharedUrl, headers: { range: `bytes=${offset}-${offset + 99}` } });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload).toEqual(full.rawPayload.subarray(offset, offset + 100));
    const unsat = await asBob({ url: sharedUrl, headers: { range: `bytes=${source.audioBytes}-` } });
    expect(unsat.statusCode).toBe(416);
    expect(unsat.headers["content-range"]).toBe(`bytes */${source.audioBytes}`);
    await app.inject({ method: "DELETE", url: "/api/share-links/" + link.id, cookies: alice });
    expect((await asBob({ method: "HEAD", url: sharedUrl })).statusCode).toBe(404);
  });
  it("streams embedded artwork only while the author and grant remain active", async () => {
    const { stdout: audio } = await promisify(execFile)(String(ffmpeg), [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=0.1",
      "-c:a", "libmp3lame", "-id3v2_version", "0", "-f", "mp3", "pipe:1",
    ], { encoding: "buffer", timeout: 10_000 });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZkAAAAASUVORK5CYII=", "base64");
    const picture = Buffer.concat([Buffer.from("\0image/png\0\x03\0"), png]);
    const frame = Buffer.alloc(10);
    frame.write("APIC");
    frame.writeUInt32BE(picture.length, 4);
    const length = frame.length + picture.length;
    const tag = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, length >> 7, length & 127]);
    const path = join(ctx.root, "covered.mp3");
    await writeFile(path, Buffer.concat([tag, frame, picture, audio]));
    const { item } = await ctx.library.importLocal(ctx.userId, path);
    const link = await share("item", item.id);
    const view = (await asBob({ url: preview(link) })).json<SharedViewDto>();
    const { thumbnail } = view.items[0].sources[0];
    expect(thumbnail).toBeTruthy();
    expect((await app.inject(thumbnail!)).statusCode).toBe(401);
    expect((await asBob({ url: item.sources[0].thumbnail! })).statusCode).toBe(404);
    const cover = await asBob({ url: thumbnail! });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers["cache-control"]).toBe("private, no-store");
    expect(cover.rawPayload).toEqual(png);

    const cardUrl = thumbnail + "?size=cover";
    expect((await app.inject(cardUrl)).statusCode).toBe(401);
    const card = await asBob({ url: cardUrl });
    expect(card.statusCode).toBe(200);
    expect(card.headers["content-type"]).toBe("image/webp");
    expect(card.headers["cache-control"]).toBe("private, no-store");

    await ctx.db.user.update({ where: { id: ctx.userId }, data: { suspended: true } });
    expect((await asBob({ url: cardUrl })).statusCode).toBe(404);
    await ctx.db.user.update({ where: { id: ctx.userId }, data: { suspended: false } });
    expect((await app.inject({ method: "DELETE", url: "/api/share-links/" + link.id, cookies: alice })).statusCode).toBe(200);
    expect((await asBob({ url: cardUrl })).statusCode).toBe(404);
  });

  it("hides storage paths when an authorized local file is missing", async () => {
    const original = await song();
    const link = await share("item", original.id);
    const view = (await asBob({ url: preview(link) })).json<SharedViewDto>();
    const file = await ctx.db.mediaFile.findUniqueOrThrow({ where: { id: original.sources[0].fileId } });
    await rm(storagePath(ctx.root, file.path));
    const response = await asBob({ url: view.items[0].sources[0].streamUrl! });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(file.path);
  });

  it("filters borrowed-only recordings out of the published count and live view", async () => {
    const origin = (await ctx.library.upsertYoutube(ctx.userId, { externalId: "abcdefghijk" })).item;
    const first = await share("item", origin.id);
    const received = (await asBob({ method: "POST", url: preview(first) + "/save" })).json<{ id: string }>();
    const own = (await ctx.library.upsertYoutube(ctx.otherUserId, { externalId: "lmnopqrstuv" })).item;
    const playlist = await ctx.library.savePlaylist(ctx.otherUserId, {
      title: "Bob's playlist",
      definition: { version: 1, sort: "source", rule: { type: "items", ids: [received.id, own.id] } },
    });
    const now = new Date(Date.now() + 5000);
    await ctx.library.refreshDuePlaylistCounts(now);
    await ctx.library.refreshDuePlaylistCounts(now);
    expect((await ctx.db.playlist.findUniqueOrThrow({ where: { id: playlist.id } })).trackCount).toBe(2);
    const published = await asBob({ method: "POST", url: "/api/share-links", payload: { kind: "playlist", targetId: playlist.id } });
    expect(published.statusCode).toBe(200);
    const link = published.json<ShareLinkDto>();
    expect(link.trackCount).toBe(1);
    const view = (await app.inject({ url: preview(link), cookies: alice })).json<SharedViewDto>();
    expect(view.trackCount).toBe(1);
    expect(view.items.map(item => item.id)).toEqual([own.id]);
  });

  it("closes a broken playlist grant while retaining an independent item grant", async () => {
    const recording = (await ctx.library.upsertYoutube(ctx.userId, { externalId: "abcdefghijk" })).item;
    const playlist = await ctx.library.savePlaylist(ctx.userId, {
      title: "One song",
      definition: { version: 1, sort: "source", rule: { type: "items", ids: [recording.id] } },
    });
    const first = await share("playlist", playlist.id);
    const second = await share("item", recording.id);
    await asBob({ method: "POST", url: preview(first) + "/save", payload: { itemId: recording.id } });
    const saved = (await asBob({ method: "POST", url: preview(second) + "/save" })).json<{ id: string }>();
    await ctx.db.playlist.update({ where: { id: playlist.id }, data: { definitionJson: "{" } });

    const closed = await asBob({ url: preview(first) });
    expect(closed.statusCode).toBe(404);
    expect(closed.json().error.code).toBe("share_unavailable");
    const received = await asBob({ url: "/api/items/" + saved.id });
    expect(received.statusCode).toBe(200);
    expect(received.json()).toMatchObject({
      shared: { available: true }, sources: [{ provider: "youtube", externalId: "abcdefghijk" }],
    });
  });

  it("checks the central author outside the SQLite transaction", async () => {
    const original = (await ctx.library.upsertYoutube(ctx.userId, { externalId: "abcdefghijk" })).item;
    const link = await share("item", original.id);
    const saved = (await asBob({ method: "POST", url: preview(link) + "/save" })).json<{ id: string }>();
    const issuer = "https://issuer.example.test";
    vi.stubEnv("KANAME_ENABLED", "1");
    vi.stubEnv("KANAME_OIDC_ISSUER", issuer);
    vi.stubEnv("KANAME_URL", "https://kaname.example.test");
    vi.stubEnv("KANAME_SERVICE_TOKEN", "test-service");
    await ctx.db.user.update({ where: { id: ctx.userId }, data: { kanameIssuer: issuer, kanameSubject: "alice" } });
    await ctx.db.user.update({ where: { id: ctx.otherUserId }, data: { kanameIssuer: issuer, kanameSubject: "bob" } });
    bob = { hibiki_session: await app.auth.createSession(ctx.otherUserId, true) };
    let authorStarted!: () => void;
    const started = new Promise<void>(resolve => { authorStarted = resolve; });
    let allowAuthor!: () => void;
    const author = new Promise<void>(resolve => { allowAuthor = resolve; });
    let unavailable = false;
    vi.stubGlobal("fetch", async (url: URL) => {
      const subject = url.pathname.split("/").at(-1)!;
      if (subject === "alice") {
        authorStarted();
        await author;
        if (unavailable) return new Response(null, { status: 503 });
      }
      return Response.json({
        service: "hibiki", subject, login: subject, role: "user",
        limits: { items: null, storageBytes: null }, permissions: { heavy: false },
      });
    });
    await app.sharing.prefetchForViewer(ctx.otherUserId, ["unrelated"], true);
    const previewRequest = asBob({ url: preview(link) });
    await started;
    let count: number | undefined;
    const deadline = new AbortController();
    try {
      count = await Promise.race([
        ctx.db.item.count({ where: { ownerId: ctx.userId } }),
        delay(500, undefined, { signal: deadline.signal }),
      ]);
    } finally {
      deadline.abort();
      allowAuthor();
    }
    expect((await previewRequest).statusCode).toBe(200);
    expect(count).toBe(1);
    expect((await app.library.getItem(ctx.otherUserId, saved.id)).shared?.available).toBe(true);
    unavailable = true;
    await app.sharing.prefetchForViewer(ctx.otherUserId, [saved.id], true);
    expect((await app.library.getItem(ctx.otherUserId, saved.id)).shared?.available).toBe(false);
    expect((await asBob({ url: preview(link) })).statusCode).toBe(503);
  });

  it("follows live playlist membership and retains the second grant for one saved recording", async () => {
    const original = await song();
    const outside = (await ctx.library.upsertYoutube(ctx.userId, { externalId: "abcdefghijk" })).item;
    const definition = { version: 1 as const, sort: "source" as const, rule: { type: "items" as const, ids: [original.id] } };
    const playlist = await ctx.library.savePlaylist(ctx.userId, { title: "One song", description: "Private description", definition });
    const link = await share("playlist", playlist.id);
    const second = await share("item", original.id);
    const trackCountBeforePublish = link.trackCount;
    expect(trackCountBeforePublish).toBeNull();
    const url = preview(link);
    const view = (await asBob({ url })).json<SharedViewDto>();
    expect(view).toMatchObject({ kind: "playlist", title: "One song", trackCount: 1, sharedBy: "alice" });
    expect(view.items.map(item => item.id)).toEqual([original.id]);
    expect(view).not.toHaveProperty("description");
    expect(view).not.toHaveProperty("definition");
    expect((await asBob({ method: "POST", url: url + "/save", payload: { itemId: outside.id } })).statusCode).toBe(404);
    const savedPlaylist = (await asBob({ method: "POST", url: url + "/save" })).json<{ id: string }>();
    expect((await asBob({ method: "POST", url: url + "/save" })).json()).toMatchObject({ id: savedPlaylist.id, kind: "playlist" });
    expect(await ctx.db.item.count({ where: { ownerId: ctx.otherUserId } })).toBe(0);
    const savedUrl = "/api/shared-playlists/" + savedPlaylist.id;
    const track = (await asBob({ method: "POST", url: savedUrl + "/save", payload: { itemId: original.id } })).json<{ id: string }>();
    expect((await asBob({ method: "POST", url: preview(second) + "/save" })).json()).toMatchObject({ id: track.id, kind: "item" });
    expect(await ctx.db.item.count({ where: { ownerId: ctx.otherUserId } })).toBe(1);
    expect(await ctx.db.mediaFile.count({ where: { ownerId: ctx.otherUserId } })).toBe(0);
    const stream = view.items[0].sources[0].streamUrl!;

    await ctx.library.savePlaylist(ctx.userId, { title: "One song", definition: { ...definition, rule: { type: "items", ids: [outside.id] } } }, playlist.id);
    expect((await asBob({ url: stream })).statusCode).toBe(404);
    expect((await asBob({ url: savedUrl })).json<SharedViewDto>().items.map(item => item.id)).toEqual([outside.id]);
    const received = (await asBob({ url: "/api/items/" + track.id })).json<SharedViewDto["items"][number]>();
    expect(received.shared?.available).toBe(true);
    expect(received.sources[0].streamUrl).toBeTruthy();
    expect(received.sources[0].streamUrl).not.toContain(new URL(second.url!).pathname.split("/").at(-1));
    expect((await asBob({ url: received.sources[0].streamUrl! })).statusCode).toBe(200);

    await ctx.library.savePlaylist(ctx.userId, { title: "One song", definition }, playlist.id);
    expect((await asBob({ url: stream })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/share-links/" + second.id, cookies: alice })).statusCode).toBe(200);
    expect((await asBob({ url: received.sources[0].streamUrl! })).statusCode).toBe(200);
    expect((await asBob({ method: "POST", url: "/api/share-links", payload: { kind: "item", targetId: track.id } })).statusCode).toBe(404);

    await ctx.library.deletePlaylist(ctx.userId, playlist.id);
    expect((await asBob({ url: received.sources[0].streamUrl! })).statusCode).toBe(404);
    expect((await asBob({ url: "/api/shared-playlists" })).json().playlists).toEqual([
      expect.objectContaining({ id: savedPlaylist.id, title: "One song", status: "unavailable" }),
    ]);
    expect((await asBob({ method: "DELETE", url: savedUrl })).statusCode).toBe(200);
    expect((await asBob({ url: "/api/shared-playlists" })).json()).toEqual({ playlists: [] });
  });
});
