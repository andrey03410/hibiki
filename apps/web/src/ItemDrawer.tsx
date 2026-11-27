import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AudioLines, Check, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Cloud, CloudSun, Disc3, FolderTree, Hash,
  LoaderCircle, Mic, MicVocal, Play, Plus, Search, Sparkle, Tags, X,
} from "lucide-react";
import type { ItemDto, TagDto } from "@hibiki/contracts";
import { api, formatDuration } from "./api";
import { ItemArtwork } from "./ItemArtwork";
import { Drawer, GroupIcon, ProgressRing, Segmented, TagChip } from "./design/primitives";
import { useData } from "./WorkspaceUi";
import { groupOf, groups, missingLabels, normalize, type TagCatalog, type TagGroup } from "./taxonomy";
import { sourceChildren, sourceTrail } from "./library-filters";
import {
  AutosaveQueue, completeness, describeChange, setPerformance, startDraft, toggleDraftTag, toggleVoice, type Draft, type SavedDraft,
} from "./tag-editing";

/** Saves the list may not show yet: reopening an item starts from them, not from the stale row. */
const savedDrafts = new Map<string, SavedDraft>();

export type DrawerTab = "tags" | "about" | "sources" | "visual" | "history";

export type DrawerPanels = {
  favorite: ReactNode;
  shared: ReactNode;
  note: ReactNode;
  sources: ReactNode;
  visual: ReactNode;
  history: ReactNode;
};

/** Side panel of one item: classification with autosave, title, sources, visuals and history. */
export function ItemDrawer({ item, catalog, open, onClose, onPrev, onNext, onPlay, initialTab = "tags", panels }: {
  item: ItemDto;
  catalog: TagCatalog;
  open: boolean;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onPlay?: () => void;
  initialTab?: DrawerTab;
  panels: DrawerPanels;
}) {
  return <Drawer open={open} onClose={onClose} label={`Запись «${item.title}»`} className="item-drawer">
    <DrawerBody key={item.id} item={item} catalog={catalog} onClose={onClose} onPrev={onPrev} onNext={onNext} onPlay={onPlay}
      initialTab={initialTab} panels={panels} />
  </Drawer>;
}

function DrawerBody({ item, catalog, onClose, onPrev, onNext, onPlay, initialTab, panels }: Omit<React.ComponentProps<typeof ItemDrawer>, "open">) {
  const { refresh, notify } = useData();
  const [tab, setTab] = useState<DrawerTab>(initialTab ?? "tags");
  const initial = useMemo(() => startDraft(item, savedDrafts.get(item.id)), [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<Draft>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [title, setTitle] = useState(item.title);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scheduleRefresh = (delay = 1500) => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refresh().catch(() => {}), delay);
  };
  const queue = useMemo(() => new AutosaveQueue(initial, next => api<ItemDto>(`/items/${encodeURIComponent(item.id)}`, "PATCH", {
    tagIds: next.tagIds, performance: next.performance, voices: next.voices,
  }).then(saved => { savedDrafts.set(item.id, { draft: next, updatedAt: saved?.updatedAt, at: Date.now() }); }), {
    busy: busy => setStatus(old => busy ? "saving" : old === "error" ? "error" : "saved"),
    saved: (before, after) => {
      scheduleRefresh();
      notify(describeChange(before, after, catalog), false, {
        label: "Отменить",
        run: () => { setDraft(before); queue.schedule(before); void queue.flush(); },
      });
    },
    failed: error => { setStatus("error"); notify(error.message, true); },
  }), [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    void queue.flush().then(() => { clearTimeout(refreshTimer.current); void refresh().catch(() => {}); });
  }, [queue]); // eslint-disable-line react-hooks/exhaustive-deps

  function change(next: Draft) {
    setDraft(next);
    queue.schedule(next);
  }
  async function saveTitle() {
    const value = title.trim();
    if (!value || value === item.title) { setTitle(item.title); return; }
    try {
      await api(`/items/${encodeURIComponent(item.id)}`, "PATCH", { title: value });
      notify("Название сохранено");
      scheduleRefresh(0);
    } catch (e) {
      notify((e as Error).message, true);
      setTitle(item.title);
    }
  }
  const progress = completeness(draft, catalog);
  const artwork = item.sources.find(source => source.thumbnail);
  const sourceCount = item.sources.length;
  return <>
    <header className="drawer-head">
      <span className="drawer-art"><ItemArtwork source={artwork} kind={item.kind} size="cover" /></span>
      <div className="drawer-title">
        <h2 title={item.title}>{title || item.title}</h2>
        <p>{[item.originalTitle !== item.title ? item.originalTitle : "", item.kind === "video" ? "Видео" : "Аудио", formatDuration(item.duration)].filter(Boolean).join(" · ")}</p>
        <div className="drawer-actions">
          {onPlay && <button type="button" className="button compact" onClick={onPlay}><Play size={13} fill="currentColor" />Играть</button>}
          {panels.favorite}
        </div>
      </div>
      <div className="drawer-progress" title={progress.missing.length ? "Не хватает: " + progress.missing.map(key => missingLabels[key].toLocaleLowerCase()).join(", ") : "Разметка заполнена"}>
        <ProgressRing done={progress.done} total={progress.total} size={44} />
        <small>разметка</small>
      </div>
      <button type="button" className="icon-button drawer-close" aria-label="Закрыть" onClick={onClose}><X size={18} /></button>
    </header>
    {panels.shared}
    <div className="ds-tabs" role="tablist">
      {([["tags", <><Tags size={14} />Разметка</>], ["about", "Название и заметка"], ["sources", `Источники${sourceCount ? " · " + sourceCount : ""}`],
        ["visual", "Видеоряд"], ["history", "История"]] as const).map(([id, label]) =>
        <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    <div className="drawer-body">
      {tab === "tags" && <ClassificationForm draft={draft} catalog={catalog} onChange={change} />}
      {tab === "about" && <div className="drawer-section">
        <label className="drawer-field"><span>Название</span>
          <input value={title} maxLength={1000} onChange={event => setTitle(event.target.value)} onBlur={() => void saveTitle()}
            onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setTitle(item.title); }} />
        </label>
        <p className="drawer-hint">Название источника: {item.originalTitle || "неизвестно"}. Ваше название сохраняется, даже если источник исчезнет.</p>
        {panels.note}
      </div>}
      {tab === "sources" && <div className="drawer-section">{panels.sources}</div>}
      {tab === "visual" && <div className="drawer-section">{panels.visual}</div>}
      {tab === "history" && <div className="drawer-section">{panels.history}</div>}
    </div>
    <footer className="drawer-foot">
      <span className={`drawer-status ${status}`} role="status">
        {status === "saving" ? <><LoaderCircle size={14} className="spin" />Сохраняем…</>
          : status === "error" ? <><CircleAlert size={14} />Не сохранено</>
          : <><Cloud size={14} />Изменения сохраняются сразу</>}
      </span>
      <span className="lib-grow" />
      <button type="button" className="button compact subtle" disabled={!onPrev} onClick={onPrev}><ChevronUp size={14} />Пред.</button>
      <button type="button" className="button compact subtle" disabled={!onNext} onClick={onNext}>След.<ChevronDown size={14} /></button>
      <button type="button" className="button compact primary" onClick={onClose}>Готово</button>
    </footer>
  </>;
}

/* ---------------- classification ---------------- */

const icons: Record<TagGroup, ReactNode> = {
  source: <FolderTree size={14} />, artist: <MicVocal size={14} />, genre: <Disc3 size={14} />, mood: <CloudSun size={14} />, extra: <Hash size={14} />,
};

function ClassificationForm({ draft, catalog, onChange }: { draft: Draft; catalog: TagCatalog; onChange: (draft: Draft) => void }) {
  const assigned = (group: TagGroup) => draft.tagIds.flatMap(id => catalog.byId.get(id) ?? []).filter(tag => groupOf(tag) === group);
  const toggle = (id: string) => onChange(toggleDraftTag(draft, id));
  const all = (group: TagGroup) => catalog.active.filter(tag => groupOf(tag) === group);
  return <div className="drawer-section classification">
    <Field group="source" label="Источник" aside={assigned("source").map(tag => <TagChip key={tag.id} tag={{ ...tag, name: catalog.paths(tag.id)[0] ?? tag.name }} onRemove={() => toggle(tag.id)} enter />)}>
      <SourceColumns catalog={catalog} selected={draft.tagIds} onToggle={toggle} />
    </Field>
    <Field group="artist" label="Исполнитель" inline>
      <AddableTags group="artist" catalog={catalog} assigned={assigned("artist")} onToggle={toggle} />
    </Field>
    <Field group="genre" label="Жанр" inline>
      {all("genre").length <= 24
        ? <ToggleTags tags={all("genre")} selected={draft.tagIds} onToggle={toggle} group="genre" catalog={catalog} />
        : <AddableTags group="genre" catalog={catalog} assigned={assigned("genre")} onToggle={toggle} />}
    </Field>
    <Field group="mood" label="Настроение" inline>
      <ToggleTags tags={all("mood")} selected={draft.tagIds} onToggle={toggle} group="mood" catalog={catalog} />
    </Field>
    <Field group="extra" label="Метки" inline>
      {all("extra").length <= 24
        ? <ToggleTags tags={all("extra")} selected={draft.tagIds} onToggle={toggle} group="extra" catalog={catalog} />
        : <AddableTags group="extra" catalog={catalog} assigned={assigned("extra")} onToggle={toggle} />}
    </Field>
    <div className="drawer-field-row">
      <span className="drawer-label g-performance"><GroupIcon group="performance"><Mic size={14} /></GroupIcon>Исполнение</span>
      <div className="drawer-wrap">
        <Segmented label="Исполнение" value={draft.performance} onChange={value => onChange(setPerformance(draft, value))} options={[
          { value: "unknown", label: "Не указано" },
          { value: "ost", label: <><AudioLines size={14} aria-hidden />Без вокала</> },
          { value: "vocal", label: <><Mic size={14} aria-hidden />С вокалом</> },
        ]} />
        {draft.performance === "vocal" && <>
          <TagChip tag={{ name: "Мужской", color: "" }} color="#8fb5ff" size="lg" state={draft.voices.includes("male") ? "on" : "off"} onClick={() => onChange(toggleVoice(draft, "male"))} />
          <TagChip tag={{ name: "Женский", color: "" }} color="#f4a8c3" size="lg" state={draft.voices.includes("female") ? "on" : "off"} onClick={() => onChange(toggleVoice(draft, "female"))} />
          {!draft.voices.length && <span className="ds-pill warn"><Sparkle size={11} />Укажите голос</span>}
        </>}
      </div>
    </div>
  </div>;
}

function Field({ group, label, inline, aside, children }: { group: TagGroup; label: string; inline?: boolean; aside?: ReactNode; children: ReactNode }) {
  return <div className={inline ? "drawer-field-row" : "drawer-field-block"}>
    <span className={`drawer-label g-${group}`}><GroupIcon group={group}>{icons[group]}</GroupIcon>{label}{aside && <span className="drawer-aside">{aside}</span>}</span>
    {inline ? <div className="drawer-wrap">{children}</div> : children}
  </div>;
}

function ToggleTags({ tags, selected, onToggle, group, catalog }: { tags: TagDto[]; selected: string[]; onToggle: (id: string) => void; group: TagGroup; catalog: TagCatalog }) {
  if (!tags.length) return <AddableTags group={group} catalog={catalog} assigned={[]} onToggle={onToggle} />;
  return <>
    {tags.map(tag => <TagChip key={tag.id} tag={tag} size="lg" state={selected.includes(tag.id) ? "on" : "off"} onClick={() => onToggle(tag.id)} />)}
    <NewTag group={group} onCreated={onToggle} compact />
  </>;
}

/** Assigned chips plus an inline search that adds existing tags or creates a new one. */
function AddableTags({ group, catalog, assigned, onToggle }: { group: TagGroup; catalog: TagCatalog; assigned: TagDto[]; onToggle: (id: string) => void }) {
  const [query, setQuery] = useState<string>();
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = query === undefined ? [] : catalog.find(query, group).filter(tag => !assigned.some(other => other.id === tag.id)).slice(0, 8);
  const exact = query !== undefined && catalog.find(query, group).some(tag => normalize(tag.name) === normalize(query));
  useEffect(() => { if (query !== undefined) input.current?.focus(); }, [query === undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setActive(0), [query]);
  const pick = (id: string) => { onToggle(id); setQuery(""); };
  return <>
    {assigned.map(tag => <TagChip key={tag.id} tag={tag} size="lg" onRemove={() => onToggle(tag.id)} enter />)}
    {query === undefined
      ? <button type="button" className="ds-chip lg dashed" onClick={() => setQuery("")}><Plus size={12} />Добавить</button>
      : <span className="drawer-adder">
          <label className="ds-search"><Search size={14} />
            <input ref={input} value={query} placeholder={`Найти: ${groups[group].toLocaleLowerCase()}`} onChange={event => setQuery(event.target.value)}
              onBlur={() => setTimeout(() => setQuery(old => old ? old : undefined), 150)}
              onKeyDown={event => {
                if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setQuery(undefined); }
                else if (event.key === "ArrowDown") { event.preventDefault(); setActive(old => Math.min(old + 1, results.length - 1)); }
                else if (event.key === "ArrowUp") { event.preventDefault(); setActive(old => Math.max(old - 1, 0)); }
                else if (event.key === "Enter" && results[active]) { event.preventDefault(); pick(results[active]!.id); }
              }} />
          </label>
          {(results.length > 0 || (query.trim() && !exact)) && <span className="drawer-adder-list" role="listbox">
            {results.map((tag, index) => <button key={tag.id} type="button" role="option" aria-selected={index === active} className="ds-option" data-active={index === active}
              onMouseDown={event => event.preventDefault()} onClick={() => pick(tag.id)}>
              <span className="ds-dot" style={{ background: "var(--c, var(--accent))" }} />{tag.name}
              {tag.aliases?.length ? <span className="sub">{tag.aliases.slice(0, 2).join(", ")}</span> : null}
            </button>)}
            {query.trim() && !exact && <NewTag group={group} name={query.trim()} onCreated={id => { onToggle(id); setQuery(""); }} />}
          </span>}
        </span>}
  </>;
}

function NewTag({ group, name, onCreated, compact }: { group: TagGroup; name?: string; onCreated: (id: string) => void; compact?: boolean }) {
  const { refresh, notify } = useData();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [value, setValue] = useState("");
  async function create(label: string) {
    if (!label.trim()) return;
    setBusy(true);
    try {
      const tag = await api<TagDto>("/tags", "POST", { name: label.trim(), group });
      await refresh();
      onCreated(tag.id);
      setAsking(false);
      setValue("");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  if (name) return <button type="button" className="ds-option drawer-create" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => void create(name)}>
    {busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}Создать «{name}»
  </button>;
  if (!compact) return null;
  return asking
    ? <span className="drawer-adder"><label className="ds-search"><Plus size={14} /><input autoFocus value={value} disabled={busy} placeholder="Новый тег"
        onChange={event => setValue(event.target.value)} onBlur={() => { if (!value) setAsking(false); }}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); void create(value); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setAsking(false); }
        }} /></label></span>
    : <button type="button" className="ds-chip lg dashed" onClick={() => setAsking(true)}><Plus size={12} />Новая</button>;
}

/** Miller columns over the source tree; the checkbox assigns, the row opens children. */
function SourceColumns({ catalog, selected, onToggle }: { catalog: TagCatalog; selected: string[]; onToggle: (id: string) => void }) {
  const initial = useMemo(() => {
    const first = selected.find(id => catalog.byId.get(id) && groupOf(catalog.byId.get(id)!) === "source");
    if (!first) return [];
    const trail = sourceTrail(catalog, first).map(tag => tag.id);
    return catalog.children.get(first)?.length ? trail : trail.slice(0, -1);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [path, setPath] = useState<string[]>(initial);
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: "smooth" }); }, [path.length]);
  const columns = [ "", ...path ].map(id => sourceChildren(catalog, id, undefined));
  const found = query.trim() ? catalog.find(query, "source").slice(0, 40) : [];
  const assignedBelow = (id: string) => selected.some(other => other !== id && sourceTrail(catalog, other).some(tag => tag.id === id));
  return <div className="miller-wrap">
    <label className="ds-search miller-search"><Search size={14} /><input value={query} placeholder="Найти источник по названию или псевдониму" onChange={event => setQuery(event.target.value)} /></label>
    {found.length > 0 || query.trim() ? <div className="miller-results">
      {found.map(tag => {
        const on = selected.includes(tag.id);
        return <button key={tag.id} type="button" className={`miller-cell ${on ? "on" : ""}`} onClick={() => onToggle(tag.id)}>
          <span className={`ds-box ${on ? "on" : ""}`} style={{ "--c": "var(--g-source)" } as React.CSSProperties}>{on && <Check size={11} strokeWidth={3} />}</span>
          <span className="miller-name">{catalog.paths(tag.id)[0] ?? tag.name}</span>
        </button>;
      })}
      {!found.length && <p className="ds-empty">Ничего не найдено</p>}
    </div> : <div className="miller" ref={scroller}>
      {columns.map((tags, depth) => <div className="miller-col" key={depth} role="listbox" aria-label={depth ? catalog.byId.get(path[depth - 1]!)?.name : "Корни"}>
        {tags.map(tag => {
          const on = selected.includes(tag.id);
          const open = path[depth] === tag.id;
          const kids = !!catalog.children.get(tag.id)?.length;
          return <div key={tag.id} className={`miller-cell ${on ? "on" : ""} ${open ? "open" : ""} ${assignedBelow(tag.id) ? "below" : ""}`}>
            <button type="button" className={`ds-box ${on ? "on" : ""}`} style={{ "--c": "var(--g-source)" } as React.CSSProperties}
              aria-label={(on ? "Снять «" : "Выбрать «") + tag.name + "»"} aria-pressed={on} onClick={() => onToggle(tag.id)}>{on && <Check size={11} strokeWidth={3} />}</button>
            <button type="button" className="miller-name" onClick={() => kids ? setPath([...path.slice(0, depth), tag.id]) : onToggle(tag.id)}>{tag.name}</button>
            {kids && <ChevronRight size={14} className="miller-arrow" />}
          </div>;
        })}
        {!tags.length && <p className="ds-empty">Пусто</p>}
      </div>)}
    </div>}
  </div>;
}
