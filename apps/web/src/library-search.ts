import type { BrowserLibrarySearch, ItemDto, SourceDto, TagDto } from "@hibiki/contracts";
import { noteFor, type NotesIndex } from "./note-model";

import { filterLabels, groupKeys, missingLabels, type TagGroup } from "./taxonomy";

type PreviousSort = Exclude<BrowserLibrarySearch["sort"], "recent">;
/** `tagAll` lists tag groups whose selected tags must all match (default: any of them). */
export type LibrarySearch = BrowserLibrarySearch & { previousSort?: PreviousSort; tagAll?: TagGroup[] };

export const librarySorts = {
  "added-desc": "Сначала новые", "added-asc": "Сначала старые",
  "title-asc": "Название ↑", "title-desc": "Название ↓",
  "duration-asc": "Сначала короткие", "duration-desc": "Сначала длинные",
  popular: "Чаще слушаю", recent: "Недавно слушал", random: "В случайном порядке",
} satisfies Record<LibrarySearch["sort"], string>;

export function newRandomSeed() {
  return crypto.getRandomValues(new Uint32Array(2)).join("-");
}

export function changeLibrarySort(current: LibrarySearch, sort: LibrarySearch["sort"]): LibrarySearch {
  const previousSort = sort === "recent" && current.sort !== "recent" ? current.sort : current.previousSort;
  const randomSeed = sort === "random" ? current.randomSeed ?? newRandomSeed() : current.randomSeed;
  return { ...current, sort, randomSeed, previousSort };
}

export function restoreLibrarySearch(raw: string | null): LibrarySearch {
  const stored: Partial<BrowserLibrarySearch> & { previousSort?: BrowserLibrarySearch["sort"] } = JSON.parse(raw ?? "{}") ?? {};
  const initial = { ...defaultLibrarySearch };
  for (const field of ["query", "minDuration", "maxDuration", "addedFrom", "addedThrough"] as const) {
    const value = stored[field];
    if (typeof value === "string") initial[field] = value;
  }
  if (stored.kind && Object.hasOwn(libraryKinds, stored.kind)) initial.kind = stored.kind;
  if (stored.provider && Object.hasOwn(libraryProviders, stored.provider)) initial.provider = stored.provider;
  if (stored.availability && Object.hasOwn(libraryStatuses, stored.availability)) initial.availability = stored.availability;
  if (stored.sort && Object.hasOwn(librarySorts, stored.sort)) initial.sort = stored.sort;
  if (Array.isArray(stored.tagIds)) initial.tagIds = stored.tagIds.filter(id => typeof id === "string" && id.length > 0 && id.length <= 256);
  // The former global AND/OR switch is replaced by per-group modes.
  const tagAll = (stored as { tagAll?: unknown }).tagAll;
  if (Array.isArray(tagAll)) initial.tagAll = groupKeys.filter(group => tagAll.includes(group));
  if (stored.performanceFilter && Object.hasOwn(filterLabels, stored.performanceFilter)) initial.performanceFilter = stored.performanceFilter;
  if (stored.missingGroup && Object.hasOwn(missingLabels, stored.missingGroup)) initial.missingGroup = stored.missingGroup;
  initial.needsClassification = stored.needsClassification === true;
  initial.favoriteOnly = stored.favoriteOnly === true;
  if (stored.previousSort && stored.previousSort !== "recent" && Object.hasOwn(librarySorts, stored.previousSort)) {
    initial.previousSort = stored.previousSort;
  }
  if (typeof stored.randomSeed === "string" && stored.randomSeed.length > 0 && stored.randomSeed.length <= 128) {
    initial.randomSeed = stored.randomSeed;
  }
  return changeLibrarySort(initial, initial.sort);
}

export const defaultLibrarySearch: LibrarySearch = {
  query: "", kind: "", tagIds: [], minDuration: "", maxDuration: "",
  addedFrom: "", addedThrough: "", provider: "", availability: "", favoriteOnly: false,
  sort: "added-desc", tagMode: "and", performanceFilter: "", needsClassification: false,
};

export type LibraryView = "list" | "cards" | "browse";

export const libraryKinds = { "": "Все", audio: "Аудио", video: "Видео" } satisfies Record<LibrarySearch["kind"], string>;
export const libraryProviders = {
  "": "Любой", youtube: "YouTube", local: "Есть локальная копия",
  "working-local": "Есть рабочая локальная копия",
} satisfies Record<LibrarySearch["provider"], string>;
export const libraryStatuses = {
  "": "Любая", available: "Есть доступный источник", unknown: "Статус неизвестен",
  unavailable: "Нет рабочего источника",
} satisfies Record<LibrarySearch["availability"], string>;

function terms(query: string) {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function includesTerms(words: string[], fields: (string | undefined)[]) {
  const text = fields.join(" ").toLocaleLowerCase();
  return words.every((word) => text.includes(word));
}

export function matchesSearch(query: string, ...fields: (string | undefined)[]) {
  const words = terms(query);
  return !words.length || includesTerms(words, fields);
}

function sourceStatus(sources: SourceDto[]): SourceDto["status"] {
  if (sources.some((source) => source.status === "available")) return "available";
  if (sources.some((source) => source.status === "unknown")) return "unknown";
  return "unavailable";
}

function workingLocalSource(source: SourceDto): boolean {
  return source.provider === "local" && source.status === "available" && !!source.streamUrl;
}

export function sourceAvailability(item: ItemDto): SourceDto["status"] {
  return sourceStatus(item.sources);
}

type LibrarySourceBadge = {
  provider: SourceDto["provider"] | "shared" | "none";
  status: SourceDto["status"];
  label: string;
};

export function librarySourceBadges(item: Pick<ItemDto, "kind" | "sources">): LibrarySourceBadge[] {
  const badges: LibrarySourceBadge[] = [];
  const own = item.sources.filter(source => !source.shared);
  const youtube = own.filter((source) => source.provider === "youtube");
  if (youtube.length) {
    const status = sourceStatus(youtube);
    const label = status === "available" ? "YouTube" : status === "unknown"
      ? "YouTube · доступность не проверена" : "YouTube недоступен";
    badges.push({ provider: "youtube", status, label });
  }
  const local = own.filter((source) => source.provider === "local");
  if (local.length) {
    const working = local.filter(workingLocalSource);
    const audioCopy = item.kind === "video" && working.every((source) => source.mime?.startsWith("audio/"));
    const status = working.length ? "available"
      : local.some((source) => source.status === "unknown") ? "unknown" : "unavailable";
    const label = status === "available" ? audioCopy ? "Аудиокопия на устройстве" : "На устройстве"
      : status === "unknown" ? "Локальная копия · доступность не проверена" : "Локальная копия недоступна";
    badges.push({ provider: "local", status, label });
  }
  const shared = item.sources.filter(source => source.shared);
  if (shared.length) badges.push({ provider: "shared", status: sourceStatus(shared), label: "Источник по ссылке" });
  if (!badges.length) badges.push({ provider: "none", status: "unavailable", label: "Нет источника" });
  return badges;
}

function durationBound(value: string) {
  const seconds = Number(value);
  return value.trim() && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function dateBound(value: string, nextDay = false) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(+date)) return undefined;
  if (nextDay) date.setDate(date.getDate() + 1);
  return +date;
}

type LibraryFilterCondition = {
  key: string;
  label: string;
  advanced: boolean;
  clear: (search: LibrarySearch) => LibrarySearch;
};

export function libraryFilterConditions(search: LibrarySearch, tags: TagDto[]): LibraryFilterCondition[] {
  const conditions: LibraryFilterCondition[] = [];
  function add(field: Exclude<keyof LibrarySearch, "query" | "sort" | "tagIds">, label: string, advanced = false) {
    conditions.push({
      key: field, label, advanced,
      clear: (current) => ({ ...current, [field]: defaultLibrarySearch[field] }),
    });
  }

  if (search.performanceFilter) add("performanceFilter", filterLabels[search.performanceFilter]);
  if (search.missingGroup) {
    conditions.push({
      key: "missingGroup", label: "Не указано · " + missingLabels[search.missingGroup], advanced: true,
      clear: current => ({...current, needsClassification: false, missingGroup: undefined}),
    });
  } else if (search.needsClassification) add("needsClassification", "Требуют разметки", true);
  if (search.kind) add("kind", libraryKinds[search.kind]);
  if (search.favoriteOnly) add("favoriteOnly", "Избранное");
  for (const id of search.tagIds) {
    conditions.push({
      key: `tag:${id}`,
      label: tags.find((tag) => tag.id === id)?.name ?? "Удалённый тег",
      advanced: false,
      clear: (current) => ({ ...current, tagIds: current.tagIds.filter((tagId) => tagId !== id) }),
    });
  }
  if (search.provider) add("provider", libraryProviders[search.provider], true);
  if (search.availability) add("availability", libraryStatuses[search.availability], true);
  if (durationBound(search.minDuration) !== undefined) add("minDuration", `Длительность от ${search.minDuration} с`, true);
  if (durationBound(search.maxDuration) !== undefined) add("maxDuration", `Длительность до ${search.maxDuration} с`, true);
  if (dateBound(search.addedFrom) !== undefined) add("addedFrom", `Добавлено с ${search.addedFrom}`, true);
  if (dateBound(search.addedThrough) !== undefined) add("addedThrough", `Добавлено по ${search.addedThrough}`, true);
  return conditions;
}

export function resetLibraryFilters({ query, sort, previousSort, randomSeed }: LibrarySearch): LibrarySearch {
  return { ...defaultLibrarySearch, query, sort, previousSort, randomSeed };
}

export function librarySearchForTag(current: LibrarySearch, id: string): LibrarySearch {
  const sort = current.sort === "recent" ? current.previousSort ?? "added-desc" : current.sort;
  return { ...resetLibraryFilters(current), query: "", tagIds: [id], sort };
}

export function selectLibraryResults(selected: string[], items: ItemDto[], checked: boolean) {
  const ids = new Set(items.map(({ id }) => id));
  return checked ? [...new Set([...selected, ...ids])] : selected.filter((id) => !ids.has(id));
}

const titleOrder = new Intl.Collator("ru", { sensitivity: "base", numeric: true });

export const popularTagLimit = 6;

export function countLibraryTags(items: readonly ItemDto[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const id of new Set(item.tags.map((tag) => tag.id))) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

export function libraryTagChoices(
  tags: readonly TagDto[], counts: ReadonlyMap<string, number> | undefined, query: string, expanded: boolean,
) {
  const words = terms(query);
  const alphabetical = (a: TagDto, b: TagDto) => titleOrder.compare(a.name, b.name);
  if (expanded || words.length) {
    return tags.filter((tag) => includesTerms(words, [tag.name])).sort(alphabetical);
  }
  return [...tags].sort((a, b) =>
    (counts?.get(b.id) ?? 0) - (counts?.get(a.id) ?? 0) || alphabetical(a, b),
  ).slice(0, popularTagLimit);
}

export function searchLibrary(items: ItemDto[], search: LibrarySearch, notes?: NotesIndex) {
  const words = terms(search.query);
  const min = durationBound(search.minDuration);
  const max = durationBound(search.maxDuration);
  const from = dateBound(search.addedFrom);
  const end = dateBound(search.addedThrough, true);
  const descending = search.sort.endsWith("-desc");

  return items.filter((item) => {
    if (search.kind && item.kind !== search.kind) return false;
    if (search.favoriteOnly && !item.favorite) return false;
    if (!search.tagIds.every((id) => item.tags.some((tag) => tag.id === id))) return false;
    if (min !== undefined && (item.duration === null || item.duration < min)) return false;
    if (max !== undefined && (item.duration === null || item.duration > max)) return false;
    if ((from !== undefined || end !== undefined)) {
      const added = Date.parse(item.createdAt);
      if (from !== undefined && added < from) return false;
      if (end !== undefined && added >= end) return false;
    }
    if (search.availability && sourceAvailability(item) !== search.availability) return false;
    if (search.provider === "working-local") {
      if (!item.sources.some(workingLocalSource)) return false;
    } else if (search.provider && !item.sources.some((source) => source.provider === search.provider)) {
      return false;
    }
    return !words.length || includesTerms(words, [
      item.title, item.originalTitle, ...item.tags.map((tag) => tag.name),
      noteFor(notes, "item", item.id),
      ...item.sources.map((source) => noteFor(notes, "source", source.id)),
    ]);
  }).sort((a, b) => {
    let order: number;
    if (search.sort.startsWith("duration")) {
      if (a.duration === null || b.duration === null) {
        return Number(a.duration === null) - Number(b.duration === null) || a.id.localeCompare(b.id);
      }
      order = a.duration - b.duration;
    } else if (search.sort.startsWith("title")) {
      order = titleOrder.compare(a.title, b.title);
    } else {
      order = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    }
    return (descending ? -order : order) || a.id.localeCompare(b.id);
  });
}
