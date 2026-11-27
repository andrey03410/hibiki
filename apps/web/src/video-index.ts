// Sample tables of an MP4 movie. A native decoder reads interleaved samples of all
// tracks in file order, so a time window maps to one contiguous byte range.
export type TrackTable = {
  kind: "video" | "audio" | "other";
  time: Float64Array; // Decode start, seconds.
  end: Float64Array; // Decode end, seconds.
  offset: Float64Array;
  size: Float64Array;
  sync?: Uint8Array; // Video only: 1 for a key frame.
};
export type VideoIndex = { duration: number; tracks: TrackTable[] };
export type ByteRange = readonly [number, number]; // Half-open.
export type TimeRanges2 = [number, number][];

function firstAtOrAfter(values: Float64Array, value: number) {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function videoTrack(index: VideoIndex) {
  return index.tracks.find(track => track.kind === "video");
}

// The key frame at or before a moment. Its bytes are needed to decode the moment.
export function keyFrameTime(index: VideoIndex, at: number) {
  const video = videoTrack(index);
  if (!video?.sync || !video.time.length) return 0;
  let i = Math.min(video.time.length - 1, Math.max(0, firstAtOrAfter(video.time, at + 1e-6) - 1));
  while (i > 0 && !video.sync[i]) i--;
  return video.time[i]!;
}

// Bytes holding every sample decoded between the key frame before `from` and `to`.
export function windowBytes(index: VideoIndex, from: number, to: number): ByteRange | undefined {
  const start = keyFrameTime(index, Math.max(0, from));
  let lo = Infinity, hi = -Infinity;
  for (const track of index.tracks) {
    const first = firstAtOrAfter(track.time, start - 1e-6);
    for (let i = first; i < track.time.length && track.time[i]! <= to; i++) {
      lo = Math.min(lo, track.offset[i]!);
      hi = Math.max(hi, track.offset[i]! + track.size[i]!);
    }
  }
  return lo < hi ? [lo, hi] : undefined;
}

export function mergeTimes(ranges: TimeRanges2, gap = 0.05) {
  const sorted = ranges.filter(([a, b]) => b > a).sort(([a], [b]) => a - b);
  const merged: TimeRanges2 = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1] + gap) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function intersectTimes(a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[]) {
  const result: TimeRanges2 = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]![0], b[j]![0]), end = Math.min(a[i]![1], b[j]![1]);
    if (end > start) result.push([start, end]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return result;
}

function contains(ranges: readonly ByteRange[], start: number, end: number) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, [a, b] = ranges[mid]!;
    if (end <= a) hi = mid - 1;
    else if (start >= b) lo = mid + 1;
    else return a <= start && end <= b;
  }
  return false;
}

// Moments whose samples, and for video the frames back to the key frame, are loaded.
export function playableTimes(index: VideoIndex, bytes: readonly ByteRange[]) {
  let result: TimeRanges2 | undefined;
  for (const track of index.tracks) {
    if (track.kind === "other") continue;
    const ranges: TimeRanges2 = [];
    let decodable = false;
    for (let i = 0; i < track.time.length; i++) {
      const present = contains(bytes, track.offset[i]!, track.offset[i]! + track.size[i]!);
      decodable = track.sync && !track.sync[i] ? decodable && present : present;
      if (decodable) ranges.push([track.time[i]!, track.end[i]!]);
    }
    const merged = mergeTimes(ranges);
    result = result ? intersectTimes(result, merged) : merged;
  }
  return result ?? [];
}

type Mp4Sample = { dts: number; duration: number; timescale: number; offset: number; size: number; is_sync: boolean };
export function tableFromSamples(kind: TrackTable["kind"], samples: readonly Mp4Sample[]): TrackTable {
  const table: TrackTable = {
    kind,
    time: new Float64Array(samples.length), end: new Float64Array(samples.length),
    offset: new Float64Array(samples.length), size: new Float64Array(samples.length),
    ...(kind === "video" && { sync: new Uint8Array(samples.length) }),
  };
  samples.forEach((sample, i) => {
    table.time[i] = sample.dts / sample.timescale;
    table.end[i] = (sample.dts + sample.duration) / sample.timescale;
    table.offset[i] = sample.offset;
    table.size[i] = sample.size;
    if (table.sync) table.sync[i] = sample.is_sync ? 1 : 0;
  });
  return table;
}

// Parse only the movie header. Sample data is never handed to mp4box.
export async function parseVideoIndex(parts: { offset: number; bytes: Uint8Array }[]): Promise<VideoIndex | undefined> {
  const { createFile, MP4BoxBuffer } = await import("mp4box");
  const parser = createFile(false);
  let index: VideoIndex | undefined;
  parser.onReady = movie => {
    if (movie.isFragmented || movie.videoTracks.length !== 1) return;
    index = {
      duration: movie.duration / movie.timescale,
      tracks: movie.tracks.map(track => tableFromSamples(
        track.type === "video" ? "video" : track.type === "audio" ? "audio" : "other",
        parser.getTrackSamplesInfo(track.id))),
    };
  };
  try {
    for (const part of parts) {
      const copy = part.bytes.slice().buffer as ArrayBuffer;
      parser.appendBuffer(MP4BoxBuffer.fromArrayBuffer(copy, part.offset));
      if (index) break;
    }
    parser.flush();
  } catch { return; }
  return index;
}
