import { describe, expect, it, vi } from "vitest";
import { AudioDelivery, ownedAudioFile } from "./audio-delivery";

const bytes = Uint8Array.from({ length: 1_200_000 }, (_, i) => i % 251);
const file = (id: string) => ({
  url: "/files/" + id, size: bytes.length, mime: "audio/mpeg", prefix: 100_000,
});
function origin() {
  let allowed = true;
  const ranges: string[] = [];
  const fetcher = async (_: string, init: RequestInit) => {
    if (!allowed) return new Response(null, { status: 403 });
    if (init.method === "HEAD") return new Response(null, { headers: { "Content-Length": String(bytes.length) } });
    const range = new Headers(init.headers).get("Range")!;
    const [, a, last] = /^bytes=(\d+)-(\d*)$/.exec(range)!;
    const b = last || String(bytes.length - 1);
    ranges.push(range);
    return new Response(bytes.slice(+a, +b + 1), { status: 206, headers: {
      "Content-Range": `bytes ${a}-${b}/${bytes.length}`,
    } });
  };
  return { fetcher, ranges, revoke: () => { allowed = false; } };
}

describe("tab-local audio delivery", () => {
  it("reuses a prepared prefix, fills holes through EOF once and serves an offline suffix", async () => {
    const server = origin();
    const delivery = new AudioDelivery(server.fetcher);
    await delivery.prepare(file("next"));
    expect(server.ranges).toEqual(["bytes=0-99999"]);
    delivery.select(file("next"), "play");
    const response = delivery.response("play", "bytes=99997-100002")!;
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 99997-100002/1200000");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(99997, 100003));
    await delivery.fill();
    const downloaded = server.ranges.map(range => range.slice(6).split("-").map(n => n ? Number(n) : bytes.length - 1)).sort((a,b) => a[0]-b[0]);
    expect(server.ranges).toEqual(["bytes=0-99999", "bytes=100000-"]);
    expect(downloaded[0][0]).toBe(0);
    expect(downloaded.at(-1)![1]).toBe(bytes.length - 1);
    downloaded.slice(1).forEach(([start], i) => expect(start).toBe(downloaded[i][1] + 1));
    server.revoke();
    expect(new Uint8Array(await delivery.response("play", "bytes=-8")!.arrayBuffer())).toEqual(bytes.slice(-8));
    expect(delivery.response("play", "bytes=1200000-")!.status).toBe(416);
  });
  it("keeps a completed prefix while the current track is seeking", async () => {
    const server = origin();
    const delivery = new AudioDelivery(server.fetcher);
    await delivery.prepare(file("next"));
    delivery.suspendPreparation();
    await delivery.prepare(file("next"));
    delivery.select(file("next"), "next");
    expect(new Uint8Array(await delivery.response("next", "bytes=0-1")!.arrayBuffer())).toEqual(bytes.slice(0, 2));
    expect(server.ranges.filter(range => range.startsWith("bytes=0-"))).toHaveLength(1);
  });
  it("uses the browser fetch receiver for its default transport", async () => {
    const server = origin();
    vi.stubGlobal("fetch", function(this: unknown, url: string, init: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return server.fetcher(url, init);
    });
    try {
      const delivery = new AudioDelivery();
      delivery.select(file("current"), "token");
      expect(new Uint8Array(await delivery.response("token", "bytes=0-1")!.arrayBuffer())).toEqual(bytes.slice(0, 2));
      delivery.clear();
    } finally { vi.unstubAllGlobals(); }
  });
  it("starts the first origin read on a play intent and shares it with the later decoder request", async () => {
    const server = origin();
    const transport = vi.fn(server.fetcher);
    const delivery = new AudioDelivery(transport);
    delivery.select(file("a"), "a");
    expect(server.ranges).toEqual([]);
    await delivery.start();
    expect(server.ranges).toEqual(["bytes=0-99999"]);
    expect(transport.mock.calls[0][1].priority).toBe("high");
    expect(new Uint8Array(await delivery.response("a", "bytes=0-2")!.arrayBuffer())).toEqual(bytes.slice(0, 3));
    expect(server.ranges.filter(range => range === "bytes=0-99999")).toHaveLength(1);
  });
  it("promotes an owned prefix without HEAD and discards all bytes on denied refill", async () => {
    const server = origin();
    const transport = vi.fn(server.fetcher);
    const delivery = new AudioDelivery(transport);
    await delivery.prepare(file("a"));
    server.revoke();
    const failure = vi.fn();
    delivery.select(file("a"), "a", failure);
    await delivery.start();
    await expect(delivery.fill()).rejects.toThrow();
    expect(transport.mock.calls.some(([,init]) => init.method === "HEAD")).toBe(false);
    expect(failure).toHaveBeenCalledWith("denied");
    expect(delivery.response("a", null)).toBeUndefined();
  });
  it("serves a shared prefix while rechecking access, then drops it on revocation", async () => {
    const server = origin();
    let rejectAccess!: () => void;
    const delivery = new AudioDelivery((url, init) => init.method === "HEAD"
      ? new Promise(resolve => { rejectAccess = () => resolve(new Response(null, { status: 403 })); })
      : server.fetcher(url, init));
    const shared = { ...file("a"), shared: true };
    await delivery.prepare(shared);
    const failure = vi.fn();
    delivery.select(shared, "a", failure);
    await delivery.start();
    expect(new Uint8Array(await delivery.response("a", "bytes=0-3")!.arrayBuffer())).toEqual(bytes.slice(0,4));
    rejectAccess();
    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith("denied"));
    expect(delivery.response("a", null)).toBeUndefined();
  });
  it("prepares a successor only when the active file is complete", async () => {
    const server = origin();
    const transport = vi.fn(server.fetcher);
    const delivery = new AudioDelivery(transport);
    delivery.select(file("a"), "a");
    await delivery.start();
    await delivery.prepare(file("b"));
    expect(transport.mock.calls.map(([url]) => url)).toEqual(["/files/a"]);
    await delivery.fill();
    await delivery.prepare(file("b"));
    expect(transport.mock.calls.map(([url]) => url)).toEqual(["/files/a", "/files/a", "/files/b"]);
  });
  it("streams the first bytes before the origin finishes its first range", async () => {
    let finish!: () => void;
    const delivery = new AudioDelivery(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([42]));
        finish = () => { controller.enqueue(new Uint8Array(9)); controller.close(); };
      },
    }), { status: 206, headers: { "Content-Range": "bytes 0-9/10" } }));
    delivery.select({ ...file("a"), size: 10, prefix: 10 }, "token");
    const reader = delivery.response("token", null)!.body!.getReader();
    try { expect((await reader.read()).value).toEqual(new Uint8Array([42])); }
    finally { finish(); }
    expect((await reader.read()).value).toHaveLength(9);
  });
  it("aborts the superseded preparation and drops former playback tokens", async () => {
    const request = vi.fn(async (_: string, init: RequestInit) => new Promise<Response>((_, reject) =>
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
    const delivery = new AudioDelivery(request);
    const first = delivery.prepare(file("a"));
    const second = delivery.prepare(file("b"));
    expect(request.mock.calls[0][1].signal!.aborted).toBe(true);
    delivery.select(file("c"), "c");
    expect(request.mock.calls[1][1].signal!.aborted).toBe(true);
    delivery.clear();
    expect(delivery.response("c", null)).toBeUndefined();
    await Promise.all([first, second]);
  });
  it("does not start a discarded range until a consumer reads its stream", async () => {
    const server = origin();
    const delivery = new AudioDelivery(server.fetcher);
    delivery.select(file("a"), "a");
    const response = delivery.response("a", "bytes=10-20")!;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(server.ranges).toEqual([]);
    await response.body!.cancel();
  });
  it("cancels abandoned seeks while retaining received bytes and one background transfer", async () => {
    const pending = new Set<string>();
    const starts: number[] = [];
    const size = 15 * 1024 * 1024;
    const fetcher = async (_: string, init: RequestInit) => {
      const range = new Headers(init.headers).get("Range")!;
      const [from,to] = range.slice(6).split("-").map(n => n ? Number(n) : size - 1);
      starts.push(from);
      pending.add(range);
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(100));
          init.signal!.addEventListener("abort", () => { pending.delete(range); c.error(init.signal!.reason); });
        },
      });
      return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${from}-${to}/${size}` } });
    };
    const delivery = new AudioDelivery(fetcher);
    delivery.select({ ...file("big"), size, prefix: 1000 }, "big");
    for (let index = 1; index <= 8; index++) {
      const at = 1000 + index * 1024 * 1024;
      const reader = delivery.response("big", `bytes=${at}-`)!.body!.getReader();
      expect((await reader.read()).value).toHaveLength(100);
      expect(pending.size).toBe(1);
      await reader.cancel();
      expect(pending.size).toBeLessThanOrEqual(1);
    }
    const reader = delivery.response("big", "bytes=1049676-")!.body!.getReader();
    expect((await reader.read()).value).toHaveLength(100);
    expect(starts).toContain(1049676);
    delivery.clear();
    expect(pending.size).toBe(0);
  });
  it("prepares tail metadata for M4A within the same prefix budget and reuses it at playback", async () => {
    const media = new Uint8Array(bytes.length);
    const view = new DataView(media.buffer);
    view.setUint32(0, 24); media.set(new TextEncoder().encode("ftyp"),4);
    view.setUint32(24, 1_099_976); media.set(new TextEncoder().encode("mdat"),28);
    view.setUint32(1_100_000, 100_000); media.set(new TextEncoder().encode("moov"),1_100_004);
    const reads: string[] = [];
    const transport = async (_: string, init: RequestInit) => {
      if (init.method === "HEAD") return new Response(null,{headers:{"Content-Length":String(media.length)}});
      const range=new Headers(init.headers).get("Range")!; reads.push(range);
      const [from,to]=range.slice(6).split("-").map(n => n ? Number(n) : media.length - 1);
      return new Response(media.slice(from,to+1),{status:206,headers:{"Content-Range":`bytes ${from}-${to}/${media.length}`}});
    };
    const delivery=new AudioDelivery(transport);
    await delivery.prepare({ ...file("next"), mime: "audio/mp4" });
    expect(reads).toEqual(["bytes=0-99999","bytes=1100000-1199999"]);
    delivery.select({ ...file("next"), mime: "audio/mp4" }, "next");
    expect(await delivery.response("next", "bytes=1100004-1100007")!.text()).toBe("moov");
    await delivery.fill();
    expect(reads.filter(r=>r==="bytes=1100000-1199999")).toHaveLength(1);
  });
  it("budgets header plus ten seconds within 2 MiB and accepts local audio through 128 MiB", () => {
    const own = { id: "s", provider: "local" as const, status: "available" as const,
      streamUrl: "/files/id", mime: "audio/mpeg", bytes: 1_000_000 };
    expect(ownedAudioFile({ ...own, playbackHints: {audioStart: 200_000} }, 40)?.prefix).toBe(400_000);
    expect(ownedAudioFile({ ...own, bytes: 128 * 1024 ** 2 }, 1)?.prefix).toBe(2 * 1024 ** 2);
    expect(ownedAudioFile({ ...own, shared: true }, 10)).toBeUndefined();
    expect(ownedAudioFile({ ...own, streamUrl: "/api/shares/x" }, 10)).toBeUndefined();
    expect(ownedAudioFile({ ...own, bytes: 1024 ** 3 }, 10)).toBeUndefined();
  });
});

it("requests the indexed M4A tail immediately and fills the remaining gap once", async () => {
  const server = origin();
  const transport = vi.fn(server.fetcher);
  const delivery = new AudioDelivery(transport);
  delivery.select({...file("m4a"), tailStart: 1_100_000, audioStart: 32, mime: "audio/mp4"}, "a");
  const ready = delivery.start();
  expect(server.ranges).toEqual(expect.arrayContaining(["bytes=0-99999","bytes=1100000-1199999"]));
  await ready;
  await delivery.fill();
  expect(server.ranges.at(-1)).toBe("bytes=100000-1099999");
});

it("retries a stalled body after 10 seconds, preserving the bytes already received", async () => {
  vi.useFakeTimers();
  try {
    const server = origin();
    let stalled = true;
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      if (!stalled) return server.fetcher(url, init);
      stalled = false;
      return new Response(new ReadableStream({start(controller) {controller.enqueue(bytes.slice(0, 10));}}), {
        status: 206, headers: {"Content-Range": "bytes 0-99999/1200000"},
      });
    });
    const delivery = new AudioDelivery(transport);
    delivery.select(file("a"), "a");
    const start = delivery.start();
    await vi.advanceTimersByTimeAsync(9999);
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(201);
    await start;
    expect(server.ranges).toEqual(["bytes=10-99999"]);
    delivery.clear();
  } finally { vi.useRealTimers(); }
});

it("downloads a 50 MiB file in one prefix and one continuation and preserves its digest offline", async () => {
  const {createHash} = await import("node:crypto");
  const data = new Uint8Array(50 * 1024 ** 2);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const ranges: string[] = [];
  const delivery = new AudioDelivery(async (_, init) => {
    const range = new Headers(init.headers).get("Range")!;
    ranges.push(range);
    const [start, last] = range.slice(6).split("-");
    const end = last ? Number(last) : data.length - 1;
    return new Response(data.slice(+start, end + 1), {status:206,
      headers: {"Content-Range": `bytes ${start}-${end}/${data.length}`}});
  });
  const hash = (view: Uint8Array) => createHash("sha256").update(view).digest("hex");
  const file = ownedAudioFile({id:"a", provider:"local", status:"available", mime:"audio/mpeg",
    bytes:data.length, streamUrl:"/files/a", playbackHints:{audioStart:300000}}, 480)!;
  delivery.select(file, "large");
  await delivery.fill();
  const cached = new Uint8Array(await delivery.response("large", null)!.arrayBuffer());
  expect(hash(cached)).toBe(hash(data));
  expect(ranges).toEqual([`bytes=0-${file.prefix-1}`, `bytes=${file.prefix}-`]);
});

it("prioritizes a decoder seek into a gap and fills the skipped interval without changing any bytes", async () => {
  const server = origin();
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    if (new Headers(init.headers).get("Range") !== "bytes=100000-") return server.fetcher(url,init);
    return new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(100000, 120000));}}), {
      status:206, headers:{"Content-Range":"bytes 100000-1199999/1200000"},
    });
  });
  const delivery = new AudioDelivery(transport);
  delivery.select(file("a"), "seek");
  await delivery.start();
  const fill = delivery.fill();
  await vi.waitFor(() => expect(delivery.snapshot()?.ranges).toEqual([[0,120000]]));
  expect(new Uint8Array(await delivery.response("seek", "bytes=900000-900003")!.arrayBuffer())).toEqual(bytes.slice(900000,900004));
  await fill;
  const ranges = transport.mock.calls.map(([,init]) => new Headers(init.headers).get("Range"));
  expect(ranges).toEqual(["bytes=0-99999","bytes=100000-","bytes=900000-","bytes=120000-899999"]);
  const {createHash} = await import("node:crypto");
  const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
  expect(sha(new Uint8Array(await delivery.response("seek",null)!.arrayBuffer()))).toBe(sha(bytes));
});

it("detects large ID3v2 headers without indexed metadata for older files", async () => {
  const source = bytes.slice();
  const headerSize = 300_000;
  source.set([73,68,51,4,0,0,headerSize >> 21, (headerSize >> 14) & 127,(headerSize >> 7) & 127,headerSize & 127]);
  const ranges: string[]=[];
  const delivery = new AudioDelivery(async (_,init)=>{
    const range = new Headers(init.headers).get("Range")!;
    ranges.push(range);
    const [from,to] = range.slice(6).split("-").map(Number);
    return new Response(source.slice(from,to+1), {status:206, headers:{"Content-Range":`bytes ${from}-${to}/${source.length}`}});
  });
  const file = ownedAudioFile({id:"a",provider:"local",status:"available",streamUrl:"/files/a",mime:"audio/mpeg",bytes:source.length},120)!;
  await delivery.prepare(file);
  const expected = 300010 + Math.ceil(10*(source.length-300010)/120);
  expect(ranges).toEqual([`bytes=0-${file.prefix-1}`, `bytes=${file.prefix}-${expected-1}`]);
});

it.each([["audio_view_missing", "unsupported"], ["file_not_found", "denied"]])(
  "distinguishes unavailable virtual audio from revoked file access (%s)", async (code, reason) => {
    const delivery = new AudioDelivery(async () => Response.json({error: {code}}, {status:404}));
    const failure = vi.fn();
    delivery.select({...file("movie"),url:"/files/movie/audio"}, "token", failure);
    await expect(delivery.start()).rejects.toThrow();
    expect(failure).toHaveBeenCalledWith(reason);
    expect(delivery.response("token",null)).toBeUndefined();
  });
