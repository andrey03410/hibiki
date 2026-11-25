import { updateSourceBuffer } from "./media-source-buffer";
import type { SourceDto } from "@hibiki/contracts";
import type { ISOFile } from "mp4box";

const MiB = 1024 ** 2;
const windowBytes = 48 * MiB;
const indexLimit = 2 * MiB;
export type VideoFile = { url: string; size: number; duration: number; prefix: number; shared?: boolean };
export function videoFile(source?: SourceDto, duration?: number | null): VideoFile | undefined {
  if (source?.provider !== "local" || source.mime !== "video/mp4" || !duration || !Number.isFinite(duration) || duration <= 0) return;
  const url = source.streamUrl, size = source.bytes, hint = source.playbackHints;
  if (!url || !size || !Number.isSafeInteger(size) || size <= 0 || !hint) return;
  const route = source.shared ? /^\/api\/(?:shared-items\/[^/?#]+|(?:shared|shared-playlists)\/[^/?#]+\/items\/[^/?#]+)\/sources\/[\w-]+$/ : /^\/files\/[\w-]+$/;
  if (!route.test(url) || !Number.isSafeInteger(hint.audioStart) || hint.audioStart < 0 || hint.audioStart >= size ||
      hint.audioStart > indexLimit || (hint.tailStart && (!Number.isSafeInteger(hint.tailStart) ||
        hint.tailStart <= hint.audioStart || hint.tailStart >= size || size - hint.tailStart > indexLimit))) return;
  if (videoWindow({ size, duration }) < 20) return;
  const prefixPayload = source.shared ? Math.min(128 * 1024, Math.ceil(size / duration * 2)) : 128 * 1024;
  return { url, size, duration, shared: source.shared, prefix: Math.min(size, hint.audioStart + prefixPayload) };
}
export const videoWindow = (file: Pick<VideoFile, "size" | "duration">) =>
  Math.min(75, windowBytes / file.size * file.duration);

export function videoRangeSize(file: VideoFile, ahead: number, held: number) {
  const remaining = Math.ceil((videoWindow(file) - ahead) * file.size / file.duration);
  const sharedLimit = file.shared ? Math.ceil(12 * file.size / file.duration) : Infinity;
  // Once playback has a cushion, do not queue many megabytes ahead of an interactive seek on HTTP/2.
  return Math.max(1, Math.min(ahead >= 12 ? 2 * MiB : 4 * MiB, windowBytes - held, remaining, sharedLimit));
}

type TrackBuffer = {
  buffer: SourceBuffer;
  spans: { end: number; bytes: number }[];
  pending: ArrayBuffer[];
};
function headroom(buffered: TimeRanges, time: number) {
  for (let i = 0; i < buffered.length; i++)
    if (buffered.start(i) <= time + .05 && buffered.end(i) > time) return buffered.end(i) - time;
  return 0;
}

// Return immediately when the movie index requests a different file position.
export async function readVideoPages(
  response: Response, start: number, end: number, pageSize: number, signal: AbortSignal,
  accept: (page: Uint8Array<ArrayBuffer>, offset: number) => Promise<number>,
  idleMs = 15000,
) {
  if (!response.body) throw new Error("Empty video range");
  const reader = response.body.getReader();
  let timedOut = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let at = start, filled = 0, complete = false;
  let page = new Uint8Array(Math.min(pageSize, end - at));
  try {
    while (at < end) {
      signal.throwIfAborted();
      // Count only time spent waiting for the next network chunk.
      const timer = setTimeout(() => { timedOut = true; cancel(); }, idleMs);
      const chunk = await reader.read().finally(() => clearTimeout(timer));
      if (timedOut) throw new Error("Video range timed out");
      const { done, value } = chunk;
      signal.throwIfAborted();
      if (done || value.length > end - at - filled) throw new Error("Truncated or oversized video range");
      for (let i = 0; i < value.length;) {
        const count = Math.min(value.length - i, page.length - filled);
        page.set(value.subarray(i, i + count), filled);
        filled += count;
        i += count;
        if (filled < page.length) continue;
        const next = await accept(page, at);
        at += page.length;
        if (next !== at) return;
        signal.throwIfAborted();
        filled = 0;
        if (at < end) page = new Uint8Array(Math.min(pageSize, end - at));
      }
    }
    complete = true;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Fetch original file ranges; only repackage encoded samples into the fragments accepted by MSE.
export function attachVideoStream(element: HTMLVideoElement, file: VideoFile, failure: (denied: boolean) => void) {
  const media = new MediaSource(), objectUrl = URL.createObjectURL(media);
  const lifetime = new AbortController(), {signal} = lifetime;
  const tracks = new Map<number, TrackBuffer>();
  let parser: ISOFile | undefined;
  let transfer: AbortController | undefined;
  let at = 0, busy = false, requested = false, finished = false, ready = false;
  let indexedBytes = 0, held = 0;
  let jump: number | undefined, seekEnd: number | undefined;
  let lastTrim = -1, pausedSeek = element.paused, holding = false;
  let fatal = false, lastAuthorized = 0, bulkRate = 0;
  let permission: AbortController | undefined;
  const waitForModule = import("mp4box");
  let parserUnavailable = false;
  void waitForModule.catch(() => {
    parserUnavailable = true;
    if (transfer && !transfer.signal.aborted) fail();
  });
  function fail(denied = false) {
    if (signal.aborted || fatal) return;
    fatal = true;
    transfer?.abort();
    failure(denied);
  }
  function schedule() {
    if (signal.aborted || fatal || media.readyState === "closed" || element.paused && !pausedSeek) return;
    if (parserUnavailable) { fail(); return; }
    if (file.shared && ready && !permission && Date.now() - lastAuthorized > 10000) {
      const request = permission = new AbortController();
      // Even a completed or slow range can keep playing buffered media after the grant changes.
      void fetch(file.url, { method: "HEAD", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) })
        .then(response => {
          if (request.signal.aborted) return;
          if (!response.ok) fail([401, 403, 404].includes(response.status));
          else lastAuthorized = Date.now();
        }).catch(() => { if (!request.signal.aborted) fail(); })
        .finally(() => { if (permission === request) permission = undefined; });
    }
    requested = true;
    if (busy) return;
    busy = true;
    void pump().catch(() => { if (!transfer?.signal.aborted) fail(); }).finally(() => {
      transfer = undefined;
      busy = false;
      if (requested && !fatal && !signal.aborted) schedule();
    });
  }
  function pause() { pausedSeek = false; requested = false; transfer?.abort(); permission?.abort(); }
  function previewReady() {
    return !element.seeking && element.readyState >= 2 && headroom(element.buffered, element.currentTime) > 0;
  }
  function finishPreview() {
    if (pausedSeek && element.paused && previewReady()) pause();
  }
  function seek() {
    if (!ready || headroom(element.buffered, element.currentTime) >= 1) return;
    holding = false;
    jump = element.currentTime;
    pausedSeek = element.paused;
    finished = false;
    transfer?.abort();
    schedule();
  }
  async function flush() {
    await Promise.all([...tracks.values()].map(async track => {
      const fragments = track.pending.splice(0);
      if (!fragments.length) return;
      const data = fragments.length === 1 ? fragments[0] : await new Blob(fragments).arrayBuffer();
      await updateSourceBuffer(track.buffer, signal, () => track.buffer.appendBuffer(data));
    }));
  }
  async function trim(end: number) {
    await Promise.all([...tracks.values()].map(async track => {
      if (track.buffer.buffered.length && end > track.buffer.buffered.start(0))
        await updateSourceBuffer(track.buffer, signal, () => track.buffer.remove(0, end));
      track.spans = track.spans.filter(span => {
        if (span.end > end) return true;
        held -= span.bytes;
        return false;
      });
    }));
  }
  function createParser(createFile: typeof import("mp4box").createFile) {
    const iso = createFile(true);
    iso.onError = () => fail();
    iso.onReady = movie => {
      // Leave alternative tracks, subtitles and unfamiliar containers to the native player.
      if (movie.isFragmented || movie.videoTracks.length !== 1 || movie.audioTracks.length > 1 ||
          movie.tracks.length !== movie.videoTracks.length + movie.audioTracks.length) throw new Error("Unsupported tracks");
      for (const track of movie.tracks) {
        const mime = `${track.type}/mp4; codecs="${track.codec}"`;
        if (!MediaSource.isTypeSupported(mime)) throw new Error("Unsupported video codec");
        if (iso.getTrackSamplesInfo(track.id).some(sample => sample.size > 12 * MiB))
          throw new Error("Video sample exceeds playback window");
        const buffer = media.addSourceBuffer(mime);
        tracks.set(track.id, { buffer, pending: [], spans: [] });
        iso.setSegmentOptions(track.id, null, { nbSamples: 4, rapAlignement: false });
      }
      for (const init of iso.initializeSegmentation("per-track")) tracks.get(init.id)!.pending.push(init.buffer);
      media.duration = movie.duration / movie.timescale || file.duration;
      ready = true;
      iso.start();
    };
    iso.onSegment = (id, _user, data, next) => {
      const track = tracks.get(id)!;
      track.pending.push(data);
      const frame = iso.getTrackSamplesInfo(id)[next - 1];
      held += data.byteLength;
      track.spans.push({ end: (frame.cts + frame.duration) / frame.timescale, bytes: data.byteLength });
      iso.releaseUsedSamples(id, next);
    };
    return iso;
  }
  async function pump() {
    do {
      requested = false;
      if (signal.aborted || element.paused && !pausedSeek || fatal) return;
      if (jump !== undefined && parser) {
        const position = jump;
        jump = undefined;
        at = parser.seek(position, true).offset;
        // Fetch just the packets needed to decode the requested frame and a short audio preroll.
        // The first response can finish before an ordinary background range competes with the seek.
        seekEnd = at;
        for (const id of tracks.keys()) {
          const track = parser.getTrackById(id);
          for (let i = track.nextSample; i < track.samples.length; i++) {
            const sample = track.samples[i]!;
            seekEnd = Math.max(seekEnd, sample.offset + sample.size);
            if (sample.dts / sample.timescale >= position + .2) break;
          }
        }
        await trim(Infinity);
        lastTrim = position - 10;
      }
      if (finished) return;
      const now = element.currentTime;
      if (now > lastTrim + 16) { await trim(now - 10); lastTrim = now - 10; }
      const ahead = headroom(element.buffered, now);
      if (pausedSeek && previewReady()) { pausedSeek = false; if (element.paused) return; }
      if (held >= windowBytes - MiB && ahead < 2) {
        // A burst of high-bitrate frames can exhaust the byte budget before the ordinary trim.
        await trim(Math.max(0, now - 1));
        if (held >= windowBytes - MiB) throw new Error("Video exceeds playback window");
      }
      const target = videoWindow(file);
      if (holding && ahead >= target * .8) return;
      holding = false;
      if (ahead >= target - .5 || held >= windowBytes - MiB) {
        holding = true;
        return;
      }
      let block = at === 0 ? file.prefix : ready ? videoRangeSize(file, ahead, held) : 256 * 1024;
      if (pausedSeek && element.paused && ahead > 0) block = Math.min(block, 128 * 1024);
      const seeking = seekEnd !== undefined && seekEnd > at;
      const end = Math.min(file.size, at + block, seeking ? seekEnd! : Infinity);
      if (seekEnd !== undefined && end >= seekEnd) seekEnd = undefined;
      if (end <= at) {
        if (!parser) throw new Error("Incomplete video index");
        parser.flush();
        await flush();
        if (!ready || !tracks.size) throw new Error("Incomplete video index");
        finished = true;
        if (media.readyState === "open") media.endOfStream();
        return;
      }
      const active = transfer = new AbortController();
      const headerTimeout = new AbortController();
      const timer = setTimeout(() => headerTimeout.abort(), 15000);
      const start = at, started = performance.now();
      const paced = ahead >= 4 && bulkRate > 0;
      const response = await fetch(file.url, { headers: { Range: `bytes=${at}-${end - 1}`,
        ...(paced && {"X-Hibiki-Video-Rate": String(bulkRate)}) }, cache: "no-store",
        signal: AbortSignal.any([signal, active.signal, headerTimeout.signal]), priority: paced ? "low" : "high" }).finally(() => clearTimeout(timer));
      if (active.signal.aborted) return;
      if ([401,403,404].includes(response.status)) { fail(true); return; }
      if (response.status !== 206 || response.headers.get("Content-Range") !== `bytes ${at}-${end - 1}/${file.size}` ||
          Number(response.headers.get("Content-Length")) !== end - at) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Invalid video range");
      }
      lastAuthorized = Date.now();
      if (!parser) {
        // The bounded prefix and the decoder module travel in parallel on a cold start.
        const { createFile } = await waitForModule;
        if (active.signal.aborted) return;
        parser = createParser(createFile);
      }
      const pageSize = !ready ? end - at : Math.min(seeking ? 32 * 1024 : ahead < 2 ? 128 * 1024 : 512 * 1024, videoRangeSize(file, ahead, held));
      await readVideoPages(response, at, end, pageSize, active.signal, async (page, position) => {
        if (!ready) {
          indexedBytes += page.byteLength;
          if (indexedBytes > indexLimit + MiB) throw new Error("Video index exceeds playback window");
        }
        const next = parser!.appendBuffer(Object.assign(page.buffer, { fileStart: position }));
        if (!Number.isSafeInteger(next) || next < 0 || next === position) throw new Error("Unreadable video index");
        // Interleaved tracks can skip a few bytes between samples. The current HTTP range already contains them.
        const sequential = position + page.byteLength;
        at = next >= sequential && next < end ? sequential : next;
        if (parser!.getAllocatedSampleDataSize() > 12 * MiB) throw new Error("Video sample exceeds playback window");
        await flush();
        if (held >= windowBytes - MiB || headroom(element.buffered, element.currentTime) >= videoWindow(file)) return -1;
        if (pausedSeek && previewReady()) {
          pausedSeek = false;
          if (element.paused) return -1;
        }
        return at;
      });
      if (active.signal.aborted) return;
      if (pausedSeek && element.paused && headroom(element.buffered, element.currentTime) > .1 && !previewReady()) {
        // A local range can fill much faster than the asynchronous decoder paints its first frame.
        await new Promise<void>(resolve => {
          const finish = () => {
            clearTimeout(timer);
            element.removeEventListener("seeked", finish);
            active.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 120);
          element.addEventListener("seeked", finish, { once: true });
          active.signal.addEventListener("abort", finish, { once: true });
        });
      }
      if (active.signal.aborted) return;
      transfer = undefined;
      if (!paced && at === end && end - start >= 256 * 1024) {
        const average = file.size / file.duration;
        const available = (end - start) * 800 / Math.max(1, performance.now() - started);
        bulkRate = Math.ceil(Math.max(64 * 1024, average * 1.5, Math.min(available, average * 6)));
      }
      requested = true;
    } while (requested);
  }
  media.addEventListener("sourceopen", schedule, { signal });
  element.addEventListener("play", schedule, { signal });
  element.addEventListener("timeupdate", schedule, { signal });
  element.addEventListener("seeking", seek, { signal });
  element.addEventListener("seeked", finishPreview, { signal });
  element.addEventListener("loadeddata", finishPreview, { signal });
  element.addEventListener("pause", pause, { signal });
  element.src = objectUrl;
  return () => {
    lifetime.abort();
    transfer?.abort();
    permission?.abort();
    parser?.stop();
    if (element.getAttribute("src") === objectUrl) { element.removeAttribute("src"); element.load(); }
    URL.revokeObjectURL(objectUrl);
  };
}
