import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Check, ChevronRight, Disc3, FolderTree, Heart, Layers, Mic2, Search, Tags, X } from "lucide-react";
import type { LibrarySearch, TagDto } from "@hibiki/contracts";
import { groupKeys, groupOf, groups, normalize, TagCatalog, type TagGroup } from "./taxonomy";

const icons = { source: FolderTree, artist: Mic2, genre: Disc3, mood: Heart, extra: Tags };

export function TagNavigation({
  catalog,
  counts,
  search,
  onChange,
  userId,
  children,
  hasPlayer,
}: {
  catalog: TagCatalog;
  counts?: Record<string, number>;
  search: LibrarySearch;
  onChange: Dispatch<SetStateAction<LibrarySearch>>;
  userId: string;
  children: ReactNode;
  hasPlayer: boolean;
}) {
  const [flat, setFlat] = useState(false);
  const [openGroups, setOpenGroups] = useState(new Set<TagGroup>(["source"]));
  const [branches, setBranches] = useState(new Set<string>());
  const [queries, setQueries] = useState<Record<string, string>>({});
  const dialog = useRef<HTMLDialogElement>(null);
  const modeButton = useRef<HTMLButtonElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId(),
    dialogTitle = useId();
  const widthKey = "hibiki:tag-panel-width:" + userId;
  const [preferred, setPreferred] = useState<number | null>(() => {
    try {
      const n = Number(localStorage.getItem(widthKey));
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  const [space, setSpace] = useState(900);
  const [playerHeight, setPlayerHeight] = useState(0);
  useEffect(() => {
    const host = layout.current!;
    const bar = document.querySelector<HTMLElement>(".mini-player");
    const observer = new ResizeObserver(() => {
      setSpace(host.clientWidth);
      setPlayerHeight(bar?.getBoundingClientRect().height ?? 0);
    });
    observer.observe(host);
    if (bar) observer.observe(bar);
    return () => observer.disconnect();
  }, [hasPlayer]);
  const max = Math.max(144, Math.min(560, Math.floor((space - 16) * 0.56)));
  const min = Math.min(248, max);
  const width = Math.max(min, Math.min(max, preferred ?? 318));
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  function resize(n: number | null) {
    const value = n === null ? null : Math.max(min, Math.min(max, Math.round(n)));
    setPreferred(value);
    try {
      if (value === null) localStorage.removeItem(widthKey);
      else localStorage.setItem(widthKey, String(value));
    } catch {
      /* Preference remains in memory. */
    }
  }
  function toggleTag(id: string) {
    onChange((old) => ({
      ...old,
      tagIds: old.tagIds.includes(id) ? old.tagIds.filter((t) => t !== id) : [...old.tagIds, id],
    }));
  }
  function changeMode(flat: boolean) {
    setFlat(flat);
    scrollArea.current?.scrollTo(0, 0);
  }
  const chosen = search.tagIds;
  function chip(id: string, full = false) {
    const tag = catalog.byId.get(id);
    const label = tag?.name ?? "Прежний тег";
    const path = catalog.paths(id).join(" / ") || label;
    return (
      <button
        key={id}
        type="button"
        className="nav-chip"
        title={path}
        aria-label={"Снять " + path}
        onClick={() => {
          toggleTag(id);
          if (full && chosen.length === 1) dialog.current?.close();
          requestAnimationFrame(() => {
            if (full && dialog.current?.open)
              dialog.current.querySelector<HTMLButtonElement>(".nav-chip")?.focus();
            else
              (
                panel.current?.querySelector<HTMLButtonElement>(".nav-chips .nav-chip") ?? modeButton.current
              )?.focus({ preventScroll: true });
          });
        }}
      >
        <span>{full ? path : label}</span>
        <X size={12} />
      </button>
    );
  }
  function searchField(key: string, label: string) {
    return (
      <label className="nav-query">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          autoComplete="off"
          aria-label={label}
          placeholder={key === "flat" ? "Название или псевдоним" : "Поиск в разделе"}
          value={queries[key] ?? ""}
          onChange={(e) => setQueries({ ...queries, [key]: e.target.value })}
        />
      </label>
    );
  }
  function row(tag: TagDto, paths: boolean, query = "", ancestors: string[] = []): ReactNode {
    const branch = !paths && !!catalog.children.get(tag.id)?.length;
    const lineage = [...ancestors, tag.id],
      pathKey = lineage.join("/");
    const open = branches.has(pathKey);
    const selected = chosen.includes(tag.id);
    const alias =
      query && !normalize(tag.name).includes(normalize(query))
        ? tag.aliases?.find((a) => normalize(a).includes(normalize(query)))
        : undefined;
    return (
      <div key={tag.id} className="nav-node">
        <div className="nav-row">
          {branch ? (
            <button
              type="button"
              className="tree-arrow"
              aria-label={(open ? "Свернуть " : "Раскрыть ") + tag.name}
              aria-expanded={open}
              onClick={() => setBranches((old) => toggled(old, pathKey))}
            >
              <ChevronRight size={14} />
            </button>
          ) : (
            <span className="tree-arrow" />
          )}
          <button
            type="button"
            className="node-choice"
            aria-pressed={selected}
            onClick={() => toggleTag(tag.id)}
            title={catalog.paths(tag.id).join(" / ")}
          >
            <span className="node-check">{selected && <Check size={13} />}</span>
            <span className="node-name">
              {tag.name}
              {paths && (
                <small>
                  {catalog
                    .paths(tag.id)
                    .map((p) => (p.includes(" › ") ? p.slice(0, p.lastIndexOf(" › ")) : groups[groupOf(tag)]))
                    .join(" / ")}
                  {alias && " · " + alias}
                </small>
              )}
            </span>
            <span className="node-count">{counts ? (counts[tag.id] ?? 0) : "…"}</span>
          </button>
        </div>
        {branch && open && (
          <div className="nav-children">
            {catalog.children
              .get(tag.id)!
              .filter((t) => !lineage.includes(t.id))
              .map((child) => row(child, false, "", lineage))}
          </div>
        )}
      </div>
    );
  }
  function matches(key: TagGroup | "flat") {
    const query = queries[key] ?? "";
    const tree = key === "source" && !query.trim();
    const tags = tree
      ? (catalog.children.get("") ?? [])
      : catalog.find(query, key === "flat" ? undefined : key);
    return (
      <>
        {searchField(key, key === "flat" ? "Найти тег" : "Найти в разделе «" + groups[key] + "»")}
        {tags.length ? (
          tags.map((t) => row(t, key === "flat" || !!query.trim(), query))
        ) : (
          <p className="nav-empty">{query.trim() ? "Совпадений нет" : "Пока нет тегов"}</p>
        )}
      </>
    );
  }

  return (
    <div
      className="library-layout"
      ref={layout}
      style={{ "--nav-width": width + "px", "--player-space": playerHeight + "px" } as React.CSSProperties}
    >
      <div className="library-results-column">{children}</div>
      <aside id={panelId} className="tag-navigation" ref={panel} aria-label="Навигация по тегам">
        <div
          className="nav-resize"
          role="separator"
          tabIndex={0}
          aria-label="Ширина панели тегов"
          aria-orientation="vertical"
          aria-controls={panelId}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={width}
          aria-valuetext={width + " пикселей"}
          title="Потяните границу или нажмите стрелку. Enter возвращает исходную ширину."
          onDoubleClick={() => resize(null)}
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "Enter", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            if (e.key === "Enter") resize(null);
            else if (e.key === "Home" || e.key === "End") resize(e.key === "Home" ? min : max);
            else resize(width + (e.key === "ArrowLeft" ? 16 : -16));
          }}
          onPointerDown={(e) => {
            if (!e.isPrimary || e.button !== 0) return;
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { id: e.pointerId, x: e.clientX, width };
          }}
          onPointerMove={(e) => {
            if (drag.current?.id === e.pointerId) resize(drag.current.width + drag.current.x - e.clientX);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
        />
        <header className="tag-nav-header">
          <h2>
            <Layers size={19} />
            Навигация
          </h2>
          <div className="library-segmented nav-modes" role="group" aria-label="Режим навигации">
            <button type="button" ref={modeButton} aria-pressed={!flat} onClick={() => changeMode(false)}>
              По разделам
            </button>
            <button type="button" aria-pressed={flat} onClick={() => changeMode(true)}>
              Найти тег
            </button>
          </div>
          <div className="nav-logic">
            <span>Совпадение тегов</span>
            <div className="library-segmented" role="group" aria-label="Совпадение тегов">
              {(["and", "or"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={(search.tagMode ?? "and") === mode}
                  onClick={() => onChange((old) => ({ ...old, tagMode: mode }))}
                >
                  {mode === "and" ? "И" : "ИЛИ"}
                </button>
              ))}
            </div>
          </div>
          {(chosen.length > 0 || search.tagMode === "or") && (
            <>
              <div className="nav-selection">
                <span>Выбрано: {chosen.length}</span>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    onChange((old) => ({ ...old, tagIds: [], tagMode: "and" }));
                    modeButton.current?.focus();
                  }}
                >
                  Сбросить
                </button>
              </div>
              <div className="nav-chips">
                {chosen.slice(0, 3).map((id) => chip(id))}
                {chosen.length > 3 && (
                  <button
                    type="button"
                    className="text-button"
                    aria-haspopup="dialog"
                    onClick={() => dialog.current?.showModal()}
                  >
                    Ещё {chosen.length - 3}
                  </button>
                )}
              </div>
            </>
          )}
        </header>
        <div className="nav-catalog" ref={scrollArea}>
          {flat
            ? matches("flat")
            : groupKeys.map((key) => {
                const open = openGroups.has(key),
                  Icon = icons[key];
                return (
                  <section className="nav-group" key={key}>
                    <button
                      type="button"
                      className="nav-group-title"
                      aria-expanded={open}
                      onClick={() => setOpenGroups((old) => toggled(old, key))}
                    >
                      <Icon size={16} className={"group-" + key} />
                      {groups[key]}
                      <ChevronRight size={15} className="group-arrow" />
                    </button>
                    {open && <div className="nav-group-interior">{matches(key)}</div>}
                  </section>
                );
              })}
        </div>
        <dialog
          ref={dialog}
          className="modal selected-tags-dialog"
          aria-labelledby={dialogTitle}
          onClick={(e) => {
            if (e.target === e.currentTarget) dialog.current?.close();
          }}
        >
          <div className="modal-heading">
            <h2 id={dialogTitle}>Выбранные теги</h2>
            <button className="icon-button" aria-label="Закрыть" onClick={() => dialog.current?.close()}>
              <X size={18} />
            </button>
          </div>
          <div className="nav-chips">{chosen.map((id) => chip(id, true))}</div>
        </dialog>
      </aside>
    </div>
  );
}

function toggled<T>(previous: Set<T>, id: T) {
  const result = new Set(previous);
  if (result.has(id)) result.delete(id);
  else result.add(id);
  return result;
}
