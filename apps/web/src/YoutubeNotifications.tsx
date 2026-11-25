import {useEffect, useRef, useState} from "react";
import {Bell} from "lucide-react";
import {Link} from "react-router";
import type {YoutubeNoticeDto, YoutubeSyncReport} from "../../server/src/youtube-sync";
import {api} from "./api";
import {pollWhileVisible} from "./use-sharing-request";
import "./youtube-sync.css";

export const pollInterval = 30_000;
export const syncChanged = "hibiki:youtube-sync-changed";
export const dateTime = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
});
export type Reload = () => void | Promise<unknown>;

export function Report({ report }: { report: YoutubeSyncReport }) {
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
