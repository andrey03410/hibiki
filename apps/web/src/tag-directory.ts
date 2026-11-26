import type { TagDto } from "@hibiki/contracts";
import { matchesSearch } from "./library-search";
import { noteFor, type NotesIndex } from "./note-model";
import { groupOf, groups, tagNameOrder, type TagCatalog, type TagGroup } from "./taxonomy";

export type DirectorySection = TagGroup | "all";
export type DirectorySort = "count" | "name";

export type DirectoryRow = {
  tag: TagDto;
  key: string;
  depth: number;
  path: string;
  branch: boolean;
  expanded: boolean;
};

export type DirectoryVisit = {
  section: DirectorySection;
  query: string;
  sort: DirectorySort;
  expanded: Set<string>;
  limit: number;
  scroll: number;
  focus: string | null;
};

export function directoryRows(
  catalog: TagCatalog, counts: Record<string, number>, notes: NotesIndex | undefined,
  section: DirectorySection, query: string, sort: DirectorySort, expanded: ReadonlySet<string>,
): DirectoryRow[] {
  function compare(a: TagDto, b: TagDto) {
    const difference = sort === "count" ? (counts[b.id] ?? 0) - (counts[a.id] ?? 0) : 0;
    return difference || tagNameOrder.compare(a.name, b.name) || (a.id < b.id ? -1 : Number(a.id > b.id));
  }
  if (section === "source" && !query.trim()) {
    const rows: DirectoryRow[] = [];
    function visit(parent: string, ancestors: string[]) {
      for (const tag of [...(catalog.children.get(parent) ?? [])].sort(compare)) {
        if (ancestors.includes(tag.id)) continue;
        const lineage = [...ancestors, tag.id];
        const key = JSON.stringify(lineage);
        const branch = Boolean(catalog.children.get(tag.id)?.length);
        const open = branch && expanded.has(key);
        rows.push({ tag, key, depth: ancestors.length, branch, expanded: open, path: "" });
        if (open) visit(tag.id, lineage);
      }
    }
    visit("", []);
    return rows;
  }
  const showPath = section === "all" || Boolean(query.trim());
  return catalog.active.filter(tag => (section === "all" || groupOf(tag) === section)
    && (!query.trim() || matchesSearch(query, tag.name, ...(tag.aliases ?? []), ...catalog.paths(tag.id), noteFor(notes, "tag", tag.id))))
    .sort(compare).map(tag => {
      const paths = showPath ? catalog.paths(tag.id).map(path => {
        const end = path.lastIndexOf(" › ");
        return end < 0 ? groups[groupOf(tag)] : path.slice(0, end);
      }) : [];
      return { tag, key: JSON.stringify([tag.id]), depth: 0, branch: false, expanded: false, path: paths.join(" / ") };
    });
}
