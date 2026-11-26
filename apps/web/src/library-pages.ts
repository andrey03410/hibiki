import type { CompactLibraryOverviewDto, ItemDto, LibraryCardPageDto, LibraryPageDto, LibraryCardOverviewDto } from "@hibiki/contracts";
import { api, ApiError } from "./api";
import type { LibrarySearch } from "./library-search";

const emptyPage: LibraryPageDto = {items: [], total: 0, nextCursor: null};

export function searchBody({ previousSort, ...filters }: LibrarySearch, selectionId?: string) {
  return {filters, selectionId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone};
}

// The overview supplies the first set of counts. Keep the last filtered set as
// well, so changing only selected tags can reuse it across search instances.
export class LibraryCardReader {
  private last?: { key: string; counts: Record<string, number> };

  async page(filters: LibrarySearch, overview: LibraryCardOverviewDto, cursor: string | undefined, signal: AbortSignal, selectionId?: string): Promise<LibraryPageDto> {
    const previous = this.last ?? { key: overview.countsKey, counts: overview.tagCounts };
    const page = await api<LibraryCardPageDto>("/library/page", "POST", {
      ...searchBody(filters, selectionId), cursor, cards: true, indexedCounts: true, tagRevision: overview.revision, countsKey: previous.key,
    }, "high", signal);
    const tags = new Map([...overview.tags, ...page.tags].map(tag => [tag.id, tag]));
    const items = page.items.map(({tagRefs, ...card}) => ({ ...card, updatedAt: card.updatedAt ?? card.createdAt,
      originalTitle: card.originalTitle ?? card.title, tags: tagRefs.map(ref => typeof ref === "number" ? overview.tags[ref]! : tags.get(ref)!) }));
    if (page.countsByIndex && (page.countsByIndex.length !== overview.tags.length
      || !page.countsByIndex.every(count => Number.isSafeInteger(count) && count >= 0))) {
      throw new ApiError("BAD_RESPONSE", "Не удалось прочитать счётчики тегов.");
    }
    const counts = page.countsUnchanged ? previous.counts : page.countsByIndex
      ? Object.fromEntries(overview.tags.map((tag, i) => [tag.id, page.countsByIndex![i]])) : page.tagCounts;
    if (counts && page.countsKey) this.last = {key: page.countsKey, counts};
    return {...page, items, tagCounts: counts};
  }
}

export function validateOverview(value: LibraryCardOverviewDto | CompactLibraryOverviewDto): LibraryCardOverviewDto {
  if (value && "directory" in value) {
    const {directory, ...summary} = value;
    const invalid = () => new ApiError("BAD_RESPONSE", "Не удалось прочитать сводку медиатеки.");
    if (!Array.isArray(directory)) throw invalid();
    const tags = directory.map(row => {
      if (!Array.isArray(row)) throw invalid();
      const [id, name, color, group, count, aliases, parents, legacyFlat] = row;
      if (typeof id !== "string" || typeof name !== "string" || typeof color !== "string"
        || !["source","artist","genre","mood","extra"].includes(group) || !Number.isSafeInteger(count) || count < 0
        || (aliases != null && (!Array.isArray(aliases) || !aliases.every(a => typeof a === "string")))
        || (parents != null && !Array.isArray(parents)) || (legacyFlat != null && legacyFlat !== true)) throw invalid();
      const parentIds = (parents ?? []).map(ref => {
        if (typeof ref === "string") return ref;
        if (!Number.isInteger(ref) || typeof directory[ref]?.[0] !== "string") throw invalid();
        return directory[ref]![0];
      });
      return {id, name, color, group, aliases: aliases ?? [], parentIds, archived: false, ...(legacyFlat && {legacyFlat})};
    });
    value = {...summary, tags, tagCounts: Object.fromEntries(directory.map(row => [row[0], row[4]]))};
  }
  if (!value || typeof value.revision !== "string" || typeof value.overviewToken !== "string"
    || !Number.isSafeInteger(value.total) || !value.tagCounts || Array.isArray(value.tagCounts) || typeof value.tagCounts !== "object"
    || !Array.isArray(value.tags) || !value.tags.every(tag => tag && typeof tag.id === "string" && typeof tag.name === "string")
    || !Array.isArray(value.playlists) || !value.playlists.every(card => card && typeof card.id === "string" && typeof card.title === "string")
    || !Array.isArray(value.jobs) || !value.jobs.every(job => job && typeof job.id === "string" && typeof job.state === "string"))
    throw new ApiError("BAD_RESPONSE", "Не удалось прочитать сводку медиатеки.");
  return value;
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

function singleCharacterEdit(oldText: string, newText: string) {
  const oldChars = Array.from(oldText), newChars = Array.from(newText);
  const [shorter, longer] = oldChars.length < newChars.length ? [oldChars, newChars] : [newChars, oldChars];
  if (longer.length !== shorter.length + 1) return false;
  const first = shorter.findIndex((char, index) => char !== longer[index]);
  return first < 0 || shorter.slice(first).every((char, index) => char === longer[first + index + 1]);
}

export class LibraryPages {
  private state = {...emptyPage, loading: true, appending: false, error: ""};
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
    // Debounce typing. A paste, full-title replacement or clear is ready to submit.
    if (previous && filters.query.trim() && singleCharacterEdit(previous.query, filters.query)) {
      this.cancel();
      this.timer = setTimeout(() => void this.refresh(), 110);
    } else if (this.state.selectionId && filters !== previous) {
      void this.restart(false);
    } else {
      void this.refresh();
    }
  }
  private begin() {
    this.cancel();
    this.controller = new AbortController();
    return this.controller.signal;
  }
  private restart(keepDepth = true): Promise<void> {
    if (!keepDepth) this.pageCount = 0;
    // Keep the mounted rows until a complete replacement arrives.
    this.update({ nextCursor: null, selectionId: undefined, loading: true, appending: false, error: "" });
    return this.refresh(false, false);
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

  async refresh(background = false, retryRevision = true): Promise<void> {
    if (background && (this.state.loading || this.state.error)) return;
    const signal = this.begin();
    if (!background) {
      this.update({loading: true, appending: false, error: ""});
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
      this.update({...page, items, tagCounts, selectionId, loading: false, appending: false});
    } catch (error) {
      if (signal.aborted) return;
      if (retryRevision && error instanceof ApiError && error.code === "library_changed" && this.pageCount > 0) return this.restart();
      if (!background) this.update({loading: false, error: (error as Error).message});
    }
  }

  favoriteChanged(id: string, favorite: boolean, favoritesOnly: boolean) {
    const item = this.state.items.find(row => row.id === id);
    if (!item || !!item.favorite === favorite) return;
    if (favoritesOnly && !favorite) {
      this.update({items: this.state.items.filter(row => row.id !== id), total: Math.max(0, this.state.total - 1)});
    } else {
      this.update({items: this.state.items.map(row => row.id === id ? {...row, favorite} : row)});
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
    this.update({loading: true, appending: true, error: ""});
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
