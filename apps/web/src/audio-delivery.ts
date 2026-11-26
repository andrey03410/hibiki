import type { SourceDto } from "@hibiki/contracts";

const MAX_FILE = 128 * 1024 * 1024;
const MAX_PREFIX = 2 * 1024 * 1024;
const PAGE = 64 * 1024;
const CHROME_PAGE = 32 * 1024;
const WEBKIT_PAGE = 16 * 1024;
type ReadFile = (url: string, init: RequestInit) => Promise<Response>;
export type AudioFile = {
  url: string; size: number; mime: string; prefix: number; duration?: number | null;
  audioStart?: number; tailStart?: number; shared?: boolean;
};
export type AudioCoverage = {
  size: number; audioStart: number; ranges: readonly [number, number][]; complete: boolean;
};
type Failure = "denied" | "unsupported" | "network";
class AccessDenied extends Error {}
class MissingAudioView extends Error {}

function prefixBytes(size: number, audioStart: number, duration?: number | null, tailBytes = 0) {
  const audio = duration && Number.isFinite(duration) && duration > 0
    ? Math.ceil(10 * (size - audioStart) / duration) : 256 * 1024;
  const limit = tailBytes < MAX_PREFIX ? MAX_PREFIX - tailBytes : MAX_PREFIX;
  return Math.min(size - tailBytes, limit, audioStart + audio);
}

export function ownedAudioFile(source?: SourceDto, duration?: number | null): AudioFile | undefined {
  if (source?.provider !== "local" || !source.streamUrl || !source.mime) return;
  const path = source.streamUrl;
  const supported = source.shared
    ? /^\/api\/(?:shared-items\/[^/?#]+|(?:shared|shared-playlists)\/[^/?#]+\/items\/[^/?#]+)\/(?:sources\/[\w-]+(?:\/audio)?|sound\/\d+)$/.test(path)
    : /^(?:\/files\/[\w-]+(?:\/audio)?|\/api\/items\/[\w-]+\/sound\/\d+)$/.test(path);
  const size = source.bytes;
  if (!supported || !size || !Number.isSafeInteger(size) || size > MAX_FILE || size < 0) return;
  const hint = source.playbackHints;
  const audioStart = hint && Number.isSafeInteger(hint.audioStart) && hint.audioStart >= 0 && hint.audioStart < size
    ? hint.audioStart : undefined;
  const tail = hint?.tailStart;
  const tailStart = tail && Number.isSafeInteger(tail) && tail > (audioStart ?? 0) && tail < size ? tail : undefined;
  return { url: path, size, mime: source.mime, duration, shared: source.shared,
    audioStart, tailStart, prefix: prefixBytes(size, audioStart ?? 0, duration, tailStart ? size - tailStart : 0) };
}

// Older library entries can lack hints until the worker has indexed their headers.
function metadataTail(prefix: Uint8Array, size: number) {
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  for (let at = 0; at + 8 <= prefix.length;) {
    const type = view.getUint32(at + 4);
    let length = view.getUint32(at);
    if (length === 1) {
      if (at + 16 > prefix.length) return;
      length = Number(view.getBigUint64(at + 8));
      if (length < 16) return;
    }
    if (length < 8 || length > size - at) return;
    if (type === 0x6d6f6f76) return;
    at += length;
    if (type === 0x6d646174 && at >= prefix.length && at < size) return at;
  }
}

type Interval = [number, number]; // Half-open byte offsets.
type Transfer = { cursor: number; end: number; controller: AbortController };

// Store pages only where bytes have arrived. A seek can leave holes without
// reserving the entire track or discarding bytes already handed to the decoder.
class AudioBytes {
  private pages = new Map<number, Uint8Array>();
  private ranges: Interval[] = [];
  private waiters = new Set<() => void>();
  private demands = new Map<symbol, number>();
  private transfer?: Transfer;
  private tailTransfer?: Transfer;
  private lifetime = new AbortController();
  private error?: Error;
  private preparing = false;
  private filling = false;
  private inspected = false;
  private priority: RequestPriority = "high";
  private bulkRate?: number;
  private prefix: number;
  readonly decoderStart: number;
  private readonly preparedTagBytes: number;
  private preloadTag = false;
  private tail?: number;
  private audioStart: number;
  private authorizing = false;
  onChange?: () => void;
  onFailure?: (reason: Failure) => void;

  constructor(readonly file: AudioFile, private read: ReadFile) {
    this.audioStart = file.audioStart ?? 0;
    // Even a small embedded cover can make Chromium scan most of an MP3 before playing.
    // Feed the indexed MPEG frames directly and still retain the tag with the original.
    this.decoderStart = file.mime === "audio/mpeg" ? this.audioStart : 0;
    const payloadPrefix = this.decoderStart ? prefixBytes(file.size - this.decoderStart, 0, file.duration) : file.prefix;
    this.preparedTagBytes = Math.min(this.decoderStart, MAX_PREFIX - payloadPrefix);
    this.prefix = this.decoderStart + payloadPrefix;
    this.tail = file.tailStart === undefined ? undefined : this.alignedTail(file.tailStart);
    if (this.tail !== undefined) {
      const tailBytes = file.size - this.tail;
      this.prefix = Math.min(this.prefix, this.tail, tailBytes < MAX_PREFIX ? MAX_PREFIX - tailBytes : MAX_PREFIX);
    }
    this.inspected = file.audioStart !== undefined;
  }
  private tailFits(start: number, prefix: number) {
    return this.file.size - Math.max(prefix, start) <= MAX_PREFIX - prefix;
  }
  private alignedTail(offset: number, prefix = 1) {
    // With indexed metadata the prefix can still shrink. A discovered index must
    // share the remaining budget with every prefix byte already in the tab.
    const chrome = Math.floor(offset / CHROME_PAGE) * CHROME_PAGE || offset;
    const webkit = Math.floor(offset / WEBKIT_PAGE) * WEBKIT_PAGE || offset;
    return [chrome, webkit, offset].find(start => this.tailFits(start, prefix)) ?? chrome;
  }
  get complete() { return this.ranges[0]?.[0] === 0 && this.ranges[0][1] === this.file.size; }
  coverage(): AudioCoverage {
    return { size: this.file.size, audioStart: this.audioStart, ranges: this.ranges.slice(), complete: this.complete };
  }
  private wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
  private async until(done: () => boolean) {
    for (;;) {
      if (this.error || this.lifetime.signal.aborted) throw this.error ?? new Error("Playback changed");
      if (done()) return;
      await new Promise<void>(resolve => this.waiters.add(resolve));
    }
  }
  private rangeAt(at: number) { return this.ranges.find(([start, end]) => start <= at && at < end); }
  private gap(start: number, limit: number): Interval | undefined {
    const at = this.rangeAt(start)?.[1] ?? start;
    if (at >= limit) return;
    return [at, Math.min(limit, this.ranges.find(([lower]) => lower > at)?.[0] ?? limit)];
  }
  private write(at: number, data: Uint8Array) {
    for (let i = 0; i < data.length;) {
      const page = Math.floor((at + i) / PAGE);
      const local = (at + i) % PAGE;
      let buffer = this.pages.get(page);
      if (!buffer) {
        buffer = new Uint8Array(Math.min(this.file.size - page * PAGE, PAGE));
        this.pages.set(page, buffer);
      }
      const count = Math.min(buffer.length - local, data.length - i);
      buffer.set(data.subarray(i, i + count), local);
      i += count;
    }
    let start = at, end = at + data.length;
    const before = this.ranges.findIndex(([, hi]) => hi >= start);
    const index = before === -1 ? this.ranges.length : before;
    let last = index;
    while (last < this.ranges.length && this.ranges[last][0] <= end) {
      start = Math.min(start, this.ranges[last][0]);
      end = Math.max(end, this.ranges[last][1]);
      last++;
    }
    this.ranges.splice(index, last - index, [start, end]);
    this.wake();
    this.onChange?.();
  }
  private copy(at: number, end: number) {
    const bytes = new Uint8Array(end - at);
    for (let i = 0; i < bytes.length;) {
      const offset = (at + i) % PAGE;
      const buffer = this.pages.get(Math.floor((at + i) / PAGE))!;
      const count = Math.min(bytes.length - i, buffer.length - offset);
      bytes.set(buffer.subarray(offset, offset + count), i);
      i += count;
    }
    return bytes;
  }
  private inspectHeader() {
    if (this.inspected || this.gap(0, this.prefix)) return;
    this.inspected = true;
    if (this.file.audioStart !== undefined) return;
    if (this.file.mime === "audio/mpeg" && this.prefix >= 10) {
      const b = this.copy(0, 10);
      if (b[0] === 73 && b[1] === 68 && b[2] === 51 && b.subarray(6).every(n => n < 128)) {
        const size = b.subarray(6).reduce((value, n) => value * 128 + n, 0);
        this.audioStart = Math.min(this.file.size, 10 + size + (b[3] === 4 && (b[5] & 16) ? 10 : 0));
        this.prefix = prefixBytes(this.file.size, this.audioStart, this.file.duration);
      }
    } else if (!this.tail && /^(audio|video)\/(mp4|x-m4a)/.test(this.file.mime)) {
      const tail = metadataTail(this.copy(0, this.prefix), this.file.size);
      if (tail !== undefined) this.tail = this.alignedTail(tail, this.prefix);
    }
  }
  private wantTail() {
    return this.tail !== undefined && (this.filling || this.tailFits(this.tail, this.prefix));
  }
  private readyPrefix() {
    return !this.gap(this.decoderStart, this.prefix) && (!this.wantTail() || !this.gap(this.tail!, this.file.size)) &&
      (!this.preloadTag || !this.gap(0, this.preparedTagBytes));
  }
  private fail(error: unknown) {
    if (this.lifetime.signal.aborted) return;
    this.error = error instanceof Error ? error : new Error("Audio unavailable");
    this.close();
    this.onFailure?.(error instanceof AccessDenied ? "denied" : error instanceof MissingAudioView ? "unsupported" : "network");
  }
  private schedule() {
    if (this.lifetime.signal.aborted) return;
    this.inspectHeader();
    const size = this.file.size;
    if ((this.preparing || this.filling) && this.wantTail() && !this.tailTransfer) {
      const tail = this.gap(this.tail!, size);
      if (tail) this.launch(tail, true, false);
    }
    if (this.transfer) return;
    const demand = [...this.demands.values()].reverse().find(at =>
      !this.rangeAt(at) && !(this.tailTransfer && at >= this.tailTransfer.cursor && at < size));
    const end = this.tailTransfer ? this.tail! : size;
    let gap: Interval | undefined;
    let priority = this.priority;
    if (demand !== undefined) {
      const limit = demand < this.decoderStart ? this.decoderStart : demand < this.prefix ? this.prefix : demand >= end ? size : end;
      gap = this.gap(demand, limit);
    } else if (this.preparing || this.filling) {
      gap = this.gap(this.decoderStart, this.prefix);
      if (!gap) {
        priority = "low";
        if (this.filling) gap = this.gap(this.decoderStart, end) ?? this.gap(0, this.decoderStart);
        else if (this.preloadTag) gap = this.gap(0, this.preparedTagBytes);
      }
    }
    if (gap) {
      if (this.filling && gap[0] === this.prefix) priority = "low";
      this.launch(gap, false, gap[0] >= this.prefix && gap[1] === size, priority);
    }
  }
  private launch([start, end]: Interval, tail: boolean, openEnded: boolean, priority = this.priority) {
    const job = { cursor: start, end, controller: new AbortController() };
    if (tail) this.tailTransfer = job;
    else this.transfer = job;
    void this.download(job, openEnded, priority).catch(error => {
      if (!job.controller.signal.aborted) this.fail(error);
    }).finally(() => {
      if (tail) this.tailTransfer = undefined;
      else this.transfer = undefined;
      this.schedule();
      this.wake();
    });
  }
  private async download(job: Transfer, openEnded: boolean, priority: RequestPriority) {
    const stop = job.controller.signal;
    for (let attempt = 1; ; attempt++) {
      stop.throwIfAborted();
      const timeout = new AbortController();
      const signal = AbortSignal.any([stop, timeout.signal]);
      const expire = () => timeout.abort(new Error("Audio transfer stalled"));
      let timer = setTimeout(expire, 10_000);
      try {
        const at = job.cursor;
        const started = performance.now();
        const rate = this.filling && priority === "low" ? this.bulkRate : undefined;
        const response = await this.read(this.file.url, {
          headers: { Range: `bytes=${at}-${openEnded ? "" : job.end - 1}`,
            ...(rate && {"X-Hibiki-Audio-Rate": String(rate)}) },
          signal, cache: "no-store", priority,
        });
        const headersAt = performance.now();
        if ([401, 403, 404].includes(response.status)) {
          if (response.status === 404 && this.file.url.endsWith("/audio")) {
            const problem = await response.json().catch(() => null);
            if (problem?.error?.code === "audio_view_missing") throw new MissingAudioView("Audio view unavailable");
          } else await response.body?.cancel();
          throw new AccessDenied("Audio access denied");
        }
        if (response.status !== 206 || response.headers.get("Content-Range") !== `bytes ${at}-${job.end - 1}/${this.file.size}` || !response.body) {
          await response.body?.cancel();
          throw new Error("Unexpected audio range");
        }
        const reader = response.body.getReader();
        const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
        signal.addEventListener("abort", cancel, {once: true});
        try {
          for (;;) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            if (done && job.cursor === job.end) break;
            if (done || value.length > job.end - job.cursor) throw new Error("Incomplete audio range");
            if (!value.length) continue;
            clearTimeout(timer);
            timer = setTimeout(expire, 10_000);
            const from = job.cursor;
            job.cursor += value.length;
            this.write(from, value);
          }
        } catch (error) {
          void reader.cancel().catch(() => {});
          throw error;
        } finally {
          signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
        const received = job.cursor - at;
        if (!rate && at === this.decoderStart && received > 0 && job.end <= this.prefix) {
          const ended = performance.now();
          // Account for an already buffered first packet on a fast response,
          // while discounting time spent waiting for an older stream's queue.
          const elapsed = Math.max(1, ended - headersAt, (ended - started) / 2);
          const bytesPerSecond = this.file.duration ? (this.file.size - this.audioStart) / this.file.duration : 0;
          this.bulkRate = Math.ceil(Math.max(64 * 1024, bytesPerSecond * 1.5, received * 800 / elapsed));
        }
        return;
      } catch (error) {
        if (!stop.aborted && job.cursor === job.end) return;
        if (stop.aborted || error instanceof AccessDenied || error instanceof MissingAudioView || attempt >= 3) throw error;
      } finally { clearTimeout(timer); }
      await new Promise<void>(resolve => setTimeout(resolve, attempt * 200));
    }
  }

  async prepare(priority: RequestPriority) {
    this.priority = priority;
    this.preloadTag = priority === "low" && this.decoderStart > 0;
    this.preparing = true;
    this.schedule();
    await this.until(() => { this.inspectHeader(); return this.readyPrefix(); });
  }
  async fill() {
    this.filling = true;
    this.schedule();
    await this.until(() => this.complete);
  }
  playing() { this.priority = "auto"; }
  async chunk(key: symbol, at: number, end: number) {
    if (!this.rangeAt(at)) {
      this.demands.delete(key);
      this.demands.set(key, at);
      const active = this.transfer;
      if (active && active.cursor !== at && !(this.tailTransfer && at >= this.tailTransfer.cursor)) active.controller.abort();
      this.schedule();
      await this.until(() => !this.demands.has(key) || !!this.rangeAt(at));
      if (!this.demands.has(key)) throw new Error("Range cancelled");
    }
    const range = this.rangeAt(at)!;
    return this.copy(at, Math.min(at + PAGE, (end + 1), range[1]));
  }
  release(key: symbol) {
    this.demands.delete(key);
    this.wake();
    if (!this.demands.size && !this.filling && !this.preparing) this.transfer?.controller.abort();
  }
  checkRetained() {
    if (this.authorizing) return;
    this.authorizing = true;
    // A fully retained own file has no missing range which could check access.
    const init = this.file.shared ? { method: "HEAD" } : { headers: { Range: "bytes=0-0" } };
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]);
    void this.read(this.file.url, { ...init, signal, cache: "no-store" }).then(async response => {
      await response.body?.cancel();
      if ([401,403,404].includes(response.status)) throw new AccessDenied("Audio access denied");
      if (!response.ok) throw new Error("Audio unavailable");
      const valid = this.file.shared ? Number(response.headers.get("Content-Length")) === this.file.size
        : response.status === 206 && response.headers.get("Content-Range") === `bytes 0-0/${this.file.size}`;
      if (!valid) throw new AccessDenied("Audio source changed");
    }).catch(error => this.fail(error));
  }
  resetAccess() { this.authorizing = false; }
  close() {
    this.lifetime.abort();
    this.transfer?.controller.abort();
    this.tailTransfer?.controller.abort();
    this.pages.clear();
    this.ranges = [];
    this.wake();
  }
}

function audioRange(value: string | null, size: number) {
  if (value === null) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start < size && start <= end) return { start, end };
}

export class AudioDelivery {
  private current?: { token: string; bytes: AudioBytes; recheck: boolean };
  private next?: AudioBytes;
  private prepared = false;
  private speculative = false;
  private state?: AudioCoverage;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private read: ReadFile = (url, init) => fetch(url, init)) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish = () => {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state = this.current?.bytes.coverage();
    this.listeners.forEach(listener => listener());
  };
  isPreparedOwnFile(file?: AudioFile) {
    // A buffered shared file still needs current membership at queue selection.
    return !!file && !file.shared && this.prepared && this.next?.file.url === file.url && this.next.file.size === file.size;
  }
  suspendPreparation() { if (!this.prepared) void this.prepare(); }
  cancelIntent() {
    if (this.speculative) void this.prepare();
  }
  prepareIntent(file?: AudioFile) {
    if (!file || file.shared || (this.next && !this.speculative)) return;
    return this.stage(file, true);
  }
  beginSelection(file?: AudioFile) {
    if (!file || file.shared || file.url === this.current?.bytes.file.url) return;
    return this.stage(file, false, true);
  }
  prepare(file?: AudioFile) {
    return this.stage(file, false);
  }
  private async stage(file: AudioFile | undefined, speculative: boolean, selected = false) {
    if (speculative && this.current && !this.current.bytes.complete) return;
    this.speculative = speculative;
    if (file && this.next?.file.url === file.url && this.next.file.size === file.size) return;
    this.next?.close();
    this.next = undefined;
    this.prepared = false;
    if (!file || (this.current && ((!selected && !this.current.bytes.complete) || file.url === this.current.bytes.file.url))) return;
    const next = this.next = new AudioBytes(file, this.read);
    try {
      await next.prepare(selected ? "high" : "low");
      if (this.next === next) this.prepared = true;
    } catch { if (this.next === next) { next.close(); this.next = undefined; } }
  }
  select(file: AudioFile | undefined, token: string, onFailure?: (reason: Failure) => void) {
    if (!file) { this.clear(); return; }
    const previous = this.current?.bytes;
    const reuse = [this.next, previous].find(entry => entry?.file.url === file.url && entry.file.size === file.size);
    if (previous !== reuse) previous?.close();
    if (this.next !== reuse) this.next?.close();
    this.next = undefined;
    const bytes = reuse ?? new AudioBytes(file, this.read);
    bytes.resetAccess();
    this.current = { token, bytes, recheck: !!(file.shared || reuse?.complete) };
    bytes.onChange = () => {
      if (bytes.complete) this.publish();
      else this.timer ??= setTimeout(this.publish, 120);
    };
    bytes.onFailure = reason => {
      if (this.current?.bytes !== bytes) return;
      this.clear();
      onFailure?.(reason);
    };
    this.publish();
  }

  decoderResponse(token: string, range: string | null) {
    return this.response(token, range, this.current?.bytes.decoderStart);
  }
  response(token: string, range: string | null, originOffset = 0) {
    const current = this.current;
    if (!current || current.token !== token) return;
    const { mime } = current.bytes.file;
    const size = current.bytes.file.size - originOffset;
    const bounds = audioRange(range, size);
    if (!bounds) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const headers = new Headers({
      "Content-Type": mime, "Content-Length": String(bounds.end - bounds.start + 1),
      "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
    });
    if (range) headers.set("Content-Range", `bytes ${bounds.start}-${bounds.end}/${size}`);
    let offset = bounds.start;
    const key = Symbol();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: async controller => {
        if (cancelled || this.current !== current) throw new Error("Playback changed");
        if (current.recheck) current.bytes.checkRetained();
        const first = offset === bounds.start;
        const chunk = await current.bytes.chunk(key, originOffset + offset, originOffset + bounds.end);
        if (cancelled || this.current !== current) throw new Error("Playback changed");
        controller.enqueue(chunk);
        offset += chunk.length;
        if (offset > bounds.end) {
          controller.close();
          current.bytes.release(key);
        }
        if (first) void this.fill().catch(() => {});
      },
      cancel() { cancelled = true; current.bytes.release(key); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: range ? 206 : 200, headers });
  }
  async start() {
    const current = this.current;
    if (current?.recheck) current.bytes.checkRetained();
    await current?.bytes.prepare("high");
  }
  playing() { this.current?.bytes.playing(); }
  paused() { this.current?.bytes.resetAccess(); }
  async fill() { await this.current?.bytes.fill(); }
  clear() {
    this.current?.bytes.close();
    this.next?.close();
    this.current = this.next = undefined;
    this.speculative = false;
    this.prepared = false;
    this.publish();
  }
}
