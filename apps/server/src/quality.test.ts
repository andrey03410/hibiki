import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "./app";
import { testContext } from "./test-utils";
import { QUALITY_VERSION } from "./media-quality";

const run = promisify(execFile);

describe("audio quality of stored media", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let cookie: string;
  let client: Client;
  beforeEach(async () => {
    ctx = await testContext();
    app = await createApp({ db: ctx.db, storageRoot: ctx.root });
    cookie = `hibiki_session=${await app.auth.createSession(ctx.userId)}`;
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const { token } = await app.auth.createToken(ctx.userId, "quality-test");
    client = new Client({ name: "quality-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { authorization: "Bearer " + token } } }));
  });
  afterEach(async () => {
    await client.close();
    await app.close();
    await ctx.close();
  });
  const make = async (name: string, args: string[]) => {
    const file = join(ctx.root, name);
    await run(String(ffmpeg), ["-hide_banner", "-loglevel", "error", "-y", ...args, file], { timeout: 20_000 });
    return file;
  };
  const sine = ["-f", "lavfi", "-i", "sine=d=0.4", "-ac", "2"];
  const importFile = async (name: string, args: string[], title = name) =>
    (await ctx.library.importLocal(ctx.userId, await make(name, args), { title })).item;
  const mcp = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text);
  const request = (filters: Record<string, unknown>) => app.inject({
    method: "POST", url: "/api/library/page", headers: { cookie }, payload: { filters },
  });
  const page = async (filters: Record<string, unknown>) => (await request(filters)).json();

  async function library() {
    const hires = await importFile("hires.flac", ["-f", "lavfi", "-i", "anoisesrc=r=96000:d=0.4", "-ac", "2", "-c:a", "flac",
      "-sample_fmt", "s32", "-bits_per_raw_sample", "24"], "Hi-Res");
    const cd = await importFile("cd.flac", [...sine, "-c:a", "flac"], "CD");
    const mp3 = await importFile("a.mp3", [...sine, "-c:a", "libmp3lame", "-b:a", "320k"], "MP3");
    const aac = await importFile("a.m4a", [...sine, "-c:a", "aac", "-b:a", "96k"], "AAC");
    const adpcm = await importFile("adpcm.wav", ["-f", "lavfi", "-i", "sine=d=0.4", "-ac", "1", "-c:a", "adpcm_ima_wav"], "ADPCM");
    const youtube = (await ctx.library.upsertYoutube(ctx.userId, { externalId: "dQw4w9WgXcQ", title: "Only YouTube" })).item;
    return { hires, cd, mp3, aac, adpcm, youtube };
  }

  it("describes each recording by its playing sound or the original of a prepared copy", async () => {
    const { hires, mp3, adpcm, youtube } = await library();
    expect(hires.audioQuality).toMatchObject({ class: "hires", label: "FLAC 24/96", sourceId: hires.sources[0]!.id });
    expect(mp3.audioQuality).toMatchObject({ class: "lossy", format: "mp3", label: "MP3 320" });
    expect(hires.sources[0]!.quality).toMatchObject({ container: "FLAC", audio: { bitDepth: 24, sampleRate: 96000 } });
    // ADPCM is prepared as a FLAC copy, which does not make the recording lossless.
    const copy = adpcm.sources.find(source => source.status === "available")!;
    expect(copy.quality).toMatchObject({ audio: { format: "flac" }, origin: { container: "WAV", audio: { format: "adpcm", class: "lossy" } } });
    expect(adpcm.audioQuality).toMatchObject({ format: "adpcm", class: "lossy", name: "ADPCM", sourceId: copy.id, prepared: true });
    const file = await ctx.db.mediaFile.findUniqueOrThrow({ where: { id: copy.fileId! } });
    const original = adpcm.sources.find(source => source.reason === "unsupported_codec")!;
    expect(file).toMatchObject({ originFileId: original.fileId, audioClass: "lossy", audioFormat: "adpcm", qualityVersion: QUALITY_VERSION });
    expect(youtube.audioQuality).toBeUndefined();
    const window = await ctx.db.$transaction(tx => ctx.library.itemWindow(tx, ctx.userId, [adpcm.id, hires.id]));
    expect(window.map(item => item.audioQuality?.label)).toEqual([adpcm.audioQuality!.label, "FLAC 24/96"]);
  });

  it("filters, counts and sorts the library by quality on the site and in MCP", async () => {
    const { hires, cd, mp3, aac, adpcm, youtube } = await library();
    const ids = (result: { items: { id: string }[] }) => result.items.map(item => item.id);

    // Lossy sound is ordered by bitrate alone: ADPCM 176 kb/s ranks above AAC 96 kb/s.
    const best = await page({ sort: "quality-desc" });
    expect(ids(best)).toEqual([hires.id, cd.id, mp3.id, adpcm.id, aac.id, youtube.id]);
    const whole = { hires: 1, "hires.flac": 1, lossless: 1, "lossless.flac": 1, lossy: 3, "lossy.mp3": 1, "lossy.aac": 1, "lossy.adpcm": 1 };
    expect(best.audioCounts).toEqual(whole);
    // The first unfiltered page reuses the overview counts, so the overview carries quality counts too.
    const overview = (await app.inject({ url: "/api/library/overview?playlists=summary", headers: { cookie } })).json();
    expect(overview.audioCounts).toEqual(whole);
    expect(ids(await page({ sort: "quality-asc" })).slice(0, 2)).toEqual([aac.id, adpcm.id]);
    expect(ids(await page({ sort: "quality-asc" })).at(-1)).toBe(youtube.id);

    const lossless = await page({ audioQuality: ["hires", "lossless"], sort: "quality-desc" });
    expect(ids(lossless)).toEqual([hires.id, cd.id]);
    // Counts ignore the quality filter itself, so the other classes stay visible.
    expect(lossless.audioCounts.lossy).toBe(3);
    expect(ids(await page({ audioQuality: ["flac"], sort: "title-asc" }))).toEqual([cd.id, hires.id]);
    expect(ids(await page({ audioQuality: ["lossless.flac", "lossy.mp3"], sort: "quality-desc" }))).toEqual([cd.id, mp3.id]);
    expect((await request({ audioQuality: ["kind:audio"] })).statusCode).toBe(400);

    const order: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await mcp("media_list", { sort: "quality-desc", limit: 2, cursor, view: "summary" });
      order.push(...ids(result));
      cursor = result.nextCursor ?? undefined;
    } while (cursor && order.length < 10);
    expect(order).toEqual([hires.id, cd.id, mp3.id, adpcm.id, aac.id, youtube.id]);
    const summary = await mcp("media_list", { audioQuality: ["lossy.adpcm"], sort: "quality-asc", view: "summary" });
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0]).toEqual({ id: adpcm.id, title: "ADPCM", kind: "audio", duration: expect.any(Number),
      audioQuality: { label: adpcm.audioQuality!.label, class: "lossy", format: "adpcm" } });
    const full = await mcp("media_get", { itemId: hires.id });
    expect(full.audioQuality).toMatchObject({ label: "FLAC 24/96" });
    expect(full.sources[0].quality).toMatchObject({ audio: { codec: "flac", bitDepth: 24 } });
  });

  it("measures files stored before the analysis existed and links old prepared copies", async () => {
    const { hires, adpcm } = await library();
    const copy = adpcm.sources.find(source => source.status === "available")!;
    await ctx.db.mediaFile.updateMany({ data: { quality: null, audioClass: null, audioFormat: null, audioScore: null, qualityVersion: 0, originFileId: null } });
    expect((await ctx.library.getItem(ctx.userId, hires.id)).audioQuality).toBeUndefined();
    const missing = await ctx.db.mediaFile.findFirstOrThrow({ where: { id: (await ctx.library.getItem(ctx.userId, (await page({ query: "MP3" })).items[0].id)).sources[0]!.fileId! } });
    await rm(join(ctx.root, missing.path));

    // Six stored files, one of them removed from disk.
    expect(await ctx.library.backfillQuality()).toEqual({ updated: 5, skipped: 1 });
    expect(await ctx.library.backfillQuality()).toEqual({ updated: 0, skipped: 1 });
    expect((await ctx.library.getItem(ctx.userId, hires.id)).audioQuality).toMatchObject({ label: "FLAC 24/96" });
    expect((await ctx.library.getItem(ctx.userId, adpcm.id)).audioQuality).toMatchObject({ format: "adpcm", prepared: true, sourceId: copy.id });
  });

  it("keeps a prepared copy unmeasured while its original cannot be read", async () => {
    const { adpcm } = await library();
    const original = adpcm.sources.find(source => source.reason === "unsupported_codec")!;
    const copy = adpcm.sources.find(source => source.status === "available")!;
    await ctx.db.mediaFile.updateMany({ data: { quality: null, audioClass: null, audioFormat: null, audioScore: null, qualityVersion: 0, originFileId: null } });
    const stored = await ctx.db.mediaFile.findUniqueOrThrow({ where: { id: original.fileId! } });
    await rm(join(ctx.root, stored.path));
    await ctx.library.backfillQuality();
    // The FLAC copy of ADPCM must not pass for lossless sound.
    expect(await ctx.db.mediaFile.findUniqueOrThrow({ where: { id: copy.fileId! } })).toMatchObject({ qualityVersion: 0, audioClass: null });
    expect((await ctx.library.getItem(ctx.userId, adpcm.id)).audioQuality).toBeUndefined();
  });
});
