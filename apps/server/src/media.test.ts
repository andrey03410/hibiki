import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { inspectFile, preparePlayback, inspectPlaybackMetadata, mp4CompatibleAudio } from "./media";

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

  it("reads a large ID3v2 header including the v2.4 footer", async () => {
    const file = join(root, "tagged.mp3");
    await generate(file, ["-f", "lavfi", "-i", "sine=duration=0.2", "-id3v2_version", "0"]);
    const track = await readFile(file);
    const length = 300 * 1024;
    const header = Buffer.from([73, 68, 51, 4, 0, 0x10, 0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) header[9 - i] = (length >>> (7 * i)) & 127;
    const footer = Buffer.from(header);
    footer.write("3DI");
    await writeFile(file, Buffer.concat([header, Buffer.alloc(length), footer, track]));
    expect((await inspectFile(file)).playback.audioStart).toBe(length + 20);
  });
  it.each([false, true])("indexes M4A top level boxes (faststart %s)", async fast => {
    const file = join(root, "metadata.m4a");
    await generate(file, ["-f", "lavfi", "-i", "sine=duration=0.3", "-c:a", "aac", ...(fast ? ["-movflags", "+faststart"] : [])]);
    const data = await readFile(file);
    const meta = await inspectPlaybackMetadata(file, "audio/mp4");
    expect(meta.audioStart).toBe(data.indexOf("mdat") + 4);
    expect(meta.tailStart).toBe(fast ? null : data.indexOf("moov") - 4);
  });
  it("preserves 24-bit PCM samples and channels in the lossless preparation", async () => {
    const file = join(root, "precision.aiff");
    await generate(file, ["-f", "lavfi", "-i", "anoisesrc=r=96000:d=0.1", "-ac", "2", "-c:a", "pcm_s24be"]);
    const prepared = await preparePlayback(file, await inspectFile(file), root);
    expect(prepared?.media).toMatchObject({ audioCodec: "flac", mime: "audio/flac", browserCompatible: true });
    const hash = async (path: string) => (await run(String(ffmpeg), ["-loglevel", "error", "-i", path, "-c:a", "pcm_s32le", "-f", "hash", "-"])).stdout;
    expect(await hash(prepared!.path)).toBe(await hash(file));
    const { parseFile } = await import("music-metadata");
    expect((await parseFile(prepared!.path)).format).toMatchObject({ sampleRate: 96000, bitsPerSample: 24, numberOfChannels: 2 });
  });

  it("accepts both HE-AAC profiles for MP4 playback", () => {
    expect(mp4CompatibleAudio("aac", "(HE-AAC) (mp4a), 44100 Hz, stereo, fltp")).toBe(true);
    expect(mp4CompatibleAudio("aac", "(HE-AACv2) (mp4a), 48000 Hz, stereo, fltp")).toBe(true);
    expect(mp4CompatibleAudio("aac", "(SSR)")).toBe(false);
  });

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
      expect(info.hasAudio).toBe(true);
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
      hasAudio: true,
      videoCodec: "h264",
      audioCodec: "aac",
      browserCompatible: true,
    });
    expect(await preparePlayback(file, info, root)).toBeUndefined();
    expect(await readdir(root)).toEqual(["compatible.mp4"]);
  });

  it("recognizes an H.264 MP4 without audio as a playable silent video", async () => {
    const file = join(root, "silent.mp4");
    await generate(file, [
      "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10:d=0.3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
    ]);
    expect(await inspectFile(file)).toMatchObject({
      kind: "video",
      hasAudio: false,
      browserCompatible: true,
    });
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
