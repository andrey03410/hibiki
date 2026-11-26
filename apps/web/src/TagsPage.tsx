import { Suspense, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocation } from "react-router";
import { ArrowDownWideNarrow, ChevronRight, Disc3, Ellipsis, FolderInput, FolderTree, Heart, Layers, Mic2, Plus, Search, Tags, X } from "lucide-react";
import type { TagDto } from "@hibiki/contracts";
import { TagCatalog, groupKeys, groups } from "./taxonomy";
import { directoryRows, type DirectoryRow, type DirectorySection, type DirectorySort, type DirectoryVisit } from "./tag-directory";
import { DeleteTag, TagEditor } from "./TagEditor";
import { TagRowMenu } from "./TagRowMenu";
import { Button, EmptyState, Modal, useData } from "./WorkspaceUi";
import { NotesLoadError, NoteIndicator, useNotes } from "./NoteEditor";
import { noteFor } from "./note-model";
import { useHasPlayer } from "./player";
import { lazyView } from "./ErrorBoundary";
import "./tag-directory.css";

const Migration = lazyView(() => import("./ClassificationMigration").then(m => ({ default: m.ClassificationMigration })));
const pageSize = 80;
const names = { all: "Все теги", ...groups };
const icons = { all: Layers, source: FolderTree, artist: Mic2, genre: Disc3, mood: Heart, extra: Tags };
const sections: DirectorySection[] = ["all", ...groupKeys];

type Dialog = { action: "edit" | "remove"; tag?: TagDto; key?: string; next?: string; previous?: string };

export default function TagsPage({ userId, visits, onBrowse }: {
  userId: string;
  visits: Map<string, DirectoryVisit>;
  onBrowse: (id: string) => void;
}) {
  const { key } = useLocation();
  const preference = "hibiki:tag-directory-sort:" + userId;
  const [initial] = useState<DirectoryVisit>(() => {
    const saved = visits.get(key);
    if (saved) return saved;
    let sort: DirectorySort = "count";
    try { if (localStorage.getItem(preference) === "name") sort = "name"; } catch { /* Keep the in-memory order. */ }
    return { section: "all", query: "", expanded: new Set(), sort, limit: pageSize, scroll: 0, focus: null };
  });
  const [section, setSection] = useState(initial.section);
  const [query, setQuery] = useState(initial.query);
  const [sort, setSort] = useState(initial.sort);
  const [expanded, setExpanded] = useState(initial.expanded);
  const [limit, setLimit] = useState(initial.limit);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ row: DirectoryRow; anchor: HTMLButtonElement } | null>(null);
  const [migration, setMigration] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const create = useRef<HTMLButtonElement>(null);
  const focusKey = useRef(initial.focus);
  const visit = useRef(initial);
  const restore = useRef<{ row?: string | null; id?: string; next?: string; previous?: string; top?: number } | null>(
    { row: initial.focus, top: initial.scroll });
  const { library, overview, refresh } = useData();
  const { notes } = useNotes();
  const hasPlayer = useHasPlayer();
  const shell = useRef<HTMLElement>(null);
  const catalog = useMemo(() => new TagCatalog(library.tags), [library.tags]);
  const rows = useMemo(() => directoryRows(catalog, overview.tagCounts, notes, section, query, sort, expanded),
    [catalog, overview.tagCounts, notes, section, query, sort, expanded]);
  const listId = useId();
  const countId = useId();
  useLayoutEffect(() => {
    visit.current = { section, query, sort, expanded, limit, scroll: visit.current.scroll, focus: focusKey.current };
  }, [section, query, sort, expanded, limit]);
  useLayoutEffect(() => {
    return () => { visits.set(key, { ...visit.current, focus: focusKey.current }); };
  }, [visits, key]);

  useLayoutEffect(() => {
    const bar = document.querySelector<HTMLElement>(".mini-player");
    if (!bar) { shell.current?.style.removeProperty("--directory-player"); return; }
    const measure = () => shell.current?.style.setProperty("--directory-player", bar.getBoundingClientRect().height + "px");
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [hasPlayer]);

  useLayoutEffect(() => {
    const pending = restore.current;
    const host = scroll.current;
    if (!pending || !host || dialog) return;
    const index = [pending.row, pending.id, pending.next, pending.previous].reduce((found, target, part) => {
      if (found >= 0 || !target) return found;
      return rows.findIndex(row => part === 1 ? row.tag.id === target : row.key === target);
    }, -1);
    if (index >= limit) {
      setLimit(Math.ceil((index + 1) / pageSize) * pageSize);
      return;
    }
    if (pending.top !== undefined) host.scrollTop = pending.top;
    if (index >= 0) {
      const button = host.querySelectorAll<HTMLButtonElement>(".directory-name")[index];
      button?.focus({ preventScroll: true });
      if (pending.top === undefined) button?.scrollIntoView({ block: "nearest" });
    } else if (pending.top === undefined || pending.row) create.current?.focus({ preventScroll: true });
    restore.current = null;
  }, [dialog, limit, rows]);



  function restartList() {
    setLimit(pageSize);
    scroll.current?.scrollTo(0, 0);
    focusKey.current = null;
    setMenu(null);
  }
  function selectSection(value: DirectorySection) {
    restartList();
    setSection(value);
  }
  function changeQuery(value: string) {
    restartList();
    setQuery(value);
  }
  function changeSort(value: DirectorySort) {
    restartList();
    setSort(value);
    try { localStorage.setItem(preference, value); } catch { /* Keep the in-memory order. */ }
  }
  function toggle(row: DirectoryRow) {
    setExpanded(old => {
      const next = new Set(old);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
  }
  function openDialog(action: "edit" | "remove", row: DirectoryRow) {
    const index = rows.indexOf(row);
    setDialog({ action, tag: row.tag, key: row.key, next: rows[index + 1]?.key, previous: rows[index - 1]?.key });
    setMenu(null);
  }
  function closeDialog(savedId?: string, deleted = false) {
    restore.current = { row: deleted ? null : dialog?.key, id: deleted ? undefined : savedId,
      next: dialog?.next, previous: dialog?.previous };
    setDialog(null);
  }
  function more() { setLimit(old => Math.min(rows.length, old + pageSize)); }

  return <section ref={shell} className="directory-page" aria-labelledby="tag-directory-title">
    <header className="directory-title">
      <h1 id="tag-directory-title">Теги</h1>
      <button type="button" className="icon-button" title="Перенос разметки" aria-label="Перенос разметки" onClick={() => setMigration(true)}><FolderInput size={18} /></button>
      <button type="button" className="button primary" ref={create} onClick={() => setDialog({ action: "edit" })}><Plus size={17} />Новый тег</button>
    </header>
    <div className="directory-panel">
      <nav className="directory-sections" aria-label="Разделы каталога">
        {sections.map(value => {
          const Icon = icons[value];
          return <button type="button" key={value} aria-current={section === value ? "true" : undefined}
            onClick={() => selectSection(value)}><Icon size={17} />{names[value]}</button>;
        })}
      </nav>
      <div className="directory-main">
        <div className="directory-section-heading"><h2>{names[section]}</h2>
          <select className="directory-mobile-sections" aria-label="Раздел каталога" value={section} onChange={e => selectSection(e.target.value as DirectorySection)}>
            {sections.map(value => <option key={value} value={value}>{names[value]}</option>)}
          </select>
        </div>
        <div className="directory-filters">
          <label className="directory-search"><Search size={16} />
            <input ref={search} type="search" aria-label="Поиск тегов" placeholder="Название или псевдоним" value={query}
              onChange={e => changeQuery(e.target.value)} />
            {query && <button type="button" aria-label="Очистить поиск" onClick={() => { changeQuery(""); search.current?.focus(); }}><X size={14} /></button>}
          </label>
          <label className="directory-sort"><ArrowDownWideNarrow size={16} />
            <select aria-label="Сортировка тегов" value={sort} onChange={e => changeSort(e.target.value as DirectorySort)}>
              <option value="count">По числу записей</option><option value="name">По алфавиту</option>
            </select>
          </label>
        </div>
        <NotesLoadError />
        <div className="directory-columns"><span>Название</span><span id={countId}>Записей</span></div>
        <div className="directory-scroll" ref={scroll} onScroll={e => {
          const area = e.currentTarget;
          visit.current.scroll = area.scrollTop;
          if (limit < rows.length && area.scrollHeight - area.clientHeight - area.scrollTop < 150) more();
        }}>
          {rows.length > 0 ? <ul className="directory-rows" id={listId} aria-label={"Теги раздела «" + names[section] + "»"}>
            {rows.slice(0, limit).map(row => {
              const { tag } = row;
              const count = overview.tagCounts[tag.id] ?? 0;
              return <li className="directory-row" key={row.key}
                style={{ "--depth": row.depth, "--tag-color": tag.color } as CSSProperties}>
                <div className="directory-node">
                  {row.branch ? <button type="button" className="directory-arrow" aria-expanded={row.expanded}
                    aria-label={(row.expanded ? "Свернуть " : "Раскрыть ") + tag.name}
                    onClick={() => toggle(row)}><ChevronRight size={16} /></button> : <span aria-hidden="true" className="directory-dot" />}
                  <button type="button" className="directory-name" title={[row.path, tag.name].filter(Boolean).join(" › ")}
                    aria-label={"Открыть записи с тегом " + tag.name}
                    aria-describedby={row.path ? listId + row.key : undefined}
                    onFocus={() => { focusKey.current = row.key; }}
                    onClick={() => { focusKey.current = row.key; onBrowse(tag.id); }}>
                    <span>{tag.name}{noteFor(notes, "tag", tag.id) && <NoteIndicator />}</span>
                    {row.path && <small id={listId + row.key}>{row.path}</small>}
                  </button>
                </div>
                <span className="directory-count" aria-describedby={countId}>{count}</span>
                <button type="button" className="directory-actions" aria-label={"Действия с тегом " + tag.name} aria-haspopup="menu"
                  aria-expanded={menu?.row.key === row.key}
                  onClick={e => setMenu(menu?.row.key === row.key ? null : { row, anchor: e.currentTarget })}><Ellipsis size={17} /></button>
              </li>;
            })}
          </ul> : <EmptyState icon={<Tags size={25} />} title={query.trim() ? "Тег не найден" : "Пока нет тегов"}
            text={query.trim() ? "Измените запрос или очистите поиск." : "Создайте первый тег в этом разделе."}
            action={query.trim() ? <Button className="subtle" onClick={() => { changeQuery(""); search.current?.focus(); }}>Очистить поиск</Button>
              : <Button className="primary" onClick={() => setDialog({ action: "edit" })}>Создать тег</Button>} />}
          {limit < rows.length && <button type="button" className="button subtle directory-more" aria-controls={listId} onClick={more}>Показать ещё</button>}
        </div>
      </div>
    </div>
    {menu && <TagRowMenu anchor={menu.anchor} name={menu.row.tag.name} close={() => setMenu(null)}
      edit={() => openDialog("edit", menu.row)} remove={() => openDialog("remove", menu.row)} />}
    {dialog?.action === "edit" && <TagEditor tag={dialog.tag} section={section === "all" ? "extra" : section} catalog={catalog} close={closeDialog} />}
    {dialog?.action === "remove" && dialog.tag && <DeleteTag tag={dialog.tag} close={deleted => closeDialog(undefined, deleted)} />}
    {migration && <Modal title="Перенос разметки" close={() => setMigration(false)}>
      <Suspense fallback={<p role="status">Загружаем настройки классификации…</p>}><Migration reload={refresh} initiallyOpen /></Suspense>
    </Modal>}
  </section>;
}
