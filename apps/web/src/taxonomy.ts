import type { ItemDto, LibrarySearch, TagDto } from "@hibiki/contracts";

export type TagGroup = NonNullable<TagDto["group"]>;
export type Performance = NonNullable<ItemDto["performance"]>;
export type Voice = NonNullable<ItemDto["voices"]>[number];
export type PerformanceFilter = NonNullable<LibrarySearch["performanceFilter"]>;
export const groups = {
  source: "Источник",
  artist: "Исполнитель",
  genre: "Жанр",
  mood: "Настроение",
  extra: "Дополнительно",
} as const;
export const groupKeys = Object.keys(groups) as TagGroup[];
export const missingLabels = {
  source: groups.source,
  artist: groups.artist,
  genre: groups.genre,
  mood: groups.mood,
  performance: "Исполнение",
  voice: "Голос",
};
export const filterLabels = {
  ost: "Без вокала (OST)",
  male: "Мужской вокал",
  female: "Женский вокал",
  vocal: "С вокалом",
} as const;

export function normalize(value: string) {
  return value.trim().toLocaleLowerCase();
}
export function groupOf(tag: TagDto): TagGroup {
  return tag.group ?? "extra";
}
const order = new Intl.Collator("ru", { sensitivity: "base", numeric: true });

export class TagCatalog {
  readonly active: TagDto[];
  readonly byId: Map<string, TagDto>;
  readonly children = new Map<string, TagDto[]>();
  private pathCache = new Map<string, string[]>();

  constructor(tags: readonly TagDto[]) {
    this.active = tags.filter((t) => !t.archived).sort((a, b) => order.compare(a.name, b.name));
    this.byId = new Map(this.active.map((t) => [t.id, t]));
    for (const tag of this.active) {
      if (groupOf(tag) !== "source") continue;
      const parents = tag.parentIds?.filter((id) => this.byId.has(id)) ?? [];
      for (const id of parents.length ? parents : [""]) {
        const siblings = this.children.get(id) ?? [];
        siblings.push(tag);
        this.children.set(id, siblings);
      }
    }
  }

  paths(id: string, ancestors = new Set<string>()): string[] {
    const cached = this.pathCache.get(id);
    if (cached) return cached;
    const tag = this.byId.get(id);
    if (!tag || ancestors.has(id)) return [];
    const parents = groupOf(tag) === "source" ? (tag.parentIds ?? []) : [];
    const chain = new Set([...ancestors, id]);
    const prefixes = parents.flatMap((parent) => this.paths(parent, chain));
    const paths = prefixes.length
      ? prefixes.map((p) => p + " › " + tag.name)
      : [groupOf(tag) === "source" ? tag.name : groups[groupOf(tag)] + " › " + tag.name];
    this.pathCache.set(id, paths);
    return paths;
  }

  matchesAncestor(tag: TagDto, selected: string[]) {
    if (!selected.length || groupOf(tag) !== "source") return false;
    const pending = [...(tag.parentIds ?? [])],
      seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      if (selected.includes(id)) return true;
      seen.add(id);
      pending.push(...(this.byId.get(id)?.parentIds ?? []));
    }
    return false;
  }

  find(query: string, group?: TagGroup) {
    const q = normalize(query);
    return this.active.filter(
      (tag) =>
        (!group || groupOf(tag) === group) &&
        (!q || [tag.name, ...(tag.aliases ?? [])].some((name) => normalize(name).includes(q))),
    );
  }
}

export function nextPerformanceFilter(current: PerformanceFilter, button: "ost" | Voice): PerformanceFilter {
  if (button === "ost") return current === "ost" ? "" : "ost";
  const other = button === "male" ? "female" : "male";
  if (current === "vocal") return other;
  if (current === other) return "vocal";
  return current === button ? "" : button;
}

export function itemPerformance(
  performance?: Performance,
  voices: Voice[] = [],
): { filter: PerformanceFilter; label: string } {
  if (performance === "ost") return { filter: "ost", label: filterLabels.ost };
  if (performance !== "vocal") return { filter: "", label: "Исполнение не указано" };
  if (!voices.length) return { filter: "vocal", label: "С вокалом, голос не указан" };
  if (voices.includes("male") && voices.includes("female"))
    return { filter: "vocal", label: "Мужской и женский вокал" };
  return { filter: voices[0]!, label: filterLabels[voices[0]!] };
}

export type BatchMode = "add" | "remove" | "replace";
export function batchTagChanges(
  items: Pick<ItemDto, "id" | "tags">[],
  chosen: string[],
  group: TagGroup,
  mode: BatchMode,
) {
  const changes: { id: string; tagIds: string[] }[] = [];
  const removed = new Map<string, { tag: TagDto; count: number }>();
  for (const { id, tags } of items) {
    const retained: string[] = [];
    for (const tag of tags.filter((t) => !t.archived)) {
      const drop =
        groupOf(tag) === group &&
        (mode === "replace" ? !chosen.includes(tag.id) : mode === "remove" && chosen.includes(tag.id));
      if (drop) {
        const previous = removed.get(tag.id);
        removed.set(tag.id, { tag, count: (previous?.count ?? 0) + 1 });
      } else retained.push(tag.id);
    }
    const tagIds = mode === "remove" ? retained : [...new Set([...retained, ...chosen])];
    const old = tags.filter((t) => !t.archived);
    if (old.length !== tagIds.length || old.some((tag) => !tagIds.includes(tag.id)))
      changes.push({ id, tagIds });
  }
  return { changes, removed: [...removed.values()] };
}

export function compositionDelta<T extends { id: string }>(current: readonly T[], proposed: readonly T[]) {
  const before = new Set(current.map((item) => item.id));
  const after = new Set(proposed.map((item) => item.id));
  return {
    added: proposed.filter((item) => !before.has(item.id)),
    removed: current.filter((item) => !after.has(item.id)),
  };
}
