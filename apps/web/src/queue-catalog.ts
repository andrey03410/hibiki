import type { ItemDto, PlaybackMode } from "@hibiki/contracts";
import { playbackSources, type PlaybackSettings } from "./player-model";

// A saved queue contains IDs. A missing detail row is only a deletion after a
// successful lookup, so browsing a different page never prunes the queue.
export class QueueCatalog {
  readonly rows = new Map<string, ItemDto>();
  private known = new Set<string>();
  private pending = new Map<string, Promise<void>>();
  private generation = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  constructor(private fetch: (ids: string[]) => Promise<ItemDto[]>) {}
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
  put(items: ItemDto[]) {
    for (const item of items) {
      this.rows.set(item.id, item);
      this.known.add(item.id);
    }
    this.publish();
  }
  async ensure(ids: string[], active: () => boolean = () => true) {
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length && active(); start += 100) {
      const chunk = unique.slice(start, start + 100).filter(id => !this.known.has(id));
      const missing = chunk.filter(id => !this.pending.has(id));
      if (missing.length) {
        const generation = this.generation;
        const request = this.fetch(missing).then(rows => {
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
    failed: ReadonlySet<string>, active: () => boolean) {
    while (active()) {
      const state = read();
      const generation = this.generation;
      const index = ended && state.repeat === "one" ? state.queueIndex
        : await this.findPlayable(state.queue, state.queueIndex, direction, state.repeat === "all", state.mode, failed, active);
      const latest = read();
      if (active() && this.generation === generation && latest.queue === state.queue && latest.queueIndex === state.queueIndex &&
          latest.mode === state.mode && latest.repeat === state.repeat) return {index, state: latest};
    }
  }
  async findPlayable(queue: string[], current: number, direction: 1 | -1, wrap: boolean,
    mode: PlaybackMode, failed?: ReadonlySet<string>, active = () => true): Promise<number> {
    for (let offset = 1; offset <= queue.length && active(); offset++) {
      const raw = current + offset * direction;
      if (!wrap && (raw < 0 || raw >= queue.length)) break;
      const index = (raw + queue.length) % queue.length;
      const id = queue[index]!;
      if (!this.known.has(id)) {
        const window = direction === 1 ? queue.slice(index, index + 32) : queue.slice(Math.max(0, index - 31), index + 1);
        await this.ensure(window, active);
      }
      const item = this.rows.get(id);
      if (item && !failed?.has(id) && playbackSources(item, mode).length) return index;
    }
    return -1;
  }
}
