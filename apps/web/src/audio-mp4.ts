import { updateSourceBuffer } from "./media-source-buffer";
import { playAudioFragments } from "./audio-fragments";
import type { AudioDelivery, AudioFile } from "./audio-delivery";

type Mp4Box = { type: string; body: number; end: number };
function readBox(data: Uint8Array, at: number, limit: number): Mp4Box {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const size = view.getUint32(at);
  const wide = size === 1;
  const length = wide ? Number(view.getBigUint64(at + 8)) : size || limit - at;
  const body = at + (wide ? 16 : 8), end = at + length;
  if (!Number.isSafeInteger(end) || body > end || end > limit) throw new Error("Invalid MP4 box");
  return { type: String.fromCharCode(...data.subarray(at + 4, at + 8)), body, end };
}
function boxes(data: Uint8Array, at: number, end: number) {
  const result: Mp4Box[] = [];
  while (at < end) {
    if (result.length >= 4096) throw new Error("Too many MP4 boxes");
    const box = readBox(data, at, end);
    result.push(box);
    at = box.end;
  }
  return result;
}

// The Apple media parser accepts progressive M4A in a SourceBuffer when the movie
// index precedes mdat. Move just the index; all original sample bytes stay intact.
export function prepareM4aHeader(ftyp: Uint8Array, tail: Uint8Array, tailStart: number) {
  try {
    if (readBox(ftyp, 0, ftyp.length).type !== "ftyp") return;
    const movie = readBox(tail, 0, tail.length);
    if (movie.type !== "moov") return;
    const moov = tail.slice(0, movie.end);
    const children = (parent: Mp4Box) => boxes(moov, parent.body, parent.end);
    const tracks = children(movie).filter(box => box.type === "trak");
    if (tracks.length !== 1) return;
    let parent = tracks[0]!;
    for (const type of ["mdia", "minf", "stbl"]) {
      const child = children(parent).find(box => box.type === type);
      if (!child) return;
      parent = child;
    }
    const tables = children(parent);
    const formats = tables.find(box => box.type === "stsd");
    if (!formats) return;
    const entries = boxes(moov, formats.body + 8, formats.end);
    if (entries.length !== 1 || entries[0]?.type !== "mp4a") return;
    const offsets = tables.filter(box => box.type === "stco" || box.type === "co64");
    if (offsets.length !== 1) return;
    const table = offsets[0]!;
    const view = new DataView(moov.buffer);
    const count = view.getUint32(table.body + 4);
    const wide = table.type === "co64", width = wide ? 8 : 4;
    if (!count || table.body + 8 + count * width !== table.end) return;
    for (let at = table.body + 8; at < table.end; at += width) {
      const old = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
      if (old < ftyp.length || old >= tailStart) return;
      if (wide) view.setBigUint64(at, BigInt(old + moov.length));
      else view.setUint32(at, old + moov.length);
    }
    const header = new Uint8Array(ftyp.length + moov.length);
    header.set(ftyp);
    header.set(moov, ftyp.length);
    return header;
  } catch { return; }
}

export function canUseM4aSource(file?: AudioFile) {
  if (!file || !/^(audio\/mp4|audio\/x-m4a)$/.test(file.mime) ||
      file.audioStart === undefined || typeof MediaSource === "undefined") return false;
  if (navigator.vendor === "Apple Computer, Inc.") return (!file.tailStart || file.size - file.tailStart <= 2 * 1024 * 1024) &&
    MediaSource.isTypeSupported("audio/mp4");
  return navigator.vendor === "Google Inc." && !file.tailStart && file.size > 32 * 1024 ** 2 &&
    file.audioStart >= 256 * 1024 && file.audioStart <= 2 * 1024 ** 2 &&
    MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"');
}

export function attachM4aSource(
  element: HTMLMediaElement, file: AudioFile, delivery: AudioDelivery, token: string, fallback: () => void,
) {
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  const lifetime = new AbortController();
  const {signal} = lifetime;
  let started = false, reading = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const read = (range: string) => {
    const response = delivery.response(token, range);
    if (response?.status !== 206 || !response.body) throw new Error("Unavailable audio range");
    return response;
  };
  async function pump() {
    if (!started || reading || source.readyState !== "open") return;
    reading = true;
    try {
      if (navigator.vendor === "Google Inc.") {
        await playAudioFragments(element, source, file, read, signal);
        return;
      }
      let start = 0;
      const end = file.tailStart ?? file.size;
      const buffer = source.addSourceBuffer("audio/mp4");
      if (file.duration && Number.isFinite(file.duration)) source.duration = file.duration;
      const append = (data: Uint8Array<ArrayBuffer>) =>
        updateSourceBuffer(buffer, signal, () => buffer.appendBuffer(data));
      if (file.tailStart) {
        const prefix = new Uint8Array(await read("bytes=0-15").arrayBuffer());
        const first = readBox(prefix, 0, file.size);
        if (first.type !== "ftyp" || first.end > 4096) throw new Error("Unsupported MP4 prefix");
        const [ftyp, tail] = await Promise.all([
          read(`bytes=0-${first.end - 1}`).arrayBuffer(),
          read(`bytes=${file.tailStart}-`).arrayBuffer(),
        ]);
        const relocated = prepareM4aHeader(new Uint8Array(ftyp), new Uint8Array(tail), file.tailStart);
        if (!relocated) throw new Error("Unsupported MP4 index");
        await append(relocated);
        start = first.end;
      }
      signal.throwIfAborted();
      reader = read(`bytes=${start}-${end - 1}`).body!.getReader();
      let offset = start;
      const probeEnd = Math.max(file.prefix, file.audioStart ?? 0) + 256 * 1024;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        // AudioDelivery returns a private, non-shared page for every read.
        await append(chunk.value as Uint8Array<ArrayBuffer>);
        offset += chunk.value.length;
        if (offset >= probeEnd && !buffer.buffered.length) throw new Error("Unsupported progressive audio");
      }
      if (!signal.aborted && source.readyState === "open") source.endOfStream();
    } catch { if (!signal.aborted) fallback(); }
  }
  source.addEventListener("sourceopen", pump);
  element.src = url;
  return {
    start() { started = true; void pump(); },
    close() {
      lifetime.abort();
      source.removeEventListener("sourceopen", pump);
      void reader?.cancel().catch(() => {});
      URL.revokeObjectURL(url);
    },
  };
}
