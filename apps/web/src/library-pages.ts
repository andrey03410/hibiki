import type { ItemDto, LibraryPageDto } from "@hibiki/contracts";
import { api, ApiError } from "./api";
import type { LibrarySearch } from "./library-search";

const emptyPage: LibraryPageDto = {items: [], total: 0, nextCursor: null};

export function searchBody(filters: LibrarySearch) {
  return {filters, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone};
}

export async function fetchItems(ids: string[]): Promise<ItemDto[]> {
  const items: ItemDto[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const page = await api<{items: ItemDto[]}>("/library/items", "POST", {ids: ids.slice(start, start + 100)});
    items.push(...page.items);
  }
  return items;
}

export class LibraryPages {
  private state = {...emptyPage, loading: true, error: ""};
  private listeners = new Set<() => void>();
  private generation = 0;
  private pageCount = 0;
  private failedAppend = false;

  constructor(private fetch: (cursor?: string) => Promise<LibraryPageDto>) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {this.listeners.delete(listener);};
  };
  snapshot = () => this.state;
  cancel = () => {this.generation++;};
  private update(patch: Partial<typeof this.state>) {
    this.state = {...this.state, ...patch};
    this.listeners.forEach(listener => listener());
  }

  async refresh() {
    const request = ++this.generation;
    this.update({loading: true, error: ""});
    this.failedAppend = false;
    try {
      let page = await this.fetch();
      let count = 1;
      let items = page.items;
      // Revalidate visible pages in place so a favorite or tag edit keeps scroll depth.
      while (request === this.generation && count < this.pageCount && page.nextCursor) {
        page = await this.fetch(page.nextCursor);
        items = items.concat(page.items);
        count++;
      }
      if (request !== this.generation) return;
      this.pageCount = count;
      this.update({...page, items, loading: false});
    } catch (error) {
      if (request === this.generation) this.update({loading: false, error: (error as Error).message});
    }
  }

  async more() {
    const {nextCursor, loading} = this.state;
    if (loading || !nextCursor) return;
    const request = ++this.generation;
    this.update({loading: true, error: ""});
    try {
      const page = await this.fetch(nextCursor);
      if (request !== this.generation) return;
      this.pageCount++;
      this.update({...page, items: this.state.items.concat(page.items), loading: false});
    } catch (error) {
      if (request !== this.generation) return;
      if (error instanceof ApiError && error.code === "library_changed") return this.refresh();
      this.failedAppend = true;
      this.update({loading: false, error: (error as Error).message});
    }
  }
  retry = () => this.failedAppend ? this.more() : this.refresh();
}
