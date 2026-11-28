import { randomUUID } from "node:crypto";
import Sqlite from "better-sqlite3";
import { invariant } from "./errors";

interface Selection {
  key: string;
  revision: string;
  ids: string[];
  tagCounts: Record<string, number>;
  audioCounts?: Record<string, number>;
}

const blockSize = 100;

// SQLite opens an anonymous temporary database for an empty filename. It can
// spill to disk and removes the file when the handle closes, even on exit.
class DiskOrder {
  private readonly db = new Sqlite("");
  readonly length: number;

  constructor(ids: string[]) {
    this.length = ids.length;
    try {
      this.db.pragma("cache_size = -64");
      this.db.pragma("journal_mode = OFF");
      this.db.exec("CREATE TABLE blocks (start INTEGER PRIMARY KEY, ids TEXT NOT NULL)");
      const put = this.db.prepare("INSERT INTO blocks (start, ids) VALUES (?, ?)");
      this.db.transaction(() => {
        for (let i = 0; i < ids.length; i += blockSize) {
          put.run(i, JSON.stringify(ids.slice(i, i + blockSize)));
        }
      })();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  slice(start = 0, end = this.length): string[] {
    const result: string[] = [];
    const blocks = this.db.prepare<[number, number], { start: number; ids: string }>(
      "SELECT start, ids FROM blocks WHERE start >= ? AND start < ? ORDER BY start",
    );
    for (const block of blocks.iterate(start - start % blockSize, Math.min(this.length, end))) {
      const ids: string[] = JSON.parse(block.ids);
      result.push(...ids.slice(Math.max(0, start - block.start), end - block.start));
    }
    return result;
  }

  close() { this.db.close(); }
}

type Entry = Omit<Selection, "ids"> & { ids: string[] | DiskOrder; expires: number; timer: NodeJS.Timeout };
interface Limits { ttl?: number; maxSelections?: number; idBudget?: number }

export class LibrarySelections {
  private readonly entries = new Map<string, Entry>();
  private readonly ttl: number;
  private readonly maxSelections: number;
  private readonly idBudget: number;
  private retainedIds = 0;

  constructor({ ttl = 15 * 60_000, maxSelections = 32, idBudget = 400_000 }: Limits = {}) {
    this.ttl = ttl;
    this.maxSelections = maxSelections;
    this.idBudget = idBudget;
  }

  add(selection: Selection) {
    const weight = selection.ids.length <= this.idBudget ? selection.ids.length : 0;
    for (const id of this.entries.keys()) {
      if (this.entries.size < this.maxSelections && this.retainedIds + weight <= this.idBudget) break;
      this.remove(id);
    }
    const ids = selection.ids.length > this.idBudget ? new DiskOrder(selection.ids) : selection.ids;
    const id = randomUUID();
    const timer = setTimeout(() => this.remove(id), this.ttl).unref();
    this.entries.set(id, { ...selection, ids, expires: Date.now() + this.ttl, timer });
    this.retainedIds += weight;
    return id;
  }

  get(id: string | undefined, key: string, revision: string) {
    const entry = id && this.entries.get(id);
    invariant(entry && entry.key === key && entry.revision === revision && entry.expires > Date.now(),
      409, "library_changed", "Медиатека изменилась, обновите результаты");
    return entry;
  }

  private remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.ids instanceof DiskOrder) entry.ids.close();
    else this.retainedIds -= entry.ids.length;
    this.entries.delete(id);
  }

  close() {
    for (const id of this.entries.keys()) this.remove(id);
  }
}
