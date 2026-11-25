import type { ItemDto, PlaybackMode } from "@hibiki/contracts";
import { playbackSources, type PlaybackSettings } from "./player-model";

export class QueueIntents {
  selection = 0;
  navigation = 0;
  command() {
    this.selection = ++this.navigation;
    return this.selection;
  }
  advance() {
    return ++this.navigation;
  }
}

// Keep boundary navigation waiting across a failed request and an explicit retry.
// Starting another queue releases waiters and invalidates the old response.
export class LibraryQueueLoad {
  private status: "complete" | "loading" | "error" = "complete";
  private listeners = new Set<() => void>();
  private request?: { run: () => Promise<void>; release: () => void; ready: Promise<void> };
  get tail() { return this.request?.ready; }
  snapshot = () => this.status;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(status: typeof this.status) {
    if (status === this.status) return;
    this.status = status;
    this.listeners.forEach(listener => listener());
  }
  cancel() {
    this.request?.release();
    this.request = undefined;
    this.publish("complete");
  }
  start(load: () => Promise<string[]>, apply: (ids: string[]) => void) {
    this.cancel();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const request = { ready, release, run: async () => {
      this.publish("loading");
      try {
        const ids = await load();
        if (request !== this.request) return;
        apply(ids);
        this.cancel();
      } catch {
        if (request === this.request) this.publish("error");
      }
    } };
    this.request = request;
    void request.run();
  }
  retry() {
    if (this.status === "error") void this.request?.run();
  }
}

export function completeLibraryOrder(state: PlaybackSettings, ids: string[]) {
  const current = state.queue[state.queueIndex];
  const queue = [...new Set(ids)];
  // The library can change between the page and the ID response. Finish the
  // playing entry even if it has just fallen outside the filter.
  if (current && !queue.includes(current)) queue.splice(state.queueIndex, 0, current);
  return { queue, queueIndex: current ? queue.indexOf(current) : 0 };
}

type SharedQueue = { number: number; load: () => Promise<ItemDto[]> };
type SharedReads = Map<SharedQueue, Promise<Map<string, ItemDto>>>;

// A saved queue contains IDs. A missing detail row is only a deletion after a
// successful lookup, so browsing a different page never prunes the queue.
export class QueueCatalog {
  readonly rows = new Map<string, ItemDto>();
  private sharedQueues = new Map<string, SharedQueue>();
  private sharedIds = new Map<string, { source: SharedQueue; id: string }>();
  private known = new Set<string>();
  private pending = new Map<string, Promise<void>>();
  private generation = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  constructor(
    private fetch: (ids: string[]) => Promise<ItemDto[]>,
    private verify: (ids: string[]) => Promise<ItemDto[]> = fetch,
  ) {}
  snapshot = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {this.listeners.delete(listener);};
  };
  private publish() {
    this.version++;
    this.listeners.forEach(listener => listener());
  }
  invalidate() {
    this.generation++;
    this.known.clear();
    this.pending.clear();
  }
  deleted = (id: string) => this.known.has(id) && !this.rows.has(id);
  isShared = (id?: string) => id !== undefined && this.sharedIds.has(id);
  sharedId(path: string, id: string) {
    const source = this.sharedQueues.get(path);
    return source && `shared-playback:${source.number}:${id}`;
  }
  sharedEntries(path: string, items: ItemDto[], load: () => Promise<ItemDto[]>) {
    let source = this.sharedQueues.get(path);
    if (!source) this.sharedQueues.set(path, source = { number: this.sharedQueues.size, load });
    else source.load = load;
    return items.map(item => {
      const id = this.sharedId(path, item.id)!;
      this.sharedIds.set(id, { source, id: item.id });
      return { ...item, id };
    });
  }
  rechecksPlayback = (id?: string) => id !== undefined && (this.isShared(id) || this.rows.get(id)?.shared !== undefined);
  async readPlayback(id: string, reads: SharedReads = new Map()) {
    const known = this.rows.get(id);
    const shared = this.sharedIds.get(id);
    if (shared) {
      let read = reads.get(shared.source);
      if (!read) {
        read = shared.source.load().then(items => new Map(items.map(item => [item.id, item])));
        reads.set(shared.source, read);
      }
      const item = (await read).get(shared.id);
      // A revoked position keeps its place in the queue until the next start.
      // Discard the metadata previously returned through this access path.
      return item ? { ...item, id } : {
        id, title: "Запись недоступна", originalTitle: "", kind: "audio" as const,
        duration: null, createdAt: "", updatedAt: "", tags: [], sources: [],
      };
    }
    if (!known?.shared) return known;
    const [latest] = await this.verify([id]);
    return latest ?? { ...known, sources: [] };
  }
  async refreshPlayback(id: string, active = () => true, reads?: SharedReads) {
    const row = await this.readPlayback(id, reads);
    if (!active()) return;
    if (row && row !== this.rows.get(id)) this.put([row]);
    return row;
  }
  put(items: ItemDto[]) {
    for (const item of items) {
      this.rows.set(item.id, item);
      this.known.add(item.id);
    }
    this.publish();
  }
  async ensure(ids: string[], active: () => boolean = () => true, verify = false) {
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length && active(); start += 100) {
      const chunk = unique.slice(start, start + 100).filter(id => !this.isShared(id) && !this.known.has(id));
      const missing = chunk.filter(id => !this.pending.has(id));
      if (missing.length) {
        const generation = this.generation;
        const request = (verify ? this.verify : this.fetch)(missing).then(rows => {
          if (generation !== this.generation) return;
          for (const id of missing) { this.rows.delete(id); this.known.add(id); }
          this.put(rows);
        }).finally(() => {
          if (generation === this.generation) missing.forEach(id => this.pending.delete(id));
        });
        missing.forEach(id => this.pending.set(id, request));
      }
      await Promise.all(new Set(chunk.map(id => this.pending.get(id))));
    }
  }
  async nextInQueue(read: () => PlaybackSettings, direction: 1 | -1, ended: boolean,
    failed: ReadonlySet<string>, active: () => boolean, unloadedTail: () => Promise<void> | undefined = () => undefined) {
    while (active()) {
      const state = read();
      const generation = this.generation;
      const tail = unloadedTail();
      const current = state.queue[state.queueIndex];
      let index: number;
      if (ended && state.repeat === "one" && !this.rechecksPlayback(current)) {
        index = state.queueIndex;
      } else if (ended && state.repeat === "one" && current) {
        const item = await this.refreshPlayback(current, active);
        index = item && playbackSources(item, state.mode).length ? state.queueIndex
          : await this.findPlayable(state.queue, state.queueIndex, direction, false, state.mode, failed, active);
      } else {
        index = await this.findPlayable(state.queue, state.queueIndex, direction, !tail && state.repeat === "all", state.mode, failed, active);
      }
      if (index < 0 && tail && (direction > 0 || state.repeat === "all")) {
        await tail;
        continue;
      }
      const latest = read();
      if (active() && this.generation === generation && latest.queue === state.queue && latest.queueIndex === state.queueIndex &&
          latest.mode === state.mode && latest.repeat === state.repeat) return {index, state: latest};
    }
  }
  async findPlayable(queue: string[], current: number, direction: 1 | -1, wrap: boolean,
    mode: PlaybackMode, failed?: ReadonlySet<string>, active = () => true): Promise<number> {
    const reads: SharedReads = new Map();
    for (let offset = 1; offset <= queue.length && active(); offset++) {
      const raw = current + offset * direction;
      if (!wrap && (raw < 0 || raw >= queue.length)) break;
      const index = (raw + queue.length) % queue.length;
      const id = queue[index]!;
      const known = this.isShared(id) || this.known.has(id);
      if (!known) {
        const window = direction === 1 ? queue.slice(index, index + 32) : queue.slice(Math.max(0, index - 31), index + 1);
        await this.ensure(window, active);
      }
      const item = this.rechecksPlayback(id) && !failed?.has(id)
        ? await this.refreshPlayback(id, active, reads) : this.rows.get(id);
      if (item && !failed?.has(id) && playbackSources(item, mode).length) return index;
    }
    return -1;
  }
}
