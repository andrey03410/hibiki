import { describe, expect, it, vi } from "vitest";
import { VideoBytes, VideoDelivery, relayVideoFile, type VideoFile } from "./video-delivery";
import { progressiveMp4 } from "./test-mp4";
import { windowBytes } from "./video-index";

const movie = progressiveMp4(600, 30); // 60 s, key frame every 3 s.
const file = (url = "/files/a"): VideoFile => ({ url, size: movie.file.length, duration: 60, indexEnd: movie.mdatBody });

function origin({ slow = false } = {}) {
  let allowed = true;
  const ranges: string[] = [];
  const fetcher = vi.fn(async (_: string, init: RequestInit) => {
    if (!allowed) return new Response(null, { status: 403 });
    if (init.method === "HEAD") return new Response(null);
    const range = new Headers(init.headers).get("Range")!;
    const [, a, last] = /^bytes=(\d+)-(\d*)$/.exec(range)!;
    const b = last || String(movie.file.length - 1);
    ranges.push(range);
    const body = movie.file.slice(+a, +b + 1);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < body.length; i += 16 * 1024) {
          if (slow) await new Promise(resolve => setTimeout(resolve, 5));
          try { controller.enqueue(body.slice(i, i + 16 * 1024)); } catch { return; }
        }
        try { controller.close(); } catch { /* cancelled */ }
      },
    });
    return new Response(stream, { status: 206, headers: { "Content-Range": `bytes ${a}-${b}/${movie.file.length}` } });
  });
  return { fetcher, ranges, revoke: () => { allowed = false; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await settle();
  expect(check()).toBe(true);
}

describe("tab-owned video delivery", () => {
  it("loads only the movie index while the recording plays as sound", async () => {
    const server = origin();
    const delivery = new VideoDelivery(server.fetcher);
    delivery.select(file(), "t");
    await until(() => !!delivery.snapshot()?.indexed);
    await settle();
    expect(server.ranges).toEqual([`bytes=0-${movie.mdatBody - 1}`]);
  });

  it("loads the key frame window on intent, before the seconds behind the playhead", async () => {
    const server = origin();
    const delivery = new VideoDelivery(server.fetcher);
    delivery.configure("window", 31, false);
    delivery.select(file(), "t");
    await until(() => (delivery.snapshot()?.playable.length ?? 0) > 0 && server.ranges.length >= 3);
    await settle();
    expect(server.ranges).toHaveLength(3);
    const playable = delivery.snapshot()!.playable;
    expect(playable[0]![0]).toBeLessThanOrEqual(21);
    expect(playable[0]![1]).toBeGreaterThanOrEqual(41);
    expect(playable.at(-1)![1]).toBeLessThan(45);
    // The first media range starts at the key frame at 30 s, then the seconds behind it follow.
    let keyFrame = movie.mdatBody;
    for (let i = 0; i < 300; i++) keyFrame += 1000 + i + 200;
    expect(server.ranges[1]).toMatch(new RegExp(`^bytes=${keyFrame}-`));
    expect(Number(/^bytes=(\d+)/.exec(server.ranges[2]!)![1])).toBeLessThan(keyFrame);
  });

  it("fills a watched video to the end and serves identical bytes to the decoder", async () => {
    const server = origin();
    const delivery = new VideoDelivery(server.fetcher);
    delivery.configure("watch", 10, true);
    delivery.select(file(), "t");
    await until(() => !!delivery.snapshot()?.complete);
    const requests = server.ranges.length;
    const response = delivery.response("t", "bytes=100-")!;
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 100-${movie.file.length - 1}/${movie.file.length}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(movie.file.slice(100));
    expect(server.ranges).toHaveLength(requests);
    expect(delivery.snapshot()!.playable).toEqual([[0, 60]]);
    expect(delivery.response("other", null)).toBeUndefined();
  });

  it("stops loading video when the view returns to sound", async () => {
    const server = origin({ slow: true });
    const delivery = new VideoDelivery(server.fetcher);
    delivery.configure("watch", 0, true);
    delivery.select(file(), "t");
    await until(() => server.ranges.length >= 3);
    delivery.configure("index", 0, false);
    await new Promise(resolve => setTimeout(resolve, 700));
    const count = server.ranges.length;
    const covered = JSON.stringify(delivery.snapshot());
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(server.ranges.length).toBe(count);
    expect(delivery.snapshot()?.complete).toBe(false);
    expect(JSON.stringify(delivery.snapshot())).toBe(covered);
  });

  it("serves a decoder read inside the window and defers a stale read from the file start", async () => {
    const server = origin({ slow: true });
    const delivery = new VideoDelivery(server.fetcher);
    delivery.configure("watch", 40, false);
    delivery.select(file(), "t");
    await until(() => !!delivery.snapshot()?.indexed);
    const stale = delivery.response("t", `bytes=${movie.mdatBody}-`)!;
    const reader = stale.body!.getReader();
    const first = reader.read();
    await until(() => server.ranges.length >= 2);
    const window = server.ranges[1]!;
    expect(window).not.toBe(`bytes=${movie.mdatBody}-`);
    expect((await first).value!.length).toBeGreaterThan(0);
    await reader.cancel();
  });

  it("prepares the next recording after the watched one and reuses it", async () => {
    const server = origin();
    const delivery = new VideoDelivery(server.fetcher);
    delivery.configure("watch", 0, true);
    delivery.setNext(file("/files/b"));
    delivery.select(file(), "t");
    await until(() => server.ranges.some(range => range.startsWith("bytes=0-")) &&
      server.fetcher.mock.calls.some(([url]) => url === "/files/b"));
    await until(() => server.fetcher.mock.calls.filter(([url]) => url === "/files/b").length >= 2);
    const before = server.fetcher.mock.calls.filter(([url]) => url === "/files/b").length;
    delivery.select(file("/files/b"), "u");
    expect(delivery.snapshot()?.indexed).toBe(true);
    await settle();
    expect(server.fetcher.mock.calls.filter(([url]) => url === "/files/b").length).toBeGreaterThanOrEqual(before);
  });

  it("reports a revoked grant", async () => {
    const server = origin();
    server.revoke();
    const failed = vi.fn();
    const delivery = new VideoDelivery(server.fetcher);
    delivery.select(file(), "t", failed);
    await until(() => failed.mock.calls.length > 0);
    expect(failed).toHaveBeenCalledWith(true);
  });

  it("keeps the playing window when the budget evicts far pages", async () => {
    const server = origin();
    const bytes = new VideoBytes(file(), server.fetcher, 480 * 1024);
    bytes.configure("watch", 30, true);
    bytes.schedule();
    await new Promise(resolve => setTimeout(resolve, 400));
    const window = windowBytes(bytes.index!, 20, 40)!;
    const ranges = bytes.byteRanges();
    expect(ranges.some(([a, b]) => a <= window[0] && b >= Math.min(window[1], window[0] + 64 * 1024))).toBe(true);
    expect(ranges.reduce((sum, [a, b]) => sum + b - a, 0)).toBeLessThanOrEqual(480 * 1024 + 64 * 1024);
    expect(bytes.complete).toBe(false);
    const requests = server.ranges.length;
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(server.ranges.length).toBe(requests);
    bytes.close();
  });

  it("bounds a decoder read to the window until the sound lets the fill start", async () => {
    const server = origin({ slow: true });
    const delivery = new VideoDelivery(server.fetcher);
    delivery.configure("watch", 10, false);
    delivery.select(file(), "t");
    await until(() => !!delivery.snapshot()?.indexed || server.ranges.length >= 2);
    // The decoder reads the window start while the head of the window is still loading.
    const response = delivery.response("t", `bytes=${movie.mdatBody}-`)!;
    const reader = response.body!.getReader();
    await reader.read();
    await until(() => server.ranges.some(range => range.startsWith(`bytes=${movie.mdatBody}-`)));
    const read = server.ranges.find(range => range.startsWith(`bytes=${movie.mdatBody}-`))!;
    expect(read).not.toBe(`bytes=${movie.mdatBody}-`);
    expect(Number(read.split("-")[1])).toBeLessThan(movie.file.length / 2);
    await reader.cancel();
  });

  it("moves the window with continuous playback", async () => {
    const server = origin();
    const delivery = new VideoDelivery(server.fetcher);
    delivery.configure("window", 5, false);
    delivery.select(file(), "t");
    await until(() => server.ranges.length >= 3);
    await settle();
    const before = server.ranges.length;
    for (let t = 5.25; t <= 25; t += .25) delivery.follow(t);
    await until(() => server.ranges.length > before);
    await until(() => (delivery.snapshot()?.playable.at(-1)?.[1] ?? 0) >= 35);
  });

  it("rechecks a shared grant while retained bytes keep playing", async () => {
    const server = origin();
    const delivery = new VideoDelivery(server.fetcher);
    const failed = vi.fn();
    delivery.configure("watch", 0, true);
    delivery.select({ ...file("/api/shared-items/x/sources/y"), shared: true }, "t", failed);
    await until(() => !!delivery.snapshot()?.complete);
    server.revoke();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11_000);
    delivery.follow(1);
    await until(() => failed.mock.calls.length > 0);
    expect(failed).toHaveBeenCalledWith(true);
    vi.restoreAllMocks();
  });

  it("accepts only original MP4 files with an index hint", () => {
    const source = { id: "s", provider: "local", mime: "video/mp4", streamUrl: "/files/a", bytes: 1000,
      playbackHints: { audioStart: 100 } } as never;
    expect(relayVideoFile(source, 10)).toEqual({ url: "/files/a", size: 1000, duration: 10, indexEnd: 100, tailStart: undefined, shared: undefined });
    expect(relayVideoFile({ ...(source as object), streamUrl: "/files/a/audio" } as never, 10)).toBeUndefined();
    expect(relayVideoFile({ ...(source as object), mime: "video/webm" } as never, 10)).toBeUndefined();
    expect(relayVideoFile(source, 0)).toBeUndefined();
  });
});
