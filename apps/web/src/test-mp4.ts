// Test helper: builds small progressive MP4 files without sample payloads.
function box(name: string, ...parts: Uint8Array[]) {
  const length = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  new DataView(result.buffer).setUint32(0, length);
  result.set(new TextEncoder().encode(name), 4);
  let offset = 8;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function u32(...values: number[]) {
  const result = new Uint8Array(values.length * 4);
  values.forEach((value, i) => new DataView(result.buffer).setUint32(i * 4, value));
  return result;
}
const zeros = (n: number) => new Uint8Array(n);
const matrix = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

// A progressive MP4: one sample per chunk, video and audio interleaved in mdat.
export function progressiveMp4(frames: number, keyEvery: number, moovAtEnd = false) {
  const frameMs = 100, videoSize = (i: number) => 1000 + i, audioSize = 200;
  const header = box("ftyp", new TextEncoder().encode("isom"), u32(0), new TextEncoder().encode("isom"));
  function trak(id: number, video: boolean, offsets: number[]) {
    const sizes = offsets.map((_, i) => video ? videoSize(i) : audioSize);
    const entry = video
      ? box("avc1", zeros(6), new Uint8Array([0, 1]), zeros(16), new Uint8Array([0, 64, 0, 64]), u32(0x480000, 0x480000, 0),
        new Uint8Array([0, 1]), zeros(32), new Uint8Array([0, 24, 0xff, 0xff]))
      : box("mp4a", zeros(6), new Uint8Array([0, 1]), zeros(8), new Uint8Array([0, 2, 0, 16]), zeros(4), u32(1000 << 16));
    const keys = offsets.map((_, i) => i).filter(i => i % keyEvery === 0).map(i => i + 1);
    const stbl = box("stbl",
      box("stsd", u32(0, 1), entry),
      box("stts", u32(0, 1, frames, frameMs)),
      ...(video ? [box("stss", u32(0, keys.length, ...keys))] : []),
      box("stsc", u32(0, 1, 1, 1, 1)),
      box("stsz", u32(0, 0, frames, ...sizes)),
      box("stco", u32(0, frames, ...offsets)));
    return box("trak",
      box("tkhd", u32(3, 0, 0, id, 0, frames * frameMs, 0, 0, 0), video ? u32(0) : u32(0x01000000), matrix, u32(video ? 64 << 16 : 0, video ? 64 << 16 : 0)),
      box("mdia",
        box("mdhd", u32(0, 0, 0, 1000, frames * frameMs, 0x55c40000)),
        box("hdlr", u32(0, 0), new TextEncoder().encode(video ? "vide" : "soun"), zeros(13)),
        box("minf", stbl)));
  }
  function moov(mdatBody: number) {
    const video: number[] = [], audio: number[] = [];
    let at = mdatBody;
    for (let i = 0; i < frames; i++) { video.push(at); at += videoSize(i); audio.push(at); at += audioSize; }
    return box("moov",
      box("mvhd", u32(0, 0, 0, 1000, frames * frameMs, 0x10000), new Uint8Array([1, 0]), zeros(10), matrix, zeros(24), u32(3)),
      trak(1, true, video), trak(2, false, audio));
  }
  let payload = 0;
  for (let i = 0; i < frames; i++) payload += videoSize(i) + audioSize;
  const draft = moov(0).length;
  const mdatBody = header.length + (moovAtEnd ? 0 : draft) + 8;
  const index = moov(mdatBody);
  const mdat = box("mdat", zeros(payload));
  const parts = moovAtEnd ? [header, mdat, index] : [header, index, mdat];
  const file = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { file.set(part, offset); offset += part.length; }
  return { file, mdatBody, tailStart: moovAtEnd ? header.length + mdat.length : undefined };
}

