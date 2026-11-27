import type { SourceDto } from "@hibiki/contracts";
import { parseVideoIndex, playableTimes, windowBytes, type TimeRanges2, type VideoIndex } from "./video-index";
import { playbackMark } from "./playback-debug";

const MiB = 1024 * 1024;
const PAGE = 64 * 1024;
const INDEX_LIMIT = 8 * MiB;
// The largest library video is 205 MB. Bigger files keep the part around the playhead.
export const VIDEO_BUDGET = 256 * MiB;
const AROUND = 10; // Seconds kept ready on both sides of the playhead.

type ReadFile = (url: string, init: RequestInit) => Promise<Response>;
export type VideoFile = { url: string; size: number; duration: number; indexEnd: number; tailStart?: number; shared?: boolean };
export type VideoMode = "index" | "window" | "watch";
export type VideoCoverage = { playable: TimeRanges2; complete: boolean; indexed: boolean };
type Interval = [number, number];
type Job = { start: number; end: number; kind: "index" | "demand" | "window" | "fill"; priority: RequestPriority; paced: boolean };
type Transfer = Job & { cursor: number; controller: AbortController };
class AccessDenied extends Error {}

export function relayVideoFile(source?: SourceDto, duration?: number | null): VideoFile | undefined {
  if (source?.provider !== "local" || source.mime !== "video/mp4" || !source.streamUrl) return;
  const url = source.streamUrl, size = source.bytes, hint = source.playbackHints;
  const route = source.shared
    ? /^\/api\/(?:shared-items\/[^/?#]+|(?:shared|shared-playlists)\/[^/?#]+\/items\/[^/?#]+)\/sources\/[\w-]+$/
    : /^\/files\/[\w-]+$/;
  if (!route.test(url) || !size || !Number.isSafeInteger(size) || !hint || !duration || !Number.isFinite(duration) || duration <= 0) return;
  const indexEnd = hint.audioStart, tail = hint.tailStart;
  if (!Number.isSafeInteger(indexEnd) || indexEnd <= 0 || indexEnd >= size) return;
  if (tail !== undefined && (!Number.isSafeInteger(tail) || tail <= indexEnd || tail >= size)) return;
  if (indexEnd + (tail === undefined ? 0 : size - tail) > INDEX_LIMIT) return;
  return { url, size, duration, indexEnd, tailStart: tail, shared: source.shared };
}

function rangeHeader(value: string | null, size: number) {
  if (value === null) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start < size && start <= end) return { start, end };
}

// Original MP4 bytes of one video, kept in the tab. The decoder reads them through
// the service worker relay; the tab decides what crosses the network and when.
export class VideoBytes {
  private pages = new Map<number, Uint8Array>();
  private ranges: Interval[] = [];
  private stored = 0;
  private waiters = new Set<() => void>();
  private demands = new Map<symbol, { at: number }>();
  private transfer?: Transfer;
  private lifetime = new AbortController();
  private error?: Error;
  private parsing = false;
  private bulkRate?: number;
  private checkedAt = 0;
  private checking = false;
  index?: VideoIndex;
  mode: VideoMode = "index";
  position = 0;
  fillAllowed = false;
  background = false;
  onChange?: () => void;
  onFailure?: (denied: boolean) => void;
  constructor(readonly file: VideoFile, private read: ReadFile, private budget = VIDEO_BUDGET) {}

  get complete() { return this.ranges[0]?.[0] === 0 && this.ranges[0][1] === this.file.size; }
  get failed() { return !!this.error; }
  byteRanges(): readonly Interval[] { return this.ranges; }
  coverage(): VideoCoverage {
    return { indexed: !!this.index, complete: this.complete,
      playable: this.index ? playableTimes(this.index, this.ranges) : [] };
  }
  configure(mode: VideoMode, position = this.position, fillAllowed = this.fillAllowed) {
    const changed = mode !== this.mode || fillAllowed !== this.fillAllowed || Math.abs(position - this.position) > 1;
    this.mode = mode;
    this.position = Math.max(0, position);
    this.fillAllowed = fillAllowed;
    if (changed) this.retarget();
  }

  private wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
  private async until(done: () => boolean) {
    for (;;) {
      if (this.error || this.lifetime.signal.aborted) throw this.error ?? new Error("Video changed");
      if (done()) return;
      await new Promise<void>(resolve => this.waiters.add(resolve));
    }
  }
  private rangeAt(at: number) { return this.ranges.find(([start, end]) => start <= at && at < end); }
  private gap(start: number, limit: number): Interval | undefined {
    let at = Math.max(0, start);
    for (;;) {
      const covered = this.rangeAt(at);
      if (!covered) break;
      at = covered[1];
    }
    if (at >= limit) return;
    return [at, Math.min(limit, this.ranges.find(([lower]) => lower > at)?.[0] ?? limit)];
  }
  private add(start: number, end: number) {
    const before = this.ranges.findIndex(([, hi]) => hi >= start);
    const index = before === -1 ? this.ranges.length : before;
    let last = index;
    while (last < this.ranges.length && this.ranges[last]![0] <= end) {
      start = Math.min(start, this.ranges[last]![0]);
      end = Math.max(end, this.ranges[last]![1]);
      last++;
    }
    this.ranges.splice(index, last - index, [start, end]);
  }
  private subtract(start: number, end: number) {
    this.ranges = this.ranges.flatMap(([a, b]): Interval[] => {
      if (b <= start || a >= end) return [[a, b]];
      return [...(a < start ? [[a, start] as Interval] : []), ...(b > end ? [[end, b] as Interval] : [])];
    });
  }
  private write(at: number, data: Uint8Array) {
    for (let i = 0; i < data.length;) {
      const page = Math.floor((at + i) / PAGE);
      const local = (at + i) % PAGE;
      let buffer = this.pages.get(page);
      if (!buffer) {
        buffer = new Uint8Array(Math.min(this.file.size - page * PAGE, PAGE));
        this.pages.set(page, buffer);
        this.stored += buffer.length;
      }
      const count = Math.min(buffer.length - local, data.length - i);
      buffer.set(data.subarray(i, i + count), local);
      i += count;
    }
    this.add(at, at + data.length);
    if (this.stored > this.budget) this.evict();
    this.wake();
    this.onChange?.();
  }
  // Drop pages away from the playhead, behind it first. Never the index or the playing window.
  private evict(target = this.budget * .9, behindOnly = false) {
    const keep = this.keepRanges();
    const anchor = this.index && windowBytes(this.index, this.position, this.position)?.[0] || 0;
    const candidates = [...this.pages.keys()].filter(page => {
      const start = page * PAGE, end = start + PAGE;
      return (!behindOnly || end <= anchor) && !keep.some(([a, b]) => start < b && end > a) &&
        !(this.transfer && this.transfer.cursor >= start && this.transfer.cursor < end);
    }).sort((a, b) => {
      const behind = (page: number) => page * PAGE < anchor ? 0 : 1;
      return behind(a) - behind(b) || Math.abs(b * PAGE - anchor) - Math.abs(a * PAGE - anchor);
    });
    for (const page of candidates) {
      if (this.stored <= target) break;
      const buffer = this.pages.get(page)!;
      this.pages.delete(page);
      this.stored -= buffer.length;
      this.subtract(page * PAGE, page * PAGE + buffer.length);
    }
  }
  private keepRanges(): Interval[] {
    const keep: Interval[] = [[0, this.file.indexEnd]];
    if (this.file.tailStart !== undefined) keep.push([this.file.tailStart, this.file.size]);
    const window = this.index && windowBytes(this.index, this.position - AROUND, this.position + AROUND);
    if (window) keep.splice(1, 0, [window[0], window[1]]);
    for (const { at } of this.demands.values()) keep.push([at, at + 2 * MiB]);
    return keep;
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
  private fail(error: unknown) {
    if (this.lifetime.signal.aborted || this.error) return;
    this.error = error instanceof Error ? error : new Error("Video unavailable");
    this.transfer?.controller.abort();
    this.wake();
    this.onFailure?.(error instanceof AccessDenied);
  }
  private indexGaps(): Interval | undefined {
    return this.gap(0, this.file.indexEnd) ??
      (this.file.tailStart === undefined ? undefined : this.gap(this.file.tailStart, this.file.size));
  }
  private parseIndex() {
    if (this.index || this.parsing || this.indexGaps()) return;
    this.parsing = true;
    const parts = [{ offset: 0, bytes: this.copy(0, this.file.indexEnd) }];
    if (this.file.tailStart !== undefined) parts.push({ offset: this.file.tailStart, bytes: this.copy(this.file.tailStart, this.file.size) });
    void parseVideoIndex(parts).then(index => {
      if (this.lifetime.signal.aborted) return;
      if (!index) throw new Error("Unsupported video index");
      this.index = index;
      playbackMark("video-index", { url: this.file.url });
      this.onChange?.();
      this.retarget();
    }).catch(error => this.fail(error)).finally(() => { this.parsing = false; });
  }
  // Byte range that keeps the moment `at` and the following seconds playable.
  private around(from: number, to: number): Interval | undefined {
    if (!this.index) return;
    const window = windowBytes(this.index, from, to);
    return window && [window[0], window[1]];
  }
  private urgentWindow() {
    if (this.mode === "index" || !this.index) return;
    return this.around(this.position, this.position + AROUND);
  }
  private nextJob(): Job | undefined {
    const size = this.file.size;
    const active = this.mode !== "index";
    const head = this.urgentWindow();
    const window = active ? this.around(this.position - AROUND, this.position + AROUND) : undefined;
    const pending = [...this.demands.values()].filter(({ at }) => !this.rangeAt(at)).reverse();
    const windowGap = head && (this.gap(head[0], head[1]) ?? this.gap(window![0], window![1]));
    // A demand far from the playhead is usually a read that the seek has already
    // superseded, such as the start of the file after the index. The window goes first.
    const demand = pending.find(({ at }) => !windowGap || !window || (at >= window[0] && at < window[1]));
    if (demand) {
      // Stream on from a read near the playhead. A stale read elsewhere gets a bounded range.
      const near = window && demand.at >= window[0] && demand.at < window[1];
      const limit = near && this.mode === "watch" ? size : Math.max(near ? window[1] : 0, Math.min(size, demand.at + 2 * MiB));
      const gap = this.gap(demand.at, demand.at < this.file.indexEnd ? this.file.indexEnd : limit);
      if (gap) return { start: gap[0], end: gap[1], kind: "demand", priority: "high", paced: false };
    }
    if (!this.index) {
      const gap = this.indexGaps();
      return gap && { start: gap[0], end: gap[1], kind: "index", priority: active ? "high" : "low", paced: false };
    }
    if (windowGap) return { start: windowGap[0], end: windowGap[1], kind: "window", priority: "high", paced: false };
    if (this.mode === "watch" && this.fillAllowed && head) {
      // A video larger than the budget keeps loading ahead and lets old pages go.
      if (this.stored >= this.budget * .85) this.evict(this.budget * .75, true);
      if (this.stored >= this.budget * .85) return;
      const gap = this.gap(head[0], size) ?? (size <= this.budget * .85 ? this.gap(0, size) : undefined);
      if (gap) return { start: gap[0], end: gap[1], kind: "fill", priority: "low", paced: !!this.bulkRate };
    }
  }
  // A moved playhead or a stopped view can make the running request irrelevant.
  private retarget() {
    const active = this.transfer;
    if (active && active.kind !== "demand" && active.kind !== "index") {
      const wanted = this.nextJob();
      if (!wanted || wanted.kind !== active.kind || wanted.start !== active.cursor) active.controller.abort();
    }
    this.schedule();
  }
  schedule() {
    if (this.lifetime.signal.aborted || this.error) return;
    this.parseIndex();
    if (this.transfer) return;
    const job = this.nextJob();
    if (!job) return;
    if (this.background) job.priority = "low";
    const transfer: Transfer = { ...job, cursor: job.start, controller: new AbortController() };
    this.transfer = transfer;
    void this.download(transfer).catch(error => {
      if (!transfer.controller.signal.aborted) this.fail(error);
    }).finally(() => {
      if (this.transfer === transfer) this.transfer = undefined;
      this.schedule();
      this.wake();
    });
  }
  private async download(job: Transfer) {
    const stop = job.controller.signal;
    const openEnded = job.end === this.file.size;
    for (let attempt = 1; ; attempt++) {
      stop.throwIfAborted();
      const timeout = new AbortController();
      const signal = AbortSignal.any([stop, timeout.signal]);
      const expire = () => timeout.abort(new Error("Video transfer stalled"));
      let timer = setTimeout(expire, 10_000);
      try {
        const at = job.cursor, started = performance.now();
        const rate = job.paced ? this.bulkRate : undefined;
        const response = await this.read(this.file.url, {
          headers: { Range: `bytes=${at}-${openEnded ? "" : job.end - 1}`, ...(rate && { "X-Hibiki-Video-Rate": String(rate) }) },
          signal, cache: "no-store", priority: job.priority,
        });
        if ([401, 403, 404].includes(response.status)) {
          await response.body?.cancel();
          throw new AccessDenied("Video access denied");
        }
        if (response.status !== 206 || response.headers.get("Content-Range") !== `bytes ${at}-${job.end - 1}/${this.file.size}` || !response.body) {
          await response.body?.cancel();
          throw new Error("Unexpected video range");
        }
        this.checkedAt = Date.now();
        const reader = response.body.getReader();
        const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          for (;;) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            if (done && job.cursor === job.end) break;
            if (done || value.length > job.end - job.cursor) throw new Error("Incomplete video range");
            if (!value.length) continue;
            clearTimeout(timer);
            timer = setTimeout(expire, 10_000);
            const from = job.cursor;
            job.cursor += value.length;
            this.write(from, value);
            // Another region became more urgent, or the next bytes are already here.
            if (job.cursor < job.end && this.rangeAt(job.cursor)) break;
            if (job.kind === "fill" && this.stored >= this.budget * .85) break;
          }
        } catch (error) {
          void reader.cancel().catch(() => {});
          throw error;
        } finally {
          signal.removeEventListener("abort", cancel);
          if (job.cursor < job.end) void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const received = job.cursor - at;
        if (!rate && received >= 512 * 1024) {
          const average = this.file.size / this.file.duration;
          const measured = received * 800 / Math.max(1, performance.now() - started);
          this.bulkRate = Math.ceil(Math.max(64 * 1024, average * 1.5, measured));
        }
        return;
      } catch (error) {
        if (!stop.aborted && job.cursor === job.end) return;
        if (stop.aborted || error instanceof AccessDenied || attempt >= 3) throw error;
      } finally { clearTimeout(timer); }
      await new Promise<void>(resolve => setTimeout(resolve, attempt * 200));
    }
  }
  async chunk(key: symbol, at: number, end: number) {
    if (!this.rangeAt(at)) {
      this.demands.delete(key);
      this.demands.set(key, { at });
      const active = this.transfer;
      const arriving = active && active.cursor <= at && at < Math.min(active.end, active.cursor + 256 * 1024);
      if (active && !arriving && active.kind !== "index" && this.nextJob()?.start !== active.cursor) active.controller.abort();
      this.schedule();
      await this.until(() => !this.demands.has(key) || !!this.rangeAt(at));
      if (!this.demands.has(key)) throw new Error("Range cancelled");
    }
    const range = this.rangeAt(at)!;
    return this.copy(at, Math.min(at + PAGE - (at % PAGE), end + 1, range[1]));
  }
  release(key: symbol) {
    if (!this.demands.delete(key)) return;
    this.wake();
    const active = this.transfer;
    if (active?.kind === "demand" && !this.demands.size) active.controller.abort();
  }
  // Retained bytes of a shared video still need the current grant.
  checkAccess() {
    if (!this.file.shared || this.checking || Date.now() - this.checkedAt < 15_000) return;
    this.checking = true;
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]);
    void this.read(this.file.url, { method: "HEAD", signal, cache: "no-store" }).then(async response => {
      await response.body?.cancel();
      if ([401, 403, 404].includes(response.status)) throw new AccessDenied("Video access denied");
      if (!response.ok) throw new Error("Video unavailable");
      this.checkedAt = Date.now();
    }).catch(error => { if (!this.lifetime.signal.aborted) this.fail(error); })
      .finally(() => { this.checking = false; });
  }
  close() {
    this.lifetime.abort();
    this.transfer?.controller.abort();
    this.pages.clear();
    this.ranges = [];
    this.stored = 0;
    this.wake();
  }
}

export class VideoDelivery {
  private current?: { token: string; bytes: VideoBytes };
  private next?: VideoBytes;
  private state?: VideoCoverage;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private mode: VideoMode = "index";
  private position = 0;
  private fillAllowed = false;
  private nextFile?: VideoFile;
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
  token() { return this.current?.token; }
  select(file: VideoFile | undefined, token: string, onFailure?: (denied: boolean) => void) {
    if (this.current && file && this.current.bytes.file.url === file.url && this.current.bytes.file.size === file.size &&
        !this.current.bytes.failed) {
      this.current.token = token;
      this.current.bytes.onFailure = onFailure;
      return;
    }
    const reuse = file && this.next?.file.url === file.url && this.next.file.size === file.size && !this.next.failed ? this.next : undefined;
    this.current?.bytes.close();
    if (!reuse) this.next?.close();
    this.next = undefined;
    if (this.nextFile?.url === file?.url) this.nextFile = undefined;
    if (!file) { this.current = undefined; this.publish(); return; }
    const bytes = reuse ?? new VideoBytes(file, this.read);
    bytes.background = false;
    this.current = { token, bytes };
    bytes.onChange = () => {
      if (bytes.complete) { this.publish(); this.prepareNext(); }
      else this.timer ??= setTimeout(this.publish, 250);
    };
    bytes.onFailure = onFailure;
    bytes.configure(this.mode, this.position, this.fillAllowed);
    bytes.schedule();
    this.publish();
  }
  configure(mode: VideoMode, position: number, fillAllowed: boolean) {
    this.mode = mode;
    this.position = position;
    this.fillAllowed = fillAllowed;
    this.current?.bytes.configure(mode, position, fillAllowed);
    if (mode !== "watch" && this.next) { this.next.close(); this.next = undefined; }
    this.prepareNext();
  }
  follow(position: number) {
    this.position = position;
    this.current?.bytes.configure(this.mode, position, this.fillAllowed);
  }
  // The next recording's index and first seconds, once the current video is complete.
  setNext(file: VideoFile | undefined) {
    this.nextFile = file;
    if (this.next && (!file || this.next.file.url !== file.url)) { this.next.close(); this.next = undefined; }
    this.prepareNext();
  }
  private prepareNext() {
    const file = this.nextFile;
    if (!file || this.next || this.mode !== "watch" || !this.current?.bytes.complete || file.url === this.current.bytes.file.url) return;
    const next = this.next = new VideoBytes(file, this.read);
    next.background = true;
    next.onFailure = () => { if (this.next === next) { next.close(); this.next = undefined; } };
    next.configure("window", 0, false);
  }
  response(token: string, range: string | null) {
    const current = this.current;
    if (!current || current.token !== token) return;
    const size = current.bytes.file.size;
    const bounds = rangeHeader(range, size);
    if (!bounds) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const headers = new Headers({
      "Content-Type": "video/mp4", "Content-Length": String(bounds.end - bounds.start + 1),
      "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
    });
    if (range) headers.set("Content-Range", `bytes ${bounds.start}-${bounds.end}/${size}`);
    let offset = bounds.start;
    const key = Symbol();
    let cancelled = false;
    current.bytes.checkAccess();
    const bytes = current.bytes;
    const stream = new ReadableStream<Uint8Array>({
      pull: async controller => {
        if (cancelled || this.current?.bytes !== bytes) throw new Error("Video changed");
        const chunk = await bytes.chunk(key, offset, bounds.end);
        if (cancelled || this.current?.bytes !== bytes) throw new Error("Video changed");
        controller.enqueue(chunk);
        offset += chunk.length;
        if (offset > bounds.end) {
          controller.close();
          bytes.release(key);
        }
      },
      cancel() { cancelled = true; bytes.release(key); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: range ? 206 : 200, headers });
  }
  clear() {
    this.current?.bytes.close();
    this.next?.close();
    this.current = this.next = undefined;
    this.nextFile = undefined;
    this.publish();
  }
}
