import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { testContext, wav } from "./test-utils";
import { downloadYoutube, refreshYoutube } from "./youtube";
import { playbackSources } from "../../web/src/player-model";

vi.mock("./youtube", async (original) => ({
  ...(await original<typeof import("./youtube")>()),
  downloadYoutube: vi.fn(),
  refreshYoutube: vi.fn(),
}));

const video = "abcdefghijk";
const url = "https://youtu.be/" + video;
let ctx: Awaited<ReturnType<typeof testContext>>;
let app: Awaited<ReturnType<typeof createApp>>;
let endpoint: string;
const clients: Client[] = [];
beforeEach(async () => {
  ctx = await testContext();
  app = await createApp({ db: ctx.db, storageRoot: ctx.root });
  endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
  vi.mocked(refreshYoutube)
    .mockReset()
    .mockResolvedValue({ externalId: video, title: "Full recording", duration: 8, available: true });
  vi.mocked(downloadYoutube)
    .mockReset()
    .mockImplementation(async (_, __, directory) => {
      await mkdir(directory, { recursive: true });
      const path = join(directory, "full.wav");
      await writeFile(path, wav(8));
      return path;
    });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app.close();
  await ctx.close();
});
async function connect(owner: string) {
  const { token } = await app.auth.createToken(owner, "replacement-test");
  const client = new Client({ name: "replacement-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", endpoint), {
      requestInit: { headers: { authorization: "Bearer " + token } },
    }),
  );
  return async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "media_replace_source", arguments: args });
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
}
async function local(seconds: number, owner = ctx.userId) {
  const path = join(ctx.root, owner + "-" + seconds + ".wav");
  await writeFile(path, wav(seconds));
  return (await ctx.library.importLocal(owner, path)).item;
}
it("switches an owned card to its downloaded full version atomically and deduplicates retries", async () => {
  const item = await local(1);
  await ctx.db.item.update({ where: { id: item.id }, data: { title: "My title", favorite: true, note: "My note" } });
  const replace = await connect(ctx.userId);
  const tag = await ctx.db.tag.create({ data: { id: "fixture-tag", name: "Keep", ownerId: ctx.userId } });
  await ctx.db.itemTag.create({ data: { itemId: item.id, tagId: tag.id } });
  const original = await ctx.db.source.findUniqueOrThrow({ where: { id: item.sources[0].id } });
  const playlist = await ctx.library.savePlaylist(ctx.userId, {
    title: "Keep",
    definition: { version: 1, rule: { type: "items", ids: [item.id] }, sort: "source" },
  });
  const history = await ctx.db.listeningSummary.create({
    data: { ownerId: ctx.userId, itemId: item.id, launches: 3 },
  });
  const link = await ctx.db.shareLink.create({
    data: {
      id: "fixture-link",
      ownerId: ctx.userId,
      kind: "item",
      targetId: item.id,
      title: "Shared",
      token: "fixture",
    },
  });
  const [first, again] = await Promise.all([
    replace({ itemId: item.id, url }),
    replace({ itemId: item.id, url: "https://www.youtube.com/watch?v=" + video }),
  ]);
  expect(first.status).toBe("queued");
  expect(again.jobId).toBe(first.jobId);
  expect((await ctx.library.getItem(ctx.userId, item.id)).duration).toBe(1);
  expect(await app.jobs.runOnce()).toBe(true);
  expect(await app.jobs.get(ctx.userId, first.jobId)).toMatchObject({ state: "done" });
  const full = await ctx.library.getItem(ctx.userId, item.id);
  expect(full).toMatchObject({ id: item.id, title: "My title", favorite: true, duration: 8 });
  expect(await ctx.db.item.findUnique({ where: { id: item.id } })).toMatchObject({ note: "My note" });
  expect(await ctx.db.source.findUnique({ where: { id: original.id } })).toEqual(original);
  expect(full.sources.find((s) => s.id === original.id)?.hash).toBe(item.sources[0].hash);
  expect(full.tags.map((t) => t.id)).toEqual([tag.id]);
  expect(full.sources.some((s) => s.externalId === video)).toBe(true);
  expect((await ctx.library.resolve(ctx.userId, playlist.id)).items.map((i) => i.id)).toEqual([item.id]);
  expect(await ctx.db.listeningSummary.findUnique({ where: { itemId: item.id } })).toEqual(history);
  expect(await ctx.db.shareLink.findUnique({ where: { id: link.id } })).toEqual(link);
  for (const mode of ["audio", "original"] as const)
    expect(playbackSources(full, mode)[0]?.id).toBe(full.preferredSourceId);
  expect(full.preferredSourceId).not.toBe(item.sources[0].id);
  expect(await replace({ itemId: item.id, url })).toMatchObject({
    status: "applied",
    sourceId: full.preferredSourceId,
  });
  expect(await ctx.db.job.count()).toBe(1);
  expect(await replace({ itemId: item.id, sourceId: item.sources[0].id })).toMatchObject({
    sourceId: item.sources[0].id,
  });
  expect((await ctx.library.getItem(ctx.userId, item.id)).duration).toBe(1);
});
it("changes a YouTube-only card immediately while rejecting other owners and ambiguous targets", async () => {
  const { item } = await ctx.library.upsertYoutube(ctx.userId, {
    externalId: "12345678901",
    title: "Short",
    duration: 1,
    available: true,
  });
  const replace = await connect(ctx.userId);
  const foreign = await connect(ctx.otherUserId);
  expect((await foreign({ itemId: item.id, url })).error.code).toBe("item_not_found");
  expect((await replace({ itemId: item.id, url, sourceId: item.sources[0].id })).error.code).toBe(
    "replacement_target",
  );
  const result = await replace({ itemId: item.id, url });
  expect(result.status).toBe("applied");
  expect((await replace({ itemId: item.id, url })).sourceId).toBe(result.sourceId);
  expect(await ctx.db.job.count()).toBe(0);
  expect(await ctx.library.getItem(ctx.userId, item.id)).toMatchObject({
    id: item.id,
    title: "Short",
    duration: 8,
    preferredSourceId: result.sourceId,
  });
});
it("leaves the previous source playable after failure and when another choice supersedes a queued job", async () => {
  const item = await local(2),
    other = await local(3),
    foreign = await local(4, ctx.otherUserId);
  const replace = await connect(ctx.userId);
  expect((await replace({ itemId: item.id, sourceId: foreign.sources[0].id })).error.code).toBe("source_not_found");
  const job = await replace({ itemId: item.id, url });
  vi.mocked(downloadYoutube).mockRejectedValueOnce(new Error("Offline"));
  await app.jobs.runOnce();
  expect(await app.jobs.get(ctx.userId, job.jobId)).toMatchObject({ state: "failed" });
  expect((await ctx.library.getItem(ctx.userId, item.id)).duration).toBe(2);
  await app.jobs.retry(ctx.userId, job.jobId);
  const chosen = await replace({ itemId: item.id, sourceId: other.sources[0].id });
  expect(chosen.status).toBe("applied");
  await app.jobs.runOnce();
  expect(await ctx.library.getItem(ctx.userId, item.id)).toMatchObject({
    duration: 3,
    preferredSourceId: chosen.sourceId,
  });
  expect(await ctx.library.getItem(ctx.userId, other.id)).toMatchObject({ sources: other.sources });
});

it("plays the full local video and its virtual sound even when a short audio file is attached", async () => {
  const movie = (length: number) => {
    const path = join(ctx.root, "fixture-" + length + ".mp4");
    execFileSync(String(ffmpeg), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=size=32x32:rate=5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660",
      "-t",
      String(length),
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      path,
    ]);
    return path;
  };
  const { item } = await ctx.library.importLocal(ctx.userId, movie(1));
  const short = join(ctx.root, "clip.wav");
  await writeFile(short, wav(1));
  await ctx.library.importLocal(ctx.userId, short, { itemId: item.id });
  const full = movie(4);
  vi.mocked(downloadYoutube).mockImplementationOnce(async (id, mode, dir) => {
    expect(id).toBe(video);
    expect(mode).toBe("video");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "full.mp4");
    await copyFile(full, path);
    return path;
  });
  const replace = await connect(ctx.userId);
  const requested = await replace({ itemId: item.id, url });
  await app.jobs.runOnce();
  expect(await app.jobs.get(ctx.userId, requested.jobId)).toMatchObject({ state: "done" });
  const chosen = await ctx.library.getItem(ctx.userId, item.id);
  const original = playbackSources(chosen, "original")[0],
    sound = playbackSources(chosen, "audio")[0];
  expect(original.id).toBe(chosen.preferredSourceId);
  expect(sound.id).toBe(original.id + ":audio");
  expect(chosen.duration).toBeCloseTo(4, 1);
  const session = await app.auth.createSession(ctx.userId);
  const response = await app.inject({
    url: sound.streamUrl!,
    cookies: { hibiki_session: session },
    headers: { range: "bytes=0-19" },
  });
  expect(response.statusCode).toBe(206);
  expect(response.headers["content-type"]).toContain("audio/mp4");
});

it("rejects a missing local file before changing the selected card", async () => {
  const item = await local(1),
    candidate = await local(5);
  const file = await ctx.db.mediaFile.findUniqueOrThrow({ where: { id: candidate.sources[0].fileId! } });
  await rm(join(ctx.root, file.path));
  const replace = await connect(ctx.userId);
  expect((await replace({ itemId: item.id, sourceId: candidate.sources[0].id })).error.code).toBe("source_not_found");
  expect(await ctx.library.getItem(ctx.userId, item.id)).toMatchObject({ duration: 1, sources: item.sources });
});
