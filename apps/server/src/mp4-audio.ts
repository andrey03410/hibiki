import type { FileHandle } from "node:fs/promises";

export const audioViewVersion = 2;
const supportedEntries = new Set(["mp4a", "Opus", "fLaC"]);
const maxMoovBytes = 32 * 1024 ** 2;
const maxChunks = 500_000;
const readSize = 256 * 1024;

class InvalidMp4 extends Error {}
function check(condition: unknown): asserts condition {
  if (!condition) throw new InvalidMp4();
}

export async function readBytes(file: FileHandle, position: number, length: number) {
  const data = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(data, done, length - done, position + done);
    if (!bytesRead) throw new Error("Файл изменился во время чтения");
    done += bytesRead;
  }
  return data;
}

type BoxHeader = { type: string; start: number; body: number; end: number };
function header(data: Buffer, offset: number, start: number, limit: number): BoxHeader {
  const type = data.toString("latin1", offset + 4, offset + 8);
  const small = data.readUInt32BE(offset);
  const length = small === 1 ? Number(data.readBigUInt64BE(offset + 8)) : small || limit - start;
  const body = start + (small === 1 ? 16 : 8);
  const end = start + length;
  check(Number.isSafeInteger(end) && body <= end && end <= limit);
  return { type, start, body, end };
}

export async function topLevelBoxes(file: FileHandle, size: number) {
  const result: BoxHeader[] = [];
  try {
    for (let offset = 0; offset < size;) {
      check(result.length < 4096 && size - offset >= 8);
      let data = await readBytes(file, offset, 8);
      if (data.readUInt32BE() === 1) {
        check(size - offset >= 16);
        data = Buffer.concat([data, await readBytes(file, offset + 8, 8)]);
      }
      const box = header(data, 0, offset, size);
      result.push(box);
      offset = box.end;
    }
    return result;
  } catch (error) {
    if (error instanceof InvalidMp4 || error instanceof RangeError) return [];
    throw error;
  }
}

type Box = { type: string; body: Buffer; raw: Buffer };
function children(data: Buffer): Box[] {
  const list: Box[] = [];
  for (let start = 0; start < data.length;) {
    check(list.length < 4096 && data.length - start >= 8);
    const box = header(data, start, start, data.length);
    list.push({ type: box.type, raw: data.subarray(start, box.end), body: data.subarray(box.body, box.end) });
    start = box.end;
  }
  return list;
}
function child(boxes: Box[], type: string) {
  const found = boxes.find(box => box.type === type);
  check(found);
  return found;
}
function prefix(type: string, size: number) {
  const wide = size + 8 > 0xffffffff;
  const result = Buffer.alloc(wide ? 16 : 8);
  result.writeUInt32BE(wide ? 1 : size + 8);
  result.write(type, 4, 4, "latin1");
  if (wide) result.writeBigUInt64BE(BigInt(size + 16), 8);
  return result;
}
function box(type: string, parts: Buffer[]) {
  return Buffer.concat([prefix(type, parts.reduce((size, b) => size + b.length, 0)), ...parts]);
}
function replace(boxes: Box[], type: string, content: Buffer) {
  return boxes.map(b => b.type === type ? content : b.raw);
}
export function chunkOffsetBox(offsets: number[]) {
  const wide = offsets.some(offset => offset > 0xffffffff);
  const width = wide ? 8 : 4;
  const values = Buffer.alloc(8 + width * offsets.length);
  values.writeUInt32BE(offsets.length, 4);
  for (let i = 0; i < offsets.length; i++) {
    if (wide) values.writeBigUInt64BE(BigInt(offsets[i]), 8 + i * width);
    else values.writeUInt32BE(offsets[i], 8 + i * width);
  }
  return box(wide ? "co64" : "stco", [values]);
}
type Slice = { virtual: number; source: number; length: number };
export type AudioView = { header: Buffer; slices: Slice[]; bytes: number };

function parseTrack(trak: Box) {
  const track = children(trak.body);
  const mdia = children(child(track, "mdia").body);
  if (child(mdia, "hdlr").body.toString("ascii", 8, 12) !== "soun") return;
  return { track, mdia, tkhd: child(track, "tkhd").body };
}
function movieDuration(mvhd: Buffer, tkhd: Buffer) {
  check(mvhd[0] <= 1 && tkhd[0] <= 1);
  const duration = tkhd[0] === 1 ? tkhd.readBigUInt64BE(28) : BigInt(tkhd.readUInt32BE(20));
  const movie = Buffer.from(mvhd);
  if (movie[0] === 1) movie.writeBigUInt64BE(duration, 24);
  else if (duration <= 0xffffffffn) movie.writeUInt32BE(Number(duration), 16);
  else throw new InvalidMp4();
  return box("mvhd", [movie]);
}
function parseMoov(data: Buffer, mdats: BoxHeader[]): AudioView {
  const movie = children(data);
  check(!movie.some(b => b.type === "mvex"));
  const tracks = movie.filter(b => b.type === "trak").map(parseTrack).filter(t => t !== undefined);
  const selected = tracks.find(t => t.tkhd.readUInt32BE(0) & 1) ?? tracks[0];
  check(selected);
  const { track, mdia, tkhd } = selected;
  const minf = children(child(mdia, "minf").body);
  const stbl = children(child(minf, "stbl").body);
  const stsd = child(stbl, "stsd").body;
  const descriptions = children(stsd.subarray(8));
  check(descriptions.length === stsd.readUInt32BE(4) && descriptions.length > 0 &&
    descriptions.every(d => supportedEntries.has(d.type) && d.body.readUInt16BE(6) === 1));
  // Keep only tracks whose samples refer to the current file.
  const dref = child(children(child(minf, "dinf").body), "dref").body;
  const ref = children(dref.subarray(8))[0];
  check(ref?.type === "url " && (ref.body.readUInt32BE(0) & 1));
  const offsets = child(stbl, stbl.some(b => b.type === "co64") ? "co64" : "stco");
  const width = offsets.type === "co64" ? 8 : 4;
  const count = offsets.body.readUInt32BE(4);
  check(count > 0 && count <= maxChunks && offsets.body.length === 8 + count * width);
  const stsc = child(stbl, "stsc").body;
  const rows = stsc.readUInt32BE(4);
  check(rows > 0 && rows <= count && stsc.length === 8 + 12 * rows && stsc.readUInt32BE(8) === 1);
  const stsz = child(stbl, "stsz").body;
  const fixed = stsz.readUInt32BE(4);
  const samples = stsz.readUInt32BE(8);
  check(samples > 0 && stsz.length === 12 + (fixed ? 0 : samples * 4));

  let sample = 0, row = 0, payload = 0, mdat = 0;
  const chunkStarts: number[] = [];
  const slices: Slice[] = [];
  for (let i = 0; i < count; i++) {
    if (row + 1 < rows && stsc.readUInt32BE(8 + (row + 1) * 12) === i + 1) row++;
    const n = stsc.readUInt32BE(12 + row * 12);
    const description = stsc.readUInt32BE(16 + row * 12);
    check(n > 0 && sample + n <= samples && description >= 1 && description <= descriptions.length);
    let length = n * fixed;
    if (!fixed) for (let s = sample; s < sample + n; s++) length += stsz.readUInt32BE(12 + s * 4);
    sample += n;
    const source = width === 8 ? Number(offsets.body.readBigUInt64BE(8 + i * 8)) : offsets.body.readUInt32BE(8 + i * 4);
    while (mdat < mdats.length && source >= mdats[mdat].end) mdat++;
    check(Number.isSafeInteger(source + length) && mdat < mdats.length &&
      source >= mdats[mdat].body && source + length <= mdats[mdat].end && length > 0);
    chunkStarts.push(payload);
    const prev = slices.at(-1);
    check(!prev || source >= prev.source + prev.length);
    if (prev && source === prev.source + prev.length) prev.length += length;
    else slices.push({ virtual: payload, source, length });
    payload += length;
  }
  check(sample === samples && row === rows - 1);
  const mvhd = movieDuration(child(movie, "mvhd").body, tkhd);
  const ftyp = box("ftyp", [Buffer.from("M4A \0\0\0\0M4A isommp42", "latin1")]);
  const mdatHeader = prefix("mdat", payload);
  function makeHeader(base: number) {
    const co = chunkOffsetBox(chunkStarts.map(offset => offset + base));
    const table = box("stbl", replace(stbl, offsets.type, co));
    const mediaInfo = box("minf", replace(minf, "stbl", table));
    const media = box("mdia", replace(mdia, "minf", mediaInfo));
    const audio = box("trak", replace(track.filter(b => b.type !== "tref"), "mdia", media));
    const moov = box("moov", [mvhd, audio, ...movie.filter(b => b.type === "udta").map(b => b.raw)]);
    return Buffer.concat([ftyp, moov, mdatHeader]);
  }
  let head = makeHeader(0);
  let base = head.length;
  head = makeHeader(base);
  if (head.length !== base) { base = head.length; head = makeHeader(base); }
  for (const span of slices) span.virtual += base;
  return { header: head, slices, bytes: base + payload };
}

export async function buildAudioView(file: FileHandle, size: number, boxes?: BoxHeader[]) {
  const top = boxes ?? await topLevelBoxes(file, size);
  const moov = top.find(b => b.type === "moov");
  if (!moov || moov.end - moov.body > maxMoovBytes || top.some(b => b.type === "moof")) return null;
  try {
    return parseMoov(await readBytes(file, moov.body, moov.end - moov.body), top.filter(b => b.type === "mdat"));
  } catch (error) {
    if (error instanceof InvalidMp4 || error instanceof RangeError) return null;
    throw error;
  }
}

export async function* readAudioRange(file: FileHandle, view: AudioView, start: number, end: number) {
  if (start < view.header.length) {
    yield view.header.subarray(start, end + 1);
    start = view.header.length;
  }
  if (start > end) return;
  const spans = view.slices;
  let i = 0, hi = spans.length;
  while (i < hi) {
    const mid = (i + hi) >>> 1;
    if (spans[mid].virtual + spans[mid].length <= start) i = mid + 1;
    else hi = mid;
  }
  while (start <= end) {
    const sourceStart = spans[i].source + start - spans[i].virtual;
    const parts: Array<{ from: number; length: number }> = [];
    let sourceEnd = sourceStart;
    // Read interleaved chunks together, then emit only the requested audio bytes.
    while (i < spans.length && start <= end) {
      const span = spans[i];
      const skip = start - span.virtual;
      const pos = span.source + skip;
      const length = Math.min(span.length - skip, end + 1 - start, sourceStart + readSize - pos);
      if (length <= 0) break;
      parts.push({ from: pos - sourceStart, length });
      sourceEnd = pos + length;
      start += length;
      if (skip + length < span.length) break;
      i++;
    }
    const data = await readBytes(file, sourceStart, sourceEnd - sourceStart);
    yield parts.length === 1 ? data : Buffer.concat(parts.map(p => data.subarray(p.from, p.from + p.length)));
  }
}
