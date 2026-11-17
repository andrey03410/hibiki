import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { inspectFile, preparePlayback } from "./media";

const run = promisify(execFile);
describe("local playback compatibility", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hibiki-codecs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const generate = async (output: string, args: string[]) => {
    await run(
      String(ffmpeg),
      ["-hide_banner", "-loglevel", "error", "-y", ...args, output],
      { timeout: 10_000 },
    );
  };

  it("keeps MP3 and PCM WAV as browser-ready audio without creating a copy", async () => {
    for (const [extension, codec] of [
      ["mp3", "libmp3lame"],
      ["wav", "pcm_s16le"],
    ]) {
      const file = join(root, `audio.${extension}`);
      await generate(file, [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.2",
        "-c:a",
        codec!,
      ]);
      const info = await inspectFile(file);
      expect(info.kind).toBe("audio");
      expect(info.browserCompatible).toBe(true);
      expect(await preparePlayback(file, info, root)).toBeUndefined();
    }
    expect(await readdir(root)).toEqual(
      expect.arrayContaining(["audio.mp3", "audio.wav"]),
    );
    expect((await readdir(root)).length).toBe(2);
  });

  it("keeps an H.264/AAC MP4 untouched", async () => {
    const file = join(root, "compatible.mp4");
    await generate(file, [
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:r=10:d=0.3",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=0.3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
    ]);
    const info = await inspectFile(file);
    expect(info).toMatchObject({
      kind: "video",
      videoCodec: "h264",
      audioCodec: "aac",
      browserCompatible: true,
    });
    expect(await preparePlayback(file, info, root)).toBeUndefined();
    expect(await readdir(root)).toEqual(["compatible.mp4"]);
  });

  it("remuxes raw AAC into an audio-only M4A playback copy", async () => {
    const file = join(root, "original.aac");
    await generate(file, [
      "-f",
      "lavfi",
      "-i",
      "sine=duration=0.3",
      "-c:a",
      "aac",
    ]);
    const info = await inspectFile(file);
    expect(info.browserCompatible).toBe(false);
    const prepared = await preparePlayback(file, info, root);
    expect(prepared?.media).toMatchObject({
      kind: "audio",
      audioCodec: "aac",
      browserCompatible: true,
      mime: "audio/mp4",
    });
    expect(prepared?.path).toMatch(/\.m4a$/);
  });

  it("remuxes compatible H.264/AAC tracks from MOV without changing their encoded packets", async () => {
    const file = join(root, "original.mov");
    await generate(file, [
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:r=10:d=0.3",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=0.3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
    ]);
    const info = await inspectFile(file);
    expect(info.browserCompatible).toBe(false);
    const prepared = await preparePlayback(file, info, root);
    expect(prepared?.media).toMatchObject({
      browserCompatible: true,
      videoCodec: "h264",
      audioCodec: "aac",
    });
    for (const [stream, format] of [
      ["0:v:0", "h264"],
      ["0:a:0", "adts"],
    ]) {
      const packets = async (input: string) =>
        (
          await run(
            String(ffmpeg),
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-i",
              input,
              "-map",
              stream!,
              "-c",
              "copy",
              "-f",
              format!,
              "pipe:1",
            ],
            { encoding: "buffer", timeout: 10_000 },
          )
        ).stdout;
      expect(await packets(prepared!.path)).toEqual(await packets(file));
    }
  });

  it("does not mistake an MP3 embedded cover for a video track", async () => {
    const file = join(root, "cover.mp3");
    await generate(file, [
      "-f",
      "lavfi",
      "-i",
      "sine=duration=0.3",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=32x32:d=0.1",
      "-map",
      "0:a",
      "-map",
      "1:v",
      "-c:a",
      "libmp3lame",
      "-c:v",
      "mjpeg",
      "-frames:v",
      "1",
      "-disposition:v",
      "attached_pic",
      "-id3v2_version",
      "3",
    ]);
    const info = await inspectFile(file);
    expect(info).toMatchObject({ kind: "audio", browserCompatible: true });
    expect(info.videoCodec).toBeUndefined();
  });

  it("removes a partial output when the real FFmpeg conversion times out", async () => {
    const file = join(root, "original.mkv");
    await generate(file, [
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=30:d=0.3",
      "-c:v",
      "ffv1",
    ]);
    const info = await inspectFile(file);
    await expect(
      preparePlayback(file, info, root, { timeoutMs: 1 }),
    ).rejects.toThrow(/время|таймаут/i);
    expect(await readdir(root)).toEqual(["original.mkv"]);
  });

  it("honors cancellation before probing an archive media file", async () => {
    const file = join(root, "original.mp3");
    await generate(file, [
      "-f",
      "lavfi",
      "-i",
      "sine=duration=0.3",
      "-c:a",
      "libmp3lame",
    ]);
    const controller = new AbortController();
    controller.abort(new Error("Archive inspection cancelled"));
    await expect(
      inspectFile(file, { signal: controller.signal }),
    ).rejects.toThrow("Archive inspection cancelled");
  });
});
