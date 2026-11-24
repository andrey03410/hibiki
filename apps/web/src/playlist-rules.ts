import type { LibraryCardOverviewDto, LibraryDto, Rule } from "@hibiki/contracts";
import { mediaWord } from "./api";

export type HistoryRule = Extract<Rule, { type: "history" }>;
export const HISTORY_CONDITIONS: Record<HistoryRule["condition"], string> = {
  "never-started": "Ещё не слушал",
  "never-completed": "Ни разу не дослушал",
  "skipped-at-least": "Быстро пропускал несколько раз",
  "last-started-before": "Давно не включал",
};

export function usesListeningHistory(rule: Rule, library: LibraryDto, visited = new Set<string>()): boolean {
  switch (rule.type) {
    case "history": return true;
    case "union":
    case "intersection": return rule.rules.some((child) => usesListeningHistory(child, library, visited));
    case "difference": return usesListeningHistory(rule.include, library, visited) || usesListeningHistory(rule.exclude, library, visited);
    case "playlist": {
      if (visited.has(rule.id)) return false;
      visited.add(rule.id);
      const definition = library.playlists.find((playlist) => playlist.id === rule.id)?.definition;
      return !!definition && (
        definition.sort === "last-started" || usesListeningHistory(definition.rule, library, visited)
      );
    }
    default: return false;
  }
}

export function ruleDescription(rule: Rule, library: Pick<LibraryCardOverviewDto, "tags" | "playlists">): string {
  switch (rule.type) {
    case "items":
      return `${rule.ids.length} ${mediaWord(rule.ids.length)} вручную`;
    case "tag":
      return `Тег «${library.tags.find((t) => t.id === rule.id)?.name ?? "не найден"}»`;
    case "playlist":
      return `Плейлист «${library.playlists.find((p) => p.id === rule.id)?.title ?? "не найден"}»`;
    case "filter":
      return `Фильтр: ${rule.kind === "audio" ? "аудио" : rule.kind === "video" ? "видео" : "все записи"}${rule.local ? ", на устройстве" : ""}`;
    case "favorite":
      return "Избранные записи";
    case "history":
      if (rule.condition === "skipped-at-least") return `Быстрых пропусков — не меньше ${rule.count}`;
      if (rule.condition === "last-started-before") return `Последний запуск более ${rule.days} дней назад`;
      return HISTORY_CONDITIONS[rule.condition];
    case "union":
      return `Объединение ${rule.rules.length} правил`;
    case "intersection":
      return `Пересечение ${rule.rules.length} правил`;
    case "difference":
      return "Выбранные записи с исключениями";
  }
}
