import { useEffect, useId, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Heart, LayoutGrid, List, Play, Search, Shuffle, SlidersHorizontal, X } from "lucide-react";
import type { TagDto } from "@hibiki/contracts";
import {
  changeLibrarySort, defaultLibrarySearch, libraryFilterConditions, libraryKinds, libraryProviders,
  librarySorts, libraryStatuses, newRandomSeed, resetLibraryFilters, restoreLibrarySearch, type LibrarySearch, type LibraryView,
} from "./library-search";
import { filterLabels, missingLabels, nextPerformanceFilter } from "./taxonomy";
import "./library-search.css";

export function useLibrarySearch(userId: string) {
  const key = `hibiki:library-search:${userId}`;
  const [value, setValue] = useState<LibrarySearch>(() => {
    try {
      return restoreLibrarySearch(sessionStorage.getItem(key));
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

export function LibrarySearchControls({ value, onChange, tags, count, selectAll, view, onViewChange, onPlay }: {
  value: LibrarySearch;
  onChange: Dispatch<SetStateAction<LibrarySearch>>;
  tags: TagDto[];
  count: number;
  selectAll?: ReactNode;
  view: LibraryView;
  onViewChange: (view: LibraryView) => void;
  onPlay: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedId = useId();
  function set<K extends keyof LibrarySearch>(field: K, next: LibrarySearch[K]) {
    onChange((current) => ({ ...current, [field]: next }));
  }

  const conditions = libraryFilterConditions(value, tags);
  const advancedCount = conditions.filter(({ advanced }) => advanced).length;
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
        <div className="library-sort-tools">
          <select aria-label="Сортировка медиатеки" value={value.sort} onChange={event => {
            const sort = event.target.value as LibrarySearch["sort"];
            onChange(current => changeLibrarySort(current, sort));
          }}>
            {Object.entries(librarySorts).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
          </select>
          {value.sort === "random" && (
            <button type="button" className="library-filter-button" aria-label="Перемешать ещё раз" title="Перемешать ещё раз"
              onClick={() => set("randomSeed", newRandomSeed())}><Shuffle size={16} /></button>
          )}
          {value.sort === "recent" && (
            <button type="button" className="library-filter-button" aria-label="Выключить режим «Недавно слушал»"
              title={`Вернуть сортировку «${librarySorts[value.previousSort ?? "added-desc"]}»`}
              onClick={() => onChange(current => changeLibrarySort(current, current.previousSort ?? "added-desc"))}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className="library-segmented library-view-switch" role="group" aria-label="Вид медиатеки">
          <button type="button" title="Список" aria-label="Список" aria-pressed={view === "list"} onClick={() => onViewChange("list")}>
            <List size={16} /> <span>Список</span>
          </button>
          <button type="button" title="Карточки" aria-label="Карточки" aria-pressed={view === "cards"} onClick={() => onViewChange("cards")}>
            <LayoutGrid size={15} /> <span>Карточки</span>
          </button>
        </div>
      </div>
      <div className="library-filter-tools">
        <div className="library-segmented" role="group" aria-label="Тип записи">
          {Object.entries(libraryKinds).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={value.kind === id} onClick={() => set("kind", id as LibrarySearch["kind"])}>{label}</button>
          ))}
        </div>
        <div className="performance-controls" role="group" aria-label="Исполнение">
          <button className="library-filter-button" type="button" title="Без вокала (OST)"
            aria-pressed={value.performanceFilter === "ost"} onClick={() => set("performanceFilter", nextPerformanceFilter(value.performanceFilter ?? "", "ost"))}>OST</button>
          <div className="vocal-split" role="group" aria-label="Вокал">
            <small aria-hidden="true">Вокал</small>
            {(["male", "female"] as const).map(voice => <button key={voice} type="button"
              title={filterLabels[voice]} aria-pressed={value.performanceFilter === voice || value.performanceFilter === "vocal"}
              onClick={() => set("performanceFilter", nextPerformanceFilter(value.performanceFilter ?? "", voice))}>{voice === "male" ? "Мужской" : "Женский"}</button>)}
          </div>
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
        <button type="button" className="library-filter-button" aria-label="Играть выдачу" title="Играть выдачу"
          disabled={!count} onClick={onPlay}>
          <Play size={14} /> <span>Играть выдачу</span>
        </button>
      </div>
      <div className="library-filter-fields" id={advancedId} hidden={!advancedOpen}>
        <div className="library-filter-selects">
          <label>
            Где доступно
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
        <label>Разметка
          <select value={value.missingGroup || (value.needsClassification ? "incomplete" : "")}
            onChange={event => {
              const v = event.target.value;
              onChange(old => ({...old, needsClassification: !!v, missingGroup: v && v !== "incomplete" ? v as LibrarySearch["missingGroup"] : undefined}));
            }}>
            <option value="">Все записи</option><option value="incomplete">Требуют разметки</option>
            {Object.entries(missingLabels).map(([id,label]) => <option key={id} value={id}>Не указано · {label}</option>)}
          </select>
        </label>
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
            {conditions.filter(c => !c.key.startsWith("tag:") && c.key !== "performanceFilter").map(({ key, label, clear }) => (
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
