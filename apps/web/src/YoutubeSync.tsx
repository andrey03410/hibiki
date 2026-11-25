import { ItemSelect, useItemNames } from "./ItemPicker";
import { pollWhileVisible } from "./use-sharing-request";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, ExternalLink, Youtube } from "lucide-react";
import { Link } from "react-router";
import type { ItemDto, PlaylistDto, TagDto } from "@hibiki/contracts";
import type {
  YoutubeLinkDto,
  YoutubeLocalEdit,
  YoutubeNoticeDto,
  YoutubeSyncMode,
  YoutubeSyncReport,
} from "../../server/src/youtube-sync";
import { api } from "./api";
import { fetchItems } from "./library-pages";
import "./youtube-sync.css";

const labels: Record<YoutubeSyncMode, string> = {
  auto: "Обновлять автоматически",
  review: "Проверять автоматически, применять вручную",
  manual: "Только вручную",
};
const pollInterval = 30_000;
const syncChanged = "hibiki:youtube-sync-changed";
const dateTime = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
});
type Reload = () => void | Promise<unknown>;

function Report({ report }: { report: YoutubeSyncReport }) {
  return (
    <div className="youtube-sync-report">
      {report.added.length > 0 && (
        <details open>
          <summary>Добавились ({report.added.length})</summary>
          <ul>
            {report.added.map((entry) => (
              <li key={entry.externalId}>
                {entry.title} · позиция {entry.to}
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.removed.length > 0 && (
        <details open>
          <summary>Ушли из плейлиста YouTube ({report.removed.length})</summary>
          <ul>
            {report.removed.map((entry) => (
              <li key={entry.externalId}>
                {entry.title} · позиция {entry.from}
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.moved.length > 0 && (
        <details open>
          <summary>Изменился порядок ({report.moved.length})</summary>
          <ul>
            {report.moved.map((entry) => (
              <li key={entry.externalId}>
                {entry.title} · с {entry.from} на {entry.to}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function YoutubeSyncSettings() {
  const [mode, setMode] = useState<YoutubeSyncMode>("auto");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void api<{ mode: YoutubeSyncMode }>("/youtube-sync/preference")
      .then(({ mode }) => {
        if (!active) return;
        setMode(mode);
        setReady(true);
      })
      .catch((failure: Error) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function change(next: YoutubeSyncMode) {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const updated = await api<{ mode: YoutubeSyncMode }>(
        "/youtube-sync/preference",
        "PATCH",
        { mode: next },
      );
      setMode(updated.mode);
      setSaved(true);
      window.dispatchEvent(new Event(syncChanged));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="settings-card">
      <div className="settings-card-heading">
        <span className="settings-icon">
          <Youtube size={22} />
        </span>
        <div>
          <h2>YouTube-плейлисты</h2>
        </div>
      </div>
      <label>
        Режим синхронизации
        <select
          value={mode}
          disabled={!ready || saving}
          onChange={(event) =>
            void change(event.target.value as YoutubeSyncMode)
          }
        >
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {saved && (
        <p className="muted small" role="status">
          Режим сохранён
        </p>
      )}
      {error && (
        <p className="youtube-sync-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function YoutubeLinkImport({
  url,
  onCreated,
}: {
  url: string;
  onCreated?: (playlist: PlaylistDto) => void | Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<PlaylistDto | null>(null);
  useEffect(() => {
    setError("");
    setCreated(null);
  }, [url]);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const playlist = await api<PlaylistDto>(
        "/youtube-sync/playlists",
        "POST",
        { url },
      );
      setCreated(playlist);
      await onCreated?.(playlist);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="youtube-sync-import">
      <button
        type="button"
        className="button subtle"
        disabled={busy || !url.trim() || !!created}
        onClick={() => void create()}
      >
        {busy ? "Получаем состав…" : "Создать связанный плейлист"}
      </button>
      {error && (
        <p className="youtube-sync-error" role="alert">
          {error}
        </p>
      )}
      {created && <Link to={`/playlists/${created.id}`}>{created.title}</Link>}
    </div>
  );
}

const emptyItems: ItemDto[] = [];

export function YoutubeSyncDetails({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => {
    if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
  }}>
    <summary>{summary}</summary>
    {open && children}
  </details>;
}

type LocalControls = {
  link: YoutubeLinkDto;
  busy: boolean;
  selection: string;
  setSelection: (id: string) => void;
  edit: (change: YoutubeLocalEdit) => void;
};

export function YoutubeLinkedPlaylist({
  playlist,
  items = emptyItems,
  libraryRevision,
  tags,
  reload,
}: {
  playlist: PlaylistDto;
  items?: ItemDto[];
  libraryRevision: string;
  tags?: TagDto[];
  reload: Reload;
}) {
  const [state, setState] = useState<{
    playlistId: string;
    link: YoutubeLinkDto | null;
  }>();
  const [selection, setSelection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestNumber = useRef(0);
  const [pendingTag,setPendingTag] = useState<{before:string|null; after:string}|null>(null);
  const path = `/playlists/${encodeURIComponent(playlist.id)}/youtube-sync`;
  const link = state?.playlistId === playlist.id ? state.link : null;

  useEffect(() => {
    let mounted = true;
    setSelection("");
    setPendingTag(null);
    setError("");
    setMessage("");
    async function load() {
      if (document.hidden) return;
      const request = ++requestNumber.current;
      await api<{ link: YoutubeLinkDto | null }>(path)
        .then(({ link }) => {
          if (!mounted || request !== requestNumber.current) return;
          setState({ playlistId: playlist.id, link });
        })
        .catch((failure: Error) => {
          if (mounted && request === requestNumber.current)
            setError(failure.message);
        });
    }
    load();
    const stop = pollWhileVisible(load, pollInterval);
    window.addEventListener(syncChanged, load);
    return () => {
      mounted = false;
      stop();
      window.removeEventListener(syncChanged, load);
    };
  }, [path, playlist.id]);

  async function update(action: "check" | "apply" | "edit", data: unknown) {
    ++requestNumber.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const updated = await api<YoutubeLinkDto>(
        action === "edit" ? path : `${path}/${action}`,
        action === "edit" ? "PATCH" : "POST",
        data,
      );
      ++requestNumber.current;
      setState({ playlistId: playlist.id, link: updated });
      if (action === "edit") setSelection("");
      if (
        !updated.error &&
        action === "check" &&
        !updated.preview &&
        updated.lastAppliedAt === link?.lastAppliedAt
      )
        setMessage("Состав YouTube не изменился.");
      if (!updated.error && action === "apply") {
        setMessage(
          updated.preview
            ? "Состав изменился. Проверьте новый предпросмотр."
            : updated.lastAppliedAt === link?.lastAppliedAt
              ? "Состав YouTube не изменился."
              : "Изменения применены.",
        );
      }
      if (action === "edit" || updated.lastAppliedAt !== link?.lastAppliedAt)
        await reload();
      window.dispatchEvent(new Event(syncChanged));
    } catch (failure) {
      setError((failure as Error).message);
      window.dispatchEvent(new Event(syncChanged));
    } finally {
      setBusy(false);
    }
  }

  if (!link)
    return error ? (
      <p className="youtube-sync-error" role="alert">
        {error}
      </p>
    ) : null;
  const knownTags = tags ?? [
    ...new Map(
      items.flatMap((item) => item.tags).map((tag) => [tag.id, tag]),
    ).values(),
  ];
  const edit = (data: YoutubeLocalEdit) => void update("edit", data);

  return (
    <section className="youtube-sync-panel">
      <div className="youtube-sync-heading">
        <div>
          <h2>Связь с YouTube</h2>
          <a
            className="text-button"
            href={link.url}
            target="_blank"
            rel="noreferrer"
          >
            Исходный плейлист <ExternalLink size={14} />
          </a>
        </div>
        <button
          type="button"
          className="button subtle"
          disabled={busy}
          onClick={() => void update("check", {})}
        >
          {busy ? "Подождите…" : "Проверить сейчас"}
        </button>
      </div>
      <p className="muted small">{labels[link.mode]}</p>
      <p className="muted small">
        {link.lastCheckedAt
          ? "Последняя проверка " +
            dateTime.format(new Date(link.lastCheckedAt))
          : "Проверок ещё не было"}
      </p>
      {message && <p role="status">{message}</p>}
      {link.error && (
        <p className="youtube-sync-error" role="alert">
          Не удалось обновить состав. {link.error}
        </p>
      )}
      {error && (
        <p className="youtube-sync-error" role="alert">
          {error}
        </p>
      )}
      {link.preview && (
        <div className="youtube-sync-preview">
          <h3>Предпросмотр изменений</h3>
          <Report report={link.preview} />
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() =>
              void update("apply", { previewId: link.preview!.id })
            }
          >
            Применить
          </button>
        </div>
      )}
      {link.report && <YoutubeSyncDetails summary="Последние применённые изменения">
        <Report report={link.report} />
      </YoutubeSyncDetails>}
      <YoutubeSyncDetails summary={`Позиции YouTube (${link.snapshot.length})${link.hidden.length ? ` · скрыто ${link.hidden.length}` : ""}`}>
        <YoutubeRemotePositions link={link} items={items} libraryRevision={libraryRevision} busy={busy} edit={edit} />
      </YoutubeSyncDetails>
      <YoutubeSyncDetails summary={`Локальные дополнения (${link.additions.length})`}>
        <YoutubeLocalAdditions revision={libraryRevision} link={link} busy={busy} edit={edit}
          selection={selection} setSelection={setSelection} />
      </YoutubeSyncDetails>
      <label>
        Тег для новых позиций YouTube
        <select value={pendingTag?.after ?? link.tagId ?? ""} disabled={busy}
          onChange={e => setPendingTag(e.target.value === (link.tagId ?? "") ? null : {before:link.tagId,after:e.target.value})}>
          <option value="">Без тега</option>
          {link.tagId && !knownTags.some(t => t.id === link.tagId && !t.archived) && <option value={link.tagId}>Прежнее точное назначение</option>}
          {knownTags.filter(t => !t.archived).map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
        </select>
      </label>
      {pendingTag && <div className="batch-preview">
        <p>Текущие записи сохранят свои назначения. Для новых позиций будет использоваться {knownTags.find(t => t.id === pendingTag.after)?.name ?? "импорт без тега"}.</p>
        <button type="button" className="button subtle compact" onClick={() => setPendingTag(null)}>Отмена</button>
        <button type="button" className="button primary compact" disabled={busy || link.tagId !== pendingTag.before}
          onClick={async () => {await update("edit",{type:"tag",tagId:pendingTag.after || null});setPendingTag(null);}}>Применить к новым позициям</button>
      </div>}
    </section>
  );
}

function YoutubeRemotePositions({ link, items, libraryRevision, busy, edit }: Pick<LocalControls, "link" | "busy" | "edit"> & {
  items: ItemDto[];
  libraryRevision: string;
}) {
  const [limit, setLimit] = useState(100);
  const rows = useMemo(() => link.snapshot.slice(0, limit), [link.snapshot, limit]);
  const titles = useMemo(() => new Map(items.map(item => [item.id, item.title])), [items]);
  const [cache, setCache] = useState<{ revision: string; titles: Map<string, string | undefined> }>();
  const loadedTitles = cache?.revision === libraryRevision ? cache.titles : undefined;
  const missing = useMemo(() => rows.map(row => row.itemId)
    .filter(id => !titles.has(id) && !loadedTitles?.has(id)), [rows, titles, loadedTitles]);
  useEffect(() => {
    if (!missing.length) return;
    let active = true;
    void fetchItems(missing).then(result => {
      if (!active) return;
      const found = new Map(result.map(item => [item.id, item.title]));
      setCache(previous => {
        const next = new Map(previous?.revision === libraryRevision ? previous.titles : undefined);
        for (const id of missing) next.set(id, found.get(id));
        return { revision: libraryRevision, titles: next };
      });
    }).catch(() => {}); // Snapshot titles stay available while member metadata is unavailable.
    return () => { active = false; };
  }, [missing, libraryRevision]);
  const hidden = new Set(link.hidden);
  const associated = new Set(link.snapshot.map(entry => entry.externalId));
  return <>
    <ul className="youtube-sync-list">
      {rows.map((entry) => {
        const isHidden = hidden.has(entry.externalId);
        return (
          <li key={entry.externalId}>
            <span>{titles.get(entry.itemId) ?? loadedTitles?.get(entry.itemId) ?? entry.title}</span>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                edit({
                  type: isHidden ? "show" : "hide",
                  externalId: entry.externalId,
                })
              }
            >
              {isHidden ? "Показать" : "Скрыть"}
            </button>
          </li>
        );
      })}
      {link.hidden
        .filter((externalId) => !associated.has(externalId))
        .map((externalId) => (
          <li key={externalId}>
            <span>{externalId} · позиция ушла с YouTube</span>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => edit({ type: "show", externalId })}
            >
              Снять скрытие
            </button>
          </li>
        ))}
    </ul>
    {limit < link.snapshot.length && <button type="button" className="button subtle compact"
      onClick={() => setLimit(current => current + 100)}>Показать ещё позиции</button>}
  </>;
}

function YoutubeLocalAdditions({ revision, link, busy, edit, selection, setSelection }: LocalControls & { revision: string }) {
  const selected = useItemNames(link.additions, revision);
  const byId = new Map(selected.names.map(item => [item.id, item]));
  const excluded = new Set([...link.snapshot.map(entry => entry.itemId), ...link.additions]);
  return <>
    <ul className="youtube-sync-list">
      {link.additions.flatMap((itemId) => {
        const item = byId.get(itemId);
        return item
          ? [
              <li key={itemId}>
                <span>{item.title}</span>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => edit({ type: "remove", itemId })}
                >
                  Убрать из подборки
                </button>
              </li>,
            ]
          : [];
      })}
    </ul>
    <div className="youtube-sync-add">
      {selected.error && <p role="alert">{selected.error} <button type="button" onClick={selected.retry}>Повторить</button></p>}
      <ItemSelect label="Запись из медиатеки" empty="Выберите запись" value={selection} onChange={setSelection}
        revision={revision} disabled={busy} excluded={excluded} />
      <button
        type="button"
        className="button subtle"
        disabled={busy || !selection}
        onClick={() => edit({ type: "add", itemId: selection })}
      >
        Добавить в конец
      </button>
    </div>
  </>;
}

export function YoutubeSyncNotifications({ reload }: { reload: Reload }) {
  const [notices, setNotices] = useState<YoutubeNoticeDto[]>([]);
  const [error, setError] = useState("");
  const appliedSeen = useRef(new Set<string>());
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    let mounted = true;
    let latest = 0;
    async function load() {
      if (document.hidden) return;
      const request = ++latest;
      try {
        const result = await api<{ notices: YoutubeNoticeDto[] }>(
          "/youtube-sync/notices",
        );
        if (!mounted || latest !== request) return;
        setNotices(result.notices);
        setError("");
        const applied = result.notices.filter(
          (notice) =>
            !notice.readAt &&
            notice.kind === "applied" &&
            !appliedSeen.current.has(notice.id),
        );
        if (applied.length) {
          for (const notice of applied) appliedSeen.current.add(notice.id);
          await reloadRef.current();
        }
      } catch (failure) {
        if (mounted && latest === request) setError((failure as Error).message);
      }
    }
    void load();
    const stop = pollWhileVisible(load, pollInterval);
    window.addEventListener(syncChanged, load);
    return () => {
      mounted = false;
      stop();
      window.removeEventListener(syncChanged, load);
    };
  }, []);

  async function markRead(notice: YoutubeNoticeDto) {
    if (notice.readAt) return;
    try {
      await api(
        `/youtube-sync/notices/${encodeURIComponent(notice.id)}/read`,
        "PATCH",
        {},
      );
      window.dispatchEvent(new Event(syncChanged));
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  const unread = notices.filter((notice) => !notice.readAt).length;
  return (
    <details className="youtube-sync-notices">
      <summary
        aria-label={
          unread
            ? `Уведомления YouTube, непрочитанных ${unread}`
            : "Уведомления YouTube"
        }
      >
        <Bell size={17} aria-hidden="true" />
        <span>Уведомления YouTube</span>
        {unread > 0 && <span className="youtube-sync-count">{unread}</span>}
      </summary>
      <div className="youtube-sync-notice-menu">
        {error && (
          <p className="youtube-sync-error" role="alert">
            {error}
          </p>
        )}
        {!notices.length && <p className="muted">Уведомлений пока нет</p>}
        {notices.map((notice) => (
          <details
            key={notice.id}
            className={notice.readAt ? undefined : "unread"}
          >
            <summary>
              <span>{notice.playlistTitle}</span>
              <span className="muted small">
                {notice.kind === "applied"
                  ? "Состав обновлён"
                  : "Найден новый состав"}
                {" · "}
                {dateTime.format(new Date(notice.createdAt))}
              </span>
            </summary>
            <Report report={notice.report} />
            <div className="youtube-sync-heading">
              <Link
                to={`/playlists/${notice.playlistId}`}
                onClick={() => void markRead(notice)}
              >
                Открыть плейлист
              </Link>
              {!notice.readAt && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void markRead(notice)}
                >
                  Отметить прочитанным
                </button>
              )}
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}
