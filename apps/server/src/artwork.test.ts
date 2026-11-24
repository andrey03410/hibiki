import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { parseFile } from "music-metadata";
import { createApp } from "./app";
import { testContext } from "./test-utils";
import { exportLibrary, inspectArchive, applyArchive } from "./portability";
import { storagePath } from "./media";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZkAAAAASUVORK5CYII=",
  "base64",
);
const webp = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
  "base64",
);

// A real MP3 stream with a hand-built ID3v2.3 APIC frame permits hostile tags
// without depending on FFmpeg accepting that image as an encoder input.
function withCover(audio: Buffer, data: Buffer, declaredMime: string) {
  const picture = Buffer.concat([
    Buffer.from(`\0${declaredMime}\0\x03\0`, "binary"),
    data,
  ]);
  const frame = Buffer.alloc(10);
  frame.write("APIC");
  frame.writeUInt32BE(picture.length, 4);
  const size = frame.length + picture.length;
  const tag = Buffer.from([
    0x49, 0x44, 0x33, 3, 0, 0,
    (size >>> 21) & 0x7f,
    (size >>> 14) & 0x7f,
    (size >>> 7) & 0x7f,
    size & 0x7f,
  ]);
  return Buffer.concat([tag, frame, picture, audio]);
}

function withFlacPictures(flac: Buffer, pictures: Buffer[]) {
  const original = Buffer.from(flac);
  let offset = 4;
  while (true) {
    const last = (original[offset]! & 0x80) !== 0;
    const end = offset + 4 + original.readUIntBE(offset + 1, 3);
    if (last) {
      original[offset] = original[offset]! & 0x7f;
      offset = end;
      break;
    }
    offset = end;
  }
  const blocks = pictures.map((picture, index) => {
    const mime = Buffer.from("image/png");
    const fields = Buffer.alloc(32 + mime.length);
    fields.writeUInt32BE(3, 0);
    fields.writeUInt32BE(mime.length, 4);
    mime.copy(fields, 8);
    fields.writeUInt32BE(1, 12 + mime.length); // Width.
    fields.writeUInt32BE(1, 16 + mime.length); // Height.
    fields.writeUInt32BE(24, 20 + mime.length);
    fields.writeUInt32BE(picture.length, 28 + mime.length);
    const header = Buffer.alloc(4);
    header[0] = index === pictures.length - 1 ? 0x86 : 6;
    header.writeUIntBE(fields.length + picture.length, 1, 3);
    return Buffer.concat([header, fields, picture]);
  });
  return Buffer.concat([original.subarray(0, offset), ...blocks, original.subarray(offset)]);
}

describe("embedded audio artwork", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let cookie: string;
  let audio: Buffer;
  beforeEach(async () => {
    ctx = await testContext();
    app = await createApp({ db: ctx.db, storageRoot: ctx.root });
    cookie = await app.auth.createSession(ctx.userId);
    const path = join(ctx.root, "plain.mp3");
    await promisify(execFile)(String(ffmpeg), [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=0.1",
      "-c:a", "libmp3lame", "-id3v2_version", "0", path,
    ], { timeout: 10_000 });
    audio = await readFile(path);
  });
  afterEach(async () => {
    await app.close();
    await ctx.close();
  });
  async function importCover(data: Buffer, mime = "image/png") {
    const path = join(ctx.root, "tagged.mp3");
    await writeFile(path, withCover(audio, data, mime));
    return (await ctx.library.importLocal(ctx.userId, path)).item;
  }
  const artworkUrl = (id: string) => `/api/items/${id}/artwork`;
  const get = (url: string) =>
    app.inject({ url, cookies: { hibiki_session: cookie } });

  it("serves distinct decodable sizes for track rows, playlist cards and the player", async () => {
    const { stdout: original } = await promisify(execFile)(String(ffmpeg), [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "testsrc2=size=1536x1024,noise=alls=16:all_seed=1",
      "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
    ], { encoding: "buffer", maxBuffer: 5 * 1024 ** 2, timeout: 10_000 });
    const item = await importCover(original);
    const url = artworkUrl(item.id);
    const small = await get(url + "?size=thumb");
    expect(small.statusCode).toBe(200);
    expect(small.rawPayload.length).toBeLessThan(32 * 1024);
    expect(small.headers["content-type"]).toBe("image/webp");
    const card = await get(url + "?size=cover");
    expect(card.statusCode).toBe(200);
    expect(card.headers["content-type"]).toBe("image/webp");
    expect(card.rawPayload.length).toBeLessThan(original.length);
    expect(card.headers.etag).not.toBe(small.headers.etag);
    const path = join(ctx.root, "rendition.webp");
    for (const [response, dimensions] of [[small, [96, 64]], [card, [640, 427]]] as const) {
      await writeFile(path, response.rawPayload);
      const { stdout: decoded } = await promisify(execFile)(String(ffmpeg), [
        "-hide_banner", "-loglevel", "error", "-i", path,
        "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
      ], { encoding: "buffer", timeout: 10_000, maxBuffer: 4 * 1024 ** 2 });
      expect([decoded.readUInt32BE(16), decoded.readUInt32BE(20)]).toEqual(dimensions);
    }
    expect((await get(url)).rawPayload.equals(original)).toBe(true);

    const etag = small.headers.etag;
    expect(typeof etag).toBe("string");
    const revalidate = (session: string) => app.inject({
      url: url + "?size=thumb", cookies: { hibiki_session: session },
      headers: { "if-none-match": String(etag) },
    });
    const unchanged = await revalidate(cookie);
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.rawPayload.length).toBe(0);
    expect((await revalidate(await app.auth.createSession(ctx.otherUserId))).statusCode).toBe(404);
    await ctx.library.deleteItem(ctx.userId, item.id);
    expect((await revalidate(cookie)).statusCode).toBe(404);
  });
  it("publishes a playlist cover only for a local image that can be decoded", async () => {
    const barePath = join(ctx.root, "plain.mp3");
    const bare = (await ctx.library.importLocal(ctx.userId, barePath)).item;
    const emptyIds = ["without-cover-1", "without-cover-2"];
    await ctx.db.item.createMany({ data: emptyIds.map(id => ({
      id, ownerId: ctx.userId, kind: "audio", title: id, originalTitle: id,
    })) });
    await ctx.db.source.createMany({ data: emptyIds.map(id => ({
      id, key: id, ownerId: ctx.userId, itemId: id, provider: "local",
      fileId: bare.sources[0]!.fileId!, status: "available",
    })) });
    const tagged = await importCover(png);
    const playlist = await ctx.library.savePlaylist(ctx.userId, {
      title: "Обложка", definition: { version: 1, sort: "source", rule: { type: "items", ids: [bare.id, ...emptyIds, tagged.id] } },
    });
    await ctx.library.refreshDuePlaylistCounts();
    const overview = await get("/api/library/overview?playlists=summary");
    expect(overview.json().playlists).toMatchObject([{
      id: playlist.id, coverUrls: [artworkUrl(tagged.id) + "?size=cover"],
    }]);
  });
  it("uses the library fallback when a raster signature has no decodable image", async () => {
    const item = await importCover(png.subarray(0, 12));
    const response = await get(artworkUrl(item.id) + "?size=thumb");
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("artwork_not_found");
  });
  it("serves PNG and WebP bytes using their actual image type", async () => {
    for (const [bytes, mime] of [
      [png, "image/png"], [webp, "image/webp"],
    ] as const) {
      const item = await importCover(bytes, "image/jpeg");
      const response = await get(artworkUrl(item.id));
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(mime);
      expect(response.rawPayload).toEqual(bytes);
    }
  });
  it("serves a local audio cover attached to a YouTube video item", async () => {
    const { item: youtube } = await ctx.library.upsertYoutube(ctx.userId, {
      externalId: "abcdefghijk", title: "Video with an audio source",
    });
    const path = join(ctx.root, "tagged.mp3");
    await writeFile(path, withCover(audio, png, "image/png"));
    const { item } = await ctx.library.importLocal(ctx.userId, path, {
      itemId: youtube.id,
    });
    expect(item.kind).toBe("video");
    expect(item.sources.find((source) => source.provider === "local")!.thumbnail)
      .toBe(artworkUrl(item.id));
    expect(item.sources.find((source) => source.provider === "youtube")!.thumbnail)
      .toBe("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg");
    const response = await get(artworkUrl(item.id));
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(png);
  });
  it("does not treat an ordinary local video as embedded audio artwork", async () => {
    const path = join(ctx.root, "video.mp4");
    await promisify(execFile)(String(ffmpeg), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=32x32:d=0.1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", path,
    ], { timeout: 10_000 });
    const { item } = await ctx.library.importLocal(ctx.userId, path);
    expect(item.sources[0]!.thumbnail).toBeUndefined();
    const response = await get(artworkUrl(item.id));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("artwork_not_found");
  });
  it("does not serve a fake image or an embedded image larger than 5 MiB", async () => {
    for (const data of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.concat([png, Buffer.alloc(5 * 1024 ** 2)]),
      Buffer.concat([png, Buffer.alloc(8 * 1024 ** 2)]),
    ]) {
      const item = await importCover(data);
      const response = await get(artworkUrl(item.id));
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("artwork_not_found");
    }
  });
  it("rejects FLAC metadata whose many small pictures exceed the cumulative extraction budget", async () => {
    const path = join(ctx.root, "many-pictures.flac");
    await promisify(execFile)(String(ffmpeg), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=duration=0.1", "-c:a", "flac", path,
    ], { timeout: 10_000 });
    const picture = Buffer.alloc(64 * 1024);
    png.copy(picture);
    await writeFile(path, withFlacPictures(await readFile(path), Array(130).fill(picture)));
    const { item } = await ctx.library.importLocal(ctx.userId, path);
    const response = await get(artworkUrl(item.id));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("artwork_not_found");
  });
  it("stops serving cached artwork when the original disappears", async () => {
    const item = await importCover(png);
    expect((await get(artworkUrl(item.id))).statusCode).toBe(200);
    const file = (await ctx.db.mediaFile.findUnique({
      where: { id: item.sources[0]!.fileId! },
    }))!;
    await rm(storagePath(ctx.root, file.path));
    const response = await get(artworkUrl(item.id));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("artwork_not_found");
  });
  it("retains an original cover after a large skipped MP4 box when the playback derivative has none", async () => {
    const path = join(ctx.root, "original.m4a");
    const cover = join(ctx.root, "cover.png");
    await writeFile(cover, png);
    await promisify(execFile)(String(ffmpeg), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=duration=0.3",
      "-i", cover,
      "-map", "0:a", "-map", "1:v", "-c:a", "alac",
      "-c:v", "copy", "-disposition:v", "attached_pic", path,
    ], { timeout: 10_000 });
    const metadata = await parseFile(path, { duration: true, skipCovers: true });
    expect(metadata.format.hasAudio).toBe(true);
    expect(metadata.format.duration).toBeGreaterThan(0.2);
    const media = await readFile(path);
    let moov = 0;
    while (media.toString("ascii", moov + 4, moov + 8) !== "moov")
      moov += media.readUInt32BE(moov);
    // Place valid padding after the encoded audio: existing sample offsets stay
    // intact, while the embedded cover is beyond the 8 MiB extraction budget.
    const padding = Buffer.alloc(9 * 1024 ** 2);
    padding.writeUInt32BE(padding.length);
    padding.write("free", 4);
    await writeFile(path, Buffer.concat([
      media.subarray(0, moov), padding, media.subarray(moov),
    ]));
    const { item } = await ctx.library.importLocal(ctx.userId, path);
    expect(item.sources).toHaveLength(2);
    expect(
      item.sources.some((source) => source.reason === "unsupported_codec"),
    ).toBe(true);
    expect(
      item.sources.some((source) => source.status === "available"),
    ).toBe(true);
    const response = await get(artworkUrl(item.id));
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });
  it("restores artwork from the original after a full archive transfer to another owner", async () => {
    const item = await importCover(png);
    const archive = join(ctx.root, "library.zip");
    await exportLibrary(ctx.db, ctx.userId, ctx.root, archive, {
      includeFiles: true,
    });
    const checked = await inspectArchive(archive, join(ctx.root, "checked"));
    expect(checked.manifest.items[0]!.sources[0]!.thumbnail).toBeUndefined();
    await applyArchive(ctx.db, ctx.otherUserId, ctx.root, checked);
    const restored = (await ctx.library.snapshot(ctx.otherUserId)).items[0]!;
    expect(restored.id).not.toBe(item.id);
    expect(restored.sources[0]!.thumbnail).toBe(artworkUrl(restored.id));
    const otherCookie = await app.auth.createSession(ctx.otherUserId);
    const response = await app.inject({
      url: artworkUrl(restored.id),
      cookies: { hibiki_session: otherCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(png);
    expect((await get(artworkUrl(restored.id))).statusCode).toBe(404);
  });
});
