import {
  playlistDefinitionSchema,
  ruleSchema,
  type ItemDto,
  type LibraryDto,
  type PlaylistDefinition,
  type PlaylistDto,
  type ResolvedPlaylist,
  type Rule,
} from "@hibiki/contracts";

export interface PlaylistHistory {
  launches: number;
  completed: number;
  skipped: number;
  lastStartedAt: Date | null;
}
type PlaylistItem = Pick<ItemDto, "id" | "kind" | "title" | "duration" | "favorite" | "createdAt"> & {
  tags: Pick<ItemDto["tags"][number], "id">[];
  sources: Pick<ItemDto["sources"][number], "provider" | "status">[];
};
export type PlaylistLibrary<T extends PlaylistItem = ItemDto> = Pick<LibraryDto, "tags"> & {
  items: T[];
  playlists: Pick<PlaylistDto, "id" | "title" | "definition">[];
  history?: ReadonlyMap<string, PlaylistHistory>;
  now?: Date;
  /** First millisecond when an evaluated time-dependent condition becomes true. */
  onFutureHistoryCutoff?: (at: number) => void;
};
export const PLAYLIST_LIMITS = { depth: 40, expandedNodes: 10_000 } as const;

export function usesPrivateHistory(
  definition: PlaylistDefinition,
  playlists?: ReadonlyMap<string, Pick<PlaylistDto, "definition">>,
  visited = new Set<string>(),
): boolean {
  const usesHistory = (rule: Rule): boolean => {
    switch (rule.type) {
      case "history":
        return true;
      case "playlist": {
        if (visited.has(rule.id)) return false;
        const target = playlists?.get(rule.id);
        if (!target) return false;
        visited.add(rule.id);
        return usesPrivateHistory(target.definition, playlists, visited);
      }
      case "union":
      case "intersection":
        return rule.rules.some(usesHistory);
      case "difference":
        return usesHistory(rule.include) || usesHistory(rule.exclude);
      default:
        return false;
    }
  };
  return definition.sort === "last-started" || usesHistory(definition.rule);
}

export function collectReferences(input: Rule): {
  itemIds: string[];
  tagIds: string[];
  playlistIds: string[];
} {
  const rule = ruleSchema.parse(input);
  const items = new Set<string>();
  const tags = new Set<string>();
  const playlists = new Set<string>();
  const visit = (current: Rule): void => {
    switch (current.type) {
      case "items":
        current.ids.forEach((id) => items.add(id));
        break;
      case "tag":
        tags.add(current.id);
        break;
      case "playlist":
        playlists.add(current.id);
        break;
      case "union":
      case "intersection":
        current.rules.forEach(visit);
        break;
      case "difference":
        visit(current.include);
        visit(current.exclude);
        break;
      case "filter":
        break;
    }
  };
  visit(rule);
  return {
    itemIds: [...items],
    tagIds: [...tags],
    playlistIds: [...playlists],
  };
}

export function validatePlaylist(
  definition: PlaylistDefinition,
  library: PlaylistLibrary<PlaylistItem>,
  editingPlaylistId?: string,
): { valid: boolean; issues: string[] } {
  const issues = new Set<string>();
  const items = new Set(library.items.map((item) => item.id));
  const tags = new Set(library.tags.map((tag) => tag.id));
  const playlists = new Map(
    library.playlists.map((playlist) => [playlist.id, playlist]),
  );
  let expandedNodes = 0;
  const visitDefinition = (
    input: PlaylistDefinition,
    path: string[],
    depth: number,
  ): void => {
    const parsed = playlistDefinitionSchema.safeParse(input);
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) =>
        issues.add(
          `Некорректные правила${path.length ? ` (${path.join(" → ")})` : ""}: ${issue.message}`,
        ),
      );
      return;
    }
    parsed.data.manualOrder?.forEach((id) => {
      if (!items.has(id))
        issues.add(`Запись порядка «${id}» не найдена или недоступна`);
    });
    visit(parsed.data.rule, path, depth);
  };
  const visit = (rule: Rule, path: string[], depth: number): void => {
    if (++expandedNodes > PLAYLIST_LIMITS.expandedNodes) {
      issues.add("Превышен бюджет вычисления плейлистов");
      return;
    }
    if (depth > PLAYLIST_LIMITS.depth) {
      issues.add("Превышена вложенность зависимостей плейлистов");
      return;
    }
    switch (rule.type) {
      case "items":
        rule.ids.forEach((id) => {
          if (!items.has(id))
            issues.add(`Запись «${id}» не найдена или недоступна`);
        });
        break;
      case "tag":
        if (!tags.has(rule.id))
          issues.add(`Тег «${rule.id}» не найден или недоступен`);
        break;
      case "playlist": {
        if (path.includes(rule.id)) {
          issues.add(
            `Обнаружен цикл плейлистов: ${[...path, rule.id].join(" → ")}`,
          );
          break;
        }
        const target = playlists.get(rule.id);
        if (!target) {
          issues.add(`Плейлист «${rule.id}» не найден или недоступен`);
          break;
        }
        visitDefinition(target.definition, [...path, rule.id], depth + 1);
        break;
      }
      case "union":
      case "intersection":
        for (const child of rule.rules) {
          if (expandedNodes > PLAYLIST_LIMITS.expandedNodes) break;
          visit(child, path, depth + 1);
        }
        break;
      case "difference":
        visit(rule.include, path, depth + 1);
        visit(rule.exclude, path, depth + 1);
        break;
      case "filter":
        break;
    }
  };
  visitDefinition(definition, editingPlaylistId ? [editingPlaylistId] : [], 1);
  return { valid: issues.size === 0, issues: [...issues] };
}

type Reasons = Map<string, string[]>;
interface Evaluation {
  selected: Reasons;
  excluded: Reasons;
}

function addReasons(target: Reasons, id: string, reasons: string[]): void {
  target.set(id, [...new Set([...(target.get(id) ?? []), ...reasons])]);
}

function mergeReasons(target: Reasons, source: Reasons): void {
  for (const [id, reasons] of source) addReasons(target, id, reasons);
}

function applyExclusions(evaluation: Evaluation): Evaluation {
  for (const id of evaluation.excluded.keys()) evaluation.selected.delete(id);
  return evaluation;
}

function sortSelection(
  selected: Reasons,
  definition: PlaylistDefinition,
  items: ReadonlyMap<string, PlaylistItem>,
  history: PlaylistLibrary["history"],
): Reasons {
  const ids = [...selected.keys()];
  const manualPositions = new Map<string, number>();
  definition.manualOrder?.forEach((id) => {
    if (!manualPositions.has(id)) manualPositions.set(id, manualPositions.size);
  });
  ids.sort((a, b) => {
    const left = items.get(a)!;
    const right = items.get(b)!;
    switch (definition.sort) {
      case "title":
        return left.title.localeCompare(right.title, "ru", {
          sensitivity: "base",
        });
      case "newest":
        return right.createdAt.localeCompare(left.createdAt);
      case "duration":
        return (left.duration ?? Infinity) - (right.duration ?? Infinity) || 0;
      case "last-started":
        return (
          (history?.get(a)?.lastStartedAt?.getTime() ?? Infinity) -
          (history?.get(b)?.lastStartedAt?.getTime() ?? Infinity) || 0
        );
      case "source":
        return (
          (manualPositions.get(a) ?? Infinity) -
            (manualPositions.get(b) ?? Infinity) || 0
        );
    }
  });
  return new Map(ids.map((id) => [id, selected.get(id)!]));
}

export class InvalidPlaylistError extends Error {}

export function resolvePlaylist<T extends PlaylistItem>(
  definition: PlaylistDefinition,
  library: PlaylistLibrary<T>,
  editingPlaylistId?: string,
): Omit<ResolvedPlaylist, "items"> & { items: T[] } {
  const validation = validatePlaylist(definition, library, editingPlaylistId);
  if (!validation.valid) throw new InvalidPlaylistError(validation.issues.join("; "));
  const items = new Map(library.items.map((item) => [item.id, item]));
  const tags = new Map(library.tags.map((tag) => [tag.id, tag]));
  const playlists = new Map(
    library.playlists.map((playlist) => [playlist.id, playlist]),
  );
  const children = new Map<string, string[]>();
  for (const tag of library.tags) {
    if (tag.archived) continue;
    for (const parent of tag.parentIds ?? []) {
      const siblings = children.get(parent) ?? [];
      siblings.push(tag.id);
      children.set(parent, siblings);
    }
  }
  const now = library.now?.getTime() ?? Date.now();
  const privatePlaylists = new Map<string, boolean>();
  const evaluateDefinition = (input: PlaylistDefinition): Evaluation => {
    const result = evaluate(input.rule);
    result.selected = sortSelection(result.selected, input, items, library.history);
    return result;
  };
  const evaluate = (rule: Rule): Evaluation => {
    const result: Evaluation = { selected: new Map(), excluded: new Map() };
    switch (rule.type) {
      case "items":
        rule.ids.forEach((id) =>
          addReasons(result.selected, id, ["Добавлено вручную"]),
        );
        break;
      case "tag": {
        const tag = tags.get(rule.id)!;
        const accepted = new Set([rule.id]);
        if (rule.descendants && !tag.archived) {
          for (const id of accepted)
            for (const child of children.get(id) ?? []) accepted.add(child);
        }
        for (const item of items.values()) {
          if (item.tags.some((entry) => accepted.has(entry.id)))
            addReasons(result.selected, item.id, [`Тег «${tag.name}»`]);
        }
        break;
      }
      case "favorite":
        for (const item of items.values())
          if (item.favorite) addReasons(result.selected, item.id, ["В избранном"]);
        break;
      case "history": {
        const explanation = {
          "never-started": "Ещё не слушал",
          "never-completed": "Ни разу не дослушал",
          "skipped-at-least": `Быстрых пропусков не меньше ${rule.count}`,
          "last-started-before": `Последний запуск более ${rule.days} дней назад`,
        }[rule.condition];
        for (const item of items.values()) {
          const summary = library.history?.get(item.id);
          const cutoff = rule.condition === "last-started-before" && summary?.lastStartedAt
            ? summary.lastStartedAt.getTime() + rule.days! * 86_400_000 + 1 : undefined;
          if (cutoff !== undefined && cutoff > now) library.onFutureHistoryCutoff?.(cutoff);
          const matches = rule.condition === "never-started"
            ? !summary?.launches
            : rule.condition === "never-completed"
              ? !summary?.completed
              : rule.condition === "skipped-at-least"
                ? (summary?.skipped ?? 0) >= rule.count!
                : cutoff !== undefined && now >= cutoff;
          if (matches) addReasons(result.selected, item.id, [explanation]);
        }
        break;
      }
      case "filter": {
        const explanation =
          [
            rule.kind === "audio"
              ? "аудио"
              : rule.kind === "video"
                ? "видео"
                : "",
            rule.local === true
              ? "есть доступный локальный файл"
              : rule.local === false
                ? "нет доступного локального файла"
                : "",
            rule.minDuration !== undefined
              ? `длительность от ${rule.minDuration} с`
              : "",
            rule.maxDuration !== undefined
              ? `длительность до ${rule.maxDuration} с`
              : "",
          ]
            .filter(Boolean)
            .join(", ") || "вся медиатека";
        for (const item of items.values()) {
          const local = item.sources.some(
            (source) =>
              source.provider === "local" && source.status === "available",
          );
          if (rule.kind !== undefined && item.kind !== rule.kind) continue;
          if (rule.local !== undefined && local !== rule.local) continue;
          if (
            rule.minDuration !== undefined &&
            (item.duration === null || item.duration < rule.minDuration)
          )
            continue;
          if (
            rule.maxDuration !== undefined &&
            (item.duration === null || item.duration > rule.maxDuration)
          )
            continue;
          addReasons(result.selected, item.id, [`Фильтр: ${explanation}`]);
        }
        break;
      }
      case "playlist": {
        const playlist = playlists.get(rule.id)!;
        const nested = evaluateDefinition(playlist.definition);
        for (const [id, reasons] of nested.selected)
          addReasons(result.selected, id, [
            ...reasons,
            `Плейлист «${playlist.title}»`,
          ]);
        let privateComposition = privatePlaylists.get(rule.id);
        if (privateComposition === undefined) {
          privateComposition = usesPrivateHistory(playlist.definition, playlists);
          privatePlaylists.set(rule.id, privateComposition);
        }
        if (!privateComposition)
          for (const [id, reasons] of nested.excluded)
            addReasons(result.excluded, id, [
              ...reasons,
              `Исключено в плейлисте «${playlist.title}»`,
            ]);
        break;
      }
      case "union":
      case "intersection": {
        const children = rule.rules.map(evaluate);
        for (const child of children) {
          mergeReasons(result.selected, child.selected);
          mergeReasons(result.excluded, child.excluded);
        }
        if (rule.type === "intersection") {
          for (const [id, reasons] of result.selected) {
            if (!children.every((child) => child.selected.has(id)))
              result.selected.delete(id);
            else
              addReasons(result.selected, id, [
                ...reasons,
                "Совпало во всех условиях пересечения",
              ]);
          }
        }
        break;
      }
      case "difference": {
        const included = evaluate(rule.include);
        const excluded = evaluate(rule.exclude);
        mergeReasons(result.selected, included.selected);
        mergeReasons(result.excluded, included.excluded);
        // Exclusions inside the subtracting expression describe that expression,
        // not the outer result (A − (B − C) must keep C).
        for (const [id, reasons] of excluded.selected)
          addReasons(result.excluded, id, [
            "Исключено правилом разности",
            ...reasons,
          ]);
        break;
      }
    }
    return applyExclusions(result);
  };
  const evaluation = evaluateDefinition(
    playlistDefinitionSchema.parse(definition),
  );
  const resolvedItems = [...evaluation.selected.keys()].map(
    (id) => items.get(id)!,
  );
  return {
    items: resolvedItems,
    reasons: Object.fromEntries(evaluation.selected),
    excluded: [...evaluation.excluded].map(([id, reasons]) => ({
      id,
      title: items.get(id)!.title,
      reasons,
    })),
    total: resolvedItems.length,
    duration: resolvedItems.reduce(
      (total, item) => total + (item.duration ?? 0),
      0,
    ),
  };
}
