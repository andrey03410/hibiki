import type { SourceDto } from "@hibiki/contracts";

const MAX_FILE = 32 * 1024 * 1024;
const MAX_PREFIX = 512 * 1024;
const BLOCK = 1024 * 1024;
type ReadFile = (url: string, init: RequestInit) => Promise<Response>;
type AudioFile = { url: string; size: number; mime: string; prefix: number };

export function ownedAudioFile(source?: SourceDto, duration?: number | null): AudioFile | undefined {
  const size = source?.bytes;
  if (source?.provider !== "local" || source.shared || !source.streamUrl || !/^\/files\/[\w-]+$/.test(source.streamUrl) ||
    !size || !Number.isSafeInteger(size) || size > MAX_FILE || size < 0 || !source.mime) return;
  const estimate = duration && Number.isFinite(duration) && duration > 0 ? Math.ceil(5 * size / duration) : 128 * 1024;
  // Reserve part of the preparation budget for trailing MP4 metadata.
  const prefixLimit = /^(audio|video)\/(mp4|x-m4a)/.test(source.mime) && size > MAX_PREFIX
    ? MAX_PREFIX - 64 * 1024 : MAX_PREFIX;
  return { url: source.streamUrl, size, mime: source.mime, prefix: Math.min(size, prefixLimit, estimate) };
}

type Block = {
  start: number;
  data: Uint8Array;
  received: number;
  changed: Promise<void>;
  notify: () => void;
  error?: unknown;
};

function changed(block: Block) {
  block.notify();
  block.changed = new Promise(resolve => { block.notify = resolve; });
}

// Follow ISO BMFF top-level box lengths. When an mdat runs past the prefix,
// its exclusive end is where the decoder will look for trailing metadata.
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
    if (type === 0x6d6f6f76) return; // moov precedes the media
    at += length;
    if (type === 0x6d646174 && at >= prefix.length && at < size) return at; // mdat
  }
}

type Demand = { block: Block; priority: RequestPriority };

// A seek takes over the active origin transfer. Sequential filling resumes
// after the bytes already received when the decoder has enough data.
class AudioBytes {
  private blocks = new Map<number, Block>();
  private decoders = new Map<symbol, Demand>();
  private pins = new Map<symbol, Demand>();
  private network?: { block: Block; controller: AbortController };
  private closed = false;
  private filling?: Promise<void>;
  private tail?: number;
  constructor(readonly file: AudioFile, private read: ReadFile) {}

  private blockAt(offset: number) {
    const { prefix, size } = this.file;
    const tail = this.tail ?? size;
    const start = offset >= tail ? tail : offset < prefix ? 0 : prefix + Math.floor((offset - prefix) / BLOCK) * BLOCK;
    let block = this.blocks.get(start);
    if (!block) {
      const end = offset >= tail ? size : Math.min(tail, start === 0 ? prefix : start + BLOCK);
      block = { start, data: new Uint8Array(end - start), received: 0, changed: Promise.resolve(), notify: () => {} };
      changed(block);
      this.blocks.set(start, block);
    }
    return block;
  }

  private schedule() {
    if (this.closed) return;
    const demands = [...this.decoders.values()].reverse().concat([...this.pins.values()]);
    const wanted = demands.find(({ block }) => !block.error && block.received < block.data.length);
    if (this.network) {
      const { block, controller } = this.network;
      if (wanted?.block !== block && block.received < block.data.length) controller.abort();
      return;
    }
    if (!wanted) return;
    const { block, priority } = wanted;
    const controller = new AbortController();
    this.network = { block, controller };
    void this.download(block, priority, controller.signal).catch(error => {
      if (!controller.signal.aborted) block.error = error;
    }).finally(() => {
      this.network = undefined;
      changed(block);
      this.schedule();
    });
  }

  private async download(block: Block, priority: RequestPriority, signal: AbortSignal) {
    const start = block.start + block.received;
    const end = block.start + block.data.length - 1;
    const response = await this.read(this.file.url, { headers: { Range: `bytes=${start}-${end}` }, signal, cache: "no-store", priority });
    if (response.status !== 206 || response.headers.get("Content-Range") !== `bytes ${start}-${end}/${this.file.size}` || !response.body) {
      await response.body?.cancel();
      throw new Error("Unexpected audio range");
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        block.data.set(value, block.received);
        block.received += value.length;
        changed(block);
      }
      if (block.received !== block.data.length) throw new Error("Incomplete audio range");
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  }

  private async load(block: Block, priority: RequestPriority) {
    const key = Symbol();
    this.pins.set(key, { block, priority });
    this.schedule();
    try {
      while (block.received < block.data.length) {
        if (this.closed || block.error) throw block.error ?? new Error("Playback changed");
        await block.changed;
      }
    } finally {
      this.pins.delete(key);
      this.schedule();
    }
  }

  prepare(priority: RequestPriority) { return this.load(this.blockAt(0), priority); }

  async prepareMetadata() {
    if (!/^(audio|video)\/(mp4|x-m4a)/.test(this.file.mime)) return;
    const prefix = this.blockAt(0).data;
    const tail = metadataTail(prefix, this.file.size);
    if (!tail || this.file.size - tail > MAX_PREFIX - prefix.length) return;
    this.tail = tail;
    await this.load(this.blockAt(tail), "low");
  }

  fill() {
    return this.filling ??= (async () => {
      for (let offset = 0; offset < this.file.size;) {
        const block = this.blockAt(offset);
        await this.load(block, "low");
        offset += block.data.length;
      }
    })();
  }

  async chunk(key: symbol, offset: number, end: number) {
    const block = this.blockAt(offset);
    if (this.decoders.get(key)?.block !== block) {
      this.decoders.set(key, { block, priority: "high" });
      this.schedule();
    }
    while (offset >= block.start + block.received) {
      if (this.closed || !this.decoders.has(key) || block.error) throw block.error ?? new Error("Range cancelled");
      await block.changed;
    }
    const count = Math.min(64 * 1024, end + 1 - offset, block.start + block.received - offset);
    return block.data.slice(offset - block.start, offset - block.start + count);
  }

  release(key: symbol) {
    const demand = this.decoders.get(key);
    this.decoders.delete(key);
    if (demand) changed(demand.block);
    this.schedule();
  }

  async authorize() {
    const response = await this.read(this.file.url, { method: "HEAD", cache: "no-store", signal: this.lifecycle.signal });
    if (!response.ok || Number(response.headers.get("Content-Length")) !== this.file.size)
      throw new Error("Audio no longer available");
  }

  private lifecycle = new AbortController();
  close() {
    this.closed = true;
    this.lifecycle.abort();
    this.network?.controller.abort();
    this.pins.clear();
    this.decoders.clear();
    for (const block of this.blocks.values()) changed(block);
    this.blocks.clear();
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
  private current?: { token: string; bytes: AudioBytes; access: Promise<void> };
  private next?: AudioBytes;
  private prepared = false;
  constructor(private read: ReadFile = (url, init) => fetch(url, init)) {}

  suspendPreparation() {
    if (!this.prepared) void this.prepare();
  }

  async prepare(file?: AudioFile) {
    if (file && this.next?.file.url === file.url && this.next.file.size === file.size) return;
    this.next?.close();
    this.next = undefined;
    this.prepared = false;
    if (!file || file.url === this.current?.bytes.file.url) return;
    const next = this.next = new AudioBytes(file, this.read);
    try {
      await next.prepare("low");
      if (this.next === next) await next.prepareMetadata();
      if (this.next === next) this.prepared = true;
    }
    catch { if (this.next === next) { next.close(); this.next = undefined; } }
  }

  select(file: AudioFile | undefined, token: string) {
    if (!file) { this.clear(); return; }
    const previous = this.current?.bytes;
    const reuse = [this.next, previous].find(entry => entry?.file.url === file.url && entry.file.size === file.size);
    if (previous !== reuse) previous?.close();
    if (this.next !== reuse) this.next?.close();
    this.next = undefined;
    const bytes = reuse ?? new AudioBytes(file, this.read);
    const access = reuse ? bytes.authorize() : Promise.resolve();
    void access.catch(() => bytes.close());
    this.current = { token, bytes, access };
  }

  response(token: string, range: string | null) {
    const current = this.current;
    if (!current || current.token !== token) return;
    const { size, mime } = current.bytes.file;
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
        await current.access;
        if (cancelled || this.current !== current) throw new Error("Playback changed");
        const first = offset === bounds.start;
        const chunk = await current.bytes.chunk(key, offset, bounds.end);
        if (this.current !== current) throw new Error("Playback changed");
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
    await current?.access;
    if (current === this.current) await current?.bytes.prepare("high");
  }

  async fill() {
    const current = this.current;
    await current?.access;
    if (current === this.current) await current?.bytes.fill();
  }

  clear() {
    this.current?.bytes.close();
    this.next?.close();
    this.current = this.next = undefined;
  }
}
