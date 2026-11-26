import { afterEach, beforeEach, expect, it } from "vitest";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { testContext, wav } from "./test-utils";
import { exportLibrary, inspectArchive, applyArchive } from "./portability";
import { clearVisual, roleFile, setVisual } from "./visuals";

let ctx: Awaited<ReturnType<typeof testContext>>;
beforeEach(async () => { ctx = await testContext(); });
afterEach(async () => { await ctx.close(); });
const run = (args: string[]) => promisify(execFile)(String(ffmpeg), ["-loglevel", "error", ...args]);

async function library() {
  const path = join(ctx.root, "song.wav");
  await writeFile(path, wav(2));
  const song = (await ctx.library.importLocal(ctx.userId, path)).item;
  const video = join(ctx.root, "donor.mp4");
  await run(["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:d=1", "-f", "lavfi", "-i", "sine=frequency=1200:duration=1",
    "-c:v", "libx264", "-c:a", "aac", "-metadata", "title=private-donor-audio", video]);
  const donor = (await ctx.library.importLocal(ctx.userId, video)).item;
  await setVisual(ctx.db, ctx.root, ctx.userId, song.id, { expectedRevision: 0, visualSourceId: donor.sources[0].id });
  return { song, donor, video };
}

async function transfer(includeFiles: boolean, label: string) {
  const zip = join(ctx.root, label + ".zip");
  await exportLibrary(ctx.db, ctx.userId, ctx.root, zip, { includeFiles });
  return inspectArchive(zip, join(ctx.root, label));
}

it("keeps v1 for ordinary libraries and exports a referenced donor only once in v2", async () => {
  expect((await transfer(false, "v1")).manifest.version).toBe(1);
  const { song, donor } = await library();
  const checked = await transfer(true, "originals");
  expect(checked.manifest.version).toBe(2);
  if (checked.manifest.version !== 2) throw Error("expected roles");
  const track = checked.manifest.visualTracks[0];
  const original = checked.manifest.items.find(i => i.id === donor.id)!.sources[0];
  expect(track.fileId).toBe(original.fileId);
  expect(track.streamIndex).toBe(0);
  expect(checked.manifest.items.find(i => i.id === song.id)?.roles?.visual.trackId).toBe(track.id);
  expect(checked.files.size).toBe(2);
  await applyArchive(ctx.db, ctx.otherUserId, ctx.root, checked);
  const altered = structuredClone(checked.manifest);
  altered.visualTracks[0].signature = "f".repeat(64);
  await expect(applyArchive(ctx.db, ctx.otherUserId, ctx.root, { ...checked, manifest: altered })).rejects.toThrow(/подпись/i);
});

it("restores missing roles from a later full archive and exports only pictures when the donor is absent", async () => {
  const { donor } = await library();
  await ctx.library.deleteItem(ctx.userId, donor.id);
  const metadata = await transfer(false, "meta");
  expect(metadata.manifest.version).toBe(2);
  expect(metadata.preview.missingRoles?.map(r => r.role).sort()).toEqual(["sound", "visual"]);
  await applyArchive(ctx.db, ctx.otherUserId, ctx.root, metadata);
  const dest = await ctx.db.item.findFirstOrThrow({ where: { ownerId: ctx.otherUserId } });
  expect((await ctx.library.getItem(ctx.otherUserId, dest.id)).visual?.available).toBe(false);
  const full = await transfer(true, "full");
  expect(full.manifest.version).toBe(2);
  const video = full.manifest.files.find(f => f.kind === "video")!;
  const bytes = full.files.get(video.path)!;
  expect(bytes.hasAudio).toBe(false);
  expect((await readFile(bytes.path)).includes(Buffer.from("private-donor-audio"))).toBe(false);
  await applyArchive(ctx.db, ctx.otherUserId, ctx.root, full);
  const restored = await ctx.library.getItem(ctx.otherUserId, dest.id);
  expect(restored.visual).toBeDefined();
  expect(restored.visual?.available).not.toBe(false);
  const sound = await roleFile(ctx.db, ctx.otherUserId, dest.id, restored.visualRevision!, "sound");
  expect(await readFile(join(ctx.root, sound.file.path))).toEqual(wav(2));
  await applyArchive(ctx.db, ctx.otherUserId, ctx.root, full);
  expect(await ctx.db.mediaFile.count({ where: { ownerId: ctx.otherUserId } })).toBe(2);
  expect(await ctx.db.visualTrack.count({ where: { ownerId: ctx.otherUserId } })).toBe(1);
  expect((await ctx.library.getItem(ctx.otherUserId, dest.id)).visualRevision).toBe(restored.visualRevision);
});

it("preserves an explicit clear on an existing destination item matched by its original audio hash", async () => {
  await library();
  const dest = (await ctx.library.importLocal(ctx.otherUserId, join(ctx.root, "song.wav"))).item;
  const full = await transfer(true, "hydrate");
  await applyArchive(ctx.db, ctx.otherUserId, ctx.root, full);
  const attached = await ctx.library.getItem(ctx.otherUserId, dest.id);
  expect(attached.visual).toBeDefined();
  await clearVisual(ctx.db, ctx.root, ctx.otherUserId, dest.id, { expectedRevision: attached.visualRevision! });
  await applyArchive(ctx.db, ctx.otherUserId, ctx.root, full);
  expect((await ctx.library.getItem(ctx.otherUserId, dest.id)).visual).toBeUndefined();
});

async function attachSamePictureAtDestination() {
  const path = join(ctx.root, "second.wav");
  await writeFile(path, wav(3));
  const other = (await ctx.library.importLocal(ctx.otherUserId, path)).item;
  const donor = (await ctx.library.importLocal(ctx.otherUserId, join(ctx.root, "donor.mp4"))).item;
  await setVisual(ctx.db, ctx.root, ctx.otherUserId, other.id, { expectedRevision: 0, visualSourceId: donor.sources[0].id });
}

it("can export unhydrated and verified assignments with the same declared picture signature", async () => {
  const { donor } = await library();
  await ctx.library.deleteItem(ctx.userId, donor.id);
  await applyArchive(ctx.db, ctx.otherUserId, ctx.root, await transfer(false, "meta"));
  await attachSamePictureAtDestination();
  const path = join(ctx.root, "onward.zip");
  await exportLibrary(ctx.db, ctx.otherUserId, ctx.root, path, { includeFiles:true });
  const checked = await inspectArchive(path, join(ctx.root,"onward"));
  expect(checked.manifest.version).toBe(2);
  expect(checked.preview.canApply).toBe(true);
});

it("discards a detached video copy when the recipient already has the same verified picture", async () => {
  const { donor } = await library();
  await ctx.library.deleteItem(ctx.userId, donor.id);
  const archive = await transfer(true, "deduplicated");
  await attachSamePictureAtDestination();
  await applyArchive(ctx.db, ctx.otherUserId, ctx.root, archive);
  expect(await ctx.db.visualTrack.count({ where: { ownerId: ctx.otherUserId } })).toBe(1);
  expect(await ctx.db.mediaFile.count({ where: { ownerId: ctx.otherUserId, sources: {none:{}},
    visualTracks: {none:{}}, visualSounds: {none:{}} } })).toBe(0);
  const copied = await readdir(join(ctx.root, "imported", ctx.otherUserId), { recursive: true, withFileTypes: true });
  expect(copied.filter(entry => entry.isFile())).toHaveLength(1);
});
