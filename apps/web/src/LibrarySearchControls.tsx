import { useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ChevronDown, Headphones, Heart, LayoutGrid, List, Play, Search, SlidersHorizontal, Tags, X } from "lucide-react";
import type { PlaybackMode, TagDto } from "@hibiki/contracts";
import {
  defaultLibrarySearch, libraryFilterConditions, libraryKinds, libraryProviders, libraryStatuses,
  libraryTagChoices, popularTagLimit, resetLibraryFilters, type LibrarySearch, type LibraryView,
} from "./library-search";
import "./library-search.css";

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
      if (stored.kind && Object.hasOwn(libraryKinds, stored.kind)) initial.kind = stored.kind;
      if (stored.provider && Object.hasOwn(libraryProviders, stored.provider)) initial.provider = stored.provider;
      if (stored.availability && Object.hasOwn(libraryStatuses, stored.availability)) initial.availability = stored.availability;
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

export function LibrarySearchControls({ value, onChange, tags, tagCounts, count, selectAll, view, onViewChange, onPlay }: {
  value: LibrarySearch;
  onChange: Dispatch<SetStateAction<LibrarySearch>>;
  tags: TagDto[];
  tagCounts?: ReadonlyMap<string, number>;
  count: number;
  selectAll?: ReactNode;
  view: LibraryView;
  onViewChange: (view: LibraryView) => void;
  onPlay: (mode?: PlaybackMode) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagQuery, setTagQuery] = useState("");
  const tagSearch = useRef<HTMLInputElement>(null);
  const resultsMenu = useRef<HTMLDetailsElement>(null);

  function playResults(mode?: PlaybackMode) {
    if (resultsMenu.current) resultsMenu.current.open = false;
    onPlay(mode);
  }
  const advancedId = useId(), tagPickerId = useId();

  function set<K extends keyof LibrarySearch>(field: K, next: LibrarySearch[K]) {
    onChange((current) => ({ ...current, [field]: next }));
  }

  function toggleTag(id: string) {
    onChange((current) => ({
      ...current,
      tagIds: current.tagIds.includes(id) ? current.tagIds.filter((tagId) => tagId !== id) : [...current.tagIds, id],
    }));
  }

  const conditions = libraryFilterConditions(value, tags);
  const advancedCount = conditions.filter(({ advanced }) => advanced).length;
  const expandedTags = tagsOpen || !!tagQuery.trim();
  const visibleTags = libraryTagChoices(tags, tagCounts, tagQuery, expandedTags);
  const previewFilters = new Set(visibleTags.map(({ id }) => `tag:${id}`));
  const summaryConditions = expandedTags ? conditions : conditions.filter(({ key }) => !previewFilters.has(key));

  return (
    <div className="library-search-controls">
      <div className="library-search-tools">
        <div className="search-input">
          <Search size={17} />
          <input
            type="search"
            aria-label="Поиск по названию, тегам и заметкам"
            placeholder="Поиск по названию"
            value={value.query}
            onChange={(event) => set("query", event.target.value)}
          />
          {value.query && (
            <button type="button" className="icon-button" aria-label="Очистить поиск" onClick={() => set("query", "")}>
              <X size={14} />
            </button>
          )}
        </div>
        <select aria-label="Сортировка медиатеки" value={value.sort} onChange={(event) => set("sort", event.target.value as LibrarySearch["sort"])}>
          {Object.entries(sorts).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
        </select>
        <div className="library-segmented library-view-switch" role="group" aria-label="Вид медиатеки">
          <button type="button" title="Список" aria-label="Список" aria-pressed={view === "list"} onClick={() => onViewChange("list")}>
            <List size={16} /> <span>Список</span>
          </button>
          <button type="button" title="Карточки" aria-label="Карточки" aria-pressed={view === "cards"} onClick={() => onViewChange("cards")}>
            <LayoutGrid size={15} /> <span>Карточки</span>
          </button>
        </div>
      </div>
      <div className="library-tag-picker" data-expanded={expandedTags || undefined}>
        <div className="library-tag-tools">
          <div className="search-input">
            <Tags size={15} aria-hidden="true" />
            <input
              ref={tagSearch}
              type="search"
              aria-label="Поиск тегов"
              placeholder="Найти тег"
              value={tagQuery}
              onChange={(event) => setTagQuery(event.target.value)}
            />
            {tagQuery && (
              <button type="button" className="icon-button" aria-label="Очистить поиск тегов" onClick={() => {
                setTagQuery("");
                tagSearch.current?.focus();
              }}>
                <X size={14} />
              </button>
            )}
          </div>
          {tags.length > popularTagLimit && (
            <button
              className="library-filter-button library-tag-toggle"
              type="button"
              aria-expanded={expandedTags}
              aria-controls={tagPickerId}
              onClick={() => {
                setTagQuery("");
                setTagsOpen(!expandedTags);
              }}
            >
              {expandedTags ? "Свернуть" : "Все теги"} <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="library-tag-options" id={tagPickerId} role="group" aria-label="Фильтр по всем выбранным тегам">
          {visibleTags.map((tag) => {
            const selected = value.tagIds.includes(tag.id);
            return (
              <button className="library-tag-choice" type="button" key={tag.id} aria-pressed={selected} onClick={() => toggleTag(tag.id)}>
                <span aria-hidden="true" className="library-tag-color" style={{ background: tag.color }} />
                <span>{tag.name}</span>
                {tagCounts && <span className="library-tag-count">{tagCounts.get(tag.id) ?? 0}</span>}
                {selected && <X size={12} aria-hidden="true" />}
              </button>
            );
          })}
          {!visibleTags.length && (
            <span className="library-tag-empty" role="status">{tags.length ? "Теги не найдены" : "В медиатеке пока нет тегов"}</span>
          )}
        </div>
      </div>
      <div className="library-filter-tools">
        <div className="library-segmented" role="group" aria-label="Тип записи">
          {Object.entries(libraryKinds).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={value.kind === id} onClick={() => set("kind", id as LibrarySearch["kind"])}>{label}</button>
          ))}
        </div>
        <button className="library-filter-button" type="button" aria-label="Избранное" title="Избранное" aria-pressed={value.favoriteOnly} onClick={() => set("favoriteOnly", !value.favoriteOnly)}>
          <Heart size={15} fill={value.favoriteOnly ? "currentColor" : "none"} /> <span>Избранное</span>
        </button>
        <button
          className="library-filter-button library-advanced-toggle"
          type="button"
          aria-label={advancedCount ? `Фильтры (${advancedCount})` : "Фильтры"}
          title="Дополнительные фильтры"
          aria-expanded={advancedOpen}
          aria-controls={advancedId}
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          <SlidersHorizontal size={15} /> <span>Фильтры</span>{advancedCount > 0 && ` ${advancedCount}`}
        </button>
        <details className="library-result-playback" ref={resultsMenu} onKeyDown={(event) => {
          if (event.key !== "Escape" || !event.currentTarget.open) return;
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }}>
          <summary className="library-filter-button" aria-label="Играть выдачу" title="Играть выдачу"><Play size={14} /> <span>Играть выдачу</span> <ChevronDown size={14} /></summary>
          <div className="dropdown">
            <button type="button" disabled={!count} onClick={() => playResults()}>
              <Play size={15} fill="currentColor" /> Играть найденное
            </button>
            <button type="button" disabled={!count} onClick={() => playResults("audio")}>
              <Headphones size={15} /> Слушать найденное
            </button>
          </div>
        </details>
      </div>
      <div className="library-filter-fields" id={advancedId} hidden={!advancedOpen}>
        <div className="library-filter-selects">
          <label>
            Источник
            <select value={value.provider} onChange={(event) => set("provider", event.target.value as LibrarySearch["provider"])}>
              {Object.entries(libraryProviders).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
            </select>
          </label>
          <label>
            Доступность
            <select value={value.availability} onChange={(event) => set("availability", event.target.value as LibrarySearch["availability"])}>
              {Object.entries(libraryStatuses).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
            </select>
          </label>
        </div>
        <fieldset>
          <legend>Длительность, сек.</legend>
          <div className="library-filter-range">
            <label>От<input type="number" min="0" step="any" value={value.minDuration} onChange={(event) => set("minDuration", event.target.value)} /></label>
            <label>До<input type="number" min="0" step="any" value={value.maxDuration} onChange={(event) => set("maxDuration", event.target.value)} /></label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Дата добавления</legend>
          <div className="library-filter-range">
            <label>С<input type="date" value={value.addedFrom} onChange={(event) => set("addedFrom", event.target.value)} /></label>
            <label>По<input type="date" value={value.addedThrough} onChange={(event) => set("addedThrough", event.target.value)} /></label>
          </div>
        </fieldset>
      </div>
      <div className="library-search-results">
        {selectAll}
        <span role="status">Найдено: {count}</span>
        {conditions.length > 0 && (
          <div className="library-search-chips">
            {summaryConditions.map(({ key, label, clear }) => (
              <button key={key} type="button" aria-label={`Снять фильтр «${label}»`} onClick={() => onChange(clear)}>
                {label} <X size={12} />
              </button>
            ))}
            <button type="button" className="text-button" onClick={() => onChange(resetLibraryFilters)}>Сбросить фильтры</button>
          </div>
        )}
      </div>
    </div>
  );
}
