import type { TagDto } from "@hibiki/contracts";
import { groupKeys, groupOf, normalize, tagNameOrder, type TagCatalog, type TagGroup } from "./taxonomy";
import type { LibrarySearch } from "./library-search";

export type TagSet = { group: TagGroup; ids: string[]; all?: boolean };

/**
 * Selected tags become one set per group: groups are combined with AND, tags
 * inside a group with OR (or AND when the group is listed in `tagAll`).
 * Archived or deleted tags kept from older sessions still filter strictly, as
 * before: they form one extra set that requires all of them.
 */
export function tagSetsFor(search: Pick<LibrarySearch, "tagIds" | "tagAll">, byId: ReadonlyMap<string, TagDto>): TagSet[] {
  const sets = new Map<TagGroup, string[]>();
  const stale: string[] = [];
  for (const id of new Set(search.tagIds)) {
    const tag = byId.get(id);
    if (!tag || tag.archived) {
      stale.push(id);
      continue;
    }
    const group = groupOf(tag);
    sets.set(group, [...(sets.get(group) ?? []), id]);
  }
  const known: TagSet[] = groupKeys.flatMap(group => {
    const ids = sets.get(group);
    if (!ids) return [];
    return [search.tagAll?.includes(group) && ids.length > 1 ? { group, ids, all: true } : { group, ids }];
  });
  return stale.length ? [...known, { group: "extra", ids: stale, all: true }] : known;
}

export function selectedIn(search: Pick<LibrarySearch, "tagIds">, catalog: TagCatalog, group: TagGroup) {
  return search.tagIds.filter(id => {
    const tag = catalog.byId.get(id);
    return tag && groupOf(tag) === group;
  });
}

/** The source node the listener is inside (the last selected source tag). */
export function currentSource(search: Pick<LibrarySearch, "tagIds">, catalog: TagCatalog): TagDto | undefined {
  const ids = selectedIn(search, catalog, "source");
  return ids.length ? catalog.byId.get(ids[ids.length - 1]!) : undefined;
}

/** Moves inside the source tree: replaces the whole source selection. */
export function withSource(search: LibrarySearch, catalog: TagCatalog, id: string | undefined): LibrarySearch {
  const others = search.tagIds.filter(tagId => {
    const tag = catalog.byId.get(tagId);
    return tag && groupOf(tag) !== "source";
  });
  return { ...search, tagIds: id ? [...others, id] : others };
}

/** Toggles a tag filter; a source tag navigates instead of stacking. */
export function toggleTag(search: LibrarySearch, catalog: TagCatalog, id: string): LibrarySearch {
  const tag = catalog.byId.get(id);
  if (!tag) return search;
  if (search.tagIds.includes(id)) return { ...search, tagIds: search.tagIds.filter(other => other !== id) };
  if (groupOf(tag) === "source") return withSource(search, catalog, id);
  return { ...search, tagIds: [...search.tagIds, id] };
}

export function addTag(search: LibrarySearch, catalog: TagCatalog, id: string): LibrarySearch {
  return search.tagIds.includes(id) ? search : toggleTag(search, catalog, id);
}

export function setGroupMode(search: LibrarySearch, group: TagGroup, all: boolean): LibrarySearch {
  const rest = (search.tagAll ?? []).filter(other => other !== group);
  return { ...search, tagAll: all ? [...rest, group] : rest };
}

export function clearGroup(search: LibrarySearch, catalog: TagCatalog, group: TagGroup): LibrarySearch {
  return { ...search, tagIds: search.tagIds.filter(id => !selectedIn({ tagIds: [id] }, catalog, group).length) };
}

/** Ancestor chain of a source tag from the root (first parent path). */
export function sourceTrail(catalog: TagCatalog, id: string): TagDto[] {
  const trail: TagDto[] = [];
  const seen = new Set<string>();
  let tag = catalog.byId.get(id);
  while (tag && !seen.has(tag.id)) {
    trail.unshift(tag);
    seen.add(tag.id);
    const parent = tag.parentIds?.find(parentId => catalog.byId.has(parentId));
    tag = parent ? catalog.byId.get(parent) : undefined;
  }
  return trail;
}

type Counts = Readonly<Record<string, number>> | undefined;
const byCount = (counts: Counts) => (a: TagDto, b: TagDto) =>
  (counts?.[b.id] ?? 0) - (counts?.[a.id] ?? 0) || tagNameOrder.compare(a.name, b.name);

export function sourceChildren(catalog: TagCatalog, id: string, counts: Counts) {
  return [...(catalog.children.get(id) ?? [])].sort(byCount(counts));
}

export function sourceSiblings(catalog: TagCatalog, id: string, counts: Counts) {
  const tag = catalog.byId.get(id);
  const parent = tag?.parentIds?.find(parentId => catalog.byId.has(parentId)) ?? "";
  return sourceChildren(catalog, parent, counts).filter(other => other.id !== id);
}

/** Options of a facet popover: matches first by count, zero-count ones apart. */
export function facetOptions(catalog: TagCatalog, group: TagGroup, query: string, counts: Counts, selected: readonly string[]) {
  const q = normalize(query);
  const matches = catalog.active.filter(tag => groupOf(tag) === group
    && (!q || [tag.name, ...(tag.aliases ?? [])].some(name => normalize(name).includes(q))));
  const order = byCount(counts);
  const chosen = matches.filter(tag => selected.includes(tag.id)).sort(order);
  const rest = matches.filter(tag => !selected.includes(tag.id));
  return {
    present: [...chosen, ...rest.filter(tag => !counts || (counts[tag.id] ?? 0) > 0).sort(order)],
    absent: counts ? rest.filter(tag => (counts[tag.id] ?? 0) === 0).sort(order) : [],
  };
}

export type Suggestion = { tag: TagDto; path: string; alias?: string; count: number };

/** Tags for the search box: prefix matches first, then by usage. */
export function tagSuggestions(catalog: TagCatalog, query: string, counts: Counts, limit = 8): Suggestion[] {
  const q = normalize(query);
  if (q.length < 2) return [];
  const scored: (Suggestion & { rank: number })[] = [];
  for (const tag of catalog.active) {
    const name = normalize(tag.name);
    const alias = name.includes(q) ? undefined : tag.aliases?.find(value => normalize(value).includes(q));
    if (!name.includes(q) && !alias) continue;
    const rank = name === q ? 0 : name.startsWith(q) ? 1 : alias ? 3 : 2;
    const path = catalog.paths(tag.id)[0] ?? tag.name;
    scored.push({ tag, path, alias, count: counts?.[tag.id] ?? 0, rank });
  }
  return scored.sort((a, b) => a.rank - b.rank || b.count - a.count || tagNameOrder.compare(a.tag.name, b.tag.name))
    .slice(0, limit).map(({ rank: _rank, ...rest }) => rest);
}

/** Source tag shown in a row: the selected one, then one below a selected section, then the first. */
export function rowSource(tags: readonly TagDto[], catalog: TagCatalog, selected: readonly string[] = []): TagDto | undefined {
  const sources = tags.filter(tag => !tag.archived && groupOf(tag) === "source");
  return sources.find(tag => selected.includes(tag.id)) ?? sources.find(tag => catalog.matchesAncestor(tag, [...selected])) ?? sources[0];
}
