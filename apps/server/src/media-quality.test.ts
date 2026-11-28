import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { parseMediaQuality, qualityColumns } from "./media-quality";
import { inspectFile } from "./media";

const run = promisify(execFile);

describe("media quality from real FFmpeg files", () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "hibiki-quality-")); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  const make = async (name: string, args: string[]) => {
    const file = join(root, name);
    await run(String(ffmpeg), ["-hide_banner", "-loglevel", "error", "-y", ...args, file], { timeout: 20_000 });
    return file;
  };
  const sine = ["-f", "lavfi", "-i", "sine=d=0.5", "-ac", "2"];

  it.each([
    ["hires.flac", ["-f", "lavfi", "-i", "anoisesrc=r=96000:d=0.5", "-ac", "2", "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"],
      { codec: "flac", format: "flac", class: "hires", name: "FLAC", label: "FLAC 24/96", bitDepth: 24, sampleRate: 96000, channels: 2 }],
    ["cd.flac", [...sine, "-c:a", "flac"],
      { codec: "flac", format: "flac", class: "lossless", label: "FLAC 16/44.1", bitDepth: 16, sampleRate: 44100 }],
    ["pcm.wav", [...sine, "-c:a", "pcm_s16le"],
      { codec: "pcm_s16le", format: "pcm", class: "lossless", name: "WAV", label: "WAV 16/44.1", channels: 2 }],
    ["surround.wav", ["-f", "lavfi", "-i", "sine=d=0.5", "-ac", "6", "-c:a", "pcm_s24le"],
      { format: "pcm", class: "hires", label: "WAV 24/44.1", bitDepth: 24, channels: 6, layout: "5.1" }],
    ["adpcm.wav", ["-f", "lavfi", "-i", "sine=d=0.5", "-ac", "1", "-c:a", "adpcm_ima_wav"],
      { codec: "adpcm_ima_wav", format: "adpcm", class: "lossy", name: "ADPCM", channels: 1 }],
    ["alac.m4a", [...sine, "-c:a", "alac"],
      { codec: "alac", format: "alac", class: "lossless", label: "ALAC 16/44.1" }],
    ["a.mp3", [...sine, "-c:a", "libmp3lame", "-b:a", "320k"],
      { codec: "mp3", format: "mp3", class: "lossy", label: "MP3 320", bitrate: 320 }],
    ["a.m4a", [...sine, "-c:a", "aac", "-b:a", "256k"],
      { codec: "aac", format: "aac", class: "lossy", name: "AAC", profile: "LC" }],
    ["a.opus", [...sine, "-c:a", "libopus", "-b:a", "160k"],
      { codec: "opus", format: "opus", class: "lossy", name: "Opus", sampleRate: 48000 }],
    ["a.ogg", [...sine, "-c:a", "libvorbis"], { codec: "vorbis", format: "vorbis", class: "lossy", name: "Vorbis" }],
  ] as const)("describes %s", async (name, args, expected) => {
    const file = await make(name, [...args]);
    const media = await inspectFile(file);
    expect(media.quality.audio).toMatchObject(expected);
    expect(media.quality.container).toBe(name.split(".").pop()!.toUpperCase());
    expect(media.quality.video).toBeUndefined();
    if (expected.class === "lossy") expect(media.quality.audio?.bitDepth).toBeUndefined();
  });

  it("estimates the audio bitrate of audio-only files from the container", async () => {
    const media = await inspectFile(await make("vbr.opus", [...sine, "-c:a", "libopus", "-b:a", "96k"]));
    expect(media.quality.audio?.bitrate).toBeGreaterThan(0);
    expect(media.quality.audio?.label).toMatch(/^Opus \d+$/);
  });

  it("describes the picture and sound of a video", async () => {
    const file = await make("v.mp4", ["-f", "lavfi", "-i", "color=s=320x240:r=25:d=0.5", ...sine,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"]);
    const { quality } = await inspectFile(file);
    expect(quality).toMatchObject({ container: "MP4", video: { codec: "h264", name: "H.264", width: 320, height: 240, fps: 25, label: "H.264 240p" },
      audio: { format: "aac", class: "lossy" } });
  });
});

describe("parseMediaQuality on production FFmpeg 7 output", () => {
  const output = (streams: string, bitrate = 130) =>
    `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x':\n  Duration: 00:03:00.00, start: 0.000000, bitrate: ${bitrate} kb/s\n${streams}`;

  it("reads HE-AAC and ignores the float decoder sample format", () => {
    const quality = parseMediaQuality(output("  Stream #0:0[0x1](und): Audio: aac (HE-AAC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 47 kb/s (default)"), ".m4a");
    expect(quality.audio).toEqual({ codec: "aac", format: "aac", class: "lossy", name: "HE-AAC", label: "HE-AAC 47",
      profile: "HE-AAC", bitrate: 47, sampleRate: 44100, channels: 2, layout: "stereo" });
  });

  it("skips decoder names and reads the video profile", () => {
    const quality = parseMediaQuality(output(
      "  Stream #0:0[0x1](und): Video: av1 (libdav1d) (Main) (av01 / 0x31307661), yuv420p(tv, bt709), 1280x720, 648 kb/s, SAR 1:1 DAR 16:9, 29.97 fps, 29.97 tbr, 30k tbn (default)\n" +
      "  Stream #0:1[0x2](und): Audio: opus (Opus / 0x7375704F), 48000 Hz, stereo, fltp, 125 kb/s (default)", 780), ".mp4");
    expect(quality.video).toEqual({ codec: "av1", name: "AV1", label: "AV1 720p", profile: "Main", width: 1280, height: 720, fps: 29.97, bitrate: 648 });
    expect(quality.audio).toMatchObject({ codec: "opus", label: "Opus 125", bitrate: 125 });
    expect(quality.bitrate).toBe(780);
  });

  it("does not treat an attached cover as video and keeps MP3 decoder names out", () => {
    const quality = parseMediaQuality(output(
      "  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 320 kb/s\n" +
      "  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)"), ".mp3");
    expect(quality.video).toBeUndefined();
    expect(quality.audio).toMatchObject({ name: "MP3", label: "MP3 320" });
    expect(quality.audio?.profile).toBeUndefined();
  });

  it("does not borrow the container bitrate for the sound of a video", () => {
    const quality = parseMediaQuality(output(
      "  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv), 1920x1080, SAR 1:1 DAR 16:9, 30 fps, 30 tbr, 1k tbn (default)\n" +
      "  Stream #0:1: Audio: opus, 48000 Hz, stereo, fltp (default)", 2500), ".webm");
    expect(quality.audio?.bitrate).toBeUndefined();
    expect(quality.audio?.label).toBe("Opus");
    expect(quality.video?.label).toBe("VP9 1080p");
  });

  it("orders scores: Hi-Res, lossless, lossy by bitrate", () => {
    const score = (streams: string, ext: string) => qualityColumns(parseMediaQuality(output(streams), ext)).audioScore!;
    const hires = score("  Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)", ".flac");
    const cd = score("  Stream #0:0: Audio: flac, 44100 Hz, stereo, s16", ".flac");
    const mp3 = score("  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s", ".mp3");
    const aac = score("  Stream #0:0: Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s", ".m4a");
    expect([hires > cd, cd > mp3, mp3 > aac]).toEqual([true, true, true]);
  });

  it("treats companded telephony PCM as lossy and ignores the container rate next to a cover", () => {
    expect(parseMediaQuality(output("  Stream #0:0: Audio: pcm_mulaw ([7][0][0][0] / 0x0007), 8000 Hz, 1 channels, s16, 64 kb/s"), ".wav").audio)
      .toMatchObject({ class: "lossy", format: "pcm", bitrate: 64 });
    const covered = parseMediaQuality(output("  Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp\n" +
      "  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 1000x1000, 90k tbr (attached pic)", 900), ".ogg");
    expect(covered.audio?.bitrate).toBeUndefined();
    expect(parseMediaQuality(output("  Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp", 131), ".ogg").audio?.bitrate).toBe(131);
  });

  it("returns no columns without sound", () => {
    expect(qualityColumns(parseMediaQuality(output("  Stream #0:0: Video: h264 (High), yuv420p, 640x360, 25 fps"), ".mp4")))
      .toEqual({ audioClass: null, audioFormat: null, audioScore: null });
  });
});
