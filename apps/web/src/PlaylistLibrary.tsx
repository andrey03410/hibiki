import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, Pause, Play } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import type { ItemDto } from "@hibiki/contracts";
import { formatDuration } from "./api";
import { ItemArtwork } from "./ItemArtwork";
import { usePlayerCard, usePlayerCommands } from "./player";
import { soundUnavailableReason } from "./player-model";
import { availableRows, currentSharedEntries, readOwnedRows, readPlaylistScope, readSharedRows, savedPlaylistPath,
  type PlaylistScope, type PlaylistTarget } from "./playlist-library";
import { isClosedShare } from "./sharing-model";
import { pollWhileVisible } from "./use-sharing-request";
import { Button, ErrorMessage, useData } from "./WorkspaceUi";

type Commands = ReturnType<typeof usePlayerCommands>;

export function usePlaylistLibrary() {
  const [scope, setScope] = useState<PlaylistScope>();
  const [pending, setPending] = useState<PlaylistTarget>();
  const [error, setError] = useState("");
  const command = useRef<AbortController | undefined>(undefined);
  const reading = useRef<AbortController | undefined>(undefined);
  const navigate = useNavigate();
  const location = useLocation();
  useLayoutEffect(() => {
    setPending(undefined);
    setError("");
    return () => reading.current?.abort();
  }, [location.key]);
  useEffect(() => () => command.current?.abort(), []);

  async function launch(target: PlaylistTarget, player: Commands) {
    command.current?.abort();
    const controller = new AbortController();
    command.current = reading.current = controller;
    const isCurrent = () => !controller.signal.aborted;
    setPending(target);
    setError("");
    try {
      const next = await readPlaylistScope(target, controller.signal);
      if (!isCurrent()) return;
      reading.current = undefined;
      setScope(next);
      navigate("/");
      window.scrollTo(0, 0);
      const entries = availableRows(next.initialRows);
      if (!entries.length) return;
      if (next.kind === "saved") {
        await player.playShared(savedPlaylistPath(next.id), entries, 0, () => currentSharedEntries(next), { fromLibrary: true, isCurrent });
      } else {
        await player.start(entries, 0, next.id, { fromLibrary: true, queueIds: next.order, isCurrent });
      }
    } catch (failure) {
      if (isCurrent()) setError((failure as Error).message);
    } finally {
      if (reading.current === controller) reading.current = undefined;
      if (isCurrent()) setPending(undefined);
    }
  }
  function cancelPending() {
    reading.current?.abort();
    reading.current = undefined;
    setPending(undefined);
    setError("");
  }
  return {scope, launch, pending, error, cancelPending, clear: () => setScope(undefined)};
}

function ScopeRow({item, index, playerId, playlistId, play}: {
  item: ItemDto; index: number; playerId: string; playlistId?: string; play: () => void;
}) {
  const {active, playing} = usePlayerCard(playerId, playlistId);
  const unavailable = soundUnavailableReason(item);
  return <li className="shared-track" aria-current={active || undefined}>
    <button type="button" className="icon-button" disabled={!!unavailable} onClick={play} title={unavailable}
      aria-label={`${playing ? "Приостановить" : "Воспроизвести"} ${item.title}`}>
      {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
    </button>
    <span className={`item-art art-${index % 6}`} aria-hidden="true">
      <ItemArtwork source={item.sources.find(source => source.thumbnail)} kind={item.kind} />
    </span>
    <div className="share-link-target"><strong>{item.title}</strong>
      <span className="small muted">{item.kind === "video" ? "Видео" : "Аудио"} · {formatDuration(item.duration)}</span>
      {unavailable && <span className="small muted">{unavailable}</span>}
    </div>
  </li>;
}

export function ScopedPlaylistPage({scope, clear}: {scope: PlaylistScope; clear: () => void}) {
  const player = usePlayerCommands();
  const {overview} = useData();
  const saved = scope.kind === "saved";
  const [rows, setRows] = useState(saved ? [] : scope.initialRows);
  const visibleRows = useRef(rows);
  visibleRows.current = rows;
  const [closed, setClosed] = useState(scope.closed);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const more = useRef<AbortController | undefined>(undefined);
  const sentinel = useRef<HTMLDivElement>(null);
  const action = useRef(0);
  const verifying = useRef<AbortController | undefined>(undefined);
  const path = savedPlaylistPath(scope.id);

  // Keep the original order, but never authorize playback using cached grants.
  const refreshShared = useCallback(async (forPlayback = false) => {
    if (verifying.current && !forPlayback) return;
    verifying.current?.abort();
    const controller = new AbortController();
    verifying.current = controller;
    try {
      const latest = await readSharedRows(path, scope.order, controller.signal);
      if (controller.signal.aborted) return;
      setRows(latest);
      setClosed(false);
      setError("");
      return latest;
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (isClosedShare(failure)) {
        setClosed(true);
        setRows(scope.order.map(() => null));
        setError("");
      } else setError((failure as Error).message);
    } finally {
      if (verifying.current === controller) verifying.current = undefined;
    }
  }, [path, scope]);

  useEffect(() => {
    if (!saved) return;
    void refreshShared();
    const stop = pollWhileVisible(async () => { await refreshShared(); });
    return () => { verifying.current?.abort(); verifying.current = undefined; stop(); };
  }, [saved, refreshShared]);
  useEffect(() => {
    if (scope.kind !== "own") return;
    const controller = new AbortController();
    async function refreshRows(ids: string[]) {
      if (!ids.length) return;
      const live = await readOwnedRows(ids, controller.signal);
      if (controller.signal.aborted) return;
      const changed = new Map(ids.map((id, index) => [id, live[index]!]));
      setRows(previous => previous.map((item, index) => {
        const id = scope.order[index];
        return id && changed.has(id) ? changed.get(id)! : item;
      }));
    }
    // Local edits can delete a visible row, yet the snapshot keeps its place.
    void refreshRows(availableRows(visibleRows.current).map(item => item.id)).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    const stop = pollWhileVisible(() => refreshRows(availableRows(visibleRows.current).filter(item => item.shared).map(item => item.id)));
    return () => { controller.abort(); stop(); };
  }, [scope, overview.revision]);
  useEffect(() => () => { ++action.current; more.current?.abort(); }, []);
  const hasMore = !saved && rows.length < scope.order.length;
  async function loadMore() {
    if (!hasMore || more.current || scope.kind !== "own") return;
    const controller = new AbortController();
    more.current = controller;
    setLoading(true);
    setError("");
    try {
      const page = await readOwnedRows(scope.order.slice(rows.length, rows.length + 100), controller.signal);
      if (!controller.signal.aborted) setRows(previous => [...previous, ...page]);
    } catch (failure) {
      if (!controller.signal.aborted) setError((failure as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (more.current === controller) more.current = undefined;
    }
  }
  useEffect(() => {
    if (!sentinel.current || !hasMore || loading || error) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "400px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [rows.length, hasMore, loading, error]);

  async function play(id: string) {
    const sequence = ++action.current;
    const isCurrent = () => sequence === action.current;
    if (saved) {
      const live = await refreshShared(true);
      if (!live || !isCurrent()) return;
      const entries = availableRows(live);
      const index = entries.findIndex(item => item.id === id);
      if (index >= 0 && !soundUnavailableReason(entries[index]!)) {
        await player.playShared(path, entries, index, () => currentSharedEntries(scope), {fromLibrary: true, activate: true, isCurrent});
      }
    } else {
      const entries = availableRows(rows);
      player.activateItem(entries, entries.findIndex(item => item.id === id), scope.id,
        {fromLibrary: true, queueIds: scope.order, isCurrent});
    }
  }
  const noSound = rows.length === scope.order.length && rows.length > 0 && !rows.some(item => item && !soundUnavailableReason(item));
  return <section className="sharing-page">
    <div className="page-top"><span className="breadcrumb">Медиатека</span>
      <button type="button" className="text-button" onClick={clear}><ArrowLeft size={14} />Вся медиатека</button>
    </div>
    <div className="title-row"><h1>{scope.title}</h1></div>
    <ErrorMessage error={error} />
    {saved && error && <Button className="subtle" onClick={() => void refreshShared()}>Повторить</Button>}
    {saved && !closed && !rows.length && !!scope.order.length && !error && <div className="loading-inline" role="status"><LoaderCircle size={16} className="spin" />Проверяем доступ…</div>}
    {closed ? <p role="status">Доступ к плейлисту закрыт.</p> :
      !scope.order.length ? <p className="empty-state muted">В плейлисте пока нет записей.</p> :
      noSound && <p role="status">В плейлисте нет записей, доступных для прослушивания.</p>}
    {!!rows.length && <ol className="shared-tracks" aria-label="Состав плейлиста">
      {rows.map((item, index) => item
        ? <ScopeRow key={item.id} item={item} index={index} playlistId={saved ? undefined : scope.id} playerId={saved ? player.sharedId(path, item.id) ?? "" : item.id}
            play={() => void play(item.id).catch(failure => setError(failure.message))} />
        : <li key={index} className="shared-track shared-track-closed"><span aria-hidden="true">{index + 1}</span>Запись недоступна</li>)}
    </ol>}
    {hasMore && <div ref={sentinel}>
      <Button className="subtle" busy={loading} onClick={() => void loadMore()}>Показать ещё</Button>
    </div>}
  </section>;
}
