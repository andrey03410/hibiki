import { afterEach, beforeEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import ffmpeg from "ffmpeg-static";
import { testContext, wav } from "./test-utils";
import { createApp } from "./app";
import type { ItemDto } from "@hibiki/contracts";

const run = (args: string[]) =>
  promisify(execFile)(String(ffmpeg), ["-hide_banner", "-loglevel", "error", ...args]);
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

it("streams a silent video role through an older share, keeps the original sound and invalidates both roles on clear", async () => {
  const alice = { hibiki_session: await app.auth.createSession(ctx.userId) };
  const bob = { hibiki_session: await app.auth.createSession(ctx.otherUserId) };
  const path = join(ctx.root, "song.wav");
  await writeFile(path, wav(3));
  const song = (await ctx.library.importLocal(ctx.userId, path)).item;
  const clip = join(ctx.root, "donor.mp4");
  await run([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x64:rate=25:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=970:duration=1",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-metadata",
    "title=donor-secret",
    clip,
  ]);
  const donor = (await ctx.library.importLocal(ctx.userId, clip)).item;
  const link = await app.inject({
    method: "POST",
    url: "/api/share-links",
    cookies: alice,
    payload: { kind: "item", targetId: song.id },
  });
  const sharedUrl = "/api/shared/" + new URL(link.json().url).pathname.split("/").at(-1);
  const url = "/api/items/" + song.id + "/visual";
  const payload = { expectedRevision: 0, visualSourceId: donor.sources[0].id };
  const set = () => app.inject({ method: "PUT", url, cookies: alice, payload });
  expect((await set()).statusCode).toBe(200);
  expect((await set()).json()).toMatchObject({ revision: 1 });
  expect(await ctx.db.mediaFile.count()).toBe(2);
  expect(await ctx.db.item.count()).toBe(2);
  const item = (await app.inject({ url: sharedUrl, cookies: bob })).json<{ items: ItemDto[] }>().items[0];
  expect(item.visual?.soundSourceId).toBe(item.sources[0].id);
  const video = await app.inject({ url: item.visual!.streamUrl, cookies: bob });
  expect(video.statusCode).toBe(200);
  expect(video.rawPayload.includes(Buffer.from("donor-secret"))).toBe(false);
  const file = join(ctx.root, "received.mp4");
  await writeFile(file, video.rawPayload);
  const hash = (p: string) => run(["-i", p, "-map", "0:v", "-c:v", "copy", "-f", "streamhash", "-"]);
  expect((await hash(file)).stdout).toBe((await hash(clip)).stdout);
  const frame = (p: string) => run(["-ss", "0.43", "-i", p, "-map", "0:v", "-frames:v", "1", "-f", "hash", "-"]);
  expect((await frame(file)).stdout).toEqual((await frame(clip)).stdout);
  await expect(run(["-i", file, "-map", "0:a", "-f", "null", "-"])).rejects.toThrow();
  for (const [start, end] of [
    [0, 99],
    [800, 1210],
    [video.rawPayload.length - 80, video.rawPayload.length - 1],
  ]) {
    const part = await app.inject({
      url: item.visual!.streamUrl,
      cookies: bob,
      headers: { range: "bytes=" + start + "-" + end },
    });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload).toEqual(video.rawPayload.subarray(start, end + 1));
  }
  expect((await app.inject({ url: item.sources[0].streamUrl!, cookies: bob })).rawPayload).toEqual(wav(3));
  const saved = await app.inject({ method: "POST", url: sharedUrl + "/save", cookies: bob, payload: {} });
  const savedId = saved.json().id;
  const job = await app.jobs.create(ctx.otherUserId, "shared-copy", { itemId: savedId });
  await app.jobs.runOnce();
  expect((await app.jobs.get(ctx.otherUserId, job.id)).state).toBe("done");
  const copy = await ctx.library.getItem(ctx.otherUserId, savedId);
  expect(copy.visual?.streamUrl).toBe("/api/items/" + savedId + "/visual/1");
  expect(await ctx.db.mediaFile.count({ where: { ownerId: ctx.otherUserId } })).toBe(2);
  await ctx.library.deleteItem(ctx.userId, donor.id);
  expect((await app.inject({ method: "HEAD", url: item.visual!.streamUrl, cookies: bob })).statusCode).toBe(200);
  expect(
    (await app.inject({ method: "DELETE", url, cookies: alice, payload: { expectedRevision: 0 } })).statusCode,
  ).toBe(409);
  expect(
    (await app.inject({ method: "DELETE", url, cookies: alice, payload: { expectedRevision: 1 } })).json(),
  ).toMatchObject({ revision: 2 });
  expect((await app.inject({ url: copy.visual!.streamUrl, cookies: bob })).rawPayload).toEqual(video.rawPayload);
  for (const stale of [item.visual!.streamUrl, item.sources[0].streamUrl!])
    expect((await app.inject({ url: stale, cookies: bob, headers: { range: "bytes=0-10" } })).statusCode).toBe(
      404,
    );
});

it("holds replacement and revision together, deduplicates uploaded packets across soundtracks, and preserves a later edit", async () => {
  const { setVisual, clearVisual } = await import("./visuals");
  const { replaceSource } = await import("./source-selection");
  const path = join(ctx.root, "track.wav");
  await writeFile(path, wav(4));
  const first = (await ctx.library.importLocal(ctx.userId, path)).item;
  await writeFile(path, wav(3));
  const second = (await ctx.library.importLocal(ctx.userId, path)).item;
  const clip = join(ctx.root, "clip.mp4"),
    remix = join(ctx.root, "different.mp4");
  await run([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x64:rate=25:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=2:frequency=400",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    clip,
  ]);
  await run([
    "-i",
    clip,
    "-f",
    "lavfi",
    "-i",
    "sine=duration=2:frequency=800",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    remix,
  ]);
  const attach = (itemId: string, uploadPath: string) =>
    setVisual(ctx.db, ctx.root, ctx.userId, itemId, { expectedRevision: 0, uploadPath });
  await Promise.all([attach(first.id, clip), attach(second.id, remix)]);
  expect(await ctx.db.visualTrack.count()).toBe(1);
  expect(await ctx.db.mediaFile.count()).toBe(3);
  expect(await ctx.db.kanameStorage.count()).toBe(0);
  await expect(
    replaceSource(ctx.db, ctx.root, ctx.userId, first.id, { sourceId: second.sources[0].id }),
  ).rejects.toMatchObject({ code: "visual_attached" });
  expect((await ctx.library.getItem(ctx.userId, first.id)).visualRevision).toBe(1);
  await replaceSource(ctx.db, ctx.root, ctx.userId, first.id, {
    sourceId: second.sources[0].id,
    clearVisualRevision: 1,
  });
  expect(await ctx.library.getItem(ctx.userId, first.id)).toMatchObject({ visualRevision: 2, duration: 3 });
  await clearVisual(ctx.db, ctx.root, ctx.userId, second.id, { expectedRevision: 1 });
  expect(await ctx.db.mediaFile.count()).toBe(2);
  expect(await ctx.db.visualTrack.count()).toBe(0);
});

it("lists actual video stream indexes and preserves the prior composition when publication fails", async () => {
  const { setVisual } = await import("./visuals");
  const video = join(ctx.root, "many.mp4"),
    path = join(ctx.root, "sound.wav");
  await writeFile(path, wav(3));
  const song = (await ctx.library.importLocal(ctx.userId, path)).item;
  await run([
    "-f",
    "lavfi",
    "-i",
    "color=red:s=32x32:d=0.5",
    "-f",
    "lavfi",
    "-i",
    "color=blue:s=32x32:d=1",
    "-map",
    "0:v",
    "-map",
    "1:v",
    "-c:v",
    "libx264",
    video,
  ]);
  const clip = (await ctx.library.importLocal(ctx.userId, video)).item;
  expect(
    (await ctx.library.getItem(ctx.userId, clip.id, true)).sources[0].videoStreams?.map((s) => s.index),
  ).toEqual([0, 1]);
  const input = { visualSourceId: clip.sources[0].id, expectedRevision: 0 };
  const attach = (id: string, options: Partial<typeof input> & { videoStreamIndex?: number } = {}) =>
    setVisual(ctx.db, ctx.root, id, song.id, { ...input, ...options });
  await expect(attach(ctx.userId)).rejects.toMatchObject({ code: "visual_video_ambiguous" });
  await expect(attach(ctx.otherUserId, { videoStreamIndex: 0 })).rejects.toMatchObject({ status: 404 });
  await expect(attach(ctx.userId, { videoStreamIndex: 2 })).rejects.toMatchObject({ code: "visual_video_index" });
  const result = await attach(ctx.userId, { videoStreamIndex: 1 });
  expect(result.visual?.duration).toBeCloseTo(1);
  const next = { ...input, expectedRevision: 1, videoStreamIndex: 0 };
  await expect(
    setVisual(ctx.db, ctx.root, ctx.userId, song.id, next, {
      onPublished: async () => {
        throw Error("lease lost");
      },
    }),
  ).rejects.toThrow("lease lost");
  expect((await ctx.library.getItem(ctx.userId, song.id)).visual).toEqual(result.visual);
  expect(await ctx.db.visualTrack.count()).toBe(1);
  expect(await ctx.db.kanameStorage.count()).toBe(0);
});
