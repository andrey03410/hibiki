import {Button, DataContext, EmptyState, EMPTY, ErrorMessage, Modal, PageTop, useData} from "./WorkspaceUi";
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  useRef,
  useState,
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
  useLocation,
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
  Link2,
  LoaderCircle,
  CircleAlert,
  Trash2,
  Pencil,
  LogOut,
  Copy,
  ExternalLink,
  Sparkles,
  CheckCircle2,
  ListPlus,
  RefreshCw,
  Heart,
} from "lucide-react";
import type {
  ItemDto,
  LibraryDto,
  CompactLibraryOverviewDto,
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
import { ErrorBoundary, lazyView } from "./ErrorBoundary";
import { ArtworkImage, ItemArtwork } from "./ItemArtwork.tsx";
import { GenerativeCover } from "./design/primitives";
import { PlaylistCard, PlaylistCover } from "./PlaylistCard";
import { ScopedPlaylistPage, usePlaylistLibrary } from "./PlaylistLibrary";
import type { PlaylistTarget } from "./playlist-library";
import { PlaylistDetails } from "./playlist-detail";
import { ruleDescription } from "./playlist-rules";
import { LibraryPages, LibraryCardReader, fetchItems, searchBody, validateOverview } from "./library-pages";
import { PlayerProvider, usePlayerCommands, usePlayerCard, useHasPlayer, useQueueEditable } from "./player.tsx";
import { missingClassification } from "@hibiki/contracts/classification";
import type { DirectoryVisit } from "./tag-directory";
import { TagNavigation } from "./TagNavigation";
import { GroupSelect, TagPicker, PerformanceEditor } from "./ClassificationEditor";
import { batchTagChanges, compositionDelta, groupKeys, groups, groupOf, itemPerformance, missingLabels, TagCatalog,
  type BatchMode, type Performance, type PerformanceFilter, type TagGroup, type Voice } from "./taxonomy";
import { ItemTagList } from "./LibraryItemControls.tsx";
import { playbackSources, soundUnavailableReason } from "./player-model.ts";
import { librarySearchForTag, librarySourceBadges, matchesSearch, sourceAvailability, type LibraryView } from "./library-search.ts";
import { LibrarySearchControls, useLibrarySearch } from "./LibrarySearchControls.tsx";
import { NoteEditor, NoteIndicator, NotesContext, NotesLoadError, useNotes, useNotesController } from "./NoteEditor.tsx";
import { noteFor } from "./note-model.ts";
import { SharedItemStatus, useSavedSharedPlaylists } from "./LibrarySharing";
import { issueShare, kanameLoginHref } from "./sharing-model";
import { overviewInterval, activeJobsInterval, pollWhileVisible } from "./use-sharing-request";
import { YoutubeSyncNotifications } from "./YoutubeNotifications";
import { useHistoryRevision } from "./history-events.ts";
import { preferenceEvent, type HistoryPreference } from "./listening-client.ts";
import "./styles.css";
import "./library-view.css";
import "./taxonomy.css";
import "./design.css";
import "./design-shell.css";

const ImportModal = lazyView(() => import("./ImportModal"));
const JobsPage = lazyView(() => import("./JobsPage"));
const SettingsPage = lazyView(() => import("./SettingsPage"));
const KanameSettings = lazyView(() => import("./KanameSettings").then(m => ({default:m.KanameSettings})));
const YoutubeLinkedPlaylist = lazyView(() => import("./YoutubeSync").then(m => ({default:m.YoutubeLinkedPlaylist})));
const TagsPage = lazyView(() => import("./TagsPage"));
const VisualEditor = lazyView(() => import("./VisualEditor").then(m => ({default:m.VisualEditor})));
const SourceReplacement = lazyView(() => import("./SourceReplacement").then(m => ({default:m.SourceReplacement})));
const RuleEditor = lazyView(() => import("./RuleEditor"));
const loadSharing = () => import("./Sharing");
const IssueShare = lazyView(() => loadSharing().then(module => ({ default: module.IssueShare })));
const ShareManager = lazyView(() => loadSharing().then(module => ({ default: module.ShareManager })));
const SharedMediaPage = lazyView(() => loadSharing().then(module => ({ default: module.SharedMediaPage })));
const SavedSharedPlaylistCard = lazyView(() => loadSharing().then(module => ({ default: module.SavedSharedPlaylistCard })));

type Toast = { id: number; text: string; error?: boolean };

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
    [playlistQuery, setPlaylistQuery] = useState("");
  const tagVisits = useRef(new Map<string, DirectoryVisit>());
  const library: LibraryDto = useMemo(() => ({items: [], playlists: [], tags: overview.tags, jobs: overview.jobs}), [overview.tags, overview.jobs]);
  const request = useRef(0);
  const overviewToken = useRef("");
  const location = useLocation();
  const notes = useNotesController();
  const librarySearch = useLibrarySearch(user.id);
  const playlistLibrary = usePlaylistLibrary();
  const seenImports = useRef<Set<string> | null>(null);
  const navigate = useNavigate();
  function browseTag(id: string) {
    playlistLibrary.clear();
    librarySearch[1]((old) => librarySearchForTag(old, id));
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
    const result = await api<CompactLibraryOverviewDto | LibraryCardOverviewDto | undefined>("/library/overview?playlists=summary&format=compact&since=" + encodeURIComponent(overviewToken.current));
    if (sequence !== request.current) return;
    if (result === undefined) return;
    const decoded = validateOverview(result);
    overviewToken.current = decoded.overviewToken!;
    setOverview(decoded);
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
  const watchedJobs = library.jobs.filter(job => job.state === "running" || job.state === "queued").map(job => job.id).sort().join(",");
  useEffect(() => {
    if (!ready) return;
    return pollWhileVisible(async () => {
      try { await refresh(); setError(""); }
      catch (failure) { setError((failure as Error).message); }
    }, overviewInterval);
  }, [ready]);
  useEffect(() => {
    if (!ready || !watchedJobs) return;
    let live = true;
    const stop = pollWhileVisible(async () => {
      const generation = request.current;
      const {jobs} = await api<Pick<LibraryDto,"jobs">>("/jobs?active=1", "GET", undefined, "low");
      if (!live || request.current !== generation || !Array.isArray(jobs)) return;
      if (jobs.map(job => job.id).sort().join(",") !== watchedJobs) {
        await refresh();
      } else {
        const active = new Map(jobs.map(job => [job.id, job]));
        setOverview(old => ({...old, jobs: old.jobs.map(job => active.get(job.id) ?? job)}));
      }
    }, activeJobsInterval);
    return () => { live = false; stop(); };
  }, [ready, watchedJobs]);
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
          <aside className="sidebar ds-side">
            <Link className="brand" to="/" aria-label="hibiki — медиатека">
              <span className="brand-icon"><AudioLines size={19} /></span>
              <span className="brand-name">hibiki</span>
              <span className="brand-kanji" aria-hidden>響</span>
            </Link>
            <nav className="main-nav" aria-label="Разделы">
              <NavLink to="/" end title="Медиатека">
                <Library size={18} />
                <span className="nav-text">Медиатека</span>
                <span className="nav-count num">{overview.total.toLocaleString("ru")}</span>
              </NavLink>
              <NavLink to="/playlists" title="Плейлисты">
                <ListMusic size={18} />
                <span className="nav-text">Плейлисты</span>
                <span className="nav-count num">{overview.playlists.length || ""}</span>
              </NavLink>
              <NavLink to="/tags" title="Теги">
                <Tags size={18} />
                <span className="nav-text">Теги</span>
                <span className="nav-count num">{overview.tags.filter(tag => !tag.archived).length.toLocaleString("ru")}</span>
              </NavLink>
              <NavLink to="/jobs" title="Задания">
                <Download size={18} />
                <span className="nav-text">Задания</span>
                {activeJobs > 0 && <span className="job-count">{activeJobs}</span>}
              </NavLink>
            </nav>
            <div className="sidebar-section">
              <span className="sidebar-label">Плейлисты</span>
              <button className="icon-button" aria-label="Создать плейлист" title="Создать плейлист" onClick={() => setCreateOpen(true)}>
                <Plus size={15} />
              </button>
            </div>
            <nav className="playlist-nav" aria-label="Плейлисты">
              {overview.playlists.slice(0, 14).map((p) => (
                <NavLink key={p.id} to={`/playlists/${p.id}`} title={p.title}>
                  <span className="playlist-thumb">
                    <ArtworkImage urls={p.coverUrls ?? []} fallback={<GenerativeCover seed={p.title} />} />
                  </span>
                  <span className="truncate">{p.title}</span>
                  {!p.manual && <Sparkles size={12} aria-label="Умный плейлист" />}
                </NavLink>
              ))}
              {!overview.playlists.length && <p className="sidebar-hint">Здесь будут подборки, собранные вами.</p>}
            </nav>
            <div className="sidebar-bottom">
              <span className="avatar" aria-hidden>{user.login.slice(0, 1).toUpperCase()}</span>
              <div className="user-name">
                <strong className="truncate">{user.login}</strong>
                <small>Личный аккаунт</small>
              </div>
              <YoutubeSyncNotifications reload={refresh} />
              <NavLink className="icon-button settings-link" to="/settings" aria-label="Настройки" title="Настройки">
                <Settings2 size={17} />
              </NavLink>
              <button className="icon-button" aria-label="Выйти" title="Выйти" onClick={() => logout().catch((e) => notify(e.message, true))}>
                <LogOut size={16} />
              </button>
            </div>
          </aside>
          <main className="main-content">
            <div id="browse-content" className="browse-content">
            {error && <p className="notes-error" role="status">{error}</p>}
            <ErrorBoundary key={location.pathname} label="Не удалось открыть страницу.">
            <React.Suspense fallback={<div className="loading-inline" role="status"><LoaderCircle size={18} className="spin" />Загружаем…</div>}>
            <Routes>
              <Route path="/player" element={<ErrorBoundary label="Не удалось показать плеер.">{watchPlayer}</ErrorBoundary>} />
              <Route path="/" element={playlistLibrary.scope
                ? <ScopedPlaylistPage key={playlistLibrary.scope.id} scope={playlistLibrary.scope} firstVisit={playlistLibrary.firstVisit} clear={playlistLibrary.clear} />
                : <LibraryPage userId={user.id} search={librarySearch} />} />
              <Route
                path="/playlists"
                element={<PlaylistsPage playlistLibrary={playlistLibrary} query={playlistQuery} onQuery={setPlaylistQuery} onCreate={() => setCreateOpen(true)} />}
              />
              <Route path="/playlists/:id" element={<PlaylistRoute onBrowseTag={browseTag} />} />
              <Route path="/tags" element={<TagsPage key={location.key} userId={user.id} visits={tagVisits.current} onBrowse={browseTag} />} />
              {kaname && <Route path="/admin" element={<KanameSettings userId={user.id} adminPage />} />}
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/share-links" element={<ShareManager />} />
              <Route path="/share/:token" element={<SharedMediaPage refreshLibrary={refresh} />} />
              <Route path="/shared-playlists/:id" element={<SharedMediaPage saved refreshLibrary={refresh} />} />
              <Route path="/settings" element={<SettingsPage user={user} kaname={kaname} />} />
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
            </ErrorBoundary>
            </div>
            <ErrorBoundary label="Не удалось показать плеер.">{miniPlayer}</ErrorBoundary>
          </main>
        </div>
        {importOpen && <ErrorBoundary label="Не удалось открыть добавление медиа."><React.Suspense fallback={<div className="loading-inline" role="status">Загружаем…</div>}>
          <ImportModal close={() => setImportOpen(false)} />
        </React.Suspense></ErrorBoundary>}{" "}
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
function LibraryNavigation(props: Omit<React.ComponentProps<typeof TagNavigation>, "hasPlayer">) {
  return <TagNavigation {...props} hasPlayer={useHasPlayer()} />;
}

const FavoriteChangeContext = React.createContext<((id: string, favorite: boolean) => void) | undefined>(undefined);
const LibraryPage = React.memo(function LibraryPage({ userId, search }: { userId: string; search: ReturnType<typeof useLibrarySearch> }) {
  const { library, overview, notify, openImport } = useData(),
    player = usePlayerCommands();
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
  const reader = useMemo(() => new LibraryCardReader(), []);
  const latestOverview = useRef(overview);
  latestOverview.current = overview;
  const pages = useMemo(() => new LibraryPages((cursor, signal, selectionId) =>
    reader.page(filters, latestOverview.current, cursor, signal, selectionId)), [filters, reader]);
  const previousFilters = useRef<typeof filters>(undefined);
  const {items, loading, appending, error, nextCursor, total, tagCounts, selectionId} = useSyncExternalStore(pages.subscribe, pages.snapshot);
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
    <LibraryNavigation catalog={catalog} archivedTagNames={overview.archivedTagNames} counts={tagCounts ?? (restrictsFacets ? undefined : overview.tagCounts)}
      search={filters} onChange={setFilters} userId={userId}>
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
        <FavoriteChangeContext.Provider value={(id, value) => pages.favoriteChanged(id, value, filters.favoriteOnly)}>
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
        </FavoriteChangeContext.Provider>
        <div ref={sentinel} aria-hidden="true" />
        {loading && (!items.length || appending) && <div role="status" className="loading-inline"><LoaderCircle className="spin" size={18} /> Загружаем записи…</div>}
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
    </LibraryNavigation>
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

type ItemTableProps = {
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
};
type EditTarget = {id: string; focusSource?: boolean};
type ShareTarget = {id: string; issued: Promise<ShareLinkDto>};
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
}: ItemTableProps) {
  const player = usePlayerCommands(),
    { library, refresh, notify } = useData();
  const catalog = useMemo(() => new TagCatalog(library.tags), [library.tags]);
  const [editTarget, setEditTarget] = useState<EditTarget>(),
    [remove, setRemove] = useState<ItemDto | null>(null),
    [shareTarget, setShareTarget] = useState<ShareTarget>(),
    [busy, setBusy] = useState(false);
  const currentItems = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const edit = editTarget ? currentItems.get(editTarget.id) : undefined;
  const inLibrary = view !== undefined;
  const selectedIds = new Set(selected);
  function activate(item: ItemDto, index: number) {
    if (onActivate) onActivate(item);
    else player.activateItem(items, index, playlistId, { fromLibrary: inLibrary || !!playlistId, queueIds: playlistOrder });
  }
  function select(id: string, checked: boolean) {
    if (selected) onSelected?.(checked ? [...selected, id] : selected.filter(other => other !== id));
  }
  const results = items.map((item, index) => <ItemRow key={item.id} item={item} index={index}
    catalog={catalog} checked={selected && selectedIds.has(item.id)} onSelect={select} activateItem={activate}
    inLibrary={inLibrary} last={index === (playlistOrder?.length ?? items.length) - 1} playlistId={playlistId}
    reasons={reasons} selectedTags={selectedTags} showMissing={showMissing} onTag={onTag} onPerformance={onPerformance}
    reorder={reorder} setEditTarget={setEditTarget} setShareTarget={setShareTarget} setRemove={setRemove} />);

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
function QueueActions({item, active, playlistId}: {item:ItemDto; active:boolean; playlistId?:string}) {
  const editable = useQueueEditable();
  const player = usePlayerCommands();
  const { notify } = useData();
  return <>
    <button
      disabled={active || !editable}
      onClick={() => {
        player.playNext(item, playlistId);
        notify("Запись будет играть следующей");
      }}
    >
      <ListPlus size={14} />
      Играть следующей
    </button>
    <button
      disabled={!editable}
      onClick={() => {
        player.enqueue(item, playlistId);
        notify("Добавлено в очередь");
      }}
    >
      <ListPlus size={14} />
      Добавить в очередь
    </button>
  </>;
}

type ItemRowProps = Pick<ItemTableProps, "selectedTags" | "showMissing" | "onPerformance" | "reorder" | "onTag" | "playlistId" | "reasons"> & {
  item: ItemDto; index: number; catalog: TagCatalog; checked?: boolean; last: boolean; inLibrary: boolean;
  onSelect: (id: string, checked: boolean) => void;
  activateItem: (item: ItemDto, index: number) => void;
  setEditTarget: (target: EditTarget) => void;
  setShareTarget: (target: ShareTarget) => void;
  setRemove: (item: ItemDto) => void;
};
const ItemRow = React.memo(function ItemRow({ item, index, catalog, checked, last, inLibrary, selectedTags, showMissing,
  reasons, reorder, onTag, onPerformance, onSelect, playlistId, activateItem, setEditTarget, setShareTarget, setRemove }: ItemRowProps) {
  const { notes } = useNotes();
  const { notify, refresh } = useData();
  const [copying, setCopying] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
    setCopying(true);
    try {
      await api(`/items/${encodeURIComponent(itemId)}/shared-copy`, "POST", {});
      notify("Задание на создание локальной копии добавлено в очередь");
      void refresh().catch(() => {});
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setCopying(false);
    }
  }


  const ownSources = item.sources.filter(source => !source.shared);
  const borrowedOnly = !!item.shared && !ownSources.length;
  const canCopy = item.shared?.available && item.sources.some(source => source.shared && source.status !== "unavailable");
  const streamUrl = ownSources.find((source) => source.streamUrl)?.streamUrl;
  const externalUrl = ownSources.find((source) => source.url)?.url;
  const artworkSource = item.sources.find((source) => source.thumbnail);
  const available = playbackSources(item).length > 0;
  const { active, playing, loadingLabel } = usePlayerCard(item.id, playlistId);
  const playlistSoundError = playlistId ? soundUnavailableReason(item) : undefined;
  const status = sourceAvailability(item);
  const hasItemNote = !!noteFor(notes, "item", item.id);
  const hasSourceNote = ownSources.some((source) => noteFor(notes, "source", source.id));
  const video = item.kind === "video";
  const yt = ownSources.some((source) => source.provider === "youtube");
  const kindLabel = video ? "Видео" : "Аудио";
  const playLabel = playing ? "Приостановить" : "Воспроизвести";
  const itemLoading = active && loadingLabel;
  const { warmCover } = usePlayerCommands();
  const coverLabel = `${playLabel} ${item.title}`;
  const activate = () => activateItem(item, index);
  const artwork = <ItemArtwork source={artworkSource} kind={item.kind} />;
  const cover = inLibrary ? (
    <button type="button" className={`item-art entry-cover art-${index % 6}`}
      aria-label={video ? `${coverLabel} · обложка` : coverLabel} title={available ? coverLabel : "Нет рабочего источника"}
      onPointerEnter={e => { if (e.pointerType === "mouse") warmCover(item); }}
      onPointerLeave={e => { if (!e.currentTarget.matches(":focus-visible")) warmCover(); }}
      onFocus={() => warmCover(item)} onBlur={() => warmCover()}
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
  const favorite = <FavoriteButton item={item} />;
  const selection = inLibrary && checked !== undefined && (
    <input
      type="checkbox"
      aria-label={`Выбрать ${item.title}`}
      checked={checked}
      onChange={event => onSelect(item.id, event.target.checked)}
    />
  );
  const menu = (
    <details onToggle={event => setMenuOpen(event.currentTarget.open)} className="row-menu" name={inLibrary ? "library-item-actions" : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}
    >
      <summary aria-label={`Действия с ${item.title}`}>
        <MoreHorizontal size={19} />
      </summary>
      {menuOpen && <div className="dropdown" onClick={(event) => {
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
        {canCopy && <button disabled={copying} onClick={() => void createLocalCopy(item.id)}>
          <Copy size={14} />
          Создать локальную копию
        </button>}
        {!borrowedOnly && status === "unavailable" && (
          <button onClick={() => setEditTarget({ id: item.id, focusSource: true })}>
            <RefreshCw size={14} />
            Заменить источник
          </button>
        )}
        <QueueActions item={item} active={active} playlistId={playlistId} />
        {reorder && (
          <>
            <button disabled={index === 0} onClick={() => reorder(item.id, -1)}>
              ↑ Переместить выше
            </button>
            <button disabled={last} onClick={() => reorder(item.id, 1)}>
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
      </div>}
    </details>
  );

  const badges = librarySourceBadges(item);
  return (
    <article className={`collection-entry ${active ? "current" : ""}`}
      key={item.id} aria-current={active || undefined}>
      <div className="entry-select">{inLibrary ? selection : (
        <button className="icon-button playlist-track-play" type="button" disabled={!available || !!playlistSoundError} onClick={activate}
          aria-label={coverLabel} title={playlistSoundError ?? coverLabel}>
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
            {playlistSoundError ? <span>{playlistSoundError}</span> : !available && item.shared?.available !== false && <span>Нет рабочего источника</span>}
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

function FavoriteButton({ item, withLabel = false }: { item: ItemDto; withLabel?: boolean }) {
  const { refresh, notify } = useData();
  const changed = React.useContext(FavoriteChangeContext);
  const [busy, setBusy] = useState(false);
  const label = item.favorite ? "Убрать из избранного" : "Добавить в избранное";
  return (
    <button
      type="button"
      className={withLabel ? "button subtle compact favorite-button" : "icon-button favorite-button"}
      title={label}
      aria-label={`${label} · ${item.title}`}
      aria-pressed={!!item.favorite}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          const result = await api<{favorite:boolean}>(`/items/${encodeURIComponent(item.id)}/favorite`, "PATCH", { favorite: !item.favorite });
          changed?.(item.id, result.favorite);
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
      <React.Suspense fallback={<div role="status">Загружаем источники…</div>}>
        {!borrowedOnly && <VisualEditor key={item.id} item={item} reload={refresh} />}
        <SourceReplacement item={item} reload={refresh} localOnly={borrowedOnly} focusSource={focusSource} />
      </React.Suspense>
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
function CatalogPlaylistEditor({ id, close }: { id: string; close: () => void }) {
  const [playlist, setPlaylist] = useState<PlaylistDto>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<PlaylistDto>("/playlists/" + encodeURIComponent(id), "GET", undefined, "high", controller.signal)
      .then(setPlaylist)
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [id, retry]);
  if (playlist) return <PlaylistEditor playlist={playlist} close={close} onSaved={close} />;
  return <Modal title="Изменить плейлист" close={close}>
    {error ? <><ErrorMessage error={error} /><Button onClick={() => setRetry(value => value + 1)}>Повторить</Button></>
      : <div className="loading-inline" role="status"><LoaderCircle className="spin" size={18} />Загружаем плейлист…</div>}
  </Modal>;
}

function PlaylistsPage({ query, onQuery, onCreate, playlistLibrary }: {
  playlistLibrary: ReturnType<typeof usePlaylistLibrary>;
  query: string;
  onQuery: (query: string) => void;
  onCreate: () => void;
}) {
  const { overview } = useData();
  const player = usePlayerCommands();
  const [edit, setEdit] = useState<{ id: string; trigger: HTMLButtonElement }>();
  const searchInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLButtonElement | undefined>(undefined);
  function launch(target: PlaylistTarget) { void playlistLibrary.launch(target, player); }
  function closeEditor() {
    restoreFocus.current = edit?.trigger;
    setEdit(undefined);
  }
  useLayoutEffect(() => {
    if (edit || !restoreFocus.current) return;
    const trigger = restoreFocus.current;
    restoreFocus.current = undefined;
    (trigger.isConnected ? trigger : searchInput.current)?.focus({preventScroll: true});
  }, [edit]);
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
        <Button className="primary" onClick={() => { playlistLibrary.cancelPending(); onCreate(); }} aria-label="Создать плейлист" title="Создать плейлист">
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
            ref={searchInput} aria-label="Поиск плейлистов"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Поиск по названию и заметкам…"
          />
        </label>
      </div>
      <NotesLoadError />
      {savedError && <ErrorMessage error={savedError.message} />}
      <ErrorMessage error={playlistLibrary.error} />
      {playlistLibrary.pending && <div className="loading-inline" role="status"><LoaderCircle size={16} className="spin" />
        Открываем «{playlistLibrary.pending.title}»…</div>}
      <div className="playlist-grid">
        {playlists.map((p) => (
          <PlaylistCard key={p.id} playlist={p} hasNote={Boolean(noteFor(notes, "playlist", p.id))}
            onPlay={() => launch({kind: "own", id: p.id, title: p.title})} onEdit={trigger => { playlistLibrary.cancelPending(); setEdit({id: p.id, trigger}); }}
            onShare={() => { playlistLibrary.cancelPending(); setShare({ id: p.id, issued: issueShare("playlist", p.id) }); }} />
        ))}
        <React.Suspense fallback={null}>
          {shared.map(playlist => <SavedSharedPlaylistCard key={playlist.id} playlist={playlist}
            onPlay={() => launch({kind: "saved", id: playlist.id, title: playlist.title})} />)}
        </React.Suspense>
      </div>
      {edit && <CatalogPlaylistEditor key={edit.id} id={edit.id} close={closeEditor} />}
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
    player = usePlayerCommands(),
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
  const details = useMemo(() => new PlaylistDetails(), []);
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
        const data = await details.read(path + "/detail?limit=" + visibleRows.current, JSON.stringify([contentKey, historyRevision]), background ? "low" : "high", signal);
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
        <React.Suspense fallback={<div role="status">Загружаем данные YouTube…</div>}>
        <YoutubeLinkedPlaylist
          key={playlist.id}
          playlist={playlist}
          items={resolved?.items}
          libraryRevision={overview.revision}
          tags={library.tags}
          reload={async () => {
            await refresh();
            await resolve();
          }}
        />
        </React.Suspense>
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
type EditorPreview = Omit<ResolvedPlaylist, "items"> & {items: Pick<ItemDto, "id" | "title" | "kind">[]; hasHistoryRules: boolean};

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
  const playlistVersion = useMemo(() => JSON.stringify(context.overview.playlists.map(p => [p.id, p.revision])), [context.overview.playlists]);
  const [editRules, setEditRules] = useState(!playlist?.youtubeLinked && initialIds === undefined);
  const library = context.overview;
  const [title, setTitle] = useState(playlist?.title ?? ""),
    [description, setDescription] = useState(playlist?.description ?? ""),
    [definition, setDefinition] = useState<PlaylistDefinition>(
      playlist?.definition ?? {
        version: 1,
        rule: { type: "items", ids: initialIds ?? [] },
        sort: "source",
      },
    ),
    [preview, setPreview] = useState<EditorPreview | null>(null),
    [error, setError] = useState(""),
    [previewError, setPreviewError] = useState(""),
    [previewBusy, setPreviewBusy] = useState(false),
    [busy, setBusy] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => { titleInput.current?.focus(); }, []);
  const [historyPreference, setHistoryPreference] = useState<HistoryPreference>();
  const hasHistoryRules = !!preview?.hasHistoryRules;
  const sortsByHistory = definition.sort === "last-started";
  const needsHistory = !playlist?.youtubeLinked && (sortsByHistory || hasHistoryRules);
  const historyRevision = useHistoryRevision(needsHistory);
  useEffect(() => {
    if (!needsHistory) return;
    let active = true;
    const update = () => void api<HistoryPreference>("/history/preference")
      .then((preference) => { if (active) setHistoryPreference(preference); })
      .catch(() => {});
    const storage = (event: StorageEvent) => { if (event.key === preferenceEvent) update(); };
    update();
    window.addEventListener(preferenceEvent, update);
    window.addEventListener("storage", storage);
    return () => { active = false; window.removeEventListener(preferenceEvent, update); window.removeEventListener("storage", storage); };
  }, [needsHistory]);
  const playlistId = playlist?.id;
  const savedKey = useMemo(() => playlist && JSON.stringify(playlist.definition), [playlist?.definition]);
  const draftKey = useMemo(() => JSON.stringify(definition), [definition]);
  const changed = !!playlist && draftKey !== savedKey;
  const [savedComposition, setSavedComposition] = useState<{ key: string; items: EditorPreview["items"] }>();
  const before = currentItems ?? (savedComposition?.key === savedKey ? savedComposition?.items : undefined);
  const delta = useMemo(() => changed && before && preview
    ? compositionDelta(before, preview.items) : undefined, [changed, before, preview]);

  useEffect(() => {
    // The catalog editor opens without loading the detail page.
    // A quick rule change can also precede the first unmodified preview.
    if (!changed || before || !playlistId || !savedKey) return;
    const controller = new AbortController();
    api<EditorPreview>("/playlists/preview", "POST", {definition: playlist!.definition, playlistId, cards:true}, undefined, controller.signal)
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
      api<EditorPreview>("/playlists/preview", "POST", { definition, playlistId, cards:true }, undefined, signal)
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
  }, [draftKey, savedKey, editRules, historyRevision, playlistId, library.revision, playlistVersion]);
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
            await refresh().catch(e => notify(e.message, true));
            onSaved(saved);
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
            {editRules && <>
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
            disabled={!title.trim() || (editRules && (!!previewError || previewBusy || !preview))}
          >
            {busy ? "Сохраняем…" : playlist ? "Сохранить изменения" : "Создать плейлист"}
            {!busy && <Check size={16} />}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
