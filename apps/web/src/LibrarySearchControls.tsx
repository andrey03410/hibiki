import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Filter, Play, Search, X } from "lucide-react";
import type { TagDto } from "@hibiki/contracts";
import { defaultLibrarySearch, type LibrarySearch } from "./library-search";
import "./library-search.css";

const kinds = { "": "Все записи", audio: "Аудио", video: "Видео" } satisfies Record<LibrarySearch["kind"], string>;
const providers = {
  "": "Любой", youtube: "YouTube", local: "Есть локальная копия",
  "working-local": "Есть рабочая локальная копия",
} satisfies Record<LibrarySearch["provider"], string>;
const statuses = {
  "": "Любая", available: "Есть доступный источник", unknown: "Статус неизвестен",
  unavailable: "Нет рабочего источника",
} satisfies Record<LibrarySearch["availability"], string>;
const sorts = {
  "added-desc": "Сначала новые", "added-asc": "Сначала старые",
  "title-asc": "Название ↑", "title-desc": "Название ↓",
  "duration-asc": "Сначала короткие", "duration-desc": "Сначала длинные",
} satisfies Record<LibrarySearch["sort"], string>;

export function useLibrarySearch(userId: string) {
  const key = `hibiki:library-search:${userId}`;
  const [value, setValue] = useState<LibrarySearch>(() => {
    try {
      const stored: Partial<LibrarySearch> = JSON.parse(sessionStorage.getItem(key) ?? "{}");
      const initial = { ...defaultLibrarySearch };
      for (const field of ["query", "minDuration", "maxDuration", "addedFrom", "addedThrough"] as const) {
        const value = stored[field];
        if (typeof value === "string") initial[field] = value;
      }
      if (stored.kind && Object.hasOwn(kinds, stored.kind)) initial.kind = stored.kind;
      if (stored.provider && Object.hasOwn(providers, stored.provider)) initial.provider = stored.provider;
      if (stored.availability && Object.hasOwn(statuses, stored.availability)) initial.availability = stored.availability;
      if (stored.sort && Object.hasOwn(sorts, stored.sort)) initial.sort = stored.sort;
      if (Array.isArray(stored.tagIds)) initial.tagIds = stored.tagIds.filter((id) => typeof id === "string");
      initial.favoriteOnly = stored.favoriteOnly === true;
      return initial;
    } catch {
      return defaultLibrarySearch;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Search state is still kept in the workspace for this visit.
    }
  }, [key, value]);
  return [value, setValue] as const;
}

export function LibrarySearchControls({ value, onChange, tags, count, onPlay }: {
  value: LibrarySearch;
  onChange: Dispatch<SetStateAction<LibrarySearch>>;
  tags: TagDto[];
  count: number;
  onPlay: () => void;
}) {
  function set<K extends keyof LibrarySearch>(field: K, next: LibrarySearch[K]) {
    onChange((current) => ({ ...current, [field]: next }));
  }

  const chips = [
    value.kind && kinds[value.kind],
    value.provider && providers[value.provider],
    value.availability && statuses[value.availability],
    value.favoriteOnly && "Избранное",
    ...value.tagIds.map((id) => tags.find((tag) => tag.id === id)?.name ?? "Удалённый тег"),
    value.minDuration && `Длительность от ${value.minDuration} с`,
    value.maxDuration && `Длительность до ${value.maxDuration} с`,
    value.addedFrom && `Добавлено с ${value.addedFrom}`,
    value.addedThrough && `Добавлено по ${value.addedThrough}`,
  ].filter(Boolean);

  return (
    <div className="library-search-controls">
      <div className="collection-tools">
        <label className="search-input">
          <Search size={16} />
          <input
            type="search"
            aria-label="Поиск в медиатеке"
            placeholder="Названия, теги и заметки…"
            value={value.query}
            onChange={(event) => set("query", event.target.value)}
          />
          {value.query && (
            <button type="button" className="icon-button" aria-label="Очистить поиск" onClick={() => set("query", "")}>
              <X size={14} />
            </button>
          )}
        </label>
        <select aria-label="Сортировка медиатеки" value={value.sort} onChange={(event) => set("sort", event.target.value as LibrarySearch["sort"])}>
          {Object.entries(sorts).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
        </select>
      </div>
      <details className="library-filter-panel">
        <summary><Filter size={15} /> Фильтры{chips.length > 0 && ` (${chips.length})`}</summary>
        <div className="library-filter-fields">
          <label>
            Тип записи
            <select value={value.kind} onChange={(event) => set("kind", event.target.value as LibrarySearch["kind"])}>
              {Object.entries(kinds).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
            </select>
          </label>
          <label>
            Источник
            <select value={value.provider} onChange={(event) => set("provider", event.target.value as LibrarySearch["provider"])}>
              {Object.entries(providers).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
            </select>
          </label>
          <label>
            Доступность
            <select value={value.availability} onChange={(event) => set("availability", event.target.value as LibrarySearch["availability"])}>
              {Object.entries(statuses).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={value.favoriteOnly} onChange={(event) => set("favoriteOnly", event.target.checked)} />
            Только избранное
          </label>
          <label>
            Длительность от, сек.
            <input type="number" min="0" step="any" value={value.minDuration} onChange={(event) => set("minDuration", event.target.value)} />
          </label>
          <label>
            Длительность до, сек.
            <input type="number" min="0" step="any" value={value.maxDuration} onChange={(event) => set("maxDuration", event.target.value)} />
          </label>
          <label>
            Добавлено с
            <input type="date" value={value.addedFrom} onChange={(event) => set("addedFrom", event.target.value)} />
          </label>
          <label>
            Добавлено по
            <input type="date" value={value.addedThrough} onChange={(event) => set("addedThrough", event.target.value)} />
          </label>
        </div>
        {(tags.length > 0 || value.tagIds.length > 0) && (
          <fieldset className="library-filter-tags">
            <legend>Все выбранные теги</legend>
            <div className="tag-picker">
              {tags.map((tag) => {
                const checked = value.tagIds.includes(tag.id);
                return (
                  <label className={`tag-option ${checked ? "active" : ""}`} key={tag.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => set("tagIds", event.target.checked ? [...value.tagIds, tag.id] : value.tagIds.filter((id) => id !== tag.id))}
                    />
                    <span style={{ background: tag.color }} />
                    {tag.name}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
      </details>
      <div className="library-search-results">
        <span role="status">Найдено: {count}</span>
        <div className="library-search-chips">
          {chips.map((chip, index) => <span key={`${index}-${chip}`}>{chip}</span>)}
        </div>
        {(chips.length > 0 || value.query || value.sort !== defaultLibrarySearch.sort) && (
          <button type="button" className="text-button" onClick={() => onChange(defaultLibrarySearch)}>Сбросить</button>
        )}
        <button type="button" className="button subtle compact" disabled={!count} onClick={onPlay}>
          <Play size={15} fill="currentColor" /> Играть найденное
        </button>
      </div>
    </div>
  );
}
