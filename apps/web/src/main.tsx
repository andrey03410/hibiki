import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useContext,
  createContext,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  NavLink,
  Routes,
  Route,
  Link,
  useNavigate,
  useParams,
} from "react-router";
import {
  AudioLines,
  Headphones,
  Library,
  ListMusic,
  Tags,
  Download,
  Settings2,
  Plus,
  Search,
  ArrowUpRight,
  Play,
  Pause,
  Music2,
  Video,
  HardDrive,
  Youtube,
  MoreHorizontal,
  X,
  Check,
  ChevronRight,
  ArrowLeft,
  Upload,
  Link2,
  LoaderCircle,
  CircleAlert,
  Trash2,
  Pencil,
  LogOut,
  KeyRound,
  Copy,
  ExternalLink,
  Clock3,
  FolderOpen,
  Sparkles,
  CheckCircle2,
  Minus,
  ListPlus,
  RefreshCw,
  Heart,
} from "lucide-react";
import type {
  ItemDto,
  LibraryDto,
  PlaylistDto,
  Rule,
  PlaylistDefinition,
  ResolvedPlaylist,
  TagDto,
  UserDto,
} from "@hibiki/contracts";
import { api, formatDuration, humanDuration, mediaWord } from "./api.ts";
import { PlayerProvider, usePlayer } from "./player.tsx";
import { playbackSources, soundUnavailableReason } from "./player-model.ts";
import { librarySourceBadges, matchesSearch, searchLibrary, selectLibraryResults, sourceAvailability, type LibraryView } from "./library-search.ts";
import { LibrarySearchControls, useLibrarySearch } from "./LibrarySearchControls.tsx";
import { NoteEditor, NoteIndicator, NotesContext, NotesLoadError, useNotes, useNotesController } from "./NoteEditor.tsx";
import { noteFor } from "./note-model.ts";
import { SourceReplacement } from "./SourceReplacement.tsx";
import { YoutubeLinkedPlaylist, YoutubeLinkImport, YoutubeSyncNotifications, YoutubeSyncSettings } from "./YoutubeSync.tsx";
import { HistorySettings } from "./HistorySettings.tsx";
import { useHistoryRevision } from "./history-events.ts";
import type { HistoryPreference } from "./listening-client.ts";
import "./styles.css";
import "./library-view.css";

const EMPTY: LibraryDto = { items: [], tags: [], playlists: [], jobs: [] };
type Toast = { id: number; text: string; error?: boolean };
const DataContext = createContext<{
  library: LibraryDto;
  refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
  openImport: () => void;
}>({
  library: EMPTY,
  refresh: async () => {},
  notify: () => {},
  openImport: () => {},
});
const useData = () => useContext(DataContext);
function Button({
  children,
  busy,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`button ${className}`}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
    </button>
  );
}
function ErrorMessage({ error }: { error?: string }) {
  return error ? (
    <div className="error-box" role="alert">
      <CircleAlert size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}
function Modal({
  title,
  subtitle,
  children,
  close,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="modal-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" aria-label="Закрыть" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Cover({
  title,
  items = [],
  large = false,
  className = "",
}: {
  title: string;
  items?: ItemDto[];
  large?: boolean;
  className?: string;
}) {
  const seed = [...title].reduce((sum, c) => sum + c.charCodeAt(0), 0),
    thumbnail = items
      .flatMap((i) => i.sources)
      .find((s) => s.thumbnail)?.thumbnail;
  return (
    <div
      className={`cover art-${seed % 6} ${large ? "large" : ""} ${className}`}
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" loading="lazy" />
      ) : (
        <>
          <span className="cover-orbit" />
          <span className="cover-orbit second" />
          <span className="cover-mark">響</span>
        </>
      )}
      <div className="cover-grain" />
    </div>
  );
}
function TagPill({ tag, onClick }: { tag: TagDto; onClick?: () => void }) {
  return (
    <button
      type="button"
      className="tag-pill"
      style={{ "--tag": tag.color || "#aaa" } as any}
      onClick={onClick}
      disabled={!onClick}
    >
      <span />
      {tag.name}
    </button>
  );
}
function EmptyState({
  title,
  text,
  action,
  icon = <Music2 size={29} />,
}: {
  title: string;
  text: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

function Auth({
  setup,
  onLogin,
}: {
  setup: boolean;
  onLogin: (user: UserDto) => void;
}) {
  const [register, setRegister] = useState(setup),
    [login, setLogin] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await api(
        "/auth/" + (register ? "register" : "login"),
        "POST",
        { login, password },
      );
      onLogin(result.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-screen">
      <section className="auth-art">
        <Link className="brand" to="/">
          <span className="brand-icon">
            <AudioLines size={25} />
          </span>
          <span>
            hibiki<span className="brand-kanji">響</span>
          </span>
        </Link>
        <div className="auth-art-center">
          <span className="auth-kanji">響</span>
          <span className="eyebrow">ВАШЕ ПРОСТРАНСТВО ЗВУКА</span>
          <h1>
            То, что хочется
            <br />
            слышать снова.
          </h1>
          <p>
            Музыка, видео и ваши собственные связи между ними.
            <br />
            Одна библиотека. Ваш ритм.
          </p>
        </div>
        <span className="auth-foot">Собрано вами. Звучит по-вашему.</span>
      </section>
      <section className="auth-form">
        <div className="auth-form-inner">
          <span className="eyebrow">ДОБРО ПОЖАЛОВАТЬ В HIBIKI</span>
          <h2>{register ? "Место для вашей музыки" : "С возвращением"}</h2>
          <p className="muted">
            {register
              ? "Создайте личную медиатеку на этом устройстве."
              : "Войдите, чтобы продолжить с того же места."}
          </p>
          <form onSubmit={submit}>
            <label>
              Логин
              <input
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="3–40 латинских букв, цифр, _ или -"
                minLength={3}
                maxLength={40}
                pattern="[a-zA-Z0-9_-]{3,40}"
                required
                autoFocus
              />
            </label>
            <label>
              Пароль
              <input
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={10}
                maxLength={200}
                placeholder="Не менее 10 символов"
                required
              />
            </label>
            <ErrorMessage error={error} />
            <Button type="submit" className="primary full" busy={busy}>
              {register ? "Создать медиатеку" : "Войти"}
              <ArrowUpRight size={17} />
            </Button>
          </form>
          <p className="auth-switch">
            {register ? "Уже есть аккаунт?" : "Первый раз здесь?"}{" "}
            <button
              onClick={() => {
                setRegister(!register);
                setError("");
              }}
            >
              {register ? "Войти" : "Создать аккаунт"}
            </button>
          </p>
          <div className="auth-privacy">
            <HardDrive size={16} />
            <span>
              Личная библиотека в вашей локальной установке.
              <br />
              Файлы и настройки остаются у вас.
            </span>
          </div>
        </div>
      </section>
    </main>
  );
}

function App() {
  const [user, setUser] = useState<UserDto | null>(null),
    [setup, setSetup] = useState(false),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  async function check() {
    setLoading(true);
    try {
      const data = await api("/me");
      setUser(data.user);
      setSetup(data.setupRequired);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void check();
  }, []);
  if (loading)
    return (
      <div className="boot">
        <AudioLines size={40} />
        <span>hibiki</span>
        <LoaderCircle className="spin" size={22} />
      </div>
    );
  if (loadError)
    return (
      <div className="boot">
        <AudioLines size={40} />
        <h2>Не удалось подключиться к Hibiki</h2>
        <p>{loadError}</p>
        <Button onClick={check}>Попробовать снова</Button>
      </div>
    );
  return user ? (
    <Workspace
      key={user.id}
      user={user}
      logout={async () => {
        await api("/auth/logout", "POST");
        setUser(null);
      }}
    />
  ) : (
    <Auth setup={setup} onLogin={setUser} />
  );
}
function Workspace({
  user,
  logout,
}: {
  user: UserDto;
  logout: () => Promise<void>;
}) {
  const [library, setLibrary] = useState<LibraryDto>(EMPTY),
    [settings, setSettings] = useState<any>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [toasts, setToasts] = useState<Toast[]>([]),
    [importOpen, setImportOpen] = useState(false),
    [createOpen, setCreateOpen] = useState(false),
    [importSettingsLoading, setImportSettingsLoading] = useState(false),
    [playlistQuery, setPlaylistQuery] = useState(""),
    [tagQuery, setTagQuery] = useState("");
  const notes = useNotesController();
  const librarySearch = useLibrarySearch(user.id);
  const seenImports = useRef<Set<string> | null>(null);
  const navigate = useNavigate();
  function notify(text: string, error = false) {
    const id = Date.now() + Math.random();
    setToasts((old) => [...old, { id, text, error }]);
    setTimeout(() => setToasts((old) => old.filter((t) => t.id !== id)), 6000);
  }
  async function refresh() {
    const result = await api<LibraryDto>("/library");
    setLibrary(result);
  }
  async function load() {
    try {
      const [data, preferences] = await Promise.all([
        api<LibraryDto>("/library"),
        api("/settings"),
      ]);
      setLibrary(data);
      setSettings(preferences);
      setReady(true);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const interval = setInterval(() => {
      void refresh().catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const completed = library.jobs.filter(
      (job) =>
        job.kind === "import" &&
        job.state === "done" &&
        (job.result as any)?.added !== undefined &&
        !(job.result as any)?.preview,
    );
    if (!seenImports.current) {
      seenImports.current = new Set(completed.map((job) => job.id));
      return;
    }
    const newlyCompleted = completed.filter(
      (job) => !seenImports.current!.has(job.id),
    );
    if (!newlyCompleted.length) return;
    newlyCompleted.forEach((job) => seenImports.current!.add(job.id));
    void notes.reload();
    setImportSettingsLoading(true);
    api("/settings")
      .then((preferences) => {
        setSettings(preferences);
        notify(
          "Импорт завершён. Очередь и настройки восстановлены. Нажмите «Воспроизвести», чтобы продолжить.",
        );
      })
      .catch((e) => notify(e.message, true))
      .finally(() => setImportSettingsLoading(false));
  }, [ready, library.jobs]);
  if (!ready)
    return (
      <div className="boot">
        <AudioLines size={38} />
        {error ? (
          <>
            <ErrorMessage error={error} />
            <Button onClick={load}>Повторить</Button>
          </>
        ) : (
          <LoaderCircle size={20} className="spin" />
        )}
      </div>
    );
  const activeJobs = library.jobs.filter(
    (j) => j.state === "running" || j.state === "queued",
  ).length;
  return (
    <NotesContext.Provider value={notes}>
    <DataContext.Provider
      value={{
        library,
        refresh,
        notify,
        openImport: () => setImportOpen(true),
      }}
    >
      <PlayerProvider
        items={library.items}
        initialSettings={settings}
        userId={user.id}
        onPlaylistSaved={() => { void refresh().catch((e) => notify(e.message, true)); }}
        suspendSaving={
          importSettingsLoading ||
          library.jobs.some(
            (j) =>
              (j.kind === "import" &&
                (j.state === "queued" || j.state === "running")) ||
              (j.kind === "import" &&
                j.state === "done" &&
                (j.result as any)?.added !== undefined &&
                !!seenImports.current &&
                !seenImports.current.has(j.id)),
          )
        }
      >
        {(watchPlayer, miniPlayer) => <>
        <div className="app-shell">
          <aside className="sidebar">
            <Link className="brand" to="/">
              <span className="brand-icon">
                <AudioLines size={25} />
              </span>
              <span>
                hibiki<span className="brand-kanji">響</span>
              </span>
            </Link>
            <span className="sidebar-label">ВАШЕ ПРОСТРАНСТВО</span>
            <nav className="main-nav">
              <NavLink to="/" end>
                <Library size={19} />
                <span>Медиатека</span>
                <span className="nav-count">{library.items.length}</span>
              </NavLink>
              <NavLink to="/player" aria-label="Плеер">
                <AudioLines size={19} />
                <span>Плеер</span>
              </NavLink>
              <NavLink to="/playlists">
                <ListMusic size={19} />
                <span>Плейлисты</span>
              </NavLink>
              <NavLink to="/tags">
                <Tags size={19} />
                <span>Теги</span>
              </NavLink>
              <NavLink to="/jobs">
                <Download size={19} />
                <span>Задания</span>
                {activeJobs > 0 && (
                  <span className="job-count">{activeJobs}</span>
                )}
              </NavLink>
            </nav>
            <div className="sidebar-section">
              <span className="sidebar-label">ПЛЕЙЛИСТЫ</span>
              <button
                className="icon-button"
                aria-label="Создать плейлист"
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={16} />
              </button>
            </div>
            <nav className="playlist-nav">
              {library.playlists.slice(0, 12).map((p, index) => (
                <NavLink key={p.id} to={`/playlists/${p.id}`}>
                  <span className={`playlist-dot dot-${index % 5}`} />
                  <span className="truncate">{p.title}</span>
                  {p.definition.rule.type !== "items" && <Sparkles size={12} />}
                </NavLink>
              ))}
              {!library.playlists.length && (
                <p className="sidebar-hint">
                  Здесь будут подборки,
                  <br />
                  собранные вами.
                </p>
              )}
            </nav>
            <div className="sidebar-bottom">
              <YoutubeSyncNotifications reload={refresh} />
              <div className="local-card">
                <span className="online-dot" />
                <span>
                  Личная медиатека<small>Хранится на вашем сервере</small>
                </span>
                <HardDrive size={17} />
              </div>
              <NavLink className="settings-link" to="/settings">
                <Settings2 size={18} />
                Настройки
                <ChevronRight size={15} />
              </NavLink>
              <div className="user-card">
                <span className="avatar">
                  {user.login.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{user.login}</strong>
                  <small>Ваш личный аккаунт</small>
                </div>
                <button
                  className="icon-button"
                  aria-label="Выйти"
                  onClick={() => logout().catch((e) => notify(e.message, true))}
                >
                  <LogOut size={17} />
                </button>
              </div>
            </div>
          </aside>
          <main className="main-content">
            <div id="browse-content" className="browse-content">
            <Routes>
              <Route path="/player" element={watchPlayer} />
              <Route path="/" element={<LibraryPage userId={user.id} search={librarySearch} />} />
              <Route
                path="/playlists"
                element={<PlaylistsPage query={playlistQuery} onQuery={setPlaylistQuery} onCreate={() => setCreateOpen(true)} />}
              />
              <Route path="/playlists/:id" element={<PlaylistPage />} />
              <Route path="/tags" element={<TagsPage query={tagQuery} onQuery={setTagQuery} />} />
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/settings" element={<SettingsPage user={user} />} />
              <Route
                path="*"
                element={
                  <EmptyState
                    title="Страница не найдена"
                    text="Загляните в медиатеку — ваши записи ждут вас."
                    action={
                      <Link className="button primary" to="/">
                        В медиатеку
                      </Link>
                    }
                  />
                }
              />
            </Routes>
            </div>
            <footer className="page-footer">
              <span>響き · Звучание, которое остаётся</span>
              <span>HIBIKI · ВАША ЛИЧНАЯ МЕДИАТЕКА</span>
            </footer>
            {miniPlayer}
          </main>
        </div>
        {importOpen && <ImportModal close={() => setImportOpen(false)} />}{" "}
        {createOpen && (
          <PlaylistEditor
            close={() => setCreateOpen(false)}
            onSaved={(p) => {
              setCreateOpen(false);
              navigate(`/playlists/${p.id}`);
            }}
          />
        )}
        <div className="toast-stack" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.error ? "error" : ""}`}>
              {t.error ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}
              <span>{t.text}</span>
              <button
                className="icon-button"
                aria-label="Закрыть уведомление"
                onClick={() =>
                  setToasts((old) => old.filter((x) => x.id !== t.id))
                }
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
        </>}
      </PlayerProvider>
    </DataContext.Provider>
    </NotesContext.Provider>
  );
}
function PageTop({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="page-top">
      <div className="breadcrumb">
        <span>Ваше пространство</span>
        <ChevronRight size={13} />
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}
function LibraryPage({ userId, search }: { userId: string; search: ReturnType<typeof useLibrarySearch> }) {
  const { library, openImport } = useData(),
    player = usePlayer();
  const [filters, setFilters] = search;
  const { notes } = useNotes();
  const [selected, setSelected] = useState<string[]>([]),
    [playlistOpen, setPlaylistOpen] = useState(false),
    [batchOpen, setBatchOpen] = useState(false);
  const viewKey = `hibiki:library-view:${userId}`;
  const [view, setView] = useState<LibraryView>(() => {
    try {
      return localStorage.getItem(viewKey) === "cards" ? "cards" : "list";
    } catch {
      return "list";
    }
  });
  const items = useMemo(() => searchLibrary(library.items, filters, notes), [library.items, filters, notes]);

  function changeView(next: LibraryView) {
    setView(next);
    try {
      localStorage.setItem(viewKey, next);
    } catch {
      // The current view still works when browser storage is unavailable.
    }
  }

  return (
    <>
      <div className="title-row library-title-row">
        <h1>Медиатека</h1>
        <Button className="primary" onClick={openImport}>
          <Plus size={17} />
          Добавить медиа
        </Button>
      </div>
      <section className="library-section">
        <LibrarySearchControls
          value={filters}
          onChange={setFilters}
          tags={library.tags}
          count={items.length}
          view={view}
          onViewChange={changeView}
          onPlay={(mode) => player.start(items, 0, undefined, { mode, fromLibrary: true })}
        />
        <NotesLoadError />
        {selected.length > 0 && (
          <div className="selection-toolbar">
            <strong>Выбрано: {selected.length}</strong>
            <Button
              className="subtle compact"
              onClick={() => setPlaylistOpen(true)}
            >
              <ListPlus size={15} />
              Создать плейлист
            </Button>
            <Button
              className="subtle compact"
              onClick={() => setBatchOpen(true)}
            >
              <Tags size={15} />
              Изменить теги
            </Button>
            <button className="text-button" onClick={() => setSelected([])}>
              Снять выбор
            </button>
          </div>
        )}
        <ItemTable
          items={items}
          view={view}
          selected={selected}
          onSelected={setSelected}
          onTag={(id) => setFilters((old) => (
            old.tagIds.includes(id) ? old : { ...old, tagIds: [...old.tagIds, id] }
          ))}
        />
        {!items.length && (
          <EmptyState
            title={
              library.items.length
                ? "Ничего не найдено"
                : "Начнём вашу коллекцию"
            }
            text={
              library.items.length
                ? "Измените условия поиска или сбросьте фильтры."
                : "Загрузите любимые аудио и видео или добавьте ссылку с YouTube."
            }
            action={
              !library.items.length && (
                <Button className="primary" onClick={openImport}>
                  <Plus size={16} />
                  Добавить медиа
                </Button>
              )
            }
          />
        )}
      </section>
      {playlistOpen && (
        <PlaylistEditor
          initialIds={selected}
          close={() => setPlaylistOpen(false)}
          onSaved={() => {
            setPlaylistOpen(false);
            setSelected([]);
          }}
        />
      )}{" "}
      {batchOpen && (
        <BatchTags ids={selected} close={() => setBatchOpen(false)} />
      )}
    </>
  );
}
function ItemArtwork({ thumbnail, kind }: { thumbnail?: string; kind: ItemDto["kind"] }) {
  const [failed, setFailed] = useState(false);
  if (thumbnail && !failed) return <img src={thumbnail} alt="" loading="lazy" onError={() => setFailed(true)} />;
  return kind === "video" ? <Video size={19} /> : <Music2 size={19} />;
}

function ItemTable({
  items,
  reasons,
  selected,
  onSelected,
  onTag,
  reorder,
  playlistId,
  view,
}: {
  items: ItemDto[];
  reasons?: Record<string, string[]>;
  selected?: string[];
  onSelected?: (ids: string[]) => void;
  onTag?: (id: string) => void;
  reorder?: (id: string, direction: number) => void;
  playlistId?: string;
  view?: LibraryView;
}) {
  const player = usePlayer(),
    { library, refresh, notify } = useData();
  const { notes } = useNotes();
  const [editTarget, setEditTarget] = useState<{ id: string; focusSource?: boolean }>(),
    [remove, setRemove] = useState<ItemDto | null>(null),
    [busy, setBusy] = useState(false);
  const currentItems = useMemo(() => new Map(library.items.map((item) => [item.id, item])), [library.items]);
  const edit = editTarget ? currentItems.get(editTarget.id) : undefined;
  const inLibrary = view !== undefined;
  const selectedIds = new Set(selected);
  const selectedCount = selected ? items.filter((item) => selectedIds.has(item.id)).length : 0;
  const selectAll = selected && (
    <input
      type="checkbox"
      aria-label="Выбрать все найденные записи"
      checked={items.length > 0 && selectedCount === items.length}
      ref={(input) => {
        if (input) input.indeterminate = selectedCount > 0 && selectedCount < items.length;
      }}
      onChange={(event) => onSelected?.(selectLibraryResults(selected, items, event.target.checked))}
    />
  );

  async function job(kind: string, itemId: string, mode?: string) {
    try {
      await api("/jobs", "POST", { kind, input: { itemId, mode } });
      notify("Задание добавлено в очередь");
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  const results = items.map((item, index) => {
    const local = item.sources.some((source) => source.provider === "local" && source.status === "available"),
      hasLocal = item.sources.some((source) => source.provider === "local"),
      yt = item.sources.some((source) => source.provider === "youtube"),
      streamUrl = item.sources.find((source) => source.streamUrl)?.streamUrl,
      externalUrl = item.sources.find((source) => source.url)?.url,
      thumbnail = item.sources.find((source) => source.thumbnail)?.thumbnail,
      available = playbackSources(item).length > 0,
      active = player.current?.id === item.id,
      canToggle = active && (!playlistId || player.settings.queuePlaylistIds?.[item.id] === playlistId),
      canResumeVideo = canToggle && player.waitingForVideo,
      status = sourceAvailability(item),
      hasItemNote = !!noteFor(notes, "item", item.id),
      hasSourceNote = item.sources.some((source) => noteFor(notes, "source", source.id)),
      kindLabel = item.kind === "video" ? "Видео" : "Аудио",
      playLabel = item.kind === "video" ? "Смотреть" : "Воспроизвести";

    const artClass = `item-art art-${index % 6}`;
    const art = <ItemArtwork key={thumbnail} thumbnail={thumbnail} kind={item.kind} />;
    const itemTitle = (
      <>
        <button className="item-title" onClick={() => setEditTarget({ id: item.id })}>{item.title}</button>
        {(hasItemNote || hasSourceNote) && (
          <NoteIndicator label={hasItemNote ? "Есть заметка у записи" : "Есть заметка у источника"} />
        )}
      </>
    );
    const favorite = <FavoriteButton item={currentItems.get(item.id) ?? item} />;
    const selection = selected && (
      <input
        type="checkbox"
        aria-label={`Выбрать ${item.title}`}
        checked={selectedIds.has(item.id)}
        onChange={(event) => onSelected?.(
          event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id),
        )}
      />
    );
    const duration = (
      <span className="item-duration" title={item.duration === null ? "Длительность неизвестна" : undefined}>
        {formatDuration(item.duration)}
      </span>
    );

    const soundReason = inLibrary && item.kind === "video" ? soundUnavailableReason(item) : undefined;
    const soundReasonId = `library-sound-reason-${encodeURIComponent(item.id)}`;
    const playActions = inLibrary && (
      <div className="library-item-playback">
        <button
          className="library-item-play"
          type="button"
          aria-label={`${playLabel} ${item.title}`}
          disabled={!available}
          title={available ? undefined : "Нет рабочего источника"}
          onClick={() => player.start(items, index, undefined, { fromLibrary: true })}
        >
          <Play size={13} fill="currentColor" /> {playLabel}
        </button>
        {item.kind === "video" && (
          <div className="library-listen-action">
            <button
              className="library-item-play"
              type="button"
              aria-label={`Слушать ${item.title}`}
              aria-disabled={soundReason ? true : undefined}
              aria-describedby={soundReason ? soundReasonId : undefined}
              onClick={() => {
                if (soundReason) {
                  notify(soundReason, true);
                  return;
                }
                player.start(items, index, undefined, { fromLibrary: true, mode: "audio" });
              }}
            >
              <Headphones size={14} /> Слушать
            </button>
            {soundReason && <span className="library-sound-reason" id={soundReasonId} role="tooltip">{soundReason}</span>}
          </div>
        )}
      </div>
    );
    const menu = (
      <details className="row-menu" name={inLibrary ? "library-item-actions" : undefined}
        onKeyDown={(event) => {
          if (!inLibrary || event.key !== "Escape" || !event.currentTarget.open) return;
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }}
      >
        <summary aria-label={`Действия с ${item.title}`}>
          <MoreHorizontal size={19} />
        </summary>
        <div className="dropdown" onClick={(event) => {
          if (inLibrary && event.target instanceof Element && event.target.closest("button:not(:disabled), a")) {
            const details = event.currentTarget.parentElement;
            if (details instanceof HTMLDetailsElement) details.open = false;
          }
        }}>
          <button onClick={() => setEditTarget({ id: item.id })}>
            <Pencil size={14} />
            Детали записи
          </button>
          {status === "unavailable" && (
            <button onClick={() => setEditTarget({ id: item.id, focusSource: true })}>
              <RefreshCw size={14} />
              Заменить источник
            </button>
          )}
          <button
            disabled={active}
            onClick={() => {
              player.playNext(item, playlistId);
              notify("Запись будет играть следующей");
            }}
          >
            <ListPlus size={14} />
            Играть следующей
          </button>
          <button
            onClick={() => {
              player.enqueue(item, playlistId);
              notify("Добавлено в очередь");
            }}
          >
            <ListPlus size={14} />
            Добавить в очередь
          </button>
          {reorder && (
            <>
              <button disabled={index === 0} onClick={() => reorder(item.id, -1)}>
                ↑ Переместить выше
              </button>
              <button disabled={index === items.length - 1} onClick={() => reorder(item.id, 1)}>
                ↓ Переместить ниже
              </button>
            </>
          )}
          {yt && (
            <>
              <button onClick={() => job("youtube-download", item.id, "audio")}>
                <Download size={14} />
                Скачать аудио
              </button>
              <button onClick={() => job("youtube-download", item.id, "video")}>
                <Video size={14} />
                Скачать видео
              </button>
              <button onClick={() => job("youtube-refresh", item.id)}>
                <RefreshCw size={14} />
                Проверить источник
              </button>
            </>
          )}
          {streamUrl && (
            <a href={streamUrl} download={item.title}>
              <Download size={14} />
              Сохранить файл
            </a>
          )}
          {externalUrl && (
            <a href={externalUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} />
              Открыть источник
            </a>
          )}
          <button className="danger-text" onClick={() => setRemove(item)}>
            <Trash2 size={14} />
            Удалить из медиатеки
          </button>
        </div>
      </details>
    );

    if (view === "cards") {
      return (
        <article className={`library-item-card ${active ? "current" : ""}`} key={item.id} aria-current={active || undefined}>
          <div className="library-card-main">
            {selection}
            <span className={artClass} aria-hidden="true">{art}</span>
            <div className="library-card-description">
              <div className="item-name-actions">{itemTitle}</div>
              <div className="library-card-meta">
                <span className="item-subtitle">{kindLabel} · {duration}</span>
                <span className="library-card-sources" role="group" aria-label="Источники">
                  {librarySourceBadges(item).map(({ provider, status, label }) => {
                    const Icon = provider === "youtube" ? Youtube : provider === "local" ? HardDrive : CircleAlert;
                    return (
                      <span key={provider} className="library-card-source" data-provider={provider} data-status={status}
                        role="img" aria-label={label} title={label}>
                        <Icon size={14} aria-hidden="true" />
                      </span>
                    );
                  })}
                </span>
              </div>
              {!available && <span className="item-subtitle">Нет рабочего источника</span>}
            </div>
          </div>
          <div className="library-card-footer">
            {playActions}
            <div className="library-card-tools">{favorite}{menu}</div>
          </div>
        </article>
      );
    }

    return (
      <div
        className={`item-row ${selected ? "selectable" : ""} ${active ? "current" : ""} ${!available ? "unavailable" : ""}`}
        key={item.id}
        aria-current={(inLibrary && active) || undefined}
      >
        {selection ?? <span className="row-number">{index + 1}</span>}
        <div className="item-title-cell">
          {inLibrary ? <span className={artClass} aria-hidden="true">{art}</span> : (
            <button
              className={artClass}
              aria-label={`${canResumeVideo ? "Смотреть" : canToggle && player.playing ? "Приостановить" : "Воспроизвести"} ${item.title}`}
              onClick={() => {
                if (canResumeVideo) player.watchCurrent();
                else if (canToggle) player.toggle();
                else player.start(items, index, playlistId);
              }}
            >
              {art}
              <span className="art-play">
                {canToggle && player.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
              </span>
            </button>
          )}
          <div className="truncate">
            <div className="item-name-actions">{itemTitle}{favorite}</div>
            <span className="item-subtitle">
              {kindLabel}
              {item.originalTitle !== item.title
                ? ` · ${item.originalTitle}`
                : local ? " · Локальная коллекция" : yt ? " · YouTube" : ""}
              {status === "unavailable" && " · Нет рабочего источника"}
              {status === "unknown" && " · Доступность не проверена"}
            </span>
            {reasons?.[item.id] && (
              <details className="reason-details">
                <summary>Почему в плейлисте</summary>
                <p>{reasons[item.id]!.join(" · ")}</p>
              </details>
            )}
          </div>
        </div>
        <div className="item-tags">
          {item.tags.slice(0, 2).map((tag) => (
            <TagPill key={tag.id} tag={tag} onClick={onTag ? () => onTag(tag.id) : undefined} />
          ))}
          {item.tags.length > 2 && <span className="small muted">+{item.tags.length - 2}</span>}
        </div>
        <span className={`source-badge ${!available ? "missing" : ""}`}>
          {hasLocal ? <HardDrive size={13} /> : yt ? <Youtube size={14} /> : <CircleAlert size={13} />}
          <span>
            {local ? "На устройстве" : hasLocal ? "Есть локальная копия" : yt ? "YouTube" : "Нет источника"}
          </span>
        </span>
        {duration}
        {playActions}
        {menu}
      </div>
    );
  });

  return (
    <>
      {view === "cards" ? (
        items.length > 0 && (
          <>
            <label className="library-card-select-all">{selectAll} Выбрать все найденные записи</label>
            <div className="library-card-grid">{results}</div>
          </>
        )
      ) : (
        (!inLibrary || items.length > 0) && (
          <div className={`item-table ${inLibrary ? "library-item-table" : ""}`}>
            <div className={`table-heading ${selected ? "selectable" : ""}`}>
              {selectAll ?? <span>#</span>}
              <span>НАЗВАНИЕ</span>
              <span>ТЕГИ</span>
              <span>ИСТОЧНИК</span>
              <Clock3 size={14} />
              {inLibrary && <span className="library-playback-heading" />}
              <span />
            </div>
            {results}
          </div>
        )
      )}
      {edit && (
        <EditItem
          key={edit.id}
          item={edit}
          focusSource={editTarget?.focusSource}
          close={() => setEditTarget(undefined)}
        />
      )}
      {remove && (
        <Modal
          title="Удалить запись?"
          subtitle={`«${remove.title}» будет удалена из вашей медиатеки и ручных списков.`}
          close={() => setRemove(null)}
        >
          <div className="modal-actions">
            <Button className="subtle" onClick={() => setRemove(null)}>
              Отмена
            </Button>
            <Button
              className="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/items/${remove.id}`, "DELETE");
                  await refresh();
                  notify("Запись удалена");
                  setRemove(null);
                } catch (e) {
                  notify((e as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Удалить
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function FavoriteButton({ item, withLabel = false }: { item: ItemDto; withLabel?: boolean }) {
  const { refresh, notify } = useData();
  const [busy, setBusy] = useState(false);
  const label = item.favorite ? "Убрать из избранного" : "Добавить в избранное";
  return (
    <button
      type="button"
      className={withLabel ? "button subtle compact favorite-button" : "icon-button favorite-button"}
      title={label}
      aria-label={`${label} · ${item.title}`}
      aria-pressed={!!item.favorite}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/items/${encodeURIComponent(item.id)}/favorite`, "PATCH", { favorite: !item.favorite });
          await refresh();
        } catch (e) {
          notify((e as Error).message, true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Heart size={15} fill={item.favorite ? "currentColor" : "none"} />
      {withLabel && label}
    </button>
  );
}
function EditItem({ item, close, focusSource }: { item: ItemDto; close: () => void; focusSource?: boolean }) {
  const { library, refresh, notify } = useData(),
    [title, setTitle] = useState(item.title),
    [tagIds, setTagIds] = useState(item.tags.map((t) => t.id)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const replacement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusSource) return;
    const frame = requestAnimationFrame(() => {
      replacement.current?.scrollIntoView({ block: "start" });
      replacement.current?.querySelector("input")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSource]);
  return (
    <Modal
      title="Детали записи"
      subtitle="Ваше название сохраняется, даже если источник исчезнет."
      close={close}
    >
      <FavoriteButton item={item} withLabel />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`/items/${item.id}`, "PATCH", { title, tagIds });
            await refresh();
            notify("Запись обновлена");
            close();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Название
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={1000}
            required
          />
        </label>
        <p className="small muted">
          Название источника: {item.originalTitle || "Неизвестно"}
        </p>
        <label>Теги</label>
        <div className="tag-picker">
          {library.tags.map((tag) => (
            <label
              className={`tag-option ${tagIds.includes(tag.id) ? "active" : ""}`}
              key={tag.id}
            >
              <input
                type="checkbox"
                checked={tagIds.includes(tag.id)}
                onChange={(e) =>
                  setTagIds((old) =>
                    e.target.checked
                      ? [...old, tag.id]
                      : old.filter((id) => id !== tag.id),
                  )
                }
              />
              <span style={{ background: tag.color }} />
              {tag.name}
              {tagIds.includes(tag.id) && <Check size={13} />}
            </label>
          ))}
        </div>
        <ErrorMessage error={error} />
        <div className="modal-actions">
          <Button type="button" className="subtle" onClick={close}>
            Закрыть
          </Button>
          <Button type="submit" className="primary" busy={busy}>
            Сохранить название и теги
          </Button>
        </div>
      </form>
      <NoteEditor kind="item" id={item.id} />
      {item.sources.length > 0 && (
        <section className="item-source-notes" aria-label="Источники">
          <h3>Источники</h3>
          {item.sources.map((s) => (
            <div className="source-details" key={s.id}>
              <div>
                <span>
                  {s.provider === "local" ? <HardDrive size={16} /> : <Youtube size={16} />}
                  {s.provider === "local" ? "Локальный файл" : "YouTube"}
                </span>
                <span className={s.status === "unavailable" ? "danger-text" : "muted"}>
                  {s.status === "available"
                    ? "Доступен"
                    : s.status === "unavailable"
                      ? "Недоступен"
                      : "Не проверен"}
                </span>
                {s.reason && <p>{s.reason}</p>}
              </div>
              <NoteEditor kind="source" id={s.id} />
            </div>
          ))}
        </section>
      )}
      <div ref={replacement}><SourceReplacement item={item} reload={refresh} /></div>
      <ItemListeningSummary itemId={item.id} />
    </Modal>
  );
}

type ItemHistorySummary = {
  launches: number;
  completed: number;
  partial: number;
  skipped: number;
  errors: number;
  listened: number;
  seeks: number;
  fromPlaylist: number;
  direct: number;
  manual: number;
  advance: number;
  repeat: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
};

function ItemListeningSummary({ itemId }: { itemId: string }) {
  const [result, setResult] = useState<{ summary: ItemHistorySummary; journalUrl: string }>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setResult(undefined);
    setError("");
    void api<{ summary: ItemHistorySummary; journalUrl: string }>(`/history/items/${encodeURIComponent(itemId)}`)
      .then((response) => { if (active) setResult(response); })
      .catch((e) => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [itemId, open]);
  const summary = result?.summary;
  const date = (value: string | null) => value ? new Date(value).toLocaleString("ru-RU") : "—";
  const stats = summary && [
    ["Запуски", summary.launches], ["Дослушивания", summary.completed],
    ["Частичные", summary.partial], ["Быстрые пропуски", summary.skipped],
    ["Ошибки", summary.errors], ["Прослушано", formatDuration(summary.listened)],
    ["Перемотки", summary.seeks], ["Из плейлиста", summary.fromPlaylist],
    ["Вне плейлиста", summary.direct], ["Вручную", summary.manual],
    ["Автопереход", summary.advance], ["Повтор", summary.repeat],
    ["Последний запуск", date(summary.lastStartedAt)],
    ["Последнее дослушивание", date(summary.lastCompletedAt)],
  ];
  return (
    <details className="item-listening-summary" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>История прослушивания</summary>
      <ErrorMessage error={error} />
      {open && !result && !error && <p className="small muted" role="status">Загружаем сводку…</p>}
      {result && (
        <>
          {summary?.launches ? (
            <dl>{stats?.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          ) : <p className="small muted">Для записи пока нет истории.</p>}
          <Link className="text-button" to={result.journalUrl}>Открыть журнал записи <ArrowUpRight size={14} /></Link>
        </>
      )}
    </details>
  );
}
function BatchTags({ ids, close }: { ids: string[]; close: () => void }) {
  const { library, refresh, notify } = useData(),
    [tags, setTags] = useState<string[]>([]),
    [mode, setMode] = useState("add"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={`Теги для ${ids.length} записей`}
      subtitle="Измените разметку выбранных записей за один шаг."
      close={close}
    >
      <label>
        Действие
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="add">Добавить к существующим</option>
          <option value="replace">Заменить все теги</option>
          <option value="remove">Убрать выбранные теги</option>
        </select>
      </label>
      <div className="tag-picker">
        {library.tags.map((t) => (
          <label className="check-row" key={t.id}>
            <input
              type="checkbox"
              checked={tags.includes(t.id)}
              onChange={(e) =>
                setTags((old) =>
                  e.target.checked
                    ? [...old, t.id]
                    : old.filter((id) => id !== t.id),
                )
              }
            />
            {t.name}
          </label>
        ))}
      </div>
      <ErrorMessage error={error} />
      <div className="modal-actions">
        <Button className="subtle" onClick={close}>
          Отмена
        </Button>
        <Button
          className="primary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/items/batch", "POST", {
                changes: ids.map((id) => {
                  const old =
                    library.items
                      .find((i) => i.id === id)
                      ?.tags.map((t) => t.id) ?? [];
                  return {
                    id,
                    tagIds:
                      mode === "replace"
                        ? tags
                        : mode === "remove"
                          ? old.filter((t) => !tags.includes(t))
                          : [...new Set([...old, ...tags])],
                  };
                }),
              });
              await refresh();
              notify("Теги обновлены");
              close();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Применить
        </Button>
      </div>
    </Modal>
  );
}
function PlaylistsPage({ query, onQuery, onCreate }: {
  query: string;
  onQuery: (query: string) => void;
  onCreate: () => void;
}) {
  const { library } = useData();
  const { notes } = useNotes();
  const playlists = library.playlists.filter((p) =>
    matchesSearch(query, p.title, p.description, noteFor(notes, "playlist", p.id)),
  );
  return (
    <>
      <PageTop label="Плейлисты" />
      <div className="title-row">
        <div>
          <span className="eyebrow">ЗВУКИ, КОТОРЫЕ СВЯЗАНЫ</span>
          <h1>
            Плейлисты<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Любимые записи вместе. По вашему выбору или по вашим правилам.
          </p>
        </div>
        <Button className="primary" onClick={onCreate}>
          <Plus size={17} />
          Создать плейлист
        </Button>
      </div>
      <div className="section-heading">
        <h2>
          Ваши подборки <span>{playlists.length}</span>
        </h2>
        <label className="search-input">
          <Search size={16} />
          <input
            aria-label="Поиск плейлистов"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Поиск по названию и заметкам…"
          />
        </label>
      </div>
      <NotesLoadError />
      <div className="playlist-grid">
        {playlists.map((p) => (
          <PlaylistCard key={p.id} playlist={p} />
        ))}
        <button className="create-playlist-card" onClick={onCreate}>
          <span>
            <Plus size={28} />
          </span>
          <strong>Соберите что-то своё</strong>
          <p>Из записей, тегов и других плейлистов</p>
        </button>
      </div>
      {!playlists.length && query && (
        <EmptyState
          title="Плейлист не найден"
          text="Измените запрос или очистите поиск."
          icon={<ListMusic size={29} />}
        />
      )}
      <div className="insight-card">
        <Sparkles size={23} />
        <div>
          <h3>Плейлисты могут расти вместе с вашей медиатекой</h3>
          <p>
            Добавьте правило по тегу, объедините подборки или исключите лишнее.
            Состав обновится сам — ваши связи сохранятся.
          </p>
        </div>
      </div>
    </>
  );
}
function PlaylistCard({ playlist }: { playlist: PlaylistDto }) {
  const { library } = useData(),
    player = usePlayer(),
    [resolved, setResolved] = useState<ResolvedPlaylist | null>(null);
  const { notes } = useNotes();
  const historyRevision = useHistoryRevision(
    playlist.definition.sort === "last-started" || usesListeningHistory(playlist.definition.rule, library),
  );
  useEffect(() => {
    let stopped = false;
    api<ResolvedPlaylist>(`/playlists/${playlist.id}/resolve`)
      .then((data) => {
        if (!stopped) setResolved(data);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [
    playlist.id,
    playlist.revision,
    historyRevision,
    library.items.map((i) => i.updatedAt).join(","),
    library.playlists.map((p) => p.revision).join(","),
  ]);
  return (
    <article className="playlist-card">
      <div className="playlist-cover-wrap">
        <Link
          to={`/playlists/${playlist.id}`}
          aria-label={`Открыть ${playlist.title}`}
        >
          <Cover title={playlist.title} items={resolved?.items} />
        </Link>
        <span className="cover-type">
          {playlist.youtubeLinked ? (
            <Youtube size={13} />
          ) : playlist.definition.rule.type === "items" ? (
            <ListMusic size={13} />
          ) : (
            <Sparkles size={13} />
          )}{" "}
          {playlist.youtubeLinked ? "СВЯЗЬ С YOUTUBE" : playlist.definition.rule.type === "items"
            ? "ВАШ ВЫБОР"
            : "ПО ПРАВИЛАМ"}
        </span>
        <button
          className="card-play"
          aria-label={`Воспроизвести ${playlist.title}`}
          disabled={!resolved?.items.length}
          onClick={() => resolved && player.start(resolved.items, 0, playlist.id)}
        >
          <Play size={20} fill="currentColor" />
        </button>
      </div>
      <Link className="playlist-card-title" to={`/playlists/${playlist.id}`}>
        {playlist.title}
      </Link>
      {noteFor(notes, "playlist", playlist.id) && <NoteIndicator />}
      <p>{playlist.description || "Ваша подборка в Hibiki"}</p>
      <span className="small muted">
        {resolved
          ? `${resolved.total} ${mediaWord(resolved.total)} · ${humanDuration(resolved.duration)}`
          : "Вычисляем состав…"}
      </span>
      <button
        type="button"
        className="button subtle compact playlist-card-listen"
        aria-label={`Слушать ${playlist.title}`}
        disabled={!resolved?.items.length}
        onClick={() => resolved && player.start(resolved.items, 0, playlist.id, { mode: "audio" })}
      >
        <Headphones size={15} /> Слушать
      </button>
    </article>
  );
}
function PlaylistPage() {
  const { id } = useParams(),
    { library, refresh, notify } = useData(),
    player = usePlayer(),
    navigate = useNavigate();
  const playlist = library.playlists.find((p) => p.id === id),
    [resolved, setResolved] = useState<ResolvedPlaylist | null>(null),
    [error, setError] = useState(""),
    [edit, setEdit] = useState(false),
    [copy, setCopy] = useState(false),
    [remove, setRemove] = useState(false),
    [busy, setBusy] = useState(false);
  const resolveRequest = useRef(0);
  const historyRevision = useHistoryRevision(Boolean(playlist && (
    playlist.definition.sort === "last-started" || usesListeningHistory(playlist.definition.rule, library)
  )));
  async function resolve() {
    if (!id) return;
    const request = ++resolveRequest.current;
    try {
      const result = await api<ResolvedPlaylist>(`/playlists/${id}/resolve`);
      if (request !== resolveRequest.current) return;
      setResolved(result);
      setError("");
    } catch (e) {
      if (request === resolveRequest.current) setError((e as Error).message);
    }
  }
  const contentKey =
    library.items.map((i) => i.updatedAt).join(",") +
    library.playlists.map((p) => p.revision).join(",");
  useEffect(() => {
    setResolved(null);
    setError("");
    return () => { resolveRequest.current++; };
  }, [id]);
  useEffect(() => {
    void resolve();
  }, [id, contentKey, historyRevision]);
  if (!playlist)
    return (
      <>
        <PageTop label="Плейлист" />
        <EmptyState
          title="Плейлист не найден"
          text="Возможно, он был удалён. Остальные подборки остаются в медиатеке."
          action={
            <Link className="button primary" to="/playlists">
              Все плейлисты
            </Link>
          }
        />
      </>
    );
  const automatic = playlist.definition.rule.type !== "items";
  async function reorder(itemId: string, direction: number) {
    if (!resolved) return;
    const order = resolved.items.map((i) => i.id),
      index = order.indexOf(itemId),
      to = index + direction;
    if (to < 0 || to >= order.length) return;
    [order[index], order[to]] = [order[to]!, order[index]!];
    try {
      await api(`/playlists/${id}`, "PATCH", {
        title: playlist!.title,
        description: playlist!.description,
        definition: {
          ...playlist!.definition,
          manualOrder: order,
          sort: "source",
        },
      });
      await refresh();
      void resolve();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <>
      <PageTop label="Плейлисты">
        <Link className="text-button" to="/playlists">
          <ArrowLeft size={14} />К подборкам
        </Link>
      </PageTop>
      <section className="playlist-detail-hero">
        <Cover title={playlist.title} items={resolved?.items} large />
        <div>
          <span className="eyebrow">
            {playlist.youtubeLinked ? "СВЯЗАН С YOUTUBE" : automatic ? "СОСТАВНОЙ ПЛЕЙЛИСТ" : "ВАШ ПЛЕЙЛИСТ"}
          </span>
          <h1>{playlist.title}</h1>
          <p className="muted">
            {playlist.description || "У каждого настроения — своё звучание."}
          </p>
          <div className="playlist-meta">
            <span>
              <span className="avatar tiny">H</span> Ваша коллекция
            </span>
            <i />
            {resolved && (
              <>
                <span>
                  {resolved.total} {mediaWord(resolved.total)}
                </span>
                <i />
                <span>{humanDuration(resolved.duration)}</span>
              </>
            )}
          </div>
          <div className="playlist-actions">
            <Button
              className="primary"
              disabled={!resolved?.items.length}
              onClick={() => resolved && player.start(resolved.items, 0, playlist.id)}
            >
              <Play size={16} fill="currentColor" />
              Воспроизвести
            </Button>
            <Button
              className="subtle"
              disabled={!resolved?.items.length}
              onClick={() => resolved && player.start(resolved.items, 0, playlist.id, { mode: "audio" })}
            >
              <Headphones size={16} />
              Слушать
            </Button>
            <Button className="subtle" onClick={() => setEdit(true)}>
              <Pencil size={16} />
              {playlist.youtubeLinked ? "Название и описание" : automatic ? "Изменить правила" : "Изменить плейлист"}
            </Button>
            {playlist.youtubeLinked && (
              <Button className="subtle" disabled={!resolved} onClick={() => setCopy(true)}>
                <Copy size={16} /> Сделать ручную копию
              </Button>
            )}
            <button
              className="icon-button"
              aria-label="Удалить плейлист"
              onClick={() => setRemove(true)}
            >
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      </section>
      <NoteEditor key={playlist.id} kind="playlist" id={playlist.id} />
      {playlist.youtubeLinked && (
        <YoutubeLinkedPlaylist
          key={playlist.id}
          playlist={playlist}
          items={library.items}
          tags={library.tags}
          reload={async () => {
            await refresh();
            await resolve();
          }}
        />
      )}
      {automatic && !playlist.youtubeLinked && (
        <div className="rule-summary">
          <Sparkles size={18} />
          <div>
            <strong>Подборка обновляется сама</strong>
            <p>
              {ruleDescription(playlist.definition.rule, library)}. Аудио и
              видео могут звучать в одной очереди.
            </p>
          </div>
          <button className="text-button" onClick={() => setEdit(true)}>
            Правила
            <ChevronRight size={15} />
          </button>
        </div>
      )}
      <ErrorMessage error={error} />
      <div className="section-heading">
        <h2>
          Состав плейлиста <span>{resolved?.total ?? "…"}</span>
        </h2>
        <button className="text-button" onClick={resolve}>
          <RefreshCw size={14} />
          Обновить состав
        </button>
      </div>
      {resolved ? (
        <>
          <ItemTable
            items={resolved.items}
            reasons={resolved.reasons}
            reorder={playlist.youtubeLinked ? undefined : reorder}
            playlistId={playlist.id}
          />
          {!resolved.items.length && (
            <EmptyState
              title="Пока здесь тихо"
              text="Добавьте записи вручную или настройте правила, чтобы собрать плейлист."
              action={!playlist.youtubeLinked && (
                <Button className="primary" onClick={() => setEdit(true)}>
                  Настроить состав
                </Button>
              )}
            />
          )}{" "}
          {resolved.excluded.length > 0 && (
            <details className="excluded-details">
              <summary>Не вошли в плейлист: {resolved.excluded.length}</summary>
              {resolved.excluded.map((i) => (
                <div key={i.id}>
                  <strong>{i.title}</strong>
                  <p>{i.reasons.join(" · ")}</p>
                </div>
              ))}
            </details>
          )}
        </>
      ) : (
        !error && (
          <div className="loading-inline">
            <LoaderCircle className="spin" size={20} />
            Вычисляем состав…
          </div>
        )
      )}
      {edit && (
        <PlaylistEditor
          playlist={playlist}
          close={() => setEdit(false)}
          onSaved={() => {
            setEdit(false);
            void resolve();
          }}
        />
      )}{" "}
      {copy && (
        <PlaylistEditor
          initialIds={resolved?.items.map((item) => item.id)}
          close={() => setCopy(false)}
          onSaved={(saved) => {
            setCopy(false);
            navigate(`/playlists/${saved.id}`);
          }}
        />
      )}
      {remove && (
        <Modal
          title="Удалить плейлист?"
          subtitle={`«${playlist.title}» исчезнет из подборок. Записи останутся в медиатеке.`}
          close={() => setRemove(false)}
        >
          <ErrorMessage error={error} />
          <div className="modal-actions">
            <Button className="subtle" onClick={() => setRemove(false)}>
              Отмена
            </Button>
            <Button
              className="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/playlists/${id}`, "DELETE");
                  await refresh();
                  notify("Плейлист удалён");
                  navigate("/playlists");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Удалить
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
type HistoryRule = Extract<Rule, { type: "history" }>;
const HISTORY_CONDITIONS: Record<HistoryRule["condition"], string> = {
  "never-started": "Ещё не слушал",
  "never-completed": "Ни разу не дослушал",
  "skipped-at-least": "Быстро пропускал несколько раз",
  "last-started-before": "Давно не включал",
};

function historyRule(condition: HistoryRule["condition"]): HistoryRule {
  if (condition === "skipped-at-least") return { type: "history", condition, count: 2 };
  if (condition === "last-started-before") return { type: "history", condition, days: 30 };
  return { type: "history", condition };
}

function usesListeningHistory(rule: Rule, library: LibraryDto, visited = new Set<string>()): boolean {
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

function ruleDescription(rule: Rule, library: LibraryDto): string {
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
function newRule(
  type: Rule["type"],
  library: LibraryDto,
  playlistId?: string,
): Rule {
  switch (type) {
    case "items":
      return { type, ids: [] };
    case "playlist":
      return {
        type,
        id: library.playlists.find((p) => p.id !== playlistId)?.id ?? "",
      };
    case "tag":
      return { type, id: library.tags[0]?.id ?? "" };
    case "filter":
    case "favorite":
      return { type };
    case "history":
      return historyRule("never-started");
    case "union":
    case "intersection":
      return { type, rules: [{ type: "items", ids: [] }] };
    case "difference":
      return {
        type,
        include: { type: "items", ids: [] },
        exclude: { type: "items", ids: [] },
      };
  }
}
function RuleEditor({
  rule,
  onChange,
  playlistId,
  depth = 0,
}: {
  rule: Rule;
  onChange: (rule: Rule) => void;
  playlistId?: string;
  depth?: number;
}) {
  const { library } = useData(),
    [search, setSearch] = useState("");
  return (
    <div className={`rule-editor depth-${depth % 2}`}>
      <div className="rule-type-row">
        <select
          aria-label={`Тип правила ${depth + 1}`}
          value={rule.type}
          onChange={(e) =>
            onChange(
              newRule(e.target.value as Rule["type"], library, playlistId),
            )
          }
        >
          <option value="items">Выбранные записи</option>
          <option value="tag">Записи с тегом</option>
          <option value="playlist">Другой плейлист</option>
          <option value="filter">Фильтр медиатеки</option>
          <option value="favorite">Избранные записи</option>
          <option value="history">История прослушивания</option>
          <option value="union">Объединить — любое правило</option>
          <option value="intersection">Пересечь — все правила</option>
          <option value="difference">Добавить с исключениями</option>
        </select>
        <span className="rule-depth">
          {depth === 0 ? "СОСТАВ" : `ПРАВИЛО ${depth + 1}`}
        </span>
      </div>
      {rule.type === "history" && (
        <div className="filter-fields">
          <label>
            Условие
            <select value={rule.condition} onChange={(event) => onChange(historyRule(event.target.value as HistoryRule["condition"]))}>
              {Object.entries(HISTORY_CONDITIONS).map(([condition, label]) => <option value={condition} key={condition}>{label}</option>)}
            </select>
          </label>
          {rule.condition === "skipped-at-least" && (
            <label>
              Минимум быстрых пропусков
              <input type="number" required min={1} max={1_000_000} step={1} value={rule.count ?? ""}
                onChange={(event) => onChange({ ...rule, count: event.target.value === "" ? undefined : event.target.valueAsNumber })} />
            </label>
          )}
          {rule.condition === "last-started-before" && (
            <label>
              Дней с последнего запуска, больше
              <input type="number" required min={1} max={36_500} step={1} value={rule.days ?? ""}
                onChange={(event) => onChange({ ...rule, days: event.target.value === "" ? undefined : event.target.valueAsNumber })} />
            </label>
          )}
        </div>
      )}
      {rule.type === "items" && (
        <>
          <label className="search-input rule-search">
            <Search size={14} />
            <input
              aria-label="Найти запись для правила"
              placeholder="Найти запись…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div className="rule-items">
            {library.items
              .filter((i) =>
                i.title.toLowerCase().includes(search.toLowerCase()),
              )
              .map((item) => (
                <label className="check-row" key={item.id}>
                  <input
                    type="checkbox"
                    checked={rule.ids.includes(item.id)}
                    onChange={(e) =>
                      onChange({
                        ...rule,
                        ids: e.target.checked
                          ? [...rule.ids, item.id]
                          : rule.ids.filter((id) => id !== item.id),
                      })
                    }
                  />
                  {item.kind === "audio" ? (
                    <Music2 size={14} />
                  ) : (
                    <Video size={14} />
                  )}
                  <span className="truncate">{item.title}</span>
                  <span className="muted small">
                    {formatDuration(item.duration)}
                  </span>
                </label>
              ))}
            {!library.items.length && (
              <p className="muted small">
                Сначала добавьте записи в медиатеку.
              </p>
            )}
          </div>
          <span className="small muted">
            Выбрано: {rule.ids.length}. Порядок выбора сохраняется.
          </span>
        </>
      )}
      {rule.type === "tag" && (
        <label>
          Тег
          <select
            value={rule.id}
            onChange={(e) => onChange({ ...rule, id: e.target.value })}
          >
            <option value="" disabled>
              Выберите тег
            </option>
            {library.tags.map((t) => (
              <option value={t.id} key={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {!library.tags.length && (
            <span className="small muted">
              Создайте тег на странице «Теги».
            </span>
          )}
        </label>
      )}
      {rule.type === "playlist" && (
        <label>
          Плейлист
          <select
            value={rule.id}
            onChange={(e) => onChange({ ...rule, id: e.target.value })}
          >
            <option value="" disabled>
              Выберите плейлист
            </option>
            {library.playlists
              .filter((p) => p.id !== playlistId)
              .map((p) => (
                <option value={p.id} key={p.id}>
                  {p.title}
                </option>
              ))}
          </select>
          <span className="small muted">
            Изменения вложенного плейлиста обновят эту подборку. Циклы
            запрещены.
          </span>
        </label>
      )}
      {rule.type === "filter" && (
        <div className="filter-fields">
          <label>
            Тип записи
            <select
              value={rule.kind ?? ""}
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value)
                  next.kind = e.target.value as "audio" | "video";
                else delete next.kind;
                onChange(next);
              }}
            >
              <option value="">Аудио и видео</option>
              <option value="audio">Только аудио</option>
              <option value="video">Только видео</option>
            </select>
          </label>
          <label>
            Локальный файл
            <select
              value={rule.local === undefined ? "" : String(rule.local)}
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value === "") delete next.local;
                else next.local = e.target.value === "true";
                onChange(next);
              }}
            >
              <option value="">Любой источник</option>
              <option value="true">Есть на устройстве</option>
              <option value="false">Нет локального файла</option>
            </select>
          </label>
          <label>
            Длительность от, сек.
            <input
              type="number"
              min="0"
              placeholder="Без минимума"
              value={rule.minDuration ?? ""}
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value === "") delete next.minDuration;
                else next.minDuration = Number(e.target.value);
                onChange(next);
              }}
            />
          </label>
          <label>
            Длительность до, сек.
            <input
              type="number"
              min="0"
              placeholder="Без максимума"
              value={rule.maxDuration ?? ""}
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value === "") delete next.maxDuration;
                else next.maxDuration = Number(e.target.value);
                onChange(next);
              }}
            />
          </label>
        </div>
      )}
      {(rule.type === "union" || rule.type === "intersection") && (
        <>
          <p className="small muted">
            {rule.type === "union"
              ? "Запись попадёт в подборку, если подходит хотя бы под одно правило. Повторы убираются."
              : "Запись должна подходить под каждое из правил ниже."}
          </p>
          {rule.rules.map((child, index) => (
            <div className="child-rule" key={index}>
              <div className="child-rule-heading">
                <span>
                  {index ? (rule.type === "union" ? "ИЛИ" : "И") : "ПРАВИЛО"}
                </span>
                <button
                  className="icon-button"
                  aria-label={`Удалить правило ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...rule,
                      rules: rule.rules.filter((_, i) => i !== index),
                    })
                  }
                >
                  <X size={14} />
                </button>
              </div>
              <RuleEditor
                rule={child}
                playlistId={playlistId}
                depth={depth + 1}
                onChange={(next) =>
                  onChange({
                    ...rule,
                    rules: rule.rules.map((r, i) => (i === index ? next : r)),
                  })
                }
              />
            </div>
          ))}
          <Button
            type="button"
            className="subtle compact"
            disabled={depth >= 10}
            onClick={() =>
              onChange({
                ...rule,
                rules: [
                  ...rule.rules,
                  { type: "tag", id: library.tags[0]?.id ?? "" },
                ],
              })
            }
          >
            <Plus size={14} />
            Добавить правило
          </Button>
        </>
      )}
      {rule.type === "difference" && (
        <>
          <span className="rule-group-label">ДОБАВИТЬ</span>
          <RuleEditor
            rule={rule.include}
            playlistId={playlistId}
            depth={depth + 1}
            onChange={(include) => onChange({ ...rule, include })}
          />
          <span className="rule-group-label exclude">
            <Minus size={13} /> ИСКЛЮЧИТЬ
          </span>
          <RuleEditor
            rule={rule.exclude}
            playlistId={playlistId}
            depth={depth + 1}
            onChange={(exclude) => onChange({ ...rule, exclude })}
          />
          <p className="small muted">
            Исключение имеет приоритет, даже если запись подходит под
            добавление.
          </p>
        </>
      )}
    </div>
  );
}
function PlaylistEditor({
  playlist,
  initialIds,
  close,
  onSaved,
}: {
  playlist?: PlaylistDto;
  initialIds?: string[];
  close: () => void;
  onSaved: (p: PlaylistDto) => void;
}) {
  const { library, refresh, notify } = useData(),
    [title, setTitle] = useState(playlist?.title ?? ""),
    [description, setDescription] = useState(playlist?.description ?? ""),
    [definition, setDefinition] = useState<PlaylistDefinition>(
      playlist?.definition ?? {
        version: 1,
        rule: { type: "items", ids: initialIds ?? [] },
        sort: "source",
      },
    ),
    [preview, setPreview] = useState<ResolvedPlaylist | null>(null),
    [error, setError] = useState(""),
    [previewError, setPreviewError] = useState(""),
    [previewBusy, setPreviewBusy] = useState(false),
    [busy, setBusy] = useState(false);
  const [historyPreference, setHistoryPreference] = useState<HistoryPreference>();
  const hasHistoryRules = usesListeningHistory(definition.rule, library);
  const sortsByHistory = definition.sort === "last-started";
  const needsHistory = !playlist?.youtubeLinked && (sortsByHistory || hasHistoryRules);
  const historyRevision = useHistoryRevision(needsHistory);
  useEffect(() => {
    if (!needsHistory) return;
    let active = true;
    void api<HistoryPreference>("/history/preference")
      .then((preference) => { if (active) setHistoryPreference(preference); })
      .catch(() => {});
    return () => { active = false; };
  }, [needsHistory, historyRevision]);
  const key = JSON.stringify(definition);
  useEffect(() => {
    if (playlist?.youtubeLinked) return;
    let disposed = false;
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      api<ResolvedPlaylist>("/playlists/preview", "POST", {
        definition,
        playlistId: playlist?.id,
      })
        .then((result) => {
          if (!disposed) {
            setPreview(result);
            setPreviewError("");
          }
        })
        .catch((e) => {
          if (!disposed) {
            setPreviewError(e.message);
            setPreview(null);
          }
        })
        .finally(() => {
          if (!disposed) setPreviewBusy(false);
        });
    }, 350);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [key, playlist?.youtubeLinked, historyRevision]);
  return (
    <Modal
      wide={!playlist?.youtubeLinked}
      title={playlist?.youtubeLinked ? "Название и описание" : playlist ? "Настроить плейлист" : "Новый плейлист"}
      subtitle={playlist?.youtubeLinked ? undefined : "Выберите записи или задайте связи. Состав проверяется сразу."}
      close={close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const saved = await api<PlaylistDto>(
              playlist ? `/playlists/${playlist.id}` : "/playlists",
              playlist ? "PATCH" : "POST",
              { title, description, definition: playlist?.youtubeLinked ? playlist.definition : definition },
            );
            await refresh();
            notify(playlist ? "Плейлист обновлён" : "Плейлист создан");
            onSaved(saved);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className={playlist?.youtubeLinked ? undefined : "editor-layout"}>
          <div className="editor-fields">
            <label>
              Название
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="Например, Для тихого вечера"
                required
                autoFocus
              />
            </label>
            <label>
              Описание <span className="muted">· необязательно</span>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={10000}
                placeholder="Как звучит эта подборка?"
              />
            </label>
            {!playlist?.youtubeLinked && <>
            <div className="section-heading editor-section-heading">
              <h3>Правила состава</h3>
              <Sparkles size={16} />
            </div>
            <RuleEditor
              rule={definition.rule}
              playlistId={playlist?.id}
              onChange={(rule) =>
                setDefinition((old) => ({
                  ...old,
                  rule,
                  manualOrder: undefined,
                }))
              }
            />
            <label>
              Порядок записей
              <select
                value={definition.sort}
                onChange={(e) =>
                  setDefinition((old) => ({
                    ...old,
                    sort: e.target.value as PlaylistDefinition["sort"],
                    manualOrder: undefined,
                  }))
                }
              >
                <option value="source">По порядку источников / выбора</option>
                <option value="title">По названию</option>
                <option value="newest">Сначала новые</option>
                <option value="duration">По длительности</option>
                <option value="last-started">Сначала давно включённые</option>
              </select>
            </label>
            </>}
          </div>
          {!playlist?.youtubeLinked && <aside className="preview-panel">
            <span className="eyebrow">ПРЕДПРОСМОТР</span>
            <h3>
              {previewBusy ? (
                <>
                  <LoaderCircle size={17} className="spin" />
                  Проверяем состав
                </>
              ) : preview ? (
                `${preview.total} ${mediaWord(preview.total)}`
              ) : (
                "Проверьте правила"
              )}
            </h3>
            {preview && (
              <p className="small muted">
                {humanDuration(preview.duration)} · без повторов
              </p>
            )}
            <ErrorMessage error={previewError} />
            {needsHistory && (
              <div className="small muted">
                {hasHistoryRules && (
                  <p>Условию «Давно не включал» нужен хотя бы один учтённый запуск. Условия «Ещё не слушал» и «Ни разу не дослушал» включают записи без истории.</p>
                )}
                {sortsByHistory && <p>Записи без учтённых запусков идут в конце списка.</p>}
                {historyPreference?.enabled === false && <p>Сбор истории выключен. Правила используют сохранённую сводку.</p>}
                {historyPreference?.resetAt && <p>Сводку сбросили {new Date(historyPreference.resetAt).toLocaleDateString("ru-RU")}.</p>}
              </div>
            )}
            <div className="preview-items">
              {preview?.items.map((item, index) => (
                <details key={item.id}>
                  <summary>
                    <span className={`preview-art art-${index % 6}`}>
                      {item.kind === "video" ? (
                        <Video size={15} />
                      ) : (
                        <Music2 size={15} />
                      )}
                    </span>
                    <span className="truncate">{item.title}</span>
                    <ChevronRight size={13} />
                  </summary>
                  <p>{preview.reasons[item.id]?.join(" · ")}</p>
                </details>
              ))}
              {preview && !preview.items.length && (
                <p className="muted small">
                  Правила верны, но пока не выбирают записи. Добавьте записи или
                  измените условия.
                </p>
              )}
            </div>
            {!!preview?.excluded.length && (
              <details className="preview-excluded">
                <summary>Исключено: {preview.excluded.length}</summary>
                {preview.excluded.map((i) => (
                  <p key={i.id}>
                    <strong>{i.title}</strong>
                    <br />
                    {i.reasons.join(" · ")}
                  </p>
                ))}
              </details>
            )}
            <div className="preview-note">
              <CheckCircle2 size={15} />
              <span>Ссылки и циклы проверяются перед сохранением.</span>
            </div>
          </aside>}
        </div>
        <ErrorMessage error={error} />
        <div className="modal-actions">
          <Button type="button" className="subtle" onClick={close}>
            Отмена
          </Button>
          <Button
            type="submit"
            className="primary"
            busy={busy}
            disabled={!!previewError || previewBusy || !title.trim()}
          >
            {playlist ? "Сохранить изменения" : "Создать плейлист"}
            <Check size={16} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
const TAG_COLORS = [
  "#b6a0ed",
  "#92b8a5",
  "#ddb18a",
  "#8faed3",
  "#d494a8",
  "#c4bd80",
  "#7cbcb8",
  "#b5b5bc",
];
function TagsPage({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const { library, refresh, notify } = useData(),
    [edit, setEdit] = useState<TagDto | "new" | null>(null),
    [name, setName] = useState(""),
    [color, setColor] = useState(TAG_COLORS[0]!),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState<TagDto | null>(null);
  const { notes } = useNotes();
  const tags = library.tags.filter((tag) => matchesSearch(query, tag.name, noteFor(notes, "tag", tag.id)));
  function open(tag: TagDto | "new") {
    setEdit(tag);
    setName(tag === "new" ? "" : tag.name);
    setColor(tag === "new" ? TAG_COLORS[0]! : tag.color);
    setError("");
  }
  return (
    <>
      <PageTop label="Теги" />
      <div className="title-row">
        <div>
          <span className="eyebrow">ПОРЯДОК БЕЗ ЛИШНИХ ПАПОК</span>
          <h1>
            Теги<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Отмечайте настроение, жанр или любую важную для вас связь.
          </p>
        </div>
        <Button className="primary" onClick={() => open("new")}>
          <Plus size={17} />
          Новый тег
        </Button>
      </div>
      <div className="section-heading">
        <h2>Ваши теги <span>{tags.length}</span></h2>
        <label className="search-input">
          <Search size={16} />
          <input
            type="search"
            aria-label="Поиск тегов"
            placeholder="Поиск по названию и заметкам…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
      </div>
      <NotesLoadError />
      <div className="tag-grid">
        {tags.map((tag) => {
          const count = library.items.filter((i) =>
            i.tags.some((t) => t.id === tag.id),
          ).length;
          return (
            <article className="tag-card" key={tag.id}>
              <span
                className="tag-card-icon"
                style={{ "--tag": tag.color } as any}
              >
                <Tags size={22} />
              </span>
              <div>
                <h3>{tag.name}{noteFor(notes, "tag", tag.id) && <NoteIndicator />}</h3>
                <p>
                  {count} {mediaWord(count)}
                </p>
              </div>
              <button
                className="icon-button"
                aria-label={`Изменить тег ${tag.name}`}
                onClick={() => open(tag)}
              >
                <Pencil size={15} />
              </button>
              <button
                className="icon-button"
                aria-label={`Удалить тег ${tag.name}`}
                onClick={() => {
                  setRemove(tag);
                  setError("");
                }}
              >
                <Trash2 size={15} />
              </button>
            </article>
          );
        })}
      </div>
      {library.tags.length > 0 && !tags.length && (
        <EmptyState title="Тег не найден" text="Измените запрос или очистите поиск." icon={<Tags size={28} />} />
      )}
      {!library.tags.length && (
        <EmptyState
          title="Найдите свои связи"
          text="Создайте первый тег и отмечайте им записи. Плейлисты по тегу будут обновляться сами."
          action={
            <Button className="primary" onClick={() => open("new")}>
              Создать тег
            </Button>
          }
          icon={<Tags size={28} />}
        />
      )}
      <div className="insight-card">
        <Tags size={22} />
        <div>
          <h3>Одна запись — несколько настроений</h3>
          <p>
            Теги не создают копий. Используйте их в правилах плейлистов,
            комбинируйте и исключайте — как вам удобно.
          </p>
        </div>
      </div>
      {edit && (
        <Modal
          title={edit === "new" ? "Новый тег" : "Изменить тег"}
          close={() => setEdit(null)}
        >
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api(
                  edit === "new" ? "/tags" : `/tags/${edit.id}`,
                  edit === "new" ? "POST" : "PATCH",
                  { name, color },
                );
                await refresh();
                notify(edit === "new" ? "Тег создан" : "Тег обновлён");
                setEdit(null);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Название
              <input
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например, Для работы"
                required
                autoFocus
              />
            </label>
            <label>Цвет</label>
            <div className="color-picker">
              {TAG_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  aria-label={`Цвет ${c}`}
                  aria-pressed={color === c}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                >
                  {color === c && <Check size={17} />}
                </button>
              ))}
              <input
                type="color"
                aria-label="Другой цвет тега"
                value={
                  color.startsWith("#") && color.length === 7
                    ? color
                    : "#b6a0ed"
                }
                onChange={(e) => setColor(e.target.value)}
              />
            </div>
            <ErrorMessage error={error} />
            <div className="modal-actions">
              <Button
                type="button"
                className="subtle"
                onClick={() => setEdit(null)}
              >
                Отмена
              </Button>
              <Button type="submit" className="primary" busy={busy}>
                Сохранить
              </Button>
            </div>
          </form>
          {edit !== "new" && <NoteEditor key={edit.id} kind="tag" id={edit.id} />}
        </Modal>
      )}
      {remove && (
        <Modal
          title="Удалить тег?"
          subtitle={`Тег «${remove.name}» исчезнет у записей. Зависимые плейлисты нужно сначала изменить.`}
          close={() => setRemove(null)}
        >
          <ErrorMessage error={error} />
          <div className="modal-actions">
            <Button className="subtle" onClick={() => setRemove(null)}>
              Отмена
            </Button>
            <Button
              className="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/tags/${remove.id}`, "DELETE");
                  await refresh();
                  notify("Тег удалён");
                  setRemove(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Удалить
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function ImportModal({ close }: { close: () => void }) {
  const { refresh, notify } = useData(),
    [tab, setTab] = useState("files"),
    [url, setUrl] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [drag, setDrag] = useState(false);
  const navigate = useNavigate();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (tab === "youtube") {
        await api("/jobs", "POST", { kind: "youtube-import", input: { url } });
        notify("Импорт YouTube начат. Прогресс — в заданиях.");
      } else {
        const body = new FormData();
        files.forEach((file) =>
          body.append(tab === "archive" ? "file" : "files", file),
        );
        await api(
          tab === "archive" ? "/imports/upload" : "/items/upload",
          "POST",
          body,
        );
        notify(
          tab === "archive"
            ? "Архив отправлен на проверку. Посмотрите отчёт перед применением."
            : `Добавлено файлов: ${files.length}`,
        );
      }
      await refresh();
      close();
      if (tab !== "files") navigate("/jobs");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Добавить в медиатеку"
      subtitle="Файлы, ссылки и подборки — всё на своём месте."
      close={close}
    >
      <div className="import-tabs">
        {[
          ["files", "Файлы", <Upload size={16} />],
          ["youtube", "YouTube", <Youtube size={17} />],
          ["archive", "Архив Hibiki", <FolderOpen size={16} />],
        ].map(([id, label, icon]) => (
          <button
            key={id as string}
            className={tab === id ? "active" : ""}
            onClick={() => {
              setTab(id as string);
              setFiles([]);
              setError("");
            }}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={submit}>
        {tab === "youtube" ? (
          <>
            <label>
              Ссылка на видео или плейлист
              <div className="input-icon">
                <Link2 size={17} />
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=…"
                  required
                />
              </div>
            </label>
            <div className="import-info">
              <Youtube size={21} />
              <p>
                Каждое видео появится отдельной записью. Импорт сохраняет ссылки
                и названия. Скачивание можно запустить отдельно в меню записи.
              </p>
            </div>
            <YoutubeLinkImport url={url} onCreated={async (playlist) => {
              await refresh();
              close();
              navigate(`/playlists/${playlist.id}`);
            }} />
          </>
        ) : (
          <>
            <label
              className={`dropzone ${drag ? "dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                setFiles(
                  Array.from(e.dataTransfer.files).slice(
                    0,
                    tab === "archive" ? 1 : undefined,
                  ),
                );
              }}
            >
              <input
                type="file"
                multiple={tab === "files"}
                accept={
                  tab === "archive"
                    ? ".zip,application/zip"
                    : "audio/*,video/*,.flac,.m4a,.ogg,.mkv"
                }
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
              <span className="drop-icon">
                <Upload size={26} />
              </span>
              <strong>
                {files.length
                  ? `Выбрано файлов: ${files.length}`
                  : "Перетащите файлы сюда"}
              </strong>
              <span>
                или <u>выберите на устройстве</u>
              </span>
              <small>
                {tab === "archive"
                  ? "ZIP-архив, экспортированный из Hibiki"
                  : "Аудио и видео · MP3, FLAC, WAV, MP4, WebM и другие"}
              </small>
            </label>
            {files.length > 0 && (
              <div className="upload-file-list">
                {files.map((f, index) => (
                  <div key={`${f.name}-${index}`}>
                    <span className="truncate">{f.name}</span>
                    <small>{(f.size / 1024 / 1024).toFixed(1)} МБ</small>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Убрать ${f.name}`}
                      onClick={() =>
                        setFiles((old) => old.filter((_, i) => i !== index))
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {tab === "archive" && (
              <p className="muted small">
                Сначала Hibiki проверит содержимое архива и покажет отчёт в
                заданиях. Вы сможете применить импорт после проверки.
              </p>
            )}
          </>
        )}
        <ErrorMessage error={error} />
        <div className="modal-actions">
          <Button
            type="button"
            className="subtle"
            onClick={close}
            disabled={busy}
          >
            Отмена
          </Button>
          <Button
            type="submit"
            className="primary"
            busy={busy}
            disabled={tab === "youtube" ? !url : !files.length}
          >
            {tab === "files"
              ? "Добавить файлы"
              : tab === "youtube"
                ? "Импортировать"
                : "Проверить архив"}
            <ArrowUpRight size={16} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
const JOB_NAMES: Record<string, string> = {
  "youtube-import": "Импорт из YouTube",
  "youtube-download": "Скачивание YouTube",
  "youtube-refresh": "Проверка источника",
  export: "Экспорт медиатеки",
  import: "Импорт архива",
  "import-preview": "Проверка архива",
  "import-apply": "Применение архива",
};
const STATE_NAMES: Record<string, string> = {
  queued: "В очереди",
  running: "Выполняется",
  done: "Завершено",
  failed: "Ошибка",
  cancelled: "Отменено",
};
function JobReport({ result }: { result: any }) {
  const report = result.preview ?? result,
    counts = report.counts,
    duplicates = report.duplicates;
  const metrics: [string, unknown][] = counts
    ? [
        ["Записей", counts.items],
        ["Тегов", counts.tags],
        ["Плейлистов", counts.playlists],
        ["Файлов", counts.files],
      ]
    : [
        ["Добавлено", report.added],
        ["Уже в библиотеке", report.existing ?? report.reused],
        ["Недоступно", report.unavailable],
        ["Ошибок", report.errors],
      ];
  const notices = [...(report.issues ?? []), ...(report.warnings ?? [])];
  return (
    <div className="job-report">
      {metrics.some(([, n]) => typeof n === "number") && (
        <div className="report-counts">
          {metrics
            .filter(([, n]) => typeof n === "number")
            .map(([label, n]) => (
              <span key={label}>
                <strong>{String(n)}</strong>
                {label}
              </span>
            ))}
        </div>
      )}
      {duplicates && (
        <p className="small muted">
          Совпадения: {duplicates.items} записей, {duplicates.tags} тегов,{" "}
          {duplicates.playlists} плейлистов. Существующие названия сохранятся.
        </p>
      )}
      {!!report.missingFiles?.length && (
        <p className="report-warning">
          Локальных файлов вне архива: {report.missingFiles.length}. Их
          источники могут быть недоступны после переноса.
        </p>
      )}
      {notices.map((notice: string, index: number) => (
        <p className="report-warning" key={index}>
          {notice}
        </p>
      ))}
      {result.preview && (
        <p className={`report-verdict ${report.canApply ? "" : "danger-text"}`}>
          {report.canApply
            ? "Архив проверен. Можно применить импорт."
            : "Импорт заблокирован. Исправьте ошибки архива."}
        </p>
      )}
      {result.itemId && (
        <p className="small muted">
          Локальный источник добавлен к существующей записи.
        </p>
      )}
      <details className="job-result">
        <summary>Технические подробности</summary>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}
function JobsPage() {
  const { library, refresh, notify, openImport } = useData(),
    [filter, setFilter] = useState("all"),
    [pending, setPending] = useState("");
  const jobs = [...library.jobs]
    .filter(
      (j) =>
        filter === "all" ||
        (filter === "active" &&
          (j.state === "running" || j.state === "queued")) ||
        (filter === "failed" && j.state === "failed"),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  async function action(id: string, name: string) {
    setPending(`${id}:${name}`);
    try {
      await api(
        name === "apply" ? `/imports/${id}/apply` : `/jobs/${id}/${name}`,
        "POST",
      );
      await refresh();
      notify(
        name === "cancel"
          ? "Задание отменено"
          : name === "retry"
            ? "Задание добавлено на повтор"
            : "Импорт запущен",
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setPending("");
    }
  }
  return (
    <>
      <PageTop label="Задания">
        <span className="status-pill">
          <span className="online-dot" />
          Обновляется автоматически
        </span>
      </PageTop>
      <div className="title-row">
        <div>
          <span className="eyebrow">ПУСТЬ HIBIKI ЗАЙМЁТСЯ ЭТИМ</span>
          <h1>
            Задания<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Импорт, скачивание и перенос продолжаются, пока вы слушаете.
          </p>
        </div>
        <Button className="primary" onClick={openImport}>
          <Plus size={17} />
          Добавить медиа
        </Button>
      </div>
      <div className="segmented jobs-filter">
        {[
          ["all", "Все задания"],
          ["active", "В работе"],
          ["failed", "С ошибками"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={filter === id ? "active" : ""}
            onClick={() => setFilter(id!)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="jobs-list">
        {jobs.map((job) => {
          const active = job.state === "running" || job.state === "queued",
            result = job.result as any;
          const isPreview =
            job.kind === "import" &&
            job.state === "done" &&
            result?.preview?.canApply === true;
          const percent = Math.min(100, Math.round(job.progress * 100));
          return (
            <article className="job-card" key={job.id}>
              <div className={`job-icon ${job.state}`}>
                {active ? (
                  <LoaderCircle size={23} className="spin" />
                ) : job.state === "done" ? (
                  <CheckCircle2 size={23} />
                ) : job.state === "failed" ? (
                  <CircleAlert size={23} />
                ) : (
                  <Download size={23} />
                )}
              </div>
              <div className="job-body">
                <div className="job-title-row">
                  <h3>{JOB_NAMES[job.kind] ?? job.kind}</h3>
                  <span className={`state-badge ${job.state}`}>
                    {STATE_NAMES[job.state]}
                  </span>
                </div>
                <p className="small muted">
                  {new Date(job.createdAt).toLocaleString("ru-RU", {
                    day: "numeric",
                    month: "long",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {job.attempt > 1 ? ` · Попытка ${job.attempt}` : ""}
                </p>
                {active && (
                  <>
                    <div className="progress-track">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                    <div className="progress-meta">
                      <span>
                        {job.state === "queued"
                          ? "Ожидает свободного обработчика"
                          : `${job.completed} из ${job.total || "…"}`}
                      </span>
                      <span>{percent}%</span>
                    </div>
                  </>
                )}
                {job.error && <ErrorMessage error={job.error} />}{" "}
                {result && <JobReport result={result} />}
              </div>
              <div className="job-actions">
                {active && (
                  <Button
                    className="subtle compact"
                    busy={pending === `${job.id}:cancel`}
                    onClick={() => action(job.id, "cancel")}
                  >
                    Отменить
                  </Button>
                )}
                {(job.state === "failed" || job.state === "cancelled") && (
                  <Button
                    className="subtle compact"
                    busy={pending === `${job.id}:retry`}
                    onClick={() => action(job.id, "retry")}
                  >
                    <RefreshCw size={14} />
                    Повторить
                  </Button>
                )}
                {job.kind === "export" && job.state === "done" && (
                  <a
                    href={`/api/jobs/${job.id}/download`}
                    className="button primary compact"
                    download
                  >
                    <Download size={14} />
                    Скачать архив
                  </a>
                )}
                {isPreview && (
                  <Button
                    className="primary compact"
                    busy={pending === `${job.id}:apply`}
                    onClick={() => action(job.id, "apply")}
                  >
                    Применить импорт
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!jobs.length && (
        <EmptyState
          title={
            filter === "all"
              ? "Всё спокойно"
              : filter === "active"
                ? "Нет активных заданий"
                : "Ошибок нет"
          }
          text={
            filter === "all"
              ? "Здесь появится прогресс импорта, скачивания и экспорта вашей медиатеки."
              : "Новые задания появятся здесь автоматически."
          }
          icon={<CheckCircle2 size={29} />}
        />
      )}
    </>
  );
}
function SettingsPage({ user }: { user: UserDto }) {
  const { library, notify, refresh, openImport } = useData(),
    [tokens, setTokens] = useState<
      { id: string; name: string; createdAt: string }[]
    >([]),
    [name, setName] = useState(""),
    [newToken, setNewToken] = useState(""),
    [busy, setBusy] = useState(false),
    [includeFiles, setIncludeFiles] = useState(true),
    [includeNotes, setIncludeNotes] = useState(false),
    [includeHistorySummary, setIncludeHistorySummary] = useState(false),
    [exportBusy, setExportBusy] = useState(false),
    [error, setError] = useState("");
  const navigate = useNavigate();
  async function loadTokens() {
    try {
      const data = await api("/tokens");
      setTokens(data.tokens);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void loadTokens();
  }, []);
  const mcpUrl = `${location.origin}/mcp`;
  async function copy(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(success);
    } catch {
      notify(
        "Не удалось скопировать. Выделите и скопируйте текст вручную.",
        true,
      );
    }
  }
  return (
    <>
      <PageTop label="Настройки" />
      <div className="title-row">
        <div>
          <span className="eyebrow">ВАШЕ ПРОСТРАНСТВО ПОД КОНТРОЛЕМ</span>
          <h1>
            Настройки<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Подключайте агента и берите медиатеку с собой.
          </p>
        </div>
      </div>
      <div className="settings-layout">
        <YoutubeSyncSettings />
        <HistorySettings items={library.items} playlists={library.playlists} />
        <section className="settings-card">
          <div className="settings-card-heading">
            <span className="settings-icon">
              <KeyRound size={22} />
            </span>
            <div>
              <h2>Подключение ИИ-агента</h2>
              <p>
                Пусть ваш агент помогает собирать и настраивать медиатеку через
                MCP.
              </p>
            </div>
          </div>
          <label>
            Адрес MCP-сервера
            <div className="copy-field">
              <input value={mcpUrl} readOnly />
              <button
                className="icon-button"
                aria-label="Скопировать адрес MCP"
                onClick={() => copy(mcpUrl, "Адрес MCP скопирован")}
              >
                <Copy size={16} />
              </button>
            </div>
          </label>
          <p className="small muted">
            Добавьте этот адрес в MCP-клиент агента и передайте личный токен как{" "}
            <code>Authorization: Bearer …</code>. Агент получает доступ только к
            вашей библиотеке.
          </p>
          <div className="section-heading token-heading">
            <h3>Личные токены</h3>
            <span className="small muted">{tokens.length} активно</span>
          </div>
          <ErrorMessage error={error} />
          <div className="token-list">
            {tokens.map((token) => (
              <div key={token.id}>
                <span className="token-dot">
                  <KeyRound size={15} />
                </span>
                <div>
                  <strong>{token.name}</strong>
                  <small>
                    Создан{" "}
                    {new Date(token.createdAt).toLocaleDateString("ru-RU")}
                  </small>
                </div>
                <Button
                  className="subtle compact"
                  onClick={async () => {
                    try {
                      await api(`/tokens/${token.id}`, "DELETE");
                      await loadTokens();
                      notify(
                        "Токен отозван. Агент больше не сможет его использовать.",
                      );
                    } catch (e) {
                      notify((e as Error).message, true);
                    }
                  }}
                >
                  Отозвать
                </Button>
              </div>
            ))}
            {!tokens.length && (
              <p className="muted small">
                Пока нет токенов. Создайте отдельный для каждого агента.
              </p>
            )}
          </div>
          <form
            className="create-token-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const data = await api("/tokens", "POST", { name });
                setNewToken(data.token);
                setName("");
                await loadTokens();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              aria-label="Название токена"
              placeholder="Название, например Codex"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Button
              className="primary"
              type="submit"
              busy={busy}
              disabled={!name.trim()}
            >
              <Plus size={16} />
              Создать токен
            </Button>
          </form>
        </section>
        <section className="settings-card">
          <div className="settings-card-heading">
            <span className="settings-icon warm">
              <FolderOpen size={22} />
            </span>
            <div>
              <h2>Ваша медиатека — с вами</h2>
              <p>
                Переносите записи, теги, плейлисты и настройки в другую
                установку или аккаунт.
              </p>
            </div>
          </div>
          <div className="export-block">
            <h3>Экспортировать библиотеку</h3>
            <p className="small muted">
              Архив сохраняет названия и связи между записями. Пароли, сессии и
              токены в него не входят.
            </p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={includeFiles}
                onChange={(e) => setIncludeFiles(e.target.checked)}
              />
              <span>
                Включить локальные медиафайлы
                <small>
                  Без файлов сохранятся метаданные и ссылки на источники.
                </small>
              </span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} />
              <span>Включить личные заметки</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={includeHistorySummary} onChange={(event) => setIncludeHistorySummary(event.target.checked)} />
              <span>Включить сводку прослушиваний<small>Счётчики для правил плейлистов.</small></span>
            </label>
            <Button
              className="subtle"
              busy={exportBusy}
              onClick={async () => {
                setExportBusy(true);
                try {
                  await api("/jobs", "POST", {
                    kind: "export",
                    input: { includeFiles, includeNotes, includeHistorySummary },
                  });
                  await refresh();
                  notify(
                    "Экспорт запущен. Ссылка на архив появится в заданиях.",
                  );
                  navigate("/jobs");
                } catch (e) {
                  notify((e as Error).message, true);
                } finally {
                  setExportBusy(false);
                }
              }}
            >
              <Download size={16} />
              Создать архив
            </Button>
          </div>
          <div className="import-block">
            <h3>Импортировать архив</h3>
            <p className="small muted">
              Hibiki проверит файлы и связи перед применением. Текущая
              библиотека сохранится.
            </p>
            <Button className="subtle" onClick={openImport}>
              <Upload size={16} />
              Выбрать архив
            </Button>
          </div>
        </section>
        <section className="settings-card account-settings">
          <div className="settings-card-heading">
            <span className="avatar">
              {user.login.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <h2>{user.login}</h2>
              <p>Личный аккаунт в вашей установке Hibiki</p>
            </div>
            <span className="status-pill">
              <span className="online-dot" />
              Подключён
            </span>
          </div>
          <p className="muted small">
            Положение в очереди, громкость, перемешивание и повтор сохраняются
            автоматически. После перезагрузки нажмите «Воспроизвести», чтобы
            продолжить.
          </p>
        </section>
      </div>
      {newToken && (
        <Modal
          title="Токен готов"
          subtitle="Скопируйте его сейчас — полностью он показывается один раз."
          close={() => setNewToken("")}
        >
          <div className="token-secret">
            <code>{newToken}</code>
            <button
              className="icon-button"
              aria-label="Скопировать токен"
              onClick={() => copy(newToken, "Токен скопирован")}
            >
              <Copy size={18} />
            </button>
          </div>
          <p className="muted small">
            Сохраните токен в настройках вашего агента. При необходимости его
            можно отозвать на этой странице.
          </p>
          <div className="modal-actions">
            <Button className="primary" onClick={() => setNewToken("")}>
              Готово
              <Check size={16} />
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
