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
