import React, { useEffect, useMemo, useState } from "react";
import { CloudSun, Disc3, FolderTree, Hash, LoaderCircle, Mic, MicVocal, Plus, Search, Tags } from "lucide-react";
import type { ItemDto } from "@hibiki/contracts";
import { api, ApiError } from "./api";
import { fetchItems } from "./library-pages";
import { records } from "./LibraryFilters";
import { Popover, Segmented, TagChip, usePopover } from "./design/primitives";
import { useData } from "./WorkspaceUi";
import { groupKeys, groupOf, groups, type Performance, type TagCatalog, type TagGroup, type Voice } from "./taxonomy";
import { bulkChanges, bulkState, bulkTags, effectiveState, nextBulkTarget, sourceLabel } from "./tag-editing";

const icons: Record<TagGroup, React.ReactNode> = {
  source: <FolderTree size={12} />, artist: <MicVocal size={12} />, genre: <Disc3 size={12} />, mood: <CloudSun size={12} />, extra: <Hash size={12} />,
};

/** «Разметить» for a selection: tri-state chips, one batch request with a revision check. */
export function BulkTagger({ ids, catalog, onDone }: { ids: string[]; catalog: TagCatalog; onDone: () => void }) {
  const pop = usePopover("start");
  return <>
    <button ref={element => { pop.anchorRef.current = element; }} type="button" className="button compact primary" aria-expanded={pop.open} onClick={pop.toggle}>
      <Tags size={14} />Разметить
    </button>
    <Popover control={pop} className="bulk-pop" label="Массовая разметка">
      <BulkPanel ids={ids} catalog={catalog} close={pop.hide} onDone={onDone} />
    </Popover>
  </>;
}

function BulkPanel({ ids, catalog, close, onDone }: { ids: string[]; catalog: TagCatalog; close: () => void; onDone: () => void }) {
  const { overview, refresh, notify } = useData();
  const [items, setItems] = useState<ItemDto[]>();
  const [revision, setRevision] = useState("");
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<Map<string, boolean>>(new Map());
  const [performance, setPerformance] = useState<{ performance: Performance; voices: Voice[] }>();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<TagGroup>();
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setRevision(overview.revision);
    setError("");
    fetchItems(ids).then(loaded => {
      if (!live) return;
      if (loaded.length !== ids.length) setError("Состав выборки изменился. Выберите записи заново.");
      setItems(loaded);
    }).catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [ids.join(","), attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const present = useMemo(() => items ? bulkTags(items, catalog) : [], [items, catalog]);
  const shown = useMemo(() => {
    const extra = [...plan.keys()].filter(id => !present.some(tag => tag.id === id)).flatMap(id => catalog.byId.get(id) ?? []);
    return [...present, ...extra];
  }, [present, plan, catalog]);
  const changes = useMemo(() => items ? bulkChanges(items, plan, performance) : [], [items, plan, performance]);
  if (!items) return <div className="ds-pop-body"><p className="ds-empty">{error || <><LoaderCircle size={14} className="spin" /> Загружаем выбранные записи…</>}</p></div>;
  const click = (id: string) => setPlan(old => {
    const next = new Map(old);
    const target = nextBulkTarget(bulkState(items, id).state, old.get(id));
    if (target === undefined) next.delete(id); else next.set(id, target);
    return next;
  });
  async function apply() {
    setBusy(true);
    setError("");
    try {
      await api("/items/batch", "POST", { expectedRevision: revision, changes });
      await refresh();
      notify(`Разметка обновлена: ${records(changes.length)}`);
      close();
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "library_changed") {
        // Reload the records and the revision; the planned changes stay and apply to the fresh state.
        await refresh().catch(() => {});
        setItems(undefined);
        setAttempt(value => value + 1);
        notify("Медиатека изменилась: состояние записей обновлено, проверьте и примените ещё раз", true);
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const candidates = adding ? catalog.find(query, adding).filter(tag => !shown.some(other => other.id === tag.id)).slice(0, 8) : [];
  const added = [...plan].filter(([, on]) => on).flatMap(([id]) => catalog.byId.get(id) ?? []);
  const removed = [...plan].filter(([, on]) => !on).flatMap(([id]) => catalog.byId.get(id) ?? []);
  const perfState = performance?.performance ?? "keep";
  return <>
    <div className="ds-pop-head"><strong>Разметка · {records(items.length)}</strong><span className="lib-grow" /><span className="bulk-hint">полоса — есть у части</span></div>
    <div className="ds-pop-body">
      {groupKeys.map(group => {
        const tags = shown.filter(tag => groupOf(tag) === group);
        return <section key={group} className={`bulk-section g-${group}`}>
          <div className="ds-section-title">{icons[group]}{groups[group]}</div>
          <div className="bulk-chips">
            {tags.map(tag => {
              const { state, count } = bulkState(items, tag.id);
              const target = plan.get(tag.id);
              const shownState = effectiveState(state, target);
              const label = target === undefined ? `${count}/${items.length}` : target ? `${count}→${items.length}` : `${count}→0`;
              return <TagChip key={tag.id} tag={{ ...tag, name: sourceLabel(tag, catalog) }} state={shownState === "off" ? "off" : shownState} count={undefined}
                title={label} onClick={() => click(tag.id)} className={target !== undefined ? "changed" : ""} />;
            })}
            {adding === group
              ? <span className="drawer-adder"><label className="ds-search"><Search size={14} /><input autoFocus value={query} placeholder={`Добавить: ${groups[group].toLocaleLowerCase()}`}
                  onChange={event => setQuery(event.target.value)} onBlur={() => setTimeout(() => { setAdding(undefined); setQuery(""); }, 150)}
                  onKeyDown={event => {
                    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setAdding(undefined); }
                    if (event.key === "Enter" && candidates[0]) { event.preventDefault(); setPlan(old => new Map(old).set(candidates[0]!.id, true)); setQuery(""); }
                  }} /></label>
                  {candidates.length > 0 && <span className="drawer-adder-list">{candidates.map(tag => <button key={tag.id} type="button" className="ds-option"
                    onMouseDown={event => event.preventDefault()} onClick={() => { setPlan(old => new Map(old).set(tag.id, true)); setQuery(""); }}>{sourceLabel(tag, catalog)}</button>)}</span>}
                </span>
              : <button type="button" className="ds-chip dashed" onClick={() => { setAdding(group); setQuery(""); }}><Plus size={11} />{groups[group]}</button>}
          </div>
        </section>;
      })}
      <section className="bulk-section g-performance">
        <div className="ds-section-title"><Mic size={12} />Исполнение</div>
        <Segmented label="Исполнение" value={perfState} onChange={value => setPerformance(value === "keep" ? undefined : { performance: value as Performance, voices: [] })}
          options={[{ value: "keep", label: "Не менять" }, { value: "unknown", label: "Не указано" }, { value: "ost", label: "Без вокала" }, { value: "vocal", label: "С вокалом" }]} />
      </section>
    </div>
    <div className="ds-pop-foot">
      <span className="bulk-foot-note">
        {error ? <span className="danger-text">{error}</span>
          : changes.length ? <>Изменится {records(changes.length)}{added.length ? <>: <span style={{ color: "var(--ok)" }}>+ {added.map(tag => tag.name).slice(0, 2).join(", ")}</span></> : null}{removed.length ? <> <span style={{ color: "var(--danger)" }}>− {removed.map(tag => tag.name).slice(0, 2).join(", ")}</span></> : null}</>
          : "Щёлкните тег, чтобы поставить его всем или снять"}
      </span>
      <span className="lib-grow" />
      {(plan.size > 0 || performance) && <button type="button" className="button compact subtle" onClick={() => { setPlan(new Map()); setPerformance(undefined); }}>Сбросить</button>}
      <button type="button" className="button compact primary" disabled={!changes.length || busy || !!error && !changes.length} onClick={() => void apply()}>
        {busy && <LoaderCircle size={14} className="spin" />}Применить
      </button>
    </div>
  </>;
}

