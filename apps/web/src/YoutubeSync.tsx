import { useEffect, useRef, useState } from "react";
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

export function YoutubeLinkedPlaylist({
  playlist,
  items,
  tags,
  reload,
}: {
  playlist: PlaylistDto;
  items: ItemDto[];
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
  const path = `/playlists/${encodeURIComponent(playlist.id)}/youtube-sync`;
  const link = state?.playlistId === playlist.id ? state.link : null;

  useEffect(() => {
    let mounted = true;
    setSelection("");
    setError("");
    setMessage("");
    function load() {
      const request = ++requestNumber.current;
      void api<{ link: YoutubeLinkDto | null }>(path)
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
    const timer = window.setInterval(load, pollInterval);
    window.addEventListener(syncChanged, load);
    return () => {
      mounted = false;
      window.clearInterval(timer);
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
  const byId = new Map(items.map((item) => [item.id, item]));
  const knownTags = tags ?? [
    ...new Map(
      items.flatMap((item) => item.tags).map((tag) => [tag.id, tag]),
    ).values(),
  ];
  const hidden = new Set(link.hidden);
  const remote = new Set(link.snapshot.map((entry) => entry.itemId));
  const associated = new Set(link.snapshot.map((entry) => entry.externalId));
  const additions = new Set(link.additions);
  const candidates = items.filter(
    (item) => !remote.has(item.id) && !additions.has(item.id),
  );
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
      {link.report && (
        <details>
          <summary>Последние применённые изменения</summary>
          <Report report={link.report} />
        </details>
      )}
      <details>
        <summary>
          Позиции YouTube ({link.snapshot.length})
          {hidden.size > 0 ? ` · скрыто ${hidden.size}` : ""}
        </summary>
        <ul className="youtube-sync-list">
          {link.snapshot.map((entry) => {
            const isHidden = hidden.has(entry.externalId);
            return (
              <li key={entry.externalId}>
                <span>{byId.get(entry.itemId)?.title ?? entry.title}</span>
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
      </details>
      <details>
        <summary>
          Локальные дополнения (
          {link.additions.filter((itemId) => byId.has(itemId)).length})
        </summary>
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
          <label>
            Запись из медиатеки
            <select
              value={selection}
              disabled={busy || !candidates.length}
              onChange={(event) => setSelection(event.target.value)}
            >
              <option value="">
                {candidates.length
                  ? "Выберите запись"
                  : "Нет записей для добавления"}
              </option>
              {candidates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button subtle"
            disabled={busy || !selection}
            onClick={() => edit({ type: "add", itemId: selection })}
          >
            Добавить в конец
          </button>
        </div>
      </details>
      <label>
        Тег для новых позиций YouTube
        <select
          value={
            knownTags.some((tag) => tag.id === link.tagId) ? link.tagId! : ""
          }
          disabled={busy}
          onChange={(event) =>
            edit({ type: "tag", tagId: event.target.value || null })
          }
        >
          <option value="">Без тега</option>
          {knownTags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
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
    const timer = window.setInterval(load, pollInterval);
    window.addEventListener(syncChanged, load);
    return () => {
      mounted = false;
      window.clearInterval(timer);
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
