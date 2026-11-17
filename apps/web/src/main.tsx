import React, {
  useEffect,
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
  Filter,
  Clock3,
  FolderOpen,
  Sparkles,
  CheckCircle2,
  Minus,
  ListPlus,
  RefreshCw,
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
import { playbackSources } from "./player-model.ts";
import "./styles.css";

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
    [importSettingsLoading, setImportSettingsLoading] = useState(false);
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
        {(watchPlayer) => <>
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
            {watchPlayer}
            <div id="browse-content" className="browse-content">
            <Routes>
              <Route path="/" element={<LibraryPage />} />
              <Route
                path="/playlists"
                element={<PlaylistsPage onCreate={() => setCreateOpen(true)} />}
              />
              <Route path="/playlists/:id" element={<PlaylistPage />} />
              <Route path="/tags" element={<TagsPage />} />
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
function LibraryPage() {
  const { library, openImport } = useData(),
    player = usePlayer();
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [tag, setTag] = useState(""),
    [sort, setSort] = useState("newest"),
    [selected, setSelected] = useState<string[]>([]),
    [playlistOpen, setPlaylistOpen] = useState(false),
    [batchOpen, setBatchOpen] = useState(false);
  let items = library.items.filter(
    (i) =>
      (!query ||
        `${i.title} ${i.originalTitle} ${i.tags.map((t) => t.name).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (filter === "all" || filter === "local"
        ? filter !== "local" ||
          i.sources.some(
            (s) => s.provider === "local" && s.status === "available",
          )
        : i.kind === filter) &&
      (!tag || i.tags.some((t) => t.id === tag)),
  );
  items = [...items].sort((a, b) =>
    sort === "title"
      ? a.title.localeCompare(b.title, "ru")
      : sort === "duration"
        ? (a.duration ?? Infinity) - (b.duration ?? Infinity)
        : b.createdAt.localeCompare(a.createdAt),
  );
  const audio = library.items.filter((i) => i.kind === "audio").length,
    video = library.items.length - audio;
  return (
    <>
      <PageTop label="Медиатека">
        <span className="status-pill">
          <span className="online-dot" />
          Всё на своём месте
        </span>
      </PageTop>
      <div className="title-row">
        <div>
          <span className="eyebrow">СОБРАНО ВАМИ</span>
          <h1>
            Медиатека<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Ваши звуки, истории и всё, что хочется сохранить.
          </p>
        </div>
        <Button className="primary" onClick={openImport}>
          <Plus size={17} />
          Добавить медиа
        </Button>
      </div>
      <section className="library-hero">
        <div className="hero-text">
          <span className="hero-label">
            <AudioLines size={15} /> ВАШ ЛИЧНЫЙ РИТМ
          </span>
          <h2>
            Разное звучание.
            <br />
            Одно пространство.
          </h2>
          <p>
            Аудио и видео рядом. Собирайте плейлисты,
            <br />
            связывайте их тегами и находите своё настроение.
          </p>
          <Button
            className="hero-button"
            onClick={() =>
              library.items.length ? player.start(library.items) : openImport()
            }
          >
            <Play size={14} fill="currentColor" />
            {library.items.length
              ? "Слушать медиатеку"
              : "Добавить первую запись"}
            <ArrowUpRight size={15} />
          </Button>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="record-disc">
            <span className="disc-label">
              響<span>HIBIKI</span>
            </span>
          </div>
          <div className="art-wave">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <span className="hero-japanese">音を、つなぐ。</span>
          <span className="hero-coordinate">PERSONAL COLLECTION / 01</span>
        </div>
      </section>
      <div className="library-stat-row">
        <span>
          <strong>{library.items.length}</strong>{" "}
          {mediaWord(library.items.length)}
        </span>
        <i />
        <span>
          <Music2 size={14} />
          {audio} аудио
        </span>
        <span>
          <Video size={14} />
          {video} видео
        </span>
        <span>
          <Clock3 size={14} />
          {humanDuration(
            library.items.reduce((s, i) => s + (i.duration ?? 0), 0),
          )}
        </span>
        <span className="stat-right">Всё, что вы любите. В одном месте.</span>
      </div>
      <section className="library-section">
        <div className="section-heading">
          <h2>
            Ваша коллекция <span>{library.items.length}</span>
          </h2>
          <div className="collection-tools">
            <label className="search-input">
              <Search size={16} />
              <input
                aria-label="Поиск в медиатеке"
                placeholder="Найти в медиатеке…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  className="icon-button"
                  aria-label="Очистить поиск"
                  onClick={() => setQuery("")}
                >
                  <X size={13} />
                </button>
              )}
            </label>
            <select
              aria-label="Сортировка медиатеки"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="newest">Сначала новые</option>
              <option value="title">По названию</option>
              <option value="duration">По длительности</option>
            </select>
          </div>
        </div>
        <div className="collection-filter">
          <div className="segmented">
            {[
              ["all", "Все записи"],
              ["audio", "Аудио"],
              ["video", "Видео"],
              ["local", "На устройстве"],
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
          <label className="tag-filter">
            <Filter size={14} />
            <select
              aria-label="Фильтр по тегу"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            >
              <option value="">Все теги</option>
              {library.tags.map((t) => (
                <option value={t.id} key={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
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
          selected={selected}
          onSelected={setSelected}
          onTag={(id) => setTag(id)}
        />
        {!items.length && (
          <EmptyState
            title={
              library.items.length
                ? "Ничего не нашлось"
                : "Начнём вашу коллекцию"
            }
            text={
              library.items.length
                ? "Попробуйте другое название или измените фильтры."
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
function ItemTable({
  items,
  reasons,
  selected,
  onSelected,
  onTag,
  reorder,
}: {
  items: ItemDto[];
  reasons?: Record<string, string[]>;
  selected?: string[];
  onSelected?: (ids: string[]) => void;
  onTag?: (id: string) => void;
  reorder?: (id: string, direction: number) => void;
}) {
  const player = usePlayer(),
    { refresh, notify } = useData();
  const [edit, setEdit] = useState<ItemDto | null>(null),
    [remove, setRemove] = useState<ItemDto | null>(null),
    [busy, setBusy] = useState(false);
  async function job(kind: string, itemId: string, mode?: string) {
    try {
      await api("/jobs", "POST", { kind, input: { itemId, mode } });
      notify("Задание добавлено в очередь");
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <>
      <div className="item-table">
        <div className={`table-heading ${selected ? "selectable" : ""}`}>
          {selected ? (
            <input
              type="checkbox"
              aria-label="Выбрать все записи"
              checked={
                !!items.length && items.every((i) => selected.includes(i.id))
              }
              onChange={(e) =>
                onSelected?.(
                  e.target.checked
                    ? [...new Set([...selected, ...items.map((i) => i.id)])]
                    : selected.filter((id) => !items.some((i) => i.id === id)),
                )
              }
            />
          ) : (
            <span>#</span>
          )}
          <span>НАЗВАНИЕ</span>
          <span>ТЕГИ</span>
          <span>ИСТОЧНИК</span>
          <Clock3 size={14} />
          <span />
        </div>
        {items.map((item, index) => {
          const local = item.sources.some(
              (s) => s.provider === "local" && s.status === "available",
            ),
            yt = item.sources.some((s) => s.provider === "youtube"),
            available = playbackSources(item).length > 0,
            active = player.current?.id === item.id;
          return (
            <div
              className={`item-row ${selected ? "selectable" : ""} ${active ? "current" : ""} ${!available ? "unavailable" : ""}`}
              key={item.id}
            >
              {selected ? (
                <input
                  type="checkbox"
                  aria-label={`Выбрать ${item.title}`}
                  checked={selected.includes(item.id)}
                  onChange={(e) =>
                    onSelected?.(
                      e.target.checked
                        ? [...selected, item.id]
                        : selected.filter((id) => id !== item.id),
                    )
                  }
                />
              ) : (
                <span className="row-number">{index + 1}</span>
              )}
              <div className="item-title-cell">
                <button
                  className={`item-art art-${index % 6}`}
                  aria-label={
                    active && player.playing
                      ? `Приостановить ${item.title}`
                      : `Воспроизвести ${item.title}`
                  }
                  onClick={() =>
                    active ? player.toggle() : player.start(items, index)
                  }
                >
                  {item.sources.find((s) => s.thumbnail)?.thumbnail ? (
                    <img
                      src={item.sources.find((s) => s.thumbnail)!.thumbnail}
                      alt=""
                      loading="lazy"
                    />
                  ) : item.kind === "video" ? (
                    <Video size={19} />
                  ) : (
                    <Music2 size={19} />
                  )}
                  <span className="art-play">
                    {active && player.playing ? (
                      <Pause size={15} fill="currentColor" />
                    ) : (
                      <Play size={15} fill="currentColor" />
                    )}
                  </span>
                </button>
                <div className="truncate">
                  <button className="item-title" onClick={() => setEdit(item)}>
                    {item.title}
                  </button>
                  <span className="item-subtitle">
                    {item.kind === "video" ? "Видео" : "Аудио"}
                    {item.originalTitle !== item.title
                      ? ` · ${item.originalTitle}`
                      : local
                        ? " · Локальная коллекция"
                        : " · YouTube"}
                    {!available && " · Источник недоступен"}
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
                {item.tags.slice(0, 2).map((t) => (
                  <TagPill
                    key={t.id}
                    tag={t}
                    onClick={onTag ? () => onTag(t.id) : undefined}
                  />
                ))}
                {item.tags.length > 2 && (
                  <span className="small muted">+{item.tags.length - 2}</span>
                )}
              </div>
              <span className={`source-badge ${!available ? "missing" : ""}`}>
                {local ? <HardDrive size={13} /> : <Youtube size={14} />}
                <span>
                  {local ? "На устройстве" : yt ? "YouTube" : "Нет источника"}
                </span>
              </span>
              <span className="item-duration">
                {formatDuration(item.duration)}
              </span>
              <details className="row-menu">
                <summary aria-label={`Действия с ${item.title}`}>
                  <MoreHorizontal size={19} />
                </summary>
                <div className="dropdown">
                  <button onClick={() => setEdit(item)}>
                    <Pencil size={14} />
                    Название и теги
                  </button>
                  <button
                    onClick={() => {
                      player.enqueue(item);
                      notify("Добавлено в очередь");
                    }}
                  >
                    <ListPlus size={14} />
                    Добавить в очередь
                  </button>
                  {reorder && (
                    <>
                      <button
                        disabled={index === 0}
                        onClick={() => reorder(item.id, -1)}
                      >
                        ↑ Переместить выше
                      </button>
                      <button
                        disabled={index === items.length - 1}
                        onClick={() => reorder(item.id, 1)}
                      >
                        ↓ Переместить ниже
                      </button>
                    </>
                  )}
                  {yt && (
                    <>
                      <button
                        onClick={() =>
                          job("youtube-download", item.id, "audio")
                        }
                      >
                        <Download size={14} />
                        Скачать аудио
                      </button>
                      <button
                        onClick={() =>
                          job("youtube-download", item.id, "video")
                        }
                      >
                        <Video size={14} />
                        Скачать видео
                      </button>
                      <button onClick={() => job("youtube-refresh", item.id)}>
                        <RefreshCw size={14} />
                        Проверить источник
                      </button>
                    </>
                  )}
                  {item.sources.find((s) => s.streamUrl) && (
                    <a
                      href={item.sources.find((s) => s.streamUrl)!.streamUrl}
                      download={item.title}
                    >
                      <Download size={14} />
                      Сохранить файл
                    </a>
                  )}
                  {item.sources.find((s) => s.url) && (
                    <a
                      href={item.sources.find((s) => s.url)!.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={14} />
                      Открыть источник
                    </a>
                  )}
                  <button
                    className="danger-text"
                    onClick={() => setRemove(item)}
                  >
                    <Trash2 size={14} />
                    Удалить из медиатеки
                  </button>
                </div>
              </details>
            </div>
          );
        })}
      </div>
      {edit && <EditItem item={edit} close={() => setEdit(null)} />}{" "}
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
function EditItem({ item, close }: { item: ItemDto; close: () => void }) {
  const { library, refresh, notify } = useData(),
    [title, setTitle] = useState(item.title),
    [tagIds, setTagIds] = useState(item.tags.map((t) => t.id)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title="Детали записи"
      subtitle="Ваше название сохраняется, даже если источник исчезнет."
      close={close}
    >
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
        <div className="source-details">
          {item.sources.map((s) => (
            <div key={s.id}>
              <span>
                {s.provider === "local" ? (
                  <HardDrive size={16} />
                ) : (
                  <Youtube size={16} />
                )}{" "}
                {s.provider === "local" ? "Локальный файл" : "YouTube"}
              </span>
              <span
                className={s.status === "unavailable" ? "danger-text" : "muted"}
              >
                {s.status === "available"
                  ? "Доступен"
                  : s.status === "unavailable"
                    ? "Недоступен"
                    : "Не проверен"}
              </span>
              {s.reason && <p>{s.reason}</p>}
            </div>
          ))}
        </div>
        <ErrorMessage error={error} />
        <div className="modal-actions">
          <Button type="button" className="subtle" onClick={close}>
            Отмена
          </Button>
          <Button type="submit" className="primary" busy={busy}>
            Сохранить изменения
          </Button>
        </div>
      </form>
    </Modal>
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
function PlaylistsPage({ onCreate }: { onCreate: () => void }) {
  const { library } = useData(),
    [query, setQuery] = useState("");
  const playlists = library.playlists.filter((p) =>
    p.title.toLowerCase().includes(query.toLowerCase()),
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
          Ваши подборки <span>{library.playlists.length}</span>
        </h2>
        <label className="search-input">
          <Search size={16} />
          <input
            aria-label="Поиск плейлистов"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти плейлист…"
          />
        </label>
      </div>
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
          text="Попробуйте другое название."
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
          {playlist.definition.rule.type === "items" ? (
            <ListMusic size={13} />
          ) : (
            <Sparkles size={13} />
          )}{" "}
          {playlist.definition.rule.type === "items"
            ? "ВАШ ВЫБОР"
            : "ПО ПРАВИЛАМ"}
        </span>
        <button
          className="card-play"
          aria-label={`Воспроизвести ${playlist.title}`}
          disabled={!resolved?.items.length}
          onClick={() => resolved && player.start(resolved.items)}
        >
          <Play size={20} fill="currentColor" />
        </button>
      </div>
      <Link className="playlist-card-title" to={`/playlists/${playlist.id}`}>
        {playlist.title}
      </Link>
      <p>{playlist.description || "Ваша подборка в Hibiki"}</p>
      <span className="small muted">
        {resolved
          ? `${resolved.total} ${mediaWord(resolved.total)} · ${humanDuration(resolved.duration)}`
          : "Вычисляем состав…"}
      </span>
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
    [remove, setRemove] = useState(false),
    [busy, setBusy] = useState(false);
  async function resolve() {
    if (!id) return;
    try {
      const result = await api<ResolvedPlaylist>(`/playlists/${id}/resolve`);
      setResolved(result);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const contentKey =
    library.items.map((i) => i.updatedAt).join(",") +
    library.playlists.map((p) => p.revision).join(",");
  useEffect(() => {
    setResolved(null);
    void resolve();
  }, [id]);
  useEffect(() => {
    void resolve();
  }, [contentKey]);
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
            {automatic ? "СОСТАВНОЙ ПЛЕЙЛИСТ" : "ВАШ ПЛЕЙЛИСТ"}
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
              onClick={() => resolved && player.start(resolved.items)}
            >
              <Play size={16} fill="currentColor" />
              Слушать
            </Button>
            <Button className="subtle" onClick={() => setEdit(true)}>
              <Pencil size={16} />
              {automatic ? "Изменить правила" : "Изменить плейлист"}
            </Button>
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
      {automatic && (
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
            reorder={reorder}
          />
          {!resolved.items.length && (
            <EmptyState
              title="Пока здесь тихо"
              text="Добавьте записи вручную или настройте правила, чтобы собрать плейлист."
              action={
                <Button className="primary" onClick={() => setEdit(true)}>
                  Настроить состав
                </Button>
              }
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
      return { type };
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
          <option value="union">Объединить — любое правило</option>
          <option value="intersection">Пересечь — все правила</option>
          <option value="difference">Добавить с исключениями</option>
        </select>
        <span className="rule-depth">
          {depth === 0 ? "СОСТАВ" : `ПРАВИЛО ${depth + 1}`}
        </span>
      </div>
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
  const { refresh, notify } = useData(),
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
  const key = JSON.stringify(definition);
  useEffect(() => {
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
  }, [key]);
  return (
    <Modal
      wide
      title={playlist ? "Настроить плейлист" : "Новый плейлист"}
      subtitle="Выберите записи или задайте связи. Состав проверяется сразу."
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
              { title, description, definition },
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
        <div className="editor-layout">
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
              </select>
            </label>
          </div>
          <aside className="preview-panel">
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
          </aside>
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
function TagsPage() {
  const { library, refresh, notify } = useData(),
    [edit, setEdit] = useState<TagDto | "new" | null>(null),
    [name, setName] = useState(""),
    [color, setColor] = useState(TAG_COLORS[0]!),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState<TagDto | null>(null);
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
      <div className="tag-grid">
        {library.tags.map((tag) => {
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
                <h3>{tag.name}</h3>
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
  const { notify, refresh, openImport } = useData(),
    [tokens, setTokens] = useState<
      { id: string; name: string; createdAt: string }[]
    >([]),
    [name, setName] = useState(""),
    [newToken, setNewToken] = useState(""),
    [busy, setBusy] = useState(false),
    [includeFiles, setIncludeFiles] = useState(true),
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
            <Button
              className="subtle"
              busy={exportBusy}
              onClick={async () => {
                setExportBusy(true);
                try {
                  await api("/jobs", "POST", {
                    kind: "export",
                    input: { includeFiles },
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
