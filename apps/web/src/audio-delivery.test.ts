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
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
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
    const downloaded = server.ranges.map(range => range.slice(6).split("-").map(Number)).sort((a,b) => a[0]-b[0]);
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
  it("does not start a retained prefix after an access check fails", async () => {
    const server = origin();
    const delivery = new AudioDelivery(server.fetcher);
    await delivery.prepare(file("a"));
    server.revoke();
    delivery.select(file("a"), "a");
    await expect(delivery.start()).rejects.toThrow();
    expect(server.ranges).toEqual(["bytes=0-99999"]);
  });
  it("rechecks access before serving previously retained bytes for another play", async () => {
    const server = origin();
    const delivery = new AudioDelivery(server.fetcher);
    await delivery.prepare(file("next"));
    server.revoke();
    delivery.select(file("next"), "new");
    await expect(delivery.response("new", "bytes=0-1")!.arrayBuffer()).rejects.toThrow();
    expect(delivery.response("old", null)).toBeUndefined();
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
      const [from,to] = range.slice(6).split("-").map(Number);
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
      const [from,to]=range.slice(6).split("-").map(Number);
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
  it("budgets five seconds of the next file and excludes shared, remote and oversized sources", () => {
    const own = { id: "s", provider: "local" as const, status: "available" as const,
      streamUrl: "/files/id", mime: "audio/mpeg", bytes: 1_000_000 };
    expect(ownedAudioFile(own, 10)?.prefix).toBe(500_000);
    expect(ownedAudioFile(own, 1)?.prefix).toBe(524_288);
    expect(ownedAudioFile({ ...own, shared: true }, 10)).toBeUndefined();
    expect(ownedAudioFile({ ...own, streamUrl: "/api/shares/x" }, 10)).toBeUndefined();
    expect(ownedAudioFile({ ...own, bytes: 1024 ** 3 }, 10)).toBeUndefined();
  });
});
