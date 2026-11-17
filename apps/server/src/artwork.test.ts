import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
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
    await promisify(execFile)(String(ffmpeg), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=duration=0.3",
      "-f", "lavfi", "-i", "color=c=red:s=32x32:d=0.1",
      "-map", "0:a", "-map", "1:v", "-c:a", "alac",
      "-c:v", "png", "-frames:v", "1", "-disposition:v", "attached_pic", path,
    ], { timeout: 10_000 });
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
    const { item } = await ctx.library.importLocal(ctx.userId, path).catch(async (error) => {
      const probe = await promisify(execFile)(String(ffmpeg), ["-hide_banner", "-i", path], {
        timeout: 10_000, maxBuffer: 1024 * 1024,
      }).then((result) => result.stderr, (failure) => String(failure.stderr ?? failure));
      const boxes: Array<{ type: string; offset: number; size: number }> = [];
      const padded = await readFile(path);
      for (let offset = 0; offset + 8 <= padded.length && boxes.length < 32;) {
        const size = padded.readUInt32BE(offset);
        boxes.push({ type: padded.toString("ascii", offset + 4, offset + 8), offset, size });
        if (size < 8) break;
        offset += size;
      }
      console.error("Artwork fixture diagnostic", { platform: process.platform, boxes, probe: probe.slice(0, 12_000) });
      throw error;
    });
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
