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
  return Buffer.concat(boxParts(type, parts));
}
function boxParts(type: string, parts: Buffer[]) {
  return [prefix(type, parts.reduce((size, part) => size + part.length, 0)), ...parts];
}
function replace(boxes: Box[], type: string, contents: Buffer[]) {
  const index = boxes.findIndex(b => b.type === type);
  check(index >= 0 && index === boxes.findLastIndex(b => b.type === type));
  const parts = boxes.map(b => b.raw);
  parts.splice(index, 1, ...contents);
  return parts;
}
function offsetTable(count: number, wide: boolean) {
  const table = Buffer.alloc(16 + count * (wide ? 8 : 4));
  table.writeUInt32BE(table.length, 0);
  table.write(wide ? "co64" : "stco", 4);
  table.writeUInt32BE(count, 12);
  return table;
}
function writeOffsets(table: Buffer, offsets: ArrayLike<number>, base: number) {
  const data = new DataView(table.buffer, table.byteOffset, table.byteLength);
  if (table.length === 16 + offsets.length * 4) {
    for (let i = 0; i < offsets.length; i++) data.setUint32(16 + i * 4, offsets[i] + base);
  } else {
    for (let i = 0; i < offsets.length; i++) data.setBigUint64(16 + i * 8, BigInt(offsets[i] + base));
  }
}
type Slice = { virtual: number; source: number; length: number };
export type AudioView = { header: Buffer; slices: Slice[]; bytes: number };

function parseTrack(trak: Box, handler: string) {
  const track = children(trak.body);
  const mdia = children(child(track, "mdia").body);
  if (child(mdia, "hdlr").body.toString("ascii", 8, 12) !== handler) return;
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
// Only the offset width can change the layout. Resolve it before filling the table or copying file bytes.
export function buildHeader(chunkStarts: Float64Array, layout: (table: Buffer) => Buffer[]) {
  const last = chunkStarts[chunkStarts.length - 1];
  const wide = last > 0xffffffff;
  let table = offsetTable(chunkStarts.length, wide);
  let parts = layout(table);
  let base = parts.reduce((sum, part) => sum + part.length, 0);
  if (!wide && base + last > 0xffffffff) {
    table = offsetTable(chunkStarts.length, true);
    parts = layout(table);
    base = parts.reduce((sum, part) => sum + part.length, 0);
  }
  writeOffsets(table, chunkStarts, base);
  return { head: Buffer.concat(parts, base), base };
}
function parseMoov(data: Buffer, mdats: BoxHeader[], videoIndex?: number) {
  const movie = children(data);
  check(!movie.some(b => b.type === "mvex"));
  const traks = movie.filter(b => b.type === "trak");
  const tracks = traks.map(t => parseTrack(t, videoIndex === undefined ? "soun" : "vide"));
  const selected = videoIndex === undefined ? tracks.find(t => t && (t.tkhd.readUInt32BE(0) & 1)) ?? tracks.find(Boolean)
    : tracks[videoIndex];
  check(selected);
  const { track, mdia, tkhd } = selected;
  const minf = children(child(mdia, "minf").body);
  const stbl = children(child(minf, "stbl").body);
  const stsd = child(stbl, "stsd").body;
  const descriptions = children(stsd.subarray(8));
  check(descriptions.length === stsd.readUInt32BE(4) && descriptions.length > 0 &&
    descriptions.every(d => (videoIndex === undefined ? supportedEntries.has(d.type) : ["avc1", "avc3"].includes(d.type)) && d.body.readUInt16BE(6) === 1));
  // Keep only tracks whose samples refer to the current file.
  const dref = child(children(child(minf, "dinf").body), "dref").body;
  const ref = children(dref.subarray(8))[0];
  check(ref?.type === "url " && (ref.body.readUInt32BE(0) & 1));
  const offsetBoxes = stbl.filter(b => b.type === "stco" || b.type === "co64");
  check(offsetBoxes.length === 1);
  const offsets = offsetBoxes[0];
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

  let sample = 0, payload = 0, mdat = 0;
  const chunkStarts = new Float64Array(count);
  const slices: Slice[] = [];
  const sizes = new DataView(stsz.buffer, stsz.byteOffset, stsz.byteLength);
  const positions = new DataView(offsets.body.buffer, offsets.body.byteOffset, offsets.body.byteLength);
  for (let row = 0; row < rows; row++) {
    const first = stsc.readUInt32BE(8 + row * 12) - 1;
    const end = row + 1 < rows ? stsc.readUInt32BE(8 + (row + 1) * 12) - 1 : count;
    const n = stsc.readUInt32BE(12 + row * 12);
    const description = stsc.readUInt32BE(16 + row * 12);
    check(first >= 0 && end > first && end <= count && n > 0 && n * (end - first) <= samples - sample &&
      description >= 1 && description <= descriptions.length);
    for (let i = first; i < end; i++) {
      let length = n * fixed;
      if (!fixed) {
        for (let s = sample; s < sample + n; s++) length += sizes.getUint32(12 + s * 4);
      }
      sample += n;
      const source = width === 4 ? positions.getUint32(8 + i * 4) : Number(positions.getBigUint64(8 + i * 8));
      while (mdat < mdats.length && source >= mdats[mdat].end) mdat++;
      check(Number.isSafeInteger(source + length) && mdat < mdats.length &&
        source >= mdats[mdat].body && source + length <= mdats[mdat].end && length > 0);
      chunkStarts[i] = payload;
      const prev = slices[slices.length - 1];
      check(!prev || source >= prev.source + prev.length);
      if (prev && source === prev.source + prev.length) prev.length += length;
      else slices.push({ virtual: payload, source, length });
      payload += length;
    }
  }
  check(sample === samples);
  const mvhd = movieDuration(child(movie, "mvhd").body, tkhd);
  const isVideo = videoIndex !== undefined;
  const ftyp = box("ftyp", [Buffer.from(isVideo ? "isom\0\0\0\0isomiso2avc1mp41" : "M4A \0\0\0\0M4A isommp42", "latin1")]);
  const mdatHeader = prefix("mdat", payload);
  const configBoxes = (description: Box) => children(description.body.subarray(78))
    .filter(b => ["avcC", "pasp", "colr", "clap", "fiel", "mdcv", "clli"].includes(b.type));
  const keep = (boxes: Box[], types: string[]) => isVideo ? boxes.filter(b => types.includes(b.type)) : boxes;
  const sampleTable = keep(stbl, ["stsd", "stts", "ctts", "stss", "stsc", "stsz", "stco", "co64", "sdtp", "sgpd", "sbgp"]);
  const mediaInfoBoxes = keep(minf, ["vmhd", "dinf", "stbl"]);
  const mediaBoxes = keep(mdia, ["mdhd", "hdlr", "minf"]);
  const trackBoxes = keep(track, ["tkhd", "edts", "mdia"]).filter(b => b.type !== "tref");
  if (isVideo) {
    const sanitize = (boxes: Box[], type: string, body: Buffer[]) => {
      const index = boxes.findIndex(b => b.type === type);
      if (index >= 0) boxes[index] = { ...boxes[index], raw: box(type, body) };
    };
    const samples = descriptions.map(d => {
      const fields = Buffer.from(d.body.subarray(0, 78));
      fields.fill(0, 42, 74); // Optional compressor name is arbitrary donor text.
      return box(d.type, [fields, ...configBoxes(d).map(b => b.raw)]);
    });
    sanitize(sampleTable, "stsd", [stsd.subarray(0,8), ...samples]);
    sanitize(mediaInfoBoxes, "dinf", [box("dref", [Buffer.from([0,0,0,0,0,0,0,1]), box("url ", [Buffer.from([0,0,0,1])])])]);
    sanitize(mediaBoxes, "hdlr", [Buffer.alloc(8), Buffer.from("vide"), Buffer.alloc(13)]);
    const edts = trackBoxes.find(b => b.type === "edts");
    if (edts) sanitize(trackBoxes, "edts", [child(children(edts.body), "elst").raw]);
    for (const [boxes,type] of [[trackBoxes,"tkhd"], [mediaBoxes,"mdhd"]] as const) {
      const fields = Buffer.from(child(boxes,type).body);
      fields.fill(0,4,fields[0] === 1 ? 20 : 12);
      sanitize(boxes,type,[fields]);
    }
    mvhd.fill(0,12,mvhd[8] === 1 ? 28 : 20);
  }
  function layout(co: Buffer) {
    const table = boxParts("stbl", replace(sampleTable, offsets.type, [co]));
    const mediaInfo = boxParts("minf", replace(mediaInfoBoxes, "stbl", table));
    const media = boxParts("mdia", replace(mediaBoxes, "minf", mediaInfo));
    const selectedTrack = boxParts("trak", replace(trackBoxes, "mdia", media));
    const moov = boxParts("moov", [mvhd, ...selectedTrack, ...movie.filter(b => !isVideo && b.type === "udta").map(b => b.raw)]);
    return [ftyp, ...moov, mdatHeader];
  }
  const { head, base } = buildHeader(chunkStarts, layout);
  for (const span of slices) span.virtual += base;
  const movieHeader = child(movie, "mvhd").body;
  const timescale = movieHeader.readUInt32BE(movieHeader[0] === 1 ? 20 : 12);
  const trackDuration = tkhd[0] === 1 ? Number(tkhd.readBigUInt64BE(28)) : tkhd.readUInt32BE(20);
  const mdhd = child(mdia, "mdhd").body;
  // Chunk boundaries and offsets change when adding a soundtrack. Sample timing,
  // presentation geometry and codec configuration identify the displayed video.
  const identity = isVideo ? [
    mdhd.subarray(mdhd[0] === 1 ? 20 : 12, mdhd[0] === 1 ? 24 : 16),
    tkhd.subarray(tkhd[0] === 1 ? 52 : 40),
    ...descriptions.flatMap(d => [
      Buffer.from(d.type), d.body.subarray(24,40), d.body.subarray(74,78),
      ...configBoxes(d).map(b => b.raw),
    ]),
    ...["stts","ctts","stss","stsz","sdtp","sgpd","sbgp"].flatMap(t => stbl.filter(b => b.type === t).map(b => b.raw)),
    ...trackBoxes.filter(b => b.type === "edts").map(b => b.raw),
    movieHeader.subarray(movieHeader[0] === 1 ? 20 : 12, movieHeader[0] === 1 ? 24 : 16),
  ] : [];
  return { header: head, slices, bytes: base + payload, duration: trackDuration / timescale, identity };
}

export async function buildAudioView(file: FileHandle, size: number, boxes?: BoxHeader[]) {
  return buildTrackView(file, size, undefined, boxes);
}
export async function buildVideoView(file: FileHandle, size: number, streamIndex: number) {
  return buildTrackView(file, size, streamIndex);
}
async function buildTrackView(file: FileHandle, size: number, index?: number, boxes?: BoxHeader[]) {
  const top = boxes ?? await topLevelBoxes(file, size);
  const moov = top.find(b => b.type === "moov");
  if (!moov || moov.end - moov.body > maxMoovBytes || top.some(b => b.type === "moof")) return null;
  try {
    return parseMoov(await readBytes(file, moov.body, moov.end - moov.body), top.filter(b => b.type === "mdat"), index);
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
