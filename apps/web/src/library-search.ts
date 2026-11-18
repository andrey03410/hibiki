import type { ItemDto } from "@hibiki/contracts";
import { noteFor, type NotesIndex } from "./note-model";

export type LibrarySearch = {
  query: string;
  kind: "" | "audio" | "video";
  tagIds: string[];
  minDuration: string;
  maxDuration: string;
  addedFrom: string;
  addedThrough: string;
  provider: "" | "youtube" | "local" | "working-local";
  availability: "" | "available" | "unknown" | "unavailable";
  favoriteOnly: boolean;
  sort: "title-asc" | "title-desc" | "duration-asc" | "duration-desc" | "added-asc" | "added-desc";
};

export const defaultLibrarySearch: LibrarySearch = {
  query: "", kind: "", tagIds: [], minDuration: "", maxDuration: "",
  addedFrom: "", addedThrough: "", provider: "", availability: "", favoriteOnly: false,
  sort: "added-desc",
};

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

export function sourceAvailability(item: ItemDto): Exclude<LibrarySearch["availability"], ""> {
  if (item.sources.some((source) => source.status === "available")) return "available";
  if (item.sources.some((source) => source.status === "unknown")) return "unknown";
  return "unavailable";
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

const titleOrder = new Intl.Collator("ru", { sensitivity: "base", numeric: true });

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
      if (!item.sources.some((source) => source.provider === "local" && source.status === "available" && source.streamUrl)) return false;
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
