import type { ItemDto, LibraryPageDto } from "@hibiki/contracts";
import { api, ApiError } from "./api";
import type { LibrarySearch } from "./library-search";

const emptyPage: LibraryPageDto = {items: [], total: 0, nextCursor: null};

export function searchBody({ previousSort, ...filters }: LibrarySearch, selectionId?: string) {
  return {filters, selectionId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone};
}

export async function fetchItems(ids: string[], verifyShared = false): Promise<ItemDto[]> {
  const items: ItemDto[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const page = await api<{items: ItemDto[]}>("/library/items", "POST", {
      ids: ids.slice(start, start + 100),
      ...(verifyShared && { verifyShared }),
    });
    items.push(...page.items);
  }
  return items;
}

export class LibraryPages {
  private state = {...emptyPage, loading: true, error: ""};
  private listeners = new Set<() => void>();
  private pageCount = 0;
  private failedAppend = false;

  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private fetch: (cursor: string | undefined, signal: AbortSignal, selectionId?: string) => Promise<LibraryPageDto>) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {this.listeners.delete(listener);};
  };
  snapshot = () => this.state;
  cancel = () => {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = undefined;
  };
  open(filters: LibrarySearch, previous?: LibrarySearch) {
    if (previous && filters.query.trim() && previous.query !== filters.query) {
      this.cancel();
      this.timer = setTimeout(() => void this.refresh(), 150);
    } else if (this.state.selectionId) {
      void this.restart();
    } else {
      void this.refresh();
    }
  }
  private begin() {
    this.cancel();
    this.controller = new AbortController();
    return this.controller.signal;
  }
  private restart(): Promise<void> {
    this.pageCount = 0;
    this.update({ ...emptyPage, tagCounts: undefined, selectionId: undefined, loading: true, error: "" });
    return this.refresh();
  }
  async fullOrder(selectionId: string | undefined, load: (id?: string) => Promise<string[]>): Promise<string[]> {
    try {
      return await load(selectionId);
    } catch (error) {
      if (!selectionId || !(error instanceof ApiError) || error.code !== "library_changed") throw error;
      // A queue can still need its tail after navigation away from this search.
      if (!this.state.selectionId || this.state.selectionId === selectionId) await this.restart();
      const replacement = this.state.selectionId;
      if (!replacement || replacement === selectionId) throw error;
      return load(replacement);
    }
  }
  private update(patch: Partial<typeof this.state>) {
    this.state = {...this.state, ...patch};
    this.listeners.forEach(listener => listener());
  }

  async refresh(background = false): Promise<void> {
    if (background && (this.state.loading || this.state.error)) return;
    const signal = this.begin();
    if (!background) {
      this.update({loading: true, error: ""});
      this.failedAppend = false;
    }
    try {
      let page = await this.fetch(undefined, signal, background ? this.state.selectionId : undefined);
      const { tagCounts, selectionId } = page;
      let count = 1;
      let items = page.items;
      // Revalidate visible pages in place so a favorite or tag edit keeps scroll depth.
      while (!signal.aborted && count < this.pageCount && page.nextCursor) {
        page = await this.fetch(page.nextCursor, signal);
        items = items.concat(page.items);
        count++;
      }
      if (signal.aborted) return;
      this.pageCount = count;
      this.update({...page, items, tagCounts, selectionId, loading: false});
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.code === "library_changed" && this.pageCount > 0) return this.restart();
      if (!background) this.update({loading: false, error: (error as Error).message});
    }
  }

  async revalidateShared(load = fetchItems) {
    if (this.state.loading || this.state.error) return;
    const ids = this.state.items.filter(item => item.shared).map(item => item.id);
    if (!ids.length) return;
    const signal = this.controller?.signal;
    const fresh = new Map((await load(ids)).map(item => [item.id, item]));
    if (signal?.aborted) return;
    const items = this.state.items.map(item => {
      const updated = fresh.get(item.id);
      return updated && JSON.stringify(item) !== JSON.stringify(updated) ? updated : item;
    });
    if (items.some((item, index) => item !== this.state.items[index])) this.update({ items });
  }

  async more() {
    const {nextCursor, loading} = this.state;
    if (loading || !nextCursor) return;
    const signal = this.begin();
    this.update({loading: true, error: ""});
    try {
      const page = await this.fetch(nextCursor, signal);
      if (signal.aborted) return;
      this.pageCount++;
      this.update({items: this.state.items.concat(page.items), total: page.total, nextCursor: page.nextCursor, loading: false});
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.code === "library_changed") return this.restart();
      this.failedAppend = true;
      this.update({loading: false, error: (error as Error).message});
    }
  }
  retry = () => this.failedAppend ? this.more() : this.refresh();
}
