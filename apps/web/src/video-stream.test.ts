import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { expect, it, vi } from "vitest";
import { attachVideoStream, videoFile, videoRangeSize, videoWindow, readVideoPages } from "./video-stream";

it("opens a bounded video window only for an authorized original MP4 route", () => {
  const source = { id: "s", provider: "local" as const, status: "available" as const, mime: "video/mp4", bytes: 214900518,
    streamUrl: "/files/f", playbackHints: { audioStart: 534512 } };
  expect(videoFile(source, 358)).toMatchObject({ url: "/files/f", size: 214900518 });
  expect(videoFile({ ...source, shared: true, streamUrl: "/api/shared-items/i/sources/k" }, 358)).toBeDefined();
  expect(videoFile({ ...source, streamUrl: "/files/f/audio" }, 358)).toBeUndefined();
  expect(videoFile({ ...source, streamUrl: "https://outside.test/f" }, 358)).toBeUndefined();
  expect(videoFile({ ...source, mime: "video/webm" }, 358)).toBeUndefined();
  expect(videoFile({ ...source, mime: "audio/mp4" }, 358)).toBeUndefined();
  expect(videoWindow({ size: 214900518, duration: 358 })).toBeGreaterThan(60);
  expect(videoWindow({ size: 2149005180, duration: 358 })).toBeLessThan(9);
  expect(videoFile({ ...source, bytes: 23 * 50e6 / 8 }, 23)).toBeUndefined();
});

it("feeds the first range page before the rest arrives and cancels when a seek changes the next byte", async () => {
  let response!: ReadableStreamDefaultController<Uint8Array>, cancelled = false;
  const stream = new Response(new ReadableStream({ start(c) { response = c; }, cancel() { cancelled = true; } }));
  const offsets: number[] = [];
  const processing = readVideoPages(stream, 100, 112, 4, new AbortController().signal, async (bytes, at) => {
    expect(bytes).toEqual(new Uint8Array([1,2,3,4]));
    offsets.push(at);
    return 900;
  });
  response.enqueue(new Uint8Array([1,2]));
  response.enqueue(new Uint8Array([3,4]));
  await processing;
  expect(offsets).toEqual([100]);
  expect(cancelled).toBe(true);
});

it("bounds shared low-bitrate requests by playable time, including the initial media payload", () => {
  const file = videoFile({ id: "s", shared: true, provider: "local", status: "available", mime: "video/mp4",
    bytes: 1350000, streamUrl: "/api/shared-items/i/sources/k", playbackHints: { audioStart: 32000 } }, 300)!;
  expect(file.prefix).toBe(41000);
  expect(videoRangeSize(file, 0, 0)).toBe(54000);
  expect(videoRangeSize(file, 74, 0)).toBe(4500);
});

it("keeps reading a slow active range and cancels an idle or abandoned stream", async () => {
  vi.useFakeTimers();
  try {
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const response = () => new Response(new ReadableStream({start(c) { feed = c; }, cancel}));
    const controller = new AbortController();
    const accept = async (_: Uint8Array, at: number) => at + 1;
    const active = readVideoPages(response(), 0, 4, 1, controller.signal, accept, 100);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(75);
      feed.enqueue(Uint8Array.of(i));
    }
    await active;
    const waiting = expect(readVideoPages(response(), 0, 1, 1, controller.signal, accept, 100)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(101);
    await waiting;
    const aborted = expect(readVideoPages(response(), 0, 1, 1, controller.signal, accept)).rejects.toThrow();
    controller.abort();
    await aborted;
    expect(cancel).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it("delivers both original encoded tracks byte-exactly and rechecks a completed shared stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibiki-video-fragments-"));
  const chunks = {audio: [] as Buffer[], video: [] as Buffer[]};
  let finish!: () => void, failed!: (reason: Error) => void, reportDenied!: (value: boolean) => void;
  const ended = new Promise<void>((resolve, reject) => { finish = resolve; failed = reject; });
  const denied = new Promise<boolean>(resolve => { reportDenied = resolve; });
  let closed: (() => void) | undefined;
  try {
    const input = join(dir, "original.mp4");
    execFileSync(String(ffmpeg), ["-v","error","-f","lavfi","-i","testsrc2=size=160x90:rate=25:duration=4",
      "-f","lavfi","-i","sine=frequency=440:duration=4","-c:v","libx264","-bf","3","-c:a","aac","-movflags","+faststart",input]);
    const data = await readFile(input);
    let media!: EventTarget;
    class Source extends EventTarget {
      readyState = "open";
      constructor() { super(); media = this; }
      static isTypeSupported() { return true; }
      addSourceBuffer(type: string) {
        const output = type.startsWith("video/") ? chunks.video : chunks.audio;
        const buffer = Object.assign(new EventTarget(), { buffered: {length: 0}, appendBuffer(part: ArrayBuffer) {
          output.push(Buffer.from(part));
          queueMicrotask(() => buffer.dispatchEvent(new Event("updateend")));
        }});
        return buffer;
      }
      endOfStream() { finish(); }
    }
    vi.stubGlobal("MediaSource", Source);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    const fetchRange = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "HEAD") return new Response(null, {status: 403});
      const range = new Headers(init.headers).get("Range")!;
      const [first,end] = range.slice(6).split("-").map(Number) as [number,number];
      return new Response(data.subarray(first,end+1), {status:206, headers:{
        "Content-Range":`bytes ${first}-${end}/${data.length}`, "Content-Length":String(end-first+1),
      }});
    });
    vi.stubGlobal("fetch", fetchRange);
    // Chromium can report a short buffered span while a paused seek still awaits its decoded frame.
    const video = Object.assign(new EventTarget(), {currentTime: 0, readyState: 1, seeking: true, paused: true,
      buffered: {length: 1, start: () => 0, end: () => .15}, getAttribute: () => null});
    closed = attachVideoStream(video as unknown as HTMLVideoElement,
      { url: "/api/shared-items/i/sources/k", shared:true, size:data.length, duration:4, prefix:32 * 1024 }, value => {
        reportDenied(value); if (!value) failed(new Error("Video stream failed"));
      });
    media.dispatchEvent(new Event("sourceopen"));
    await ended;
    const digest = (path: string, track: string) => execFileSync(String(ffmpeg),
      ["-v","error","-i",path,"-map",`0:${track[0]}:0`,"-c","copy","-f","streamhash","-hash","sha256","-"], {encoding:"utf8"});
    for (const track of ["audio","video"] as const) {
      const path = join(dir, track + ".mp4");
      await writeFile(path, Buffer.concat(chunks[track]));
      expect(chunks[track].length).toBeGreaterThan(1);
      expect(digest(path, track)).toBe(digest(input, track));
    }
    expect(fetchRange.mock.calls.length).toBeGreaterThan(1);
    video.readyState = 4;
    video.seeking = false;
    video.dispatchEvent(new Event("seeked"));
    video.paused = false;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11000);
    video.dispatchEvent(new Event("timeupdate"));
    expect(await denied).toBe(true);
  } finally {
    closed?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(dir, {recursive:true, force:true});
  }
});
