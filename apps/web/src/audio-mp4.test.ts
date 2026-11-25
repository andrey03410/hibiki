import { describe, expect, it, vi } from "vitest";
import { canUseM4aSource, prepareM4aHeader } from "./audio-mp4";

function box(name: string, ...parts: Uint8Array[]) {
  const length = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  new DataView(result.buffer).setUint32(0, length);
  result.set(new TextEncoder().encode(name), 4);
  let offset = 8;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function headers(wide: boolean, offset = 35) {
  const type = box("ftyp", new TextEncoder().encode("M4A "));
  const entries = new Uint8Array(wide ? 16 : 12);
  const table = new DataView(entries.buffer);
  table.setUint32(4, 1);
  if (wide) table.setBigUint64(8, BigInt(offset));
  else table.setUint32(8, offset);
  const codec = new Uint8Array(8);
  new DataView(codec.buffer).setUint32(4, 1);
  const stbl = box("stbl",box("stsd", codec, box("mp4a")),box(wide ? "co64" : "stco", entries));
  const moov = box("moov",box("trak",box("mdia",box("minf",stbl))));
  return {type, moov};
}
describe("progressive WebKit M4A header", () => {
  it.each([false,true])("moves the movie index ahead of mdat preserving sample addresses (wide=%s)", wide => {
    const {type, moov} = headers(wide);
    const before = moov.slice();
    const head = prepareM4aHeader(type, moov, 500)!;
    expect(moov).toEqual(before);
    expect(head.subarray(0, type.length)).toEqual(type);
    const table = new DataView(head.buffer);
    const at = head.length - (wide ? 8 : 4);
    expect(wide ? Number(table.getBigUint64(at)) : table.getUint32(at)).toBe(35 + moov.length);
  });
  it("declines chunk tables that refer outside the preceding media or a truncated index", () => {
    const {type,moov} = headers(false,999);
    expect(prepareM4aHeader(type,moov,500)).toBeUndefined();
    expect(prepareM4aHeader(type,moov.subarray(0,moov.length-1),1000)).toBeUndefined();
  });
});

it("enables Chromium fragment delivery only for a large fast-start M4A with a substantial known index", () => {
  vi.stubGlobal("navigator", { vendor: "Google Inc." });
  vi.stubGlobal("MediaSource", { isTypeSupported: (mime: string) => mime.includes("mp4a.40.2") });
  const large = { url: "/files/large", size: 55_704_700, mime: "audio/mp4", prefix: 776194, audioStart: 616194 };
  try {
    expect(canUseM4aSource(large)).toBe(true);
    expect(canUseM4aSource({...large, size: 8_000_000})).toBe(false);
    expect(canUseM4aSource({...large, audioStart: 16_000})).toBe(false);
    expect(canUseM4aSource({...large, tailStart: 55_000_000})).toBe(false);
    expect(canUseM4aSource({...large, mime: "audio/mpeg"})).toBe(false);
  } finally { vi.unstubAllGlobals(); }
});

it("keeps filling the original after WebKit has enough decoded audio, then trims and resumes on playback", async () => {
  const { AudioDelivery } = await import("./audio-delivery");
  const { attachM4aSource } = await import("./audio-mp4");
  const media = Object.assign(new EventTarget(), { src: "", currentTime: 0 });
  const native = new EventTarget();
  let ahead = 0, first = 0, appends = 0, removals = 0;
  const buffer = Object.assign(native, {
    buffered: { get length() { return ahead ? 1 : 0; }, start: () => first, end: () => ahead },
    appendBuffer() {
      if (ahead - first >= 120) throw new DOMException("Decoder quota", "QuotaExceededError");
      appends++;
      ahead += 60;
      queueMicrotask(() => native.dispatchEvent(new Event("updateend")));
    },
    remove(_start: number, until: number) {
      removals++;
      first = until;
      queueMicrotask(() => native.dispatchEvent(new Event("updateend")));
    },
  });
  vi.stubGlobal("navigator", {vendor:"Apple Computer, Inc."});
  vi.stubGlobal("MediaSource", class extends EventTarget {
    readyState = "open";
    addSourceBuffer() { return buffer; }
    endOfStream() {}
  });
  const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  const original = new Uint8Array(1024 * 1024);
  const file = {url:"/files/long", size:original.length, mime:"audio/mp4", prefix:64*1024, audioStart:0, duration:600};
  const delivery = new AudioDelivery(async (_url, init) => {
    const [start, last] = new Headers(init.headers).get("Range")!.slice(6).split("-");
    const end = last ? Number(last)+1 : original.length;
    return new Response(original.slice(Number(start),end), {status:206,headers:{"Content-Range":`bytes ${start}-${end-1}/${original.length}`}});
  });
  const fallback = vi.fn();
  delivery.select(file,"owner");
  const session = attachM4aSource(media as unknown as HTMLMediaElement, file, delivery, "owner", fallback);
  try {
    session.start();
    await delivery.fill();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(appends).toBe(2);
    expect(delivery.snapshot()?.complete).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    media.currentTime = 85;
    media.dispatchEvent(new Event("timeupdate"));
    await vi.waitFor(() => expect(appends).toBe(3));
    expect(removals).toBe(1);
    expect(fallback).not.toHaveBeenCalled();
  } finally { session.close(); delivery.clear(); objectUrl.mockRestore(); vi.unstubAllGlobals(); }
});
