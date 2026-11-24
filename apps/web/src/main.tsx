import { KanameSettings } from "./KanameSettings";
import React, {
  useEffect,
  useMemo,
  useSyncExternalStore,
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
  useSearchParams,
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
  FolderOpen,
  Sparkles,
  CheckCircle2,
  ListPlus,
  RefreshCw,
  Heart,
} from "lucide-react";
import type {
  ItemDto,
  LibraryDto,
  LibraryCardOverviewDto,
  PlaylistDto,
  PlaylistDetailDto,
  PlaylistDefinition,
  ResolvedPlaylist,
  ShareLinkDto,
  TagDto,
  UserDto,
} from "@hibiki/contracts";
import { api, ApiError, setWorkspaceOwner, formatDuration, humanDuration, mediaWord } from "./api.ts";
import { ItemArtwork } from "./ItemArtwork.tsx";
import { PlaylistCard, PlaylistCover } from "./PlaylistCard";
import { ruleDescription, usesListeningHistory } from "./playlist-rules";
import { LibraryPages, fetchItems, searchBody } from "./library-pages";
import { PlayerProvider, usePlayer } from "./player.tsx";
import { missingClassification } from "@hibiki/contracts/classification";
import { TagNavigation } from "./TagNavigation";
import { ClassificationMigration } from "./ClassificationMigration";
import { GroupSelect, TagPicker, PerformanceEditor } from "./ClassificationEditor";
import { batchTagChanges, compositionDelta, groupKeys, groups, groupOf, itemPerformance, missingLabels, TagCatalog,
  type BatchMode, type Performance, type PerformanceFilter, type TagGroup, type Voice } from "./taxonomy";
import { ItemTagList } from "./LibraryItemControls.tsx";
import { playbackSources } from "./player-model.ts";
import { resetLibraryFilters, librarySourceBadges, matchesSearch, sourceAvailability, type LibraryView } from "./library-search.ts";
import { LibrarySearchControls, useLibrarySearch } from "./LibrarySearchControls.tsx";
import { NoteEditor, NoteIndicator, NotesContext, NotesLoadError, useNotes, useNotesController } from "./NoteEditor.tsx";
import { noteFor } from "./note-model.ts";
import { SourceReplacement } from "./SourceReplacement.tsx";
import { SharedItemStatus, useSavedSharedPlaylists } from "./LibrarySharing";
import { issueShare, kanameLoginHref } from "./sharing-model";
import { pollWhileVisible } from "./use-sharing-request";
import { YoutubeLocalAdditions, YoutubeLinkedPlaylist, YoutubeLinkImport, YoutubeSyncNotifications, YoutubeSyncSettings } from "./YoutubeSync.tsx";
import { useHistoryRevision } from "./history-events.ts";
import type { HistoryPreference } from "./listening-client.ts";
import "./styles.css";
import "./library-view.css";
import "./taxonomy.css";

const RuleEditor = React.lazy(() => import("./RuleEditor"));
const loadSharing = () => import("./Sharing");
const HistorySettings = React.lazy(() => import("./HistorySettings").then(module => ({ default: module.HistorySettings })));
const IssueShare = React.lazy(() => loadSharing().then(module => ({ default: module.IssueShare })));
const ShareManager = React.lazy(() => loadSharing().then(module => ({ default: module.ShareManager })));
const SharedMediaPage = React.lazy(() => loadSharing().then(module => ({ default: module.SharedMediaPage })));
const SavedSharedPlaylistCard = React.lazy(() => loadSharing().then(module => ({ default: module.SavedSharedPlaylistCard })));

const EMPTY: LibraryDto = { items: [], tags: [], playlists: [], jobs: [] };
type Toast = { id: number; text: string; error?: boolean };
const DataContext = createContext<{
  library: LibraryDto;
  overview: LibraryCardOverviewDto;
  refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
  openImport: () => void;
}>({
  library: EMPTY,
  overview: {...EMPTY, playlists: [], total: 0, tagCounts: {}, revision: ""},
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
  kaname,
  setup,
  onLogin,
}: {
  setup: boolean;
  kaname: boolean;
  onLogin: (user: UserDto) => void;
}) {
  const registrationEnabled = import.meta.env.VITE_PROVISIONED_ACCOUNTS_ONLY !== "1";
  const [register, setRegister] = useState(registrationEnabled && setup),
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
          {kaname ? <a className="primary" href={kanameLoginHref(location.pathname)}>Войти через Kaname <ArrowUpRight size={17} /></a> : <form onSubmit={submit}>
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
                minLength={register ? 10 : undefined}
                maxLength={200}
                placeholder={register ? "Не менее 10 символов" : undefined}
                required
              />
            </label>
            <ErrorMessage error={error} />
            <Button type="submit" className="primary full" busy={busy}>
              {register ? "Создать медиатеку" : "Войти"}
              <ArrowUpRight size={17} />
            </Button>
          </form>}
          {!kaname && registrationEnabled && <p className="auth-switch">
            {register ? "Уже есть аккаунт?" : "Первый раз здесь?"}{" "}
            <button
              onClick={() => {
                setRegister(!register);
                setError("");
              }}
            >
              {register ? "Войти" : "Создать аккаунт"}
            </button>
          </p>}
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
    [kaname, setKaname] = useState(false),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  function enter(user: UserDto | null) {
    setWorkspaceOwner(user?.id);
    setUser(user);
  }
  async function check() {
    setLoading(true);
    try {
      const data = await api("/me");
      enter(data.user);
      setSetup(data.setupRequired);
      setKaname(Boolean(data.kanameEnabled));
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
      kaname={kaname}
      logout={async () => {
        await api("/auth/logout", "POST");
        enter(null);
      }}
    />
  ) : (
    <Auth kaname={kaname} setup={setup} onLogin={enter} />
  );
}
function Workspace({
  user, kaname,
  logout,
}: {
  user: UserDto;
  kaname: boolean;
  logout: () => Promise<void>;
}) {
  const [overview, setOverview] = useState<LibraryCardOverviewDto>({...EMPTY, playlists: [], total: 0, tagCounts: {}, revision: ""}),
    [settings, setSettings] = useState<any>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [toasts, setToasts] = useState<Toast[]>([]),
    [importOpen, setImportOpen] = useState(false),
    [createOpen, setCreateOpen] = useState(false),
    [importSettingsLoading, setImportSettingsLoading] = useState(false),
    [playlistQuery, setPlaylistQuery] = useState(""),
    [tagQuery, setTagQuery] = useState("");
  const library: LibraryDto = useMemo(() => ({items: [], playlists: [], tags: overview.tags, jobs: overview.jobs}), [overview.tags, overview.jobs]);
  const request = useRef(0);
  const overviewSignature = useRef("");
  const notes = useNotesController();
  const librarySearch = useLibrarySearch(user.id);
  const seenImports = useRef<Set<string> | null>(null);
  const navigate = useNavigate();
  function browseTag(id: string) {
    librarySearch[1]((old) => ({ ...resetLibraryFilters(old), query: "", tagIds: [id] }));
    navigate("/");
    window.scrollTo(0, 0);
  }
  function notify(text: string, error = false) {
    const id = Date.now() + Math.random();
    setToasts((old) => [...old, { id, text, error }]);
    setTimeout(() => setToasts((old) => old.filter((t) => t.id !== id)), 6000);
  }
  async function refresh() {
    const sequence = ++request.current;
    const result = await api<LibraryCardOverviewDto>("/library/overview?playlists=summary");
    if (sequence !== request.current) return;
    const signature = JSON.stringify(result);
    if (signature !== overviewSignature.current) {
      overviewSignature.current = signature;
      setOverview(result);
    }
  }
  async function load() {
    try {
      const [, preferences] = await Promise.all([refresh(), api("/settings")]);
      setSettings(preferences);
      setReady(true);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    return () => {request.current++;};
  }, []);
  useEffect(() => {
    if (!ready) return;
    let running = false;
    const interval = setInterval(async () => {
      if (running) return;
      running = true;
      try { await refresh(); } catch { /* The next polling tick retries. */ }
      finally { running = false; }
    }, 3000);
    return () => clearInterval(interval);
  }, [ready]);
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
        library, overview,
        refresh,
        notify,
        openImport: () => setImportOpen(true),
      }}
    >
      <PlayerProvider
        revision={overview.revision}
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
              <NavLink to="/" end aria-label="Медиатека" title="Медиатека">
                <Library size={19} />
                <span>Медиатека</span>
                <span className="nav-count">{overview.total}</span>
              </NavLink>
              <NavLink to="/player" aria-label="Плеер" title="Плеер">
                <AudioLines size={19} />
                <span>Плеер</span>
              </NavLink>
              <NavLink to="/playlists" aria-label="Плейлисты" title="Плейлисты">
                <ListMusic size={19} />
                <span>Плейлисты</span>
              </NavLink>
              <NavLink to="/tags" aria-label="Теги" title="Теги">
                <Tags size={19} />
                <span>Теги</span>
              </NavLink>
              <NavLink to="/jobs" aria-label="Задания" title="Задания">
                <Download size={19} />
                <span>Задания</span>
                {activeJobs > 0 && (
                  <span className="job-count">{activeJobs}</span>
                )}
              </NavLink>
              <NavLink to="/share-links" aria-label="Мои ссылки" title="Мои ссылки">
                <Link2 size={19} />
                <span>Мои ссылки</span>
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
              {overview.playlists.slice(0, 12).map((p, index) => (
                <NavLink key={p.id} to={`/playlists/${p.id}`}>
                  <span className={`playlist-dot dot-${index % 5}`} />
                  <span className="truncate">{p.title}</span>
                  {!p.manual && <Sparkles size={12} />}
                </NavLink>
              ))}
              {!overview.playlists.length && (
                <p className="sidebar-hint">
                  Здесь будут подборки,
                  <br />
                  собранные вами.
                </p>
              )}
            </nav>
            <div className="sidebar-bottom">
              <YoutubeSyncNotifications reload={refresh} />
              <NavLink className="settings-link" to="/settings" aria-label="Настройки" title="Настройки">
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
            <React.Suspense fallback={<div className="loading-inline" role="status"><LoaderCircle size={18} className="spin" />Загружаем…</div>}>
            <Routes>
              <Route path="/player" element={watchPlayer} />
              <Route path="/" element={<LibraryPage userId={user.id} search={librarySearch} />} />
              <Route
                path="/playlists"
                element={<PlaylistsPage query={playlistQuery} onQuery={setPlaylistQuery} onCreate={() => setCreateOpen(true)} />}
              />
              <Route path="/playlists/:id" element={<PlaylistRoute onBrowseTag={browseTag} />} />
              <Route path="/tags" element={<TagsPage query={tagQuery} onQuery={setTagQuery} onBrowse={browseTag} />} />
              {kaname && <Route path="/admin" element={<KanameSettings userId={user.id} adminPage />} />}
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/share-links" element={<ShareManager />} />
              <Route path="/share/:token" element={<SharedMediaPage refreshLibrary={refresh} />} />
              <Route path="/shared-playlists/:id" element={<SharedMediaPage saved refreshLibrary={refresh} />} />
              <Route path="/settings" element={<WithCatalog><SettingsPage user={user} kaname={kaname} /></WithCatalog>} />
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
            </React.Suspense>
            </div>
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
function useCatalog(enabled = true) {
  const { overview } = useData();
  const [catalog, setCatalog] = useState<Pick<LibraryDto, "items" | "playlists">>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const playlistVersion = useMemo(() => enabled
    ? JSON.stringify(overview.playlists.map(p => [p.id, p.revision, p.youtubeLinked]))
    : undefined, [enabled, overview.playlists]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setError("");
    api<LibraryDto>("/library", "GET", undefined, undefined, controller.signal)
      .then(({ items, playlists }) => { if (!controller.signal.aborted) setCatalog({ items, playlists }); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [enabled, overview.revision, playlistVersion, retry]);
  return { catalog, error, retry: () => setRetry(n => n + 1) };
}

function WithCatalog({children}: {children: ReactNode}) {
  const context = useData();
  const { catalog, error, retry } = useCatalog();
  if (error) return <div role="alert"><ErrorMessage error={error} /><Button onClick={retry}>Повторить</Button></div>;
  if (!catalog) return <div role="status" className="loading-inline">Загружаем каталог…</div>;
  return <DataContext.Provider value={{...context, library: {...context.library, ...catalog}}}>{children}</DataContext.Provider>;
}

const LibraryPage = React.memo(function LibraryPage({ userId, search }: { userId: string; search: ReturnType<typeof useLibrarySearch> }) {
  const { library, overview, notify, openImport } = useData(),
    player = usePlayer();
  const [filters, setFilters] = search;
  const [selected, setSelected] = useState<string[]>([]),
    [batchOpen, setBatchOpen] = useState(false);
  const viewKey = `hibiki:library-view:${userId}`;
  const [view, setView] = useState<LibraryView>(() => {
    try {
      return localStorage.getItem(viewKey) === "cards" ? "cards" : "list";
    } catch {
      return "list";
    }
  });
  const pages = useMemo(() => new LibraryPages((cursor, signal, selectionId) =>
    api("/library/page", "POST", { ...searchBody(filters, selectionId), cursor }, undefined, signal)), [filters]);
  const previousFilters = useRef<typeof filters>(undefined);
  const {items, loading, error, nextCursor, total, tagCounts, selectionId} = useSyncExternalStore(pages.subscribe, pages.snapshot);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    pages.open(filters, previousFilters.current);
    previousFilters.current = filters;
    return pages.cancel;
  }, [pages, filters, overview.revision]);
  const watchesAvailability = !!(filters.availability || filters.provider);
  const showsShared = items.some(item => item.shared);
  useEffect(() => {
    if (watchesAvailability) return pollWhileVisible(() => pages.refresh(true));
    if (showsShared) return pollWhileVisible(() => pages.revalidateShared());
  }, [pages, watchesAvailability, showsShared]);
  useEffect(() => {
    if (!nextCursor || loading || error || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void pages.more();
    }, {rootMargin: "400px"});
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [pages, nextCursor, loading, error]);
  const actions = useRef(0);
  useEffect(() => () => {actions.current++;}, [pages, overview.revision]);
  const idQuery = useMemo(() => {
    let pending: Promise<string[]> | undefined;
    const read = (id?: string) => api<{ids: string[]}>("/library/ids", "POST", searchBody(filters, id), "low")
      .then(result => result.ids);
    return () => pending ??= pages.fullOrder(selectionId, read)
      .then(ids => {
        if (watchesAvailability) pending = undefined;
        return ids;
      }).catch(e => { pending = undefined; throw e; });
  }, [pages, filters, selectionId, overview.revision, watchesAvailability]);
  const pageComplete = !loading && !nextCursor && !error && items.length === total;
  const pageIds = useMemo(() => items.map(item => item.id), [items]);
  const allIds = () => pageComplete ? Promise.resolve(pageIds) : idQuery();
  function play(item?: ItemDto) {
    const index = item ? items.findIndex(entry => entry.id === item.id) : 0;
    const options = {fromLibrary: true, loadQueueIds: pageComplete ? undefined : idQuery};
    if (item) player.activateItem(items, index, undefined, options);
    else player.start(items, 0, undefined, options);
  }
  const catalog = useMemo(() => new TagCatalog(library.tags), [library.tags]);
  const restrictsFacets = filters.sort === "recent" || filters.query.trim() || filters.kind || filters.provider || filters.availability || filters.favoriteOnly
    || filters.minDuration || filters.maxDuration || filters.addedFrom || filters.addedThrough || filters.performanceFilter
    || filters.needsClassification || filters.missingGroup;
  const selectedIds = new Set(selected);
  const hasSelection = selected.length > 0;
  const [selectionScope, setSelectionScope] = useState<{query: typeof idQuery; ids: string[]}>();
  useEffect(() => {
    if (!hasSelection || pageComplete || !total) return;
    let active = true;
    void idQuery().then(ids => {if (active) setSelectionScope({query: idQuery, ids});}).catch(() => {});
    return () => {active = false;};
  }, [hasSelection, pageComplete, idQuery, total]);
  const scope = pageComplete ? pageIds : selectionScope?.query === idQuery ? selectionScope.ids : undefined;
  const allSelected = !!scope?.length && hasSelection && scope.every(id => selectedIds.has(id));
  const selectAll = (
    <label className="collection-select-all">
      <input type="checkbox" aria-label="Выбрать все найденные записи" checked={allSelected}
        ref={input => { if (input) input.indeterminate = !allSelected && (scope ?? pageIds).some(id => selectedIds.has(id)); }}
        onChange={async event => {
          const checked = event.target.checked;
          const request = ++actions.current;
          try {
            const ids = new Set(await allIds());
            if (request !== actions.current) return;
            setSelected(old => checked ? [...new Set([...old, ...ids])] : old.filter(id => !ids.has(id)));
            setSelectionScope({query: idQuery, ids: [...ids]});
          } catch (e) { notify((e as Error).message, true); }
        }} />
      Выбрать все
    </label>
  );

  function changeView(next: LibraryView) {
    setView(next);
    try {
      localStorage.setItem(viewKey, next);
    } catch {
      // The current view still works when browser storage is unavailable.
    }
  }

  return (
    <TagNavigation catalog={catalog} archivedTagNames={overview.archivedTagNames} counts={tagCounts ?? (restrictsFacets ? undefined : overview.tagCounts)}
      search={filters} onChange={setFilters} userId={userId} hasPlayer={!!player.current}>
      <div className="title-row library-title-row">
        <h1>Медиатека</h1>
        <Button className="primary" onClick={openImport} aria-label="Добавить медиа" title="Добавить медиа">
          <Plus size={17} />
          <span>Добавить медиа</span>
        </Button>
      </div>
      <section className="library-section">
        <LibrarySearchControls
          value={filters}
          onChange={setFilters}
          tags={library.tags}
          count={total}
          selectAll={total > 0 ? selectAll : undefined}
          view={view}
          onViewChange={changeView}
          onPlay={() => void play()}
        />
        <NotesLoadError />
        {selected.length > 0 && (
          <div className="selection-toolbar">
            <strong>Выбрано: {selected.length}</strong>
            <CreateSelectionPlaylist ids={selected} onSaved={() => setSelected([])} />
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
          selectedTags={filters.tagIds}
          showMissing={!!(filters.needsClassification || filters.missingGroup)}
          onPerformance={value => setFilters(old => ({...old,performanceFilter:value}))}
          onSelected={setSelected}
          onActivate={item => void play(item)}
          onTag={(id) => setFilters((old) => (
            old.tagIds.includes(id) ? old : { ...old, tagIds: [...old.tagIds, id] }
          ))}
        />
        <div ref={sentinel} aria-hidden="true" />
        {loading && <div role="status" className="loading-inline"><LoaderCircle className="spin" size={18} /> Загружаем записи…</div>}
        {error && <div role="alert"><ErrorMessage error={error} /><Button onClick={() => void pages.retry()}>Повторить загрузку</Button></div>}
        {!loading && !error && !items.length && (
          <EmptyState
            title={
              filters.sort === "recent" ? "Среди найденных треков пока нет прослушанных"
                : overview.total ? "Ничего не найдено"
                : "Начнём вашу коллекцию"
            }
            text={
              overview.total
                ? "Измените условия поиска или сбросьте фильтры."
                : "Загрузите любимые аудио и видео или добавьте ссылку с YouTube."
            }
            action={
              !overview.total && (
                <Button className="primary" onClick={openImport}>
                  <Plus size={16} />
                  Добавить медиа
                </Button>
              )
            }
          />
        )}
      </section>
      {batchOpen && (
        <BatchTags ids={selected} close={() => setBatchOpen(false)} />
      )}
    </TagNavigation>
  );
});
function CreateSelectionPlaylist({ ids, onSaved }: { ids: string[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button className="subtle compact" onClick={() => setOpen(true)}>
      <ListPlus size={15} /> Создать плейлист
    </Button>
    {open && <PlaylistEditor initialIds={ids} close={() => setOpen(false)} onSaved={onSaved} />}
  </>;
}

function ItemTable({
  items,
  playlistOrder,
  reasons,
  selected,
  onSelected,
  onActivate,
  onTag,
  selectedTags, showMissing, onPerformance,
  reorder,
  playlistId,
  view,
}: {
  items: ItemDto[];
  playlistOrder?: string[];
  reasons?: Record<string, string[]>;
  selected?: string[];
  onSelected?: (ids: string[]) => void;
  onActivate?: (item: ItemDto) => void;
  onTag?: (id: string) => void;
  selectedTags?:string[];
  showMissing?:boolean;
  onPerformance?:(value:PerformanceFilter) => void;
  reorder?: (id: string, direction: number) => void;
  playlistId?: string;
  view?: LibraryView;
}) {
  const player = usePlayer(),
    { library, refresh, notify } = useData();
  const catalog = useMemo(() => new TagCatalog(library.tags), [library.tags]);
  const { notes } = useNotes();
  const [editTarget, setEditTarget] = useState<{ id: string; focusSource?: boolean }>(),
    [remove, setRemove] = useState<ItemDto | null>(null),
    [shareTarget, setShareTarget] = useState<{ id: string; issued: Promise<ShareLinkDto> }>(),
    [copying, setCopying] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const currentItems = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const edit = editTarget ? currentItems.get(editTarget.id) : undefined;
  const inLibrary = view !== undefined;
  const selectedIds = new Set(selected);
  async function job(kind: string, itemId: string, mode?: string) {
    try {
      await api("/jobs", "POST", { kind, input: { itemId, mode } });
      notify("Задание добавлено в очередь");
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  async function createLocalCopy(itemId: string) {
    setCopying(previous => [...previous, itemId]);
    try {
      await api(`/items/${encodeURIComponent(itemId)}/shared-copy`, "POST", {});
      notify("Задание на создание локальной копии добавлено в очередь");
      void refresh().catch(() => {});
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setCopying(previous => previous.filter(id => id !== itemId));
    }
  }

  const results = items.map((item, index) => {
    const ownSources = item.sources.filter(source => !source.shared);
    const borrowedOnly = !!item.shared && !ownSources.length;
    const canCopy = item.shared?.available && item.sources.some(source => source.shared && source.status !== "unavailable");
    const streamUrl = ownSources.find((source) => source.streamUrl)?.streamUrl;
    const externalUrl = ownSources.find((source) => source.url)?.url;
    const artworkSource = item.sources.find((source) => source.thumbnail);
    const available = playbackSources(item).length > 0;
    const active = player.current?.id === item.id;
    const playing = active && player.playing;
    const status = sourceAvailability(item);
    const hasItemNote = !!noteFor(notes, "item", item.id);
    const hasSourceNote = ownSources.some((source) => noteFor(notes, "source", source.id));
    const video = item.kind === "video";
    const yt = ownSources.some((source) => source.provider === "youtube");
    const kindLabel = video ? "Видео" : "Аудио";
    const playLabel = playing ? "Приостановить"
      : !inLibrary && video && (!active || player.waitingForVideo || player.mode === "original") ? "Смотреть"
      : "Воспроизвести";
    const itemLoading = active && player.loadingLabel;
    const coverLabel = `${playLabel} ${item.title}`;
    const activate = () => onActivate ? onActivate(item) : player.activateItem(items, index, playlistId, { fromLibrary: inLibrary, queueIds: playlistOrder });
    const artwork = <ItemArtwork source={artworkSource} kind={item.kind} />;
    const cover = inLibrary ? (
      <button type="button" className={`item-art entry-cover art-${index % 6}`}
        aria-label={video ? `${coverLabel} · обложка` : coverLabel} title={available ? coverLabel : "Нет рабочего источника"}
        disabled={!available} onClick={activate}>
        {artwork}
        {available && (
          <span className="entry-cover-control" aria-hidden="true">
            {itemLoading ? <span className="cover-loading" /> : playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
          </span>
        )}
      </button>
    ) : <span className={`item-art art-${index % 6}`}>{artwork}</span>;
    const itemTitle = (
      <>
        <button className="item-title" title={item.title} onClick={() => setEditTarget({ id: item.id })}>{item.title}</button>
        {(hasItemNote || hasSourceNote) && (
          <NoteIndicator label={hasItemNote ? "Есть заметка у записи" : "Есть заметка у источника"} />
        )}
      </>
    );
    const favorite = <FavoriteButton item={currentItems.get(item.id) ?? item} />;
    const selection = inLibrary && selected && (
      <input
        type="checkbox"
        aria-label={`Выбрать ${item.title}`}
        checked={selectedIds.has(item.id)}
        onChange={(event) => onSelected?.(
          event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id),
        )}
      />
    );
    const menu = (
      <details className="row-menu" name={inLibrary ? "library-item-actions" : undefined}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !event.currentTarget.open) return;
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }}
      >
        <summary aria-label={`Действия с ${item.title}`}>
          <MoreHorizontal size={19} />
        </summary>
        <div className="dropdown" onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button:not(:disabled), a")) {
            const details = event.currentTarget.parentElement;
            if (details instanceof HTMLDetailsElement) {
              details.open = false;
              details.querySelector("summary")?.focus();
            }
          }
        }}>
          <button onClick={() => setEditTarget({ id: item.id })}>
            <Pencil size={14} />
            Детали записи
          </button>
          {!borrowedOnly && <button onFocus={() => void loadSharing()} onPointerEnter={() => void loadSharing()}
            onClick={() => setShareTarget({ id: item.id, issued: issueShare("item", item.id) })}>
            <Link2 size={14} />
            Поделиться
          </button>}
          {canCopy && <button disabled={copying.includes(item.id)} onClick={() => void createLocalCopy(item.id)}>
            <Copy size={14} />
            Создать локальную копию
          </button>}
          {!borrowedOnly && status === "unavailable" && (
            <button onClick={() => setEditTarget({ id: item.id, focusSource: true })}>
              <RefreshCw size={14} />
              Заменить источник
            </button>
          )}
          <button
            disabled={active || !player.queueEditable}
            onClick={() => {
              player.playNext(item, playlistId);
              notify("Запись будет играть следующей");
            }}
          >
            <ListPlus size={14} />
            Играть следующей
          </button>
          <button
            disabled={!player.queueEditable}
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
              <button disabled={index === (playlistOrder?.length ?? items.length) - 1} onClick={() => reorder(item.id, 1)}>
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

    const badges = librarySourceBadges(item);
    return (
      <article className={`collection-entry ${active ? "current" : ""}`}
        key={item.id} aria-current={active || undefined}>
        <div className="entry-select">{inLibrary ? selection : (
          <button className="icon-button playlist-track-play" type="button" disabled={!available} onClick={activate}
            aria-label={coverLabel} title={coverLabel}>
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
        )}</div>
        <div className="entry-identity">
          {cover}
          <div className="entry-description">
            <div className="item-name-actions">{itemTitle}</div>
            <SharedItemStatus item={item} />
            <ItemTagList tags={item.tags} catalog={catalog} selected={selectedTags} performance={item.performance}
              voices={item.voices} onTag={onTag} onPerformance={onPerformance}/>
            {showMissing && <small className="missing-reasons">Не указано · {missingClassification(item.tags,item.performance,item.voices).map(k => missingLabels[k]).join(", ")}</small>}
            <div className="entry-meta">
              <span>{itemLoading || kindLabel} · {formatDuration(item.duration)}</span>
              {badges.map(({ provider, status, label }) => {
                const Icon = provider === "youtube" ? Youtube : provider === "local" ? HardDrive : provider === "shared" ? Link2 : CircleAlert;
                return (
                  <span key={provider} className="entry-source" data-provider={provider} data-status={status}
                    role="img" aria-label={label} title={label}>
                    <Icon size={13} aria-hidden="true" />
                  </span>
                );
              })}
              {!available && item.shared?.available !== false && <span>Нет рабочего источника</span>}
            </div>
            {reasons?.[item.id] && (
              <details className="reason-details">
                <summary>Почему в плейлисте</summary>
                <p>{reasons[item.id]!.join(" · ")}</p>
              </details>
            )}
          </div>
        </div>
        <div className="entry-tools">{favorite}{menu}</div>
      </article>
    );
  });

  return (
    <>
      {(!inLibrary || items.length > 0) && (
        <div className={`item-collection ${view === "cards" ? "collection-cards" : "collection-list"}`}>
          <div className="collection-results">{results}</div>
        </div>
      )}
      {edit && (
        <EditItem
          key={edit.id}
          item={edit}
          focusSource={editTarget?.focusSource}
          close={() => setEditTarget(undefined)}
        />
      )}
      {shareTarget && <React.Suspense fallback={null}>
        <IssueShare kind="item" targetId={shareTarget.id} issued={shareTarget.issued} close={() => setShareTarget(undefined)} />
      </React.Suspense>}
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
    [tagIds, setTagIds] = useState(item.tags.filter(t => !t.archived).map((t) => t.id)),
    [performance,setPerformance] = useState<Performance>(item.performance ?? "unknown"),
    [voices,setVoices] = useState<Voice[]>(item.voices ?? []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const catalog = useMemo(() => new TagCatalog(library.tags), [library.tags]);
  const borrowedOnly = !!item.shared && item.sources.every(source => source.shared);
  const missing = missingClassification(tagIds.flatMap(id => catalog.byId.get(id) ?? []),performance,voices);
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
      <SharedItemStatus item={item} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const submitter = (e.nativeEvent as SubmitEvent).submitter;
            await api(`/items/${item.id}`, "PATCH", {
              ...(title !== item.title && {title}), tagIds, performance, voices,
              completeClassification: submitter instanceof HTMLButtonElement && submitter.name === "complete",
            });
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
        <div className="edit-classification">{groupKeys.map(key => <details key={key} className="edit-group">
          <summary>{groups[key]}<span>{catalog.active.filter(tag => tagIds.includes(tag.id) && groupOf(tag) === key).length}</span></summary>
          <TagPicker catalog={catalog} group={key} ids={tagIds} onChange={setTagIds}/>
        </details>)}</div>
        <PerformanceEditor performance={performance} voices={voices} onChange={(p,v) => {setPerformance(p);setVoices(v);}}/>
        <p className="small muted" role="status">{missing.length ? "Осталось указать: " + missing.map(key => missingLabels[key]).join(", ") : "Все обязательные поля заполнены"}</p>
        <ErrorMessage error={error} />
        <div className="modal-actions">
          <Button type="button" className="subtle" onClick={close}>
            Закрыть
          </Button>
          <Button type="submit" className={missing.length ? "primary" : "subtle"} busy={busy}>Сохранить</Button>
          <Button type="submit" name="complete" className="primary" disabled={!!missing.length} busy={busy}>Завершить разметку</Button>
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
                  {s.shared ? <Link2 size={16} /> : s.provider === "local" ? <HardDrive size={16} /> : <Youtube size={16} />}
                  {s.shared ? "Источник по ссылке" : s.provider === "local" ? "Локальный файл" : "YouTube"}
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
              {!s.shared && <NoteEditor kind="source" id={s.id} />}
            </div>
          ))}
        </section>
      )}
      <div ref={replacement}><SourceReplacement item={item} reload={refresh} localOnly={borrowedOnly} /></div>
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
  const {library,refresh,notify} = useData();
  const catalog = useMemo(() => new TagCatalog(library.tags), [library.tags]);
  const [group,setGroup] = useState<TagGroup|"performance">("source"), [chosen,setChosen] = useState<string[]>([]);
  const [mode,setMode] = useState<BatchMode>("add"), [busy,setBusy] = useState(false), [error,setError] = useState("");
  const [performance,setPerformance] = useState<Performance>("unknown"), [voices,setVoices] = useState<Voice[]>([]);
  const [preview,setPreview] = useState<{revision:string; changes:{id:string;tagIds?:string[];performance?:Performance;voices?:Voice[]}[];
    removed:{label:string;count:number}[] }>();
  async function prepare() {
    const {revision} = await api<LibraryCardOverviewDto>("/library/overview?playlists=summary");
    const items = await fetchItems(ids);
    if(items.length !== ids.length) throw Error("Состав выборки изменился. Выберите записи заново.");
    if (group !== "performance") {
      const {changes,removed} = batchTagChanges(items,chosen,group,mode);
      setPreview({revision, changes, removed:removed.map(({tag,count}) => ({label:catalog.paths(tag.id).join(" / ") || tag.name,count}))});
    } else {
      const current = itemPerformance(performance,voices).label;
      const changes = items.filter(t => itemPerformance(t.performance,t.voices).label !== current);
      const removed = new Map<string,number>();
      for (const item of changes) {
        const label = itemPerformance(item.performance,item.voices).label;
        removed.set(label, (removed.get(label) ?? 0)+1);
      }
      setPreview({revision, changes:changes.map(({id}) => ({id,performance,voices})),removed:[...removed].map(([label,count]) => ({label,count}))});
    }
  }
  async function submit() {
    setBusy(true);setError("");
    try {
      if (!preview) await prepare();
      else {
        await api("/items/batch","POST",{expectedRevision:preview.revision,changes:preview.changes});
        await refresh(); notify("Разметка обновлена"); close();
      }
    } catch(e) {setPreview(undefined);setError((e as Error).message);} finally {setBusy(false);}
  }
  return <Modal title={`Разметка для ${ids.length} записей`} close={close}>
    <fieldset className="batch-choices" disabled={busy} onChange={() => setPreview(undefined)}>
      <GroupSelect value={group} allowPerformance onChange={g => {setGroup(g);setChosen([]);}}/>
      {group === "performance" ? <PerformanceEditor performance={performance} voices={voices} onChange={(p,v) => {setPerformance(p);setVoices(v);}}/>
        : <><label>Действие<select value={mode} onChange={e => setMode(e.target.value as BatchMode)}>
          <option value="add">Добавить к существующим</option><option value="replace">Заменить значения раздела</option>
          <option value="remove">Убрать выбранные значения</option></select></label>
          <TagPicker key={group} group={group} catalog={catalog} ids={chosen} onChange={setChosen}/></>}
    </fieldset>
    {preview && <section className="batch-preview" aria-live="polite"><h3>Изменится записей: {preview.changes.length}</h3>
      {preview.removed.length > 0 && <><p>Будут сняты</p><ul>{preview.removed.map(r => <li key={r.label}>{r.label} · {r.count}</li>)}</ul></>}
    </section>}
    <ErrorMessage error={error}/><div className="modal-actions"><Button className="subtle" onClick={close}>Отмена</Button>
      <Button className="primary" disabled={preview?.changes.length === 0} busy={busy} onClick={() => void submit()}>{preview ? "Применить" : "Показать изменения"}</Button>
    </div></Modal>;
}
function PlaylistsPage({ query, onQuery, onCreate }: {
  query: string;
  onQuery: (query: string) => void;
  onCreate: () => void;
}) {
  const { overview } = useData();
  const { playlists: savedPlaylists, error: savedError, loading: savedLoading } = useSavedSharedPlaylists();
  const { notes } = useNotes();
  const [share, setShare] = useState<{ id: string; issued: Promise<ShareLinkDto> }>();
  const playlists = overview.playlists.filter((p) =>
    matchesSearch(query, p.title, p.description, noteFor(notes, "playlist", p.id)),
  );
  const shared = savedPlaylists.filter(playlist => matchesSearch(query, playlist.title, playlist.sharedBy));
  const resultCount = playlists.length + shared.length;
  return (
    <>
      <div className="title-row library-title-row">
        <h1>Плейлисты</h1>
        <Button className="primary" onClick={onCreate} aria-label="Создать плейлист" title="Создать плейлист">
          <Plus size={17} />
          <span>Создать плейлист</span>
        </Button>
      </div>
      <div className="section-heading">
        <h2>
          Найдено <span>{resultCount}</span>
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
      {savedError && <ErrorMessage error={savedError.message} />}
      <div className="playlist-grid">
        {playlists.map((p) => (
          <PlaylistCard key={p.id} playlist={p} hasNote={Boolean(noteFor(notes, "playlist", p.id))} onShare={() => setShare({ id: p.id, issued: issueShare("playlist", p.id) })} />
        ))}
        <React.Suspense fallback={null}>
          {shared.map(playlist => <SavedSharedPlaylistCard key={playlist.id} playlist={playlist} />)}
        </React.Suspense>
      </div>
      {share && <React.Suspense fallback={
        <Modal title="Поделиться" close={() => setShare(undefined)}>
          <div className="loading-inline" role="status"><LoaderCircle className="spin" size={18} />Создаём ссылку…</div>
        </Modal>
      }>
        <IssueShare key={share.id} kind="playlist" targetId={share.id} issued={share.issued} close={() => setShare(undefined)} />
      </React.Suspense>}
      {!resultCount && !savedError && !savedLoading && query && (
        <EmptyState
          title="Плейлист не найден"
          text="Измените запрос или очистите поиск."
          icon={<ListMusic size={29} />}
        />
      )}
      {!resultCount && !savedError && !savedLoading && !query && (
        <EmptyState title="Здесь будут ваши плейлисты" text="Соберите плейлист из записей или задайте правила подбора." />
      )}
    </>
  );
}
function LinkedPlaylistCatalog(props: Omit<React.ComponentProps<typeof YoutubeLocalAdditions>, "items">) {
  const { catalog, error, retry } = useCatalog();
  if (error) return <><ErrorMessage error={error} /><Button onClick={retry}>Повторить загрузку</Button></>;
  if (!catalog) return <div role="status" className="loading-inline">Загружаем записи медиатеки…</div>;
  return <YoutubeLocalAdditions {...props} items={catalog.items} />;
}
function PlaylistRoute({ onBrowseTag }: { onBrowseTag: (id: string) => void }) {
  const { id } = useParams();
  return id && <PlaylistPage key={id} id={id} onBrowseTag={onBrowseTag} />;
}
function PlaylistExclusions({ id, count, version }: { id: string; count: number; version: string }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<{ total: number; entries: ResolvedPlaylist["excluded"] }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPage(undefined);
    setError("");
    void api<{ total: number; entries: ResolvedPlaylist["excluded"] }>(
      `/playlists/${encodeURIComponent(id)}/exclusions?offset=${offset}`, "GET", undefined, undefined, controller.signal,
    ).then(result => {
      if (!result.entries.length && offset > 0) setOffset(0);
      else setPage(result);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [id, version, offset, retry, open]);
  return <details className="excluded-details" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Не вошли в плейлист: {count}</summary>
    {open && <>
      {page?.entries.map(item => <div key={item.id}><strong>{item.title}</strong><p>{item.reasons.join(" · ")}</p></div>)}
      {error ? <><ErrorMessage error={error} /><Button onClick={() => setRetry(n => n + 1)}>Повторить</Button></>
        : !page && <div role="status">Загружаем записи…</div>}
      {page && offset > 0 && <Button onClick={() => setOffset(n => Math.max(0, n - 100))}>Назад</Button>}
      {page && offset + page.entries.length < page.total && <Button onClick={() => setOffset(n => n + 100)}>Далее</Button>}
    </>}
  </details>;
}
function PlaylistPage({ id, onBrowseTag }: { id: string; onBrowseTag: (id: string) => void }) {
  const { library, overview, refresh, notify } = useData(),
    player = usePlayer(),
    navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const edit = params.get("edit") === "1";
  function setEdit(open: boolean) {
    const next = new URLSearchParams(params);
    if (open) next.set("edit", "1");
    else next.delete("edit");
    setParams(next, { replace: true });
  }
  const card = overview.playlists.find(p => p.id === id);
  const [playlist, setPlaylist] = useState<PlaylistDto>(),
    [resolved, setResolved] = useState<ResolvedPlaylist & { refreshAt: number | null } & Pick<PlaylistDetailDto, "ids" | "changeToken" | "validUntil" | "excludedCount" | "cover">>(),
    [usesHistory, setUsesHistory] = useState<boolean>(),
    [notFound, setNotFound] = useState(false),
    [error, setError] = useState(""),
    [copy, setCopy] = useState(false),
    [share, setShare] = useState<Promise<ShareLinkDto>>(),
    [remove, setRemove] = useState(false),
    [busy, setBusy] = useState(false),
    [loadingMore, setLoadingMore] = useState(false),
    [moreError, setMoreError] = useState("");
  const visibleRows = useRef(24);
  const sentinel = useRef<HTMLDivElement>(null);
  const moreRequest = useRef<AbortController | null>(null);
  const request = useRef<AbortController | null>(null);
  const historyRevision = useHistoryRevision(usesHistory !== false);
  const path = `/playlists/${encodeURIComponent(id)}`;
  async function resolve(background = false, metadataOnly = false) {
    request.current?.abort();
    moreRequest.current?.abort();
    moreRequest.current = null;
    setLoadingMore(false);
    setMoreError("");
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    try {
      if (metadataOnly) {
        setPlaylist(await api<PlaylistDto>(path, "GET", undefined, "high", signal));
      } else {
        const data = await api<PlaylistDetailDto>(path + "/detail?limit=" + visibleRows.current, "GET", undefined, background ? "low" : "high", signal);
        setPlaylist(data.playlist);
        setResolved({ ...data.resolved, ids: data.ids, cover: data.cover, changeToken: data.changeToken, validUntil: data.validUntil,
          refreshAt: data.validUntil === null ? null : performance.now() + (data.validUntil - data.serverNow),
          excludedCount: data.excludedCount });
        setUsesHistory(data.usesHistory);
      }
      setNotFound(false);
      setError("");
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError && e.status === 404) {
        setNotFound(true);
        setPlaylist(undefined);
        setResolved(undefined);
      } else if (!background) {
        setError((e as Error).message);
        if (!metadataOnly && e instanceof ApiError && e.status === 422) {
          setResolved(undefined);
          // Keep a broken rule editable even when evaluation fails.
          await api<PlaylistDto>(path, "GET", undefined, "high", signal).then(setPlaylist).catch(() => {});
        }
      }
    }
  }
  const contentKey = JSON.stringify([overview.revision, overview.playlists.map(p => [p.id, p.revision, p.youtubeLinked])]);
  useEffect(() => {
    if (!edit || !playlist || playlist.revision !== card?.revision) void resolve(false, edit);
    return () => { request.current?.abort(); moreRequest.current?.abort(); };
  }, [contentKey, historyRevision, edit]);
  useEffect(() => {
    if (edit || resolved?.refreshAt == null) return;
    const delay = Math.max(0, resolved.refreshAt - performance.now());
    const timer = window.setTimeout(() => void resolve(), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resolved, edit]);
  const hasSharedRows = resolved?.cover?.shared || !!resolved?.items.some(item => item.shared);
  useEffect(() => {
    if (!edit && hasSharedRows) return pollWhileVisible(() => resolve(true));
  }, [edit, hasSharedRows]);
  const hasMore = !!resolved && resolved.items.length < resolved.ids.length;
  async function loadMore() {
    if (!resolved || !hasMore || moreRequest.current) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    setLoadingMore(true);
    setMoreError("");
    const offset = resolved.items.length;
    const ids = resolved.ids.slice(offset, offset + 100);
    try {
      const { items } = await api<{items: ItemDto[]}>(path + "/rows", "POST", {
        offset, changeToken: resolved.changeToken, validUntil: resolved.validUntil,
      }, undefined, controller.signal);
      if (items.length !== ids.length || items.some((item, i) => item.id !== ids[i])) {
        await resolve();
        return;
      }
      visibleRows.current = offset + items.length;
      setResolved(previous => previous === resolved ? { ...resolved, items: [...resolved.items, ...items] } : previous);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.code === "playlist_changed") await resolve();
      else setMoreError((failure as Error).message);
    } finally {
      if (moreRequest.current === controller) {
        moreRequest.current = null;
        setLoadingMore(false);
      }
    }
  }
  useEffect(() => {
    if (!hasMore || edit || moreError || loadingMore || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "400px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [resolved, edit, hasMore, loadingMore, moreError]);
  if (notFound)
    return (
      <>
        <PageTop label="Плейлист" />
        <EmptyState
          title="Плейлист не найден"
          text="Возможно, он был удалён. Остальные подборки остаются в медиатеке."
          action={<Link className="button primary" to="/playlists">Все плейлисты</Link>}
        />
      </>
    );
  if (!playlist) {
    const status = error
      ? <><ErrorMessage error={error} /><Button onClick={() => void resolve(false, edit)}>Повторить</Button></>
      : <div className="loading-inline" role="status"><LoaderCircle className="spin" size={20} />Загружаем плейлист…</div>;
    return <><PageTop label="Плейлисты" />{card && <h1>{card.title}</h1>}
      {edit ? <Modal title="Изменить плейлист" close={() => setEdit(false)}>{status}</Modal> : status}
    </>;
  }
  const automatic = playlist.definition.rule.type !== "items";
  async function reorder(itemId: string, direction: number) {
    if (!resolved) return;
    const order = [...resolved.ids],
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
        <PlaylistCover title={playlist.title} items={resolved?.items}
          coverUrls={resolved?.cover?.url ? [resolved.cover.url, ...(card?.coverUrls ?? [])] : card?.coverUrls} large />
        <div>
          <span className="eyebrow">
            {playlist.youtubeLinked ? "СВЯЗАН С YOUTUBE" : automatic ? "СОСТАВНОЙ ПЛЕЙЛИСТ" : "ВАШ ПЛЕЙЛИСТ"}
          </span>
          <h1>{playlist.title}</h1>
          {playlist.description && <p className="muted">{playlist.description}</p>}
          <div className="playlist-meta">
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
              onClick={() => resolved && player.start(resolved.items, 0, playlist.id, { queueIds: resolved.ids })}
            >
              <Play size={16} fill="currentColor" />
              Воспроизвести
            </Button>
            <Button
              className="subtle"
              disabled={!resolved?.items.length}
              onClick={() => resolved && player.start(resolved.items, 0, playlist.id, { mode: "audio", queueIds: resolved.ids })}
            >
              <Headphones size={16} />
              Слушать
            </Button>
            <Button className="subtle" onClick={() => setEdit(true)}>
              <Pencil size={16} />
              {playlist.youtubeLinked ? "Название и описание" : automatic ? "Изменить правила" : "Изменить плейлист"}
            </Button>
            <Button className="subtle" onFocus={() => void loadSharing()} onPointerEnter={() => void loadSharing()}
              onClick={() => setShare(issueShare("playlist", playlist.id))}>
              <Link2 size={16} /> Поделиться
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
      {playlist.youtubeLinked && !edit && (
        <YoutubeLinkedPlaylist
          key={playlist.id}
          playlist={playlist}
          items={resolved?.items}
          LocalAdditions={LinkedPlaylistCatalog}
          libraryRevision={overview.revision}
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
              {ruleDescription(playlist.definition.rule, overview)}. Аудио и
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
        <button className="text-button" onClick={() => void resolve()}>
          <RefreshCw size={14} />
          Обновить состав
        </button>
      </div>
      {resolved ? (
        <>
          <ItemTable
            items={resolved.items}
            playlistOrder={resolved.ids}
            reasons={resolved.reasons}
            reorder={playlist.youtubeLinked ? undefined : reorder}
            playlistId={playlist.id}
            onTag={onBrowseTag}
          />
          {hasMore && <div ref={sentinel}>
            <ErrorMessage error={moreError} />
            <Button className="subtle" busy={loadingMore} onClick={() => void loadMore()}>Показать ещё</Button>
          </div>}
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
          {resolved.excludedCount > 0 && <PlaylistExclusions id={id} count={resolved.excludedCount}
            version={JSON.stringify([contentKey, resolved.changeToken, resolved.validUntil])} />}
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
          currentItems={resolved && !hasMore ? resolved.items : undefined}
          close={() => setEdit(false)}
          onSaved={() => {
            setEdit(false);
          }}
        />
      )}{" "}
      {copy && (
        <PlaylistEditor
          initialIds={resolved?.ids}
          close={() => setCopy(false)}
          onSaved={(saved) => {
            setCopy(false);
            navigate(`/playlists/${saved.id}`);
          }}
        />
      )}
      {share && <React.Suspense fallback={null}>
        <IssueShare key={playlist.id} kind="playlist" targetId={playlist.id} issued={share} close={() => setShare(undefined)} />
      </React.Suspense>}
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
function PlaylistEditor({
  playlist,
  initialIds,
  currentItems,
  close,
  onSaved,
}: {
  playlist?: PlaylistDto;
  initialIds?: string[];
  currentItems?: ItemDto[];
  close: () => void;
  onSaved: (p: PlaylistDto) => void;
}) {
  const context = useData();
  const { refresh, notify } = context;
  const [editRules, setEditRules] = useState(!playlist?.youtubeLinked && initialIds === undefined);
  const { catalog, error: catalogError, retry: retryCatalog } = useCatalog(editRules);
  const library = useMemo(() => ({ ...context.library, ...catalog }), [context.library, catalog]);
  const [title, setTitle] = useState(playlist?.title ?? ""),
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
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => { titleInput.current?.focus(); }, []);
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
  const playlistId = playlist?.id;
  const savedKey = useMemo(() => playlist && JSON.stringify(playlist.definition), [playlist?.definition]);
  const draftKey = useMemo(() => JSON.stringify(definition), [definition]);
  const changed = !!playlist && draftKey !== savedKey;
  const [savedComposition, setSavedComposition] = useState<{ key: string; items: ItemDto[] }>();
  const before = currentItems ?? (savedComposition?.key === savedKey ? savedComposition?.items : undefined);
  const delta = useMemo(() => changed && before && preview
    ? compositionDelta(before, preview.items) : undefined, [changed, before, preview]);

  useEffect(() => {
    // The cover opens the editor before the detail page loads its rows.
    // A quick rule change can also precede the first unmodified preview.
    if (!changed || before || !playlistId || !savedKey) return;
    const controller = new AbortController();
    api<ResolvedPlaylist>(`/playlists/${encodeURIComponent(playlistId)}/resolve`, "GET", undefined, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setSavedComposition({ key: savedKey, items: result.items }); })
      .catch(() => {}); // A broken original rule can still be repaired.
    return () => controller.abort();
  }, [changed, before, playlistId, savedKey]);

  useEffect(() => {
    if (!editRules) return;
    const controller = new AbortController();
    const { signal } = controller;
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      api<ResolvedPlaylist>("/playlists/preview", "POST", { definition, playlistId }, undefined, signal)
        .then(result => {
          if (signal.aborted) return;
          setPreview(result);
          setPreviewError("");
          if (savedKey === draftKey) setSavedComposition({ key: savedKey, items: result.items });
        })
        .catch(e => {
          if (signal.aborted) return;
          setPreviewError(e.message);
          setPreview(null);
        })
        .finally(() => { if (!signal.aborted) setPreviewBusy(false); });
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [draftKey, savedKey, editRules, historyRevision, playlistId]);
  return (
    <Modal
      wide={editRules}
      title={playlist?.youtubeLinked ? "Название и описание" : playlist ? "Настроить плейлист" : "Новый плейлист"}
      subtitle={editRules ? "Выберите записи или задайте связи. Состав проверяется сразу." : undefined}
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
            notify(playlist ? "Плейлист обновлён" : "Плейлист создан");
            onSaved(saved);
            void refresh().catch(e => notify(e.message, true));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className={editRules ? "editor-layout" : undefined}>
          <div className="editor-fields">
            <label>
              Название
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="Например, Для тихого вечера"
                required
                ref={titleInput}
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
            {!editRules && initialIds && <div className="section-heading editor-section-heading">
              <strong>{initialIds.length} {mediaWord(initialIds.length)} в порядке выбора</strong>
              <Button type="button" className="subtle compact" onClick={() => setEditRules(true)}>
                Настроить состав
              </Button>
            </div>}
            {editRules && catalogError && <div>
              <ErrorMessage error={catalogError} />
              <Button type="button" onClick={retryCatalog}>Повторить загрузку</Button>
            </div>}
            {editRules && !catalog && !catalogError && <div className="loading-inline" role="status">
              <LoaderCircle size={17} className="spin" /> Загружаем каталог для правил…
            </div>}
            {editRules && catalog && <>
            <div className="section-heading editor-section-heading">
              <h3>Правила состава</h3>
              <Sparkles size={16} />
            </div>
            <React.Suspense fallback={<div className="loading-inline" role="status">Загружаем редактор правил…</div>}>
              <RuleEditor
                library={library}
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
            </React.Suspense>
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
          {editRules && <aside className="preview-panel">
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
            {delta && !previewBusy && <details className="preview-excluded">
              <summary>Добавится: {delta.added.length} · Уйдёт: {delta.removed.length}</summary>
              {delta.added.map(item => <p key={item.id}>+ {item.title}</p>)}
              {delta.removed.map(item => <p key={item.id}>− {item.title}</p>)}
            </details>}
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
            disabled={!title.trim() || (editRules && (!catalog || !!catalogError || !!previewError || previewBusy))}
          >
            {busy ? "Сохраняем…" : playlist ? "Сохранить изменения" : "Создать плейлист"}
            {!busy && <Check size={16} />}
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
function TagsPage({ query, onQuery, onBrowse }: {
  query: string;
  onQuery: (query: string) => void;
  onBrowse: (id: string) => void;
}) {
  const { library, overview, refresh, notify } = useData(),
    [edit, setEdit] = useState<TagDto | "new" | null>(null),
    [name, setName] = useState(""),
    [group,setGroup] = useState<TagGroup>("extra"), [aliases,setAliases] = useState(""),
    [parents,setParents] = useState<string[]>([]), [section,setSection] = useState<TagGroup|"">(""),
    [color, setColor] = useState(TAG_COLORS[0]!),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState<TagDto | null>(null);
  const { notes } = useNotes();
  const catalog = useMemo(() => new TagCatalog(library.tags), [library.tags]);
  const tags = catalog.active.filter(tag => (!section || groupOf(tag) === section) && matchesSearch(query, tag.name, ...(tag.aliases ?? []), ...catalog.paths(tag.id), noteFor(notes,"tag",tag.id)));
  const counts = useMemo(() => new Map(Object.entries(overview.tagCounts)), [overview.tagCounts]);
  function open(tag: TagDto | "new") {
    setEdit(tag);
    setGroup(tag === "new" ? section || "extra" : groupOf(tag));
    setAliases(tag === "new" ? "" : (tag.aliases ?? []).join("\n"));
    setParents(tag === "new" ? [] : tag.parentIds ?? []);
    setName(tag === "new" ? "" : tag.name);
    setColor(tag === "new" ? TAG_COLORS[0]! : tag.color);
    setError("");
  }
  return (
    <>
      <div className="title-row library-title-row">
        <h1>Теги</h1>
        <Button className="primary" onClick={() => open("new")} aria-label="Новый тег" title="Новый тег">
          <Plus size={17} />
          <span>Новый тег</span>
        </Button>
      </div>
      <div className="section-heading">
        <h2>Найдено <span>{tags.length}</span></h2>
        <select aria-label="Раздел каталога" value={section} onChange={e => setSection(e.target.value as typeof section)}>
          <option value="">Все разделы</option>{groupKeys.map(key => <option key={key} value={key}>{groups[key]}</option>)}
        </select>
        <label className="search-input">
          <Search size={16} />
          <input
            type="search"
            aria-label="Поиск тегов"
            placeholder="Название или псевдоним…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
      </div>
      <ClassificationMigration reload={refresh}/>
      <NotesLoadError />
      <div className="tag-grid tag-directory">
        {tags.map((tag) => {
          const count = counts.get(tag.id) ?? 0;
          return (
            <article className="tag-card" key={tag.id}>
              <button className="tag-browse" type="button" onClick={() => onBrowse(tag.id)}
                aria-label={`Открыть записи с тегом ${tag.name}`} title={tag.name}>
                <span className="tag-card-icon" style={{ "--tag": tag.color } as React.CSSProperties}>
                  <Tags size={17} aria-hidden="true" />
                </span>
                <span className="tag-browse-description">
                  <span className="tag-browse-name">{tag.name}{noteFor(notes, "tag", tag.id) && <NoteIndicator />}</span>
                  <small>{catalog.paths(tag.id).map(p => p.includes(" › ") ? p.slice(0,p.lastIndexOf(" › ")) : groups[groupOf(tag)]).join(" / ")} · {count} {mediaWord(count)}</small>
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
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
                  { name, color, group, aliases: aliases.split(/\r?\n/).map(a => a.trim()).filter(Boolean), parentIds: group === "source" ? parents : [] },
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
            <GroupSelect value={group} onChange={g => {if(g !== "performance") setGroup(g);}}/>
            <label>Псевдонимы (по одному на строку)<textarea rows={3} value={aliases} onChange={e => setAliases(e.target.value)}/></label>
            {group === "source" && <details className="edit-group"><summary>Родители в дереве <span>{parents.length}</span></summary>
              <TagPicker catalog={catalog} ids={parents} group="source" excludeId={edit === "new" ? undefined : edit.id} onChange={setParents}/>
            </details>}
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
  "shared-copy": "Создание локальной копии",
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
function SettingsPage({ user, kaname }: { user: UserDto; kaname: boolean }) {
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
        {kaname && <KanameSettings userId={user.id} />}
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
