import React, { useEffect, useId, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  ArrowDownUp, AudioLines, Check, ChevronDown, ChevronRight, CloudSun, Disc3, FolderTree, GalleryHorizontalEnd, Hash, Heart,
  Layers, LayoutGrid, List, Mic, MicVocal, Search, Shuffle, SlidersHorizontal, Sparkle, X,
} from "lucide-react";
import type { TagDto } from "@hibiki/contracts";
import { GenerativeCover, GroupIcon, Popover, Segmented, TagChip, usePopover } from "./design/primitives";
import { tagColor } from "./design/tag-colors";
import {
  addTag, clearGroup, currentSource, facetOptions, selectedIn, setGroupMode, sourceChildren, sourceSiblings, sourceTrail,
  tagSuggestions, toggleTag, withSource,
} from "./library-filters";
import {
  changeLibrarySort, libraryFilterConditions, libraryKinds, libraryProviders, librarySorts, libraryStatuses,
  newRandomSeed, resetLibraryFilters, type LibrarySearch, type LibraryView,
} from "./library-search";
import { groupKeys, groupOf, groups, missingLabels, type TagCatalog, type TagGroup } from "./taxonomy";
import { ArtworkImage } from "./ItemArtwork";
import { api } from "./api";

type Counts = Readonly<Record<string, number>> | undefined;
type SearchProps = { search: LibrarySearch; onChange: Dispatch<SetStateAction<LibrarySearch>>; catalog: TagCatalog; counts: Counts };

const facetGroups = [
  { group: "artist", label: "Исполнитель", icon: <MicVocal size={14} /> },
  { group: "genre", label: "Жанр", icon: <Disc3 size={14} /> },
  { group: "mood", label: "Настроение", icon: <CloudSun size={14} /> },
  { group: "extra", label: "Метки", icon: <Hash size={14} /> },
] as const satisfies readonly { group: TagGroup; label: string; icon: ReactNode }[];
export const groupIcons: Record<TagGroup, ReactNode> = {
  source: <FolderTree size={14} />, artist: <MicVocal size={14} />, genre: <Disc3 size={14} />, mood: <CloudSun size={14} />, extra: <Hash size={14} />,
};
const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many;
};
export const records = (n: number) => `${n.toLocaleString("ru")} ${plural(n, "запись", "записи", "записей")}`;

/* ---------------- search with tag suggestions ---------------- */

export function LibrarySearchBox({ search, onChange, catalog, counts }: SearchProps) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const suggestions = useMemo(() => tagSuggestions(catalog, search.query, counts), [catalog, search.query, counts]);
  const open = focused && suggestions.length > 0;
  useEffect(() => setActive(-1), [search.query]);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]");
      if ((event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);
  function choose(id: string) {
    onChange(current => ({ ...addTag(current, catalog, id), query: "" }));
    setActive(-1);
  }
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return <div className={`lib-search ${open ? "open" : ""}`}>
    <label className="lib-search-field">
      <Search size={18} aria-hidden />
      <input ref={input} type="search" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        aria-label="Поиск по названию, тегам и заметкам" placeholder="Треки, исполнители, источники, жанры…"
        value={search.query} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onChange={event => onChange(current => ({ ...current, query: event.target.value }))}
        onKeyDown={event => {
          if (event.key === "Escape") {
            if (search.query) onChange(current => ({ ...current, query: "" })); else input.current?.blur();
          } else if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const last = suggestions.length - 1;
            setActive(old => event.key === "ArrowDown" ? (old >= last ? -1 : old + 1) : (old <= -1 ? last : old - 1));
          } else if (open && ((event.key === "Tab" && !event.shiftKey) || (event.key === "Enter" && active >= 0))) {
            event.preventDefault();
            choose(suggestions[Math.max(0, active)]!.tag.id);
          }
        }} />
      {search.query
        ? <button type="button" className="icon-button" aria-label="Очистить поиск" onMouseDown={event => event.preventDefault()}
            onClick={() => onChange(current => ({ ...current, query: "" }))}><X size={15} /></button>
        : <span className="ds-kbd" aria-hidden>{mac ? "⌘ K" : "Ctrl K"}</span>}
    </label>
    <div className="lib-suggest" id={listId} role="listbox" aria-label="Теги" hidden={!open}>
      <div className="ds-section-title"><Layers size={12} />Теги — добавить в фильтр</div>
      {suggestions.map((suggestion, index) => {
        const group = groupOf(suggestion.tag);
        const parts = suggestion.path.split(" › ");
        return <div key={suggestion.tag.id} id={`${listId}-${index}`} role="option" aria-selected={index === active}
          className="ds-option lib-suggest-row" data-active={index === active}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(suggestion.tag.id)}>
          <GroupIcon group={group}>{groupIcons[group]}</GroupIcon>
          <span className="lib-suggest-name">
            {parts.length > 1 && <span className="path">{parts.slice(0, -1).join(" › ")} › </span>}
            <strong>{parts[parts.length - 1]}</strong>
            {suggestion.alias && <span className="sub"> · «{suggestion.alias}»</span>}
          </span>
          <span className="ds-pill">{groups[group]}</span>
          <span className="n">{suggestion.count ? records(suggestion.count) : "нет в выдаче"}</span>
          {index === Math.max(0, active) && <span className="ds-kbd">{active >= 0 ? "Enter" : "Tab"}</span>}
        </div>;
      })}
      <div className="lib-suggest-foot"><Search size={13} />Enter — искать «{search.query.trim()}» в названиях и заметках</div>
    </div>
  </div>;
}

/* ---------------- source tabs, breadcrumbs ---------------- */

export function SourceTabs({ search, onChange, catalog, counts, total, view, onViewChange }: SearchProps & {
  total: number; view: LibraryView; onViewChange: (view: LibraryView) => void;
}) {
  const roots = sourceChildren(catalog, "", counts);
  const source = currentSource(search, catalog);
  const root = source ? sourceTrail(catalog, source.id)[0] : undefined;
  return <div className="lib-tabs">
    <div className="lib-tabs-scroll" role="tablist" aria-label="Источник">
      <button type="button" role="tab" aria-selected={!root} className="lib-tab" onClick={() => onChange(current => withSource(current, catalog, undefined))}>
        <Layers size={15} />Всё{!root && <span className="n num">{total.toLocaleString("ru")}</span>}
      </button>
      {roots.map(tag => <button key={tag.id} type="button" role="tab" aria-selected={root?.id === tag.id}
        className={`lib-tab ${counts && !counts[tag.id] ? "zero" : ""}`} style={{ "--c": tagColor(tag) } as React.CSSProperties}
        onClick={() => onChange(current => withSource(current, catalog, root?.id === tag.id && source?.id === tag.id ? undefined : tag.id))}>
        {tag.name}<span className="n num">{(counts?.[tag.id] ?? 0).toLocaleString("ru")}</span>
      </button>)}
    </div>
    <Segmented label="Вид медиатеки" value={view} onChange={onViewChange} options={[
      { value: "list", label: <List size={15} aria-label="Список" />, title: "Список" },
      { value: "cards", label: <LayoutGrid size={15} aria-label="Карточки" />, title: "Карточки" },
      { value: "browse", label: <><GalleryHorizontalEnd size={15} aria-hidden />Обзор</>, title: "Обзор разделов" },
    ]} />
  </div>;
}

export function SourceTrail({ search, onChange, catalog, counts }: SearchProps) {
  const source = currentSource(search, catalog);
  const more = usePopover();
  if (!source) return null;
  const trail = sourceTrail(catalog, source.id);
  const inside = sourceChildren(catalog, source.id, counts).filter(tag => !counts || counts[tag.id]);
  const near = sourceSiblings(catalog, source.id, counts).filter(tag => !counts || counts[tag.id]).slice(0, 3);
  const go = (id: string | undefined) => onChange(current => withSource(current, catalog, id));
  if (trail.length < 2 && !inside.length) return null;
  const root = trail.length < 2;
  const shown = inside.slice(0, root ? 8 : 6);
  return <nav className="lib-trail" aria-label="Раздел источника">
    {trail.slice(0, -1).map(tag => <React.Fragment key={tag.id}>
      <button type="button" className="lib-crumb" onClick={() => go(tag.id)}>{tag.name}</button>
      <ChevronRight size={14} className="lib-crumb-sep" aria-hidden />
    </React.Fragment>)}
    {!root && <TagChip tag={source} state="on" size="lg" count={counts?.[source.id]} title="Текущий раздел" />}
    {inside.length > 0 && <span className={`lib-trail-label ${root ? "first" : ""}`}>{root ? "Разделы" : "внутри"}</span>}
    {shown.map(tag => <TagChip key={tag.id} tag={tag} state="off" size="lg" count={counts?.[tag.id]} onClick={() => go(tag.id)} enter />)}
    {inside.length > shown.length && <>
      <button ref={element => { more.anchorRef.current = element; }} type="button" className="ds-chip lg dashed" onClick={more.toggle}>
        ещё {inside.length - shown.length}
      </button>
      <Popover control={more} className="lib-more-pop" label="Все разделы">
        <TagList tags={inside.slice(shown.length)} counts={counts} onPick={id => { more.hide(); go(id); }} />
      </Popover>
    </>}
    {!root && near.length > 0 && <span className="lib-trail-label">рядом</span>}
    {!root && near.map(tag => <TagChip key={tag.id} tag={tag} state="off" size="lg" count={counts?.[tag.id]} onClick={() => go(tag.id)} enter />)}
  </nav>;
}

function TagList({ tags, counts, onPick }: { tags: TagDto[]; counts: Counts; onPick: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const shown = tags.filter(tag => tag.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <>
    <div className="ds-pop-head"><label className="ds-search"><Search size={14} /><input autoFocus value={query} placeholder="Найти раздел" onChange={event => setQuery(event.target.value)} /></label></div>
    <div className="ds-pop-body">
      {shown.map(tag => <button key={tag.id} type="button" className="ds-option" onClick={() => onPick(tag.id)}>
        <span className="ds-dot" style={{ background: tagColor(tag) }} />{tag.name}<span className="n">{counts?.[tag.id] ?? ""}</span>
      </button>)}
      {!shown.length && <p className="ds-empty">Ничего не найдено</p>}
    </div>
  </>;
}

/* ---------------- facets ---------------- */

export function FacetBar({ search, onChange, catalog, counts }: SearchProps) {
  const perf = search.performanceFilter ?? "";
  const vocal = perf === "vocal" || perf === "male" || perf === "female";
  const set = <K extends keyof LibrarySearch>(field: K, value: LibrarySearch[K]) => onChange(current => ({ ...current, [field]: value }));
  return <div className="lib-facets">
    <Segmented label="Исполнение" value={vocal ? "vocal" : perf || "any"} onChange={value => set("performanceFilter", value === "any" ? "" : value as LibrarySearch["performanceFilter"])}
      options={[
        { value: "any", label: "Любое" },
        { value: "ost", label: <><AudioLines size={14} aria-hidden />OST</>, title: "Без вокала" },
        { value: "vocal", label: <><Mic size={14} aria-hidden />Вокал</>, title: "С вокалом" },
      ]} />
    {vocal && <Segmented label="Голос" value={perf} onChange={value => set("performanceFilter", value)} options={[
      { value: "vocal", label: "Любой" }, { value: "male", label: "Муж." }, { value: "female", label: "Жен." },
    ]} />}
    <span className="lib-divider" aria-hidden />
    {facetGroups.map(facet => <Facet key={facet.group} {...facet} search={search} onChange={onChange} catalog={catalog} counts={counts} />)}
    <MoreFilters search={search} onChange={onChange} />
    <span className="lib-grow" />
    <button type="button" className={`ds-facet icon ${search.favoriteOnly ? "on" : ""}`} style={{ "--c": "var(--g-artist)" } as React.CSSProperties}
      aria-pressed={search.favoriteOnly} title="Только избранное" aria-label="Только избранное" onClick={() => set("favoriteOnly", !search.favoriteOnly)}>
      <Heart size={15} fill={search.favoriteOnly ? "currentColor" : "none"} />
    </button>
    <SortMenu search={search} onChange={onChange} />
  </div>;
}

function Facet({ group, label, icon, search, onChange, catalog, counts }: SearchProps & { group: TagGroup; label: string; icon: ReactNode }) {
  const pop = usePopover();
  const selected = selectedIn(search, catalog, group);
  const all = !!search.tagAll?.includes(group);
  return <>
    <button ref={element => { pop.anchorRef.current = element; }} type="button" className={`ds-facet g-${group} ${selected.length ? "on" : ""}`}
      aria-expanded={pop.open} aria-haspopup="dialog" onClick={pop.toggle}>
      {icon}{label}{selected.length > 0 && <span className="b">{selected.length}</span>}<ChevronDown size={14} className="chev" />
    </button>
    <Popover control={pop} className="lib-facet-pop" label={label}>
      <FacetPanel group={group} label={label} icon={icon} selected={selected} all={all} search={search} onChange={onChange}
        catalog={catalog} counts={counts} close={pop.hide} />
    </Popover>
  </>;
}

function FacetPanel({ group, label, icon, selected, all, onChange, catalog, counts, close }: SearchProps & {
  group: TagGroup; label: string; icon: ReactNode; selected: string[]; all: boolean; close: () => void;
}) {
  const [query, setQuery] = useState("");
  const { present, absent } = facetOptions(catalog, group, query, counts, selected);
  const limit = 200;
  const option = (tag: TagDto, zero = false) => {
    const on = selected.includes(tag.id);
    return <button key={tag.id} type="button" role="menuitemcheckbox" aria-checked={on} className={`ds-option ${zero ? "zero" : ""}`}
      style={{ "--c": tagColor(tag) } as React.CSSProperties} onClick={() => onChange(current => toggleTag(current, catalog, tag.id))}>
      <span className={`ds-box ${on ? "on" : ""}`}>{on && <Check size={11} strokeWidth={3} />}</span>
      <span className="label">{tag.name}</span>
      <span className="n">{counts ? counts[tag.id] ?? 0 : ""}</span>
    </button>;
  };
  return <>
    <div className="ds-pop-head">
      <span className={`lib-facet-title g-${group}`}><GroupIcon group={group}>{icon}</GroupIcon>{label}</span>
      <span className="lib-grow" />
      <Segmented label="Совпадение" value={all ? "all" : "any"} onChange={value => onChange(current => setGroupMode(current, group, value === "all"))}
        options={[{ value: "any", label: "Любой из", title: "Запись подходит, если у неё есть хотя бы один из выбранных" },
          { value: "all", label: "Все", title: "Запись подходит, только если у неё есть все выбранные" }]} />
    </div>
    <div className="lib-facet-search">
      <label className="ds-search"><Search size={14} /><input autoFocus value={query} placeholder={`Найти: ${label.toLocaleLowerCase()}`} onChange={event => setQuery(event.target.value)} /></label>
    </div>
    <div className="ds-pop-body" role="menu" aria-label={label}>
      {present.length > 0 && <div className="ds-section-title">{counts ? "В текущей выдаче" : "Все значения"}</div>}
      {present.slice(0, limit).map(tag => option(tag))}
      {absent.length > 0 && <div className="ds-section-title">Не встречаются здесь</div>}
      {absent.slice(0, 60).map(tag => option(tag, true))}
      {present.length > limit && <p className="ds-empty">Показаны первые {limit}. Уточните поиск.</p>}
      {!present.length && !absent.length && <p className="ds-empty">{query ? "Ничего не найдено" : "В этой группе пока нет тегов"}</p>}
    </div>
    <div className="ds-pop-foot">
      <span className="lib-facet-hint">{selected.length > 1 ? (all ? "Нужны все выбранные" : "Подходит любой из выбранных") : "Поиск и по псевдонимам"}</span>
      <span className="lib-grow" />
      {selected.length > 0 && <button type="button" className="button compact subtle" onClick={() => onChange(current => clearGroup(current, catalog, group))}>Сбросить</button>}
      <button type="button" className="button compact" onClick={close}>Готово</button>
    </div>
  </>;
}

function MoreFilters({ search, onChange }: Pick<SearchProps, "search" | "onChange">) {
  const pop = usePopover();
  const set = <K extends keyof LibrarySearch>(field: K, value: LibrarySearch[K]) => onChange(current => ({ ...current, [field]: value }));
  const active = libraryFilterConditions(search, []).filter(condition => condition.advanced || condition.key === "kind").length;
  return <>
    <button ref={element => { pop.anchorRef.current = element; }} type="button" className={`ds-facet ${active ? "on" : ""}`} aria-expanded={pop.open} onClick={pop.toggle}>
      <SlidersHorizontal size={14} />Ещё{active > 0 && <span className="b">{active}</span>}
    </button>
    <Popover control={pop} className="lib-more-filters" label="Дополнительные фильтры">
      <div className="ds-pop-head"><strong>Дополнительные фильтры</strong></div>
      <div className="ds-pop-body lib-more-grid">
        <div className="lib-field"><span>Тип записи</span>
          <Segmented label="Тип записи" value={search.kind || "all"} onChange={value => set("kind", value === "all" ? "" : value as LibrarySearch["kind"])}
            options={Object.entries(libraryKinds).map(([value, label]) => ({ value: value || "all", label }))} />
        </div>
        <label className="lib-field"><span>Разметка</span>
          <select value={search.missingGroup || (search.needsClassification ? "incomplete" : "")} onChange={event => {
            const value = event.target.value;
            onChange(current => ({ ...current, needsClassification: !!value, missingGroup: value && value !== "incomplete" ? value as LibrarySearch["missingGroup"] : undefined }));
          }}>
            <option value="">Все записи</option><option value="incomplete">Требуют разметки</option>
            {Object.entries(missingLabels).map(([id, label]) => <option key={id} value={id}>Не указано · {label}</option>)}
          </select>
        </label>
        <label className="lib-field"><span>Где доступно</span>
          <select value={search.provider} onChange={event => set("provider", event.target.value as LibrarySearch["provider"])}>
            {Object.entries(libraryProviders).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
          </select>
        </label>
        <label className="lib-field"><span>Доступность</span>
          <select value={search.availability} onChange={event => set("availability", event.target.value as LibrarySearch["availability"])}>
            {Object.entries(libraryStatuses).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
          </select>
        </label>
        <fieldset className="lib-field"><legend>Длительность, сек.</legend>
          <div className="lib-range">
            <input type="number" min="0" step="any" aria-label="Длительность от" placeholder="от" value={search.minDuration} onChange={event => set("minDuration", event.target.value)} />
            <span>—</span>
            <input type="number" min="0" step="any" aria-label="Длительность до" placeholder="до" value={search.maxDuration} onChange={event => set("maxDuration", event.target.value)} />
          </div>
        </fieldset>
        <fieldset className="lib-field"><legend>Дата добавления</legend>
          <div className="lib-range">
            <input type="date" aria-label="Добавлено с" value={search.addedFrom} onChange={event => set("addedFrom", event.target.value)} />
            <span>—</span>
            <input type="date" aria-label="Добавлено по" value={search.addedThrough} onChange={event => set("addedThrough", event.target.value)} />
          </div>
        </fieldset>
      </div>
      <div className="ds-pop-foot">
        <span className="lib-grow" />
        {active > 0 && <button type="button" className="button compact subtle" onClick={() => onChange(current => ({
          ...current, kind: "", provider: "", availability: "", needsClassification: false, missingGroup: undefined,
          minDuration: "", maxDuration: "", addedFrom: "", addedThrough: "",
        }))}>Сбросить</button>}
        <button type="button" className="button compact" onClick={pop.hide}>Готово</button>
      </div>
    </Popover>
  </>;
}

function SortMenu({ search, onChange }: Pick<SearchProps, "search" | "onChange">) {
  const pop = usePopover("end");
  return <>
    <button ref={element => { pop.anchorRef.current = element; }} type="button" className="ds-facet" aria-expanded={pop.open} aria-label={`Сортировка: ${librarySorts[search.sort]}`} onClick={pop.toggle}>
      <ArrowDownUp size={14} />{librarySorts[search.sort]}<ChevronDown size={14} className="chev" />
    </button>
    <Popover control={pop} className="lib-sort-pop" label="Сортировка">
      <div className="ds-pop-body" role="menu">
        <div className="ds-section-title">Порядок</div>
        {Object.entries(librarySorts).map(([id, label]) => <button key={id} type="button" role="menuitemradio" aria-checked={search.sort === id}
          className="ds-option" onClick={() => { onChange(current => changeLibrarySort(current, id as LibrarySearch["sort"])); pop.hide(); }}>
          <span className="lib-check">{search.sort === id && <Check size={14} />}</span>{label}
        </button>)}
      </div>
    </Popover>
  </>;
}

/* ---------------- active filters ---------------- */

export function ActiveFilters({ search, onChange, catalog, archivedTagNames, extra }: Omit<SearchProps, "counts"> & {
  archivedTagNames?: Record<string, string>; extra?: ReactNode;
}) {
  const known = groupKeys.map(group => ({ group, ids: selectedIn(search, catalog, group) })).filter(set => set.ids.length);
  const unknown = search.tagIds.filter(id => !catalog.byId.has(id));
  const others = libraryFilterConditions(search, []).filter(condition => !condition.key.startsWith("tag:"));
  if (!known.length && !unknown.length && !others.length) return null;
  const remove = (id: string) => onChange(current => ({ ...current, tagIds: current.tagIds.filter(other => other !== id) }));
  const parts: ReactNode[] = [];
  for (const { group, ids } of known) {
    const all = search.tagAll?.includes(group);
    parts.push(<span className="lib-active-group" key={group}>
      {ids.map((id, index) => {
        const tag = catalog.byId.get(id)!;
        const name = group === "source" ? sourceTrail(catalog, id).map(node => node.name).join(" › ") : tag.name;
        return <React.Fragment key={id}>
          {index > 0 && <span className="lib-or">{all ? "и" : "или"}</span>}
          <TagChip tag={{ ...tag, name }} onRemove={() => remove(id)} enter />
        </React.Fragment>;
      })}
    </span>);
  }
  for (const id of unknown) {
    const name = archivedTagNames && Object.hasOwn(archivedTagNames, id) ? archivedTagNames[id]! : "Удалённый тег";
    parts.push(<span className="ds-chip g-extra" key={id}><span className="label">{name}</span>
      <button type="button" className="x" aria-label={`Снять ${name}`} onClick={() => remove(id)}><X size={11} /></button></span>);
  }
  for (const condition of others) {
    parts.push(<span className="ds-chip g-performance" key={condition.key}><span className="label">{condition.label}</span>
      <button type="button" className="x" aria-label={`Снять фильтр «${condition.label}»`} onClick={() => onChange(condition.clear)}><X size={11} /></button></span>);
  }
  return <div className="lib-active" role="group" aria-label="Активные фильтры">
    {parts.map((part, index) => <React.Fragment key={index}>{index > 0 && <span className="lib-and">И</span>}{part}</React.Fragment>)}
    <span className="lib-grow" />
    {extra}
    <button type="button" className="button compact subtle" onClick={() => onChange(current => ({ ...resetLibraryFilters(current), tagAll: [] }))}>Сбросить</button>
  </div>;
}

/* ---------------- results bar ---------------- */

export function ResultsBar({ search, onChange, total, loading, selectAll, onPlay }: Pick<SearchProps, "search" | "onChange"> & {
  total: number; loading: boolean; selectAll?: ReactNode; onPlay: () => void;
}) {
  return <div className="lib-results">
    {selectAll}
    <span role="status" className={loading ? "lib-results-count loading" : "lib-results-count"}><b className="num">{total.toLocaleString("ru")}</b> {records(total).split(" ").slice(1).join(" ")}</span>
    {search.sort === "random" && <button type="button" className="button compact subtle" onClick={() => onChange(current => ({ ...current, randomSeed: newRandomSeed() }))}>
      <Shuffle size={14} />Перемешать ещё раз
    </button>}
    {search.sort === "recent" && <button type="button" className="button compact subtle" onClick={() => onChange(current => changeLibrarySort(current, current.previousSort ?? "added-desc"))}>
      <X size={14} />Выключить «Недавно слушал»
    </button>}
    <span className="lib-grow" />
    <button type="button" className="button compact" disabled={!total} onClick={onPlay}><PlayIcon />Играть выдачу</button>
  </div>;
}
const PlayIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" fill="currentColor" /></svg>;

/* ---------------- browse view ---------------- */

export function BrowseGrid({ search, onChange, catalog, counts, onShowList }: SearchProps & { onShowList: () => void }) {
  const source = currentSource(search, catalog);
  const nodes = sourceChildren(catalog, source?.id ?? "", counts).filter(tag => !counts || counts[tag.id]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const key = nodes.map(node => node.id).join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    api<{ covers: Record<string, string> }>("/library/section-covers", "POST", { ids: key.split(",").slice(0, 100) }, "low")
      .then(result => { if (live) setCovers(old => ({ ...old, ...result.covers })); }).catch(() => {});
    return () => { live = false; };
  }, [key]);
  if (!nodes.length) return <div className="lib-browse-empty">
    <Sparkle size={22} />
    <p>{source ? `Внутри «${source.name}» нет разделов.` : "Источники ещё не размечены."}</p>
    <button type="button" className="button compact" onClick={onShowList}>Показать записи</button>
  </div>;
  return <div className="lib-browse" role="list">
    {nodes.map(tag => {
      const kids = catalog.children.get(tag.id)?.length ?? 0;
      return <button key={tag.id} type="button" role="listitem" className="lib-tile" style={{ "--c": tagColor(tag) } as React.CSSProperties}
        onClick={() => onChange(current => withSource(current, catalog, tag.id))}>
        <span className="lib-tile-cover">
          <ArtworkImage urls={[covers[tag.id]]} fallback={<GenerativeCover seed={tag.name} />} />
        </span>
        <span className="lib-tile-name">{tag.name}</span>
        <span className="lib-tile-sub">{records(counts?.[tag.id] ?? 0)}{kids ? ` · ${kids} ${plural(kids, "раздел", "раздела", "разделов")}` : ""}</span>
      </button>;
    })}
  </div>;
}

