import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  ListMusic,
  AudioLines,
  Video,
  Headphones,
  Minimize2,
  X,
  Music2,
  Maximize2,
  CircleAlert,
  ArrowDown,
  ArrowUp,
  GripVertical,
} from "lucide-react";
import { moveQueueItem, removeUpcomingItem, undoQueueRemoval, type QueueRemoval } from "@hibiki/core";
import type { ItemDto, PlaybackMode, PlaylistDto } from "@hibiki/contracts";
import { api, formatDuration, mediaWord } from "./api.ts";
import { CompactPlaybackQueue, PlaybackSeekBar } from "./PlaybackControls";
import { useListeningAttempt } from "./listening-client";
import "./queue.css";
import {
  nextPlayableIndex,
  firstPlayableIndex,
  playbackSources,
  sourceLoadPosition,
  restorePlayback,
  playbackShortcut,
  playbackArtwork,
  playbackKind,
  canAutoplayPlayback,
  soundUnavailableReason,
  enterPlayerFullscreen,
  createFullscreenIdleTimer,
  addToPlaybackQueue,
  createPlaybackAttempt,
  playbackSourceForAttempt,
  queuePlaylistInput,
  startPlaybackQueue,
  togglePlaybackShuffle,
  playbackSettingsSignature,
  restoreCachedPlayback,
  nativePlaybackReading,
  youtubePlaybackReading,
  prepareYoutubePlayback,
  nativeRestartHasProgress,
  createYoutubeRestartConfirmation,
  recoverDeletedQueueEntry,
  reconcileQueuePlaylistIds,
  type PlaybackFinish,
  type PlaybackReading,
  type PlaybackSettings,
  type PlaybackTrigger,
} from "./player-model.ts";

interface Controller {
  current?: ItemDto;
  playing: boolean;
  waitingForVideo: boolean;
  settings: PlaybackSettings;
  start: (items: ItemDto[], index?: number, playlistId?: string, options?: StartOptions) => void;
  enqueue: (item: ItemDto, playlistId?: string) => void;
  playNext: (item: ItemDto, playlistId?: string) => void;
  toggle: () => void;
  watchCurrent: () => void;
}
type StartOptions = { mode?: PlaybackMode; fromLibrary?: boolean };
const PlayerContext = createContext<Controller | null>(null);
export const usePlayer = () => useContext(PlayerContext)!;

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}
let youtubePromise: Promise<void> | undefined;
function loadYoutube() {
  return (youtubePromise ??= new Promise<void>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () =>
      reject(new Error("Не удалось загрузить YouTube. Проверьте соединение."));
    document.head.append(script);
  }));
}
function Youtube({
  id,
  playing,
  volume,
  position,
  engine,
  onTime,
  onEnded,
  onError,
  onPaused,
  onBuffering,
  onPlaying,
}: {
  id: string;
  playing: boolean;
  volume: number;
  position: number;
  engine: React.RefObject<any>;
  onTime: (...reading: PlaybackReading) => void;
  onEnded: () => void;
  onError: () => void;
  onPaused: () => void;
  onBuffering: () => void;
  onPlaying: (...reading: PlaybackReading) => void;
}) {
  const target = useRef<HTMLDivElement>(null),
    callbacks = useRef({ onTime, onEnded, onError, onPaused, onBuffering, onPlaying });
  callbacks.current = { onTime, onEnded, onError, onPaused, onBuffering, onPlaying };
  const pending = useRef({ position, volume, playing });
  pending.current = { position, volume, playing };
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setInterval>,
      player: any;
    const reportTime = () => {
      const state = player?.getPlayerState?.();
      if (!disposed && (state === 1 || state === 2))
        callbacks.current.onTime(...youtubePlaybackReading(player));
    };
    const host = document.createElement("div");
    target.current?.append(host);
    loadYoutube()
      .then(() => {
        if (disposed) return;
        player = new window.YT.Player(host, {
          width: "100%",
          height: "100%",
          videoId: id,
          playerVars: {
            autoplay: 0,
            playsinline: 1,
            rel: 0,
            origin: location.origin,
          },
          events: {
            onReady: () => {
              if (disposed) return;
              engine.current = player;
              const { volume, position, playing } = pending.current;
              player.setVolume(volume * 100);
              prepareYoutubePlayback(player, id, position, playing);
              timer = setInterval(reportTime, 500);
            },
            onStateChange: (event: any) => {
              if (disposed) return;
              if (event.data === 0) callbacks.current.onEnded();
              if (event.data === 1) callbacks.current.onPlaying(...youtubePlaybackReading(player));
              if (event.data === 2) callbacks.current.onPaused();
              if (event.data === 3) callbacks.current.onBuffering();
            },
            onPlaybackRateChange: reportTime,
            onError: () => { if (!disposed) callbacks.current.onError(); },
            onAutoplayBlocked: () => { if (!disposed) callbacks.current.onPaused(); },
          },
        });
      })
      .catch(() => { if (!disposed) callbacks.current.onError(); });
    return () => {
      disposed = true;
      clearInterval(timer);
      player?.destroy?.();
      engine.current = null;
      host.remove();
    };
  }, [id]);
  useEffect(() => {
    const p = engine.current;
    if (p?.playVideo) playing ? p.playVideo() : p.pauseVideo();
  }, [playing]);
  useEffect(() => {
    engine.current?.setVolume?.(volume * 100);
  }, [volume]);
  return <div ref={target} className="youtube-frame" />;
}

function QueuePlaylistDialog({
  ids, close, saved,
}: {
  ids: string[];
  close: () => void;
  saved: (playlist: PlaylistDto) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !title.trim() || !ids.length) return;
    setSaving(true);
    setError("");
    try {
      const playlist = await api<PlaylistDto>("/playlists", "POST", queuePlaylistInput(title, ids));
      saved(playlist);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Не удалось сохранить плейлист.");
      setSaving(false);
    }
  }
  return (
    <dialog
      className="queue-playlist-dialog"
      ref={dialog}
      aria-labelledby="queue-playlist-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) close(); }}
    >
      <form onSubmit={submit}>
        <h2 id="queue-playlist-title">Сохранить очередь как плейлист</h2>
        <p>{ids.length} {mediaWord(ids.length)}</p>
        <label>
          Название
          <input required maxLength={200} autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="queue-playlist-actions">
          <button type="button" className="button" disabled={saving} onClick={close}>Отмена</button>
          <button className="button primary" disabled={saving || !title.trim() || !ids.length}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function PlayerProvider({
  items,
  initialSettings,
  userId,
  children,
  suspendSaving = false,
  onPlaylistSaved,
}: {
  items: ItemDto[];
  initialSettings: any;
  userId: string;
  children: (player: ReactNode, miniPlayer: ReactNode) => ReactNode;
  suspendSaving?: boolean;
  onPlaylistSaved?: (playlist: PlaylistDto) => void;
}) {
  const navigate = useNavigate();
  const { key: routeKey } = useLocation();
  const onPlayerScreen = !!useMatch("/player");
  const history = useListeningAttempt(userId);
  const [attempt] = useState(() => createPlaybackAttempt(history));
  const serverSignature = useRef<string | undefined>(undefined);
  const storageKey = `hibiki.player.${userId}`;
  const [settings, setSettings] = useState<PlaybackSettings>(() => {
    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch {}
    serverSignature.current = playbackSettingsSignature(restorePlayback(initialSettings ?? {}, items));
    return restoreCachedPlayback(initialSettings, cached, items);
  });
  const [playing, setPlaying] = useState(false),
    [duration, setDuration] = useState(0),
    [failedSources, setFailedSources] = useState<ReadonlySet<string>>(() => new Set()),
    [error, setError] = useState(""),
    [offerAudioSkip, setOfferAudioSkip] = useState(false),
    [nativeFullscreen, setNativeFullscreen] = useState(false),
    [viewportFullscreen, setViewportFullscreen] = useState(false),
    [controlsIdle, setControlsIdle] = useState(false),
    [failedArtwork, setFailedArtwork] = useState<string>(),
    [saveError, setSaveError] = useState(""),
    [removal, setRemoval] = useState<(QueueRemoval & { title: string; playlistId?: string })>(),
    [dragOver, setDragOver] = useState<string>(),
    [showSavePlaylist, setShowSavePlaylist] = useState(false),
    [createdPlaylist, setCreatedPlaylist] = useState<PlaylistDto>();
  const savingSuspended = useRef(suspendSaving);
  savingSuspended.current = suspendSaving;
  const controlsIdleTimer = useRef<ReturnType<typeof createFullscreenIdleTimer> | null>(null);
  const viewportRestore = useRef<{ x: number; y: number; focus: Element | null } | null>(null);
  const stage = useRef<HTMLDivElement>(null),
    native = useRef<HTMLMediaElement | null>(null),
    youtube = useRef<any>(null),
    seekOnLoad = useRef(settings.position),
    live = useRef(settings),
    playOnPlayerOpen = useRef<string | undefined>(undefined),
    playingRef = useRef(playing),
    itemsRef = useRef(items),
    failed = useRef(new Set<string>()),
    nativeStarted = useRef(new WeakSet<HTMLMediaElement>()),
    nativePositionReady = useRef(new WeakSet<HTMLMediaElement>()),
    nativeRestart = useRef<{ element: HTMLMediaElement; position: number } | null>(null),
    youtubeRestart = useRef<ReturnType<typeof createYoutubeRestartConfirmation> | null>(null),
    draggingId = useRef<string | undefined>(undefined),
    scrub = useRef<{ target?: number } | null>(null);
  itemsRef.current = items;
  const attachNative = useCallback((element: HTMLMediaElement | null) => {
    if (!element) return;
    native.current = element;
    return () => {
      element.pause();
      if (native.current === element) native.current = null;
    };
  }, []);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const current = itemsById.get(settings.queue[settings.queueIndex]!);
  const sourceIdentity = useRef<{ itemId?: string; sourceId?: string; preferredSourceId?: string }>(undefined);
  const previousSource = sourceIdentity.current;
  const source = current ? playbackSourceForAttempt(
    current,
    failedSources,
    previousSource?.itemId === current.id && previousSource.sourceId
      ? { sourceId: previousSource.sourceId, preferredSourceId: previousSource.preferredSourceId }
      : undefined,
    settings.mode,
  ) : undefined;
  const isYoutube = source?.provider === "youtube";
  const youtubeId = isYoutube
    ? source.externalId || new URL(source.url!).searchParams.get("v") || source.url!.split("/").pop()
    : undefined;
  const presentationKind = current ? playbackKind(current, source, settings.mode) : undefined;
  const waitingForVideo = !!current && !!source &&
    !canAutoplayPlayback(current, source, settings.mode, onPlayerScreen);
  const identity = { itemId: current?.id, sourceId: source?.id };
  const sourceKey = JSON.stringify([identity, presentationKind, waitingForVideo]);
  const mediaKey = useRef(sourceKey);
  const positionOnVideoExit = waitingForVideo && previousSource?.itemId === current?.id &&
    previousSource?.sourceId === source?.id
    ? readPosition()
    : undefined;
  // Preserve the load position when the source changes within the same entry.
  seekOnLoad.current = sourceLoadPosition(previousSource, identity, settings.position, seekOnLoad.current);
  if (previousSource?.itemId !== identity.itemId || previousSource?.sourceId !== identity.sourceId) {
    sourceIdentity.current = { ...identity, preferredSourceId: current?.preferredSourceId };
  }

  function patch(value: Partial<PlaybackSettings>) {
    live.current = { ...live.current, ...value };
    setSettings(live.current);
  }
  function playIntent(value: boolean) {
    playingRef.current = value;
    setPlaying(value);
  }
  function currentMedia() {
    return mediaKey.current === sourceKey;
  }
  function readPosition(): number | undefined {
    const element = native.current;
    if (element && nativePositionReady.current.has(element)) return element.currentTime;
    const iframe = youtube.current;
    if (iframe?.getPlayerState?.() === 1) {
      const position = iframe.getCurrentTime?.();
      if (typeof position === "number" && position > 0) return position;
    }
  }
  function playNative(element: HTMLMediaElement) {
    element.play().catch(() => {
      if (native.current !== element || !currentMedia() || !playingRef.current) return;
      playIntent(false);
      setError("Нажмите «Воспроизвести», чтобы продолжить.");
    });
  }
  function measureProgress() {
    if (scrub.current?.target !== undefined) return;
    if (native.current) attempt.progress(...nativePlaybackReading(native.current));
    else if (youtube.current) attempt.progress(...youtubePlaybackReading(youtube.current));
  }
  function finishAttempt(reason: PlaybackFinish) {
    measureProgress();
    attempt.finish(reason);
    scrub.current = null;
    nativeRestart.current = null;
    youtubeRestart.current = null;
  }
  function selectAttempt(state: PlaybackSettings, trigger: PlaybackTrigger, list = itemsRef.current) {
    const id = state.queue[state.queueIndex];
    const item = list.find((entry) => entry.id === id);
    const playlistIds = state.queuePlaylistIds;
    attempt.select(item ?? null, id && playlistIds && Object.hasOwn(playlistIds, id) ? playlistIds[id] : undefined, trigger);
  }
  function resetSources() {
    setFailedSources(new Set());
    sourceIdentity.current = undefined;
    seekOnLoad.current = 0;
  }
  function playEntry(
    state: PlaybackSettings,
    index: number,
    trigger: PlaybackTrigger,
    { list = itemsRef.current, autoplay = true }: { list?: ItemDto[]; autoplay?: boolean } = {},
  ) {
    const id = state.queue[index];
    const entry = list.find((item) => item.id === id);
    const preferred = entry && playbackSources(entry, state.mode)[0];
    const canPlay = !!entry && canAutoplayPlayback(entry, preferred, state.mode, onPlayerScreen);
    const shouldPlay = autoplay && canPlay;
    const sameSource = !!current && !!preferred && id === current.id &&
      source?.id === preferred.id && presentationKind === playbackKind(current, preferred, state.mode);
    resetSources();
    patch({ ...state, queueIndex: index, position: 0 });
    selectAttempt(live.current, trigger, list);
    setError("");
    setOfferAudioSkip(false);
    playIntent(shouldPlay);
    if (sameSource) {
      const element = native.current;
      if (shouldPlay && element) {
        nativeStarted.current.delete(element);
        nativeRestart.current = { element, position: 0 };
      }
      if (!shouldPlay) {
        element?.pause();
        youtube.current?.pauseVideo?.();
      }
      positionMedia(0, shouldPlay);
      if (!shouldPlay) return;
      if (element) {
        if (element.paused || element.ended) playNative(element);
      } else if (youtube.current) {
        youtube.current.playVideo?.();
      }
    } else {
      mediaKey.current = "";
      setDuration(0);
    }
  }
  function switchTo(index: number) {
    const state = live.current;
    const item = itemsById.get(state.queue[index]!);
    if (!item || !playbackSources(item, state.mode).length) return;
    finishAttempt("manual");
    failed.current.delete(item.id);
    playEntry(state, index, "manual");
  }
  function start(entries: ItemDto[], index = 0, playlistId?: string, options: StartOptions = {}) {
    if (!entries.length) return;
    // Playlist results can predate the latest availability/track metadata refresh.
    const list = entries.map((item) => itemsById.get(item.id) ?? item);
    const { mode = "original", fromLibrary = false } = options;
    const shuffle = !fromLibrary && live.current.shuffle;
    const state = {
      ...live.current,
      ...startPlaybackQueue(list, index, shuffle, playlistId),
      mode, shuffle,
    };
    const playable = firstPlayableIndex(state.queue, state.queueIndex, list, mode, !fromLibrary);
    if (playable < 0) {
      setOfferAudioSkip(false);
      setError(mode === "audio"
        ? "В этой подборке нет записей, доступных для прослушивания."
        : "В этой очереди нет доступных источников.");
      return;
    }
    const entry = list.find((item) => item.id === state.queue[playable])!;
    const chosenSource = playbackSources(entry, mode)[0];
    const opensPlayer = mode === "original" &&
      (!!playlistId || entry.kind === "video" || playbackKind(entry, chosenSource, mode) === "video");
    finishAttempt("manual");
    failed.current.clear();
    setRemoval(undefined);
    playOnPlayerOpen.current = undefined;
    playEntry(state, playable, playable === state.queueIndex ? "manual" : "advance", { list });
    if (opensPlayer && !onPlayerScreen) openAndPlay(entry.id);
    if (playable !== state.queueIndex) showSkipped(state, state.queueIndex, playable);
  }
  function nextIndex(direction: 1 | -1, state = live.current, retry = false) {
    const { queue, queueIndex, repeat, mode } = state;
    return nextPlayableIndex(
      queue, queueIndex,
      retry ? itemsRef.current : itemsRef.current.filter((item) => !failed.current.has(item.id)),
      direction, repeat === "all", mode,
    );
  }
  function showSkipped(state: PlaybackSettings, startIndex: number, endIndex: number) {
    if (startIndex === endIndex) return;
    const { queue, mode } = state;
    const skippedIds = endIndex < 0 ? queue.slice(startIndex)
      : endIndex > startIndex ? queue.slice(startIndex, endIndex)
      : [...queue.slice(startIndex), ...queue.slice(0, endIndex)];
    const skipped = skippedIds.map((id) => itemsById.get(id)).find(
      (item) => item && !playbackSources(item, mode).length,
    );
    if (skipped) {
      const reason = mode === "audio" ? soundUnavailableReason(skipped) : "Источник недоступен";
      setError(`Пропущено: «${skipped.title}». ${reason}.`);
    }
  }
  function next(direction: 1 | -1 = 1, ended = false) {
    if (!currentMedia()) return;
    finishAttempt(ended ? "ended" : "manual");
    const state = live.current;
    const index = ended && state.repeat === "one" ? state.queueIndex : nextIndex(direction);
    if (index < 0) {
      playIntent(false);
      if (ended) seek(0, false);
      selectAttempt(live.current, "manual");
      if (direction === 1) showSkipped(state, state.queueIndex + 1, -1);
      return;
    }
    const trigger = ended ? (index === state.queueIndex ? "repeat" : "advance") : "manual";
    playEntry(state, index, trigger);
    if (direction === 1 && index !== state.queueIndex)
      showSkipped(state, (state.queueIndex + 1) % state.queue.length, index);
  }
  function sourceError() {
    if (!currentMedia()) return;
    mediaKey.current = "";
    const unsuccessful = new Set(failedSources);
    if (source) unsuccessful.add(source.id);
    if (current && playbackSourceForAttempt(current, unsuccessful, undefined, settings.mode)) {
      measureProgress();
      attempt.paused();
      setFailedSources(unsuccessful);
      setError("Основной источник недоступен. Переключено на другой.");
      return;
    }
    finishAttempt("error");
    if (current) failed.current.add(current.id);
    const index = nextIndex(1);
    if (index >= 0) playEntry(live.current, index, "advance", { autoplay: playingRef.current });
    else {
      setFailedSources(unsuccessful);
      playIntent(false);
    }
    setError(index >= 0
      ? `«${current?.title ?? "Запись"}» недоступна. Переходим к следующей.`
      : "В очереди больше нет доступных источников.");
  }
  function positionMedia(position: number, confirmYoutubeRestart = false) {
    const player = youtube.current;
    const element = native.current;
    if (youtubeId && player) {
      if (confirmYoutubeRestart || youtubeRestart.current)
        youtubeRestart.current = createYoutubeRestartConfirmation(player.getCurrentTime?.() ?? 0, position);
      if (playingRef.current || player.getPlayerState?.() === 2) player.seekTo(position, true);
      else prepareYoutubePlayback(player, youtubeId, position, false);
    } else if (element?.readyState) {
      element.currentTime = position;
      if (nativeRestart.current?.element === element)
        nativeRestart.current.position = element.currentTime;
    }
    seekOnLoad.current = position;
  }
  function seek(position: number, record = true) {
    const bounded = Math.max(0, Math.min(duration || current?.duration || Infinity, position));
    if (record) {
      measureProgress();
      attempt.seek(bounded);
    }
    positionMedia(bounded);
    patch({ position: bounded });
  }
  function seekFromSlider(position: number) {
    if (!scrub.current) {
      seek(position);
      return;
    }
    if (scrub.current.target === undefined) {
      measureProgress();
      attempt.paused();
    }
    scrub.current.target = position;
    seek(position, false);
  }
  function finishScrub() {
    const position = scrub.current?.target;
    scrub.current = null;
    if (position === undefined) return;
    attempt.seek(position);
    const element = native.current;
    if (element && !element.paused && !element.seeking && nativeStarted.current.has(element))
      attempt.playing(...nativePlaybackReading(element));
    else if (!youtubeRestart.current && youtube.current?.getPlayerState?.() === 1)
      attempt.playing(...youtubePlaybackReading(youtube.current));
  }
  const nativeEvents = {
    onLoadedMetadata(event: SyntheticEvent<HTMLMediaElement>) {
      if (!currentMedia()) return;
      const element = event.currentTarget;
      element.currentTime = seekOnLoad.current;
      nativePositionReady.current.add(element);
      element.volume = live.current.volume;
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
    },
    onPlaying(event: SyntheticEvent<HTMLMediaElement>) {
      if (!currentMedia()) return;
      const element = event.currentTarget;
      if (element.paused || element.ended) return;
      if (nativeRestart.current?.element === element && (element.seeking || element.readyState < 3)) return;
      nativeRestart.current = null;
      nativeStarted.current.add(element);
      if (scrub.current?.target === undefined) attempt.playing(...nativePlaybackReading(element));
      showFullscreenControls();
      playIntent(true);
    },
    onTimeUpdate(event: SyntheticEvent<HTMLMediaElement>) {
      const element = event.currentTarget;
      if (!currentMedia() || element.seeking || scrub.current?.target !== undefined) return;
      const reading = nativePlaybackReading(element);
      patch({ position: reading[0] });
      const restart = nativeRestart.current;
      if (restart?.element === element && playingRef.current && nativeRestartHasProgress(element, restart.position)) {
        nativeRestart.current = null;
        nativeStarted.current.add(element);
        attempt.playing(...reading);
      }
      attempt.progress(...reading);
    },
    onRateChange(event: SyntheticEvent<HTMLMediaElement>) {
      if (currentMedia() && !event.currentTarget.seeking && scrub.current?.target === undefined)
        attempt.progress(...nativePlaybackReading(event.currentTarget));
    },
    onWaiting() {
      if (currentMedia()) attempt.paused();
    },
    onSeeking() {
      if (currentMedia()) attempt.paused();
    },
    onSeeked(event: SyntheticEvent<HTMLMediaElement>) {
      const element = event.currentTarget;
      if (!currentMedia()) return;
      if (nativeRestart.current?.element === element) {
        nativeRestart.current.position = element.currentTime;
        return;
      }
      if (
        playingRef.current && !element.paused &&
        element.readyState >= 3 && nativeStarted.current.has(element) && scrub.current?.target === undefined
      ) attempt.playing(...nativePlaybackReading(element));
    },
    onPause(event: SyntheticEvent<HTMLMediaElement>) {
      if (!currentMedia() || !event.currentTarget.paused || event.currentTarget.ended) return;
      measureProgress();
      attempt.paused();
      showFullscreenControls();
      playIntent(false);
    },
    onEnded: () => next(1, true),
    onError: sourceError,
  };
  function toggle() {
    if (!current || waitingForVideo) return;
    if (!source) {
      if (playbackSources(current, settings.mode).length) {
        finishAttempt("manual");
        failed.current.delete(current.id);
        playEntry(live.current, live.current.queueIndex, "manual");
      } else {
        playIntent(true);
        sourceError();
      }
      return;
    }
    if (playingRef.current) {
      measureProgress();
      attempt.paused();
      native.current?.pause();
      youtube.current?.pauseVideo?.();
      playIntent(false);
    } else {
      setError("");
      playIntent(true);
      if (native.current) playNative(native.current);
      youtube.current?.playVideo?.();
    }
  }
  function openAndPlay(itemId: string) {
    playOnPlayerOpen.current = itemId;
    navigate("/player");
  }
  function watchCurrent() {
    if (current && waitingForVideo) openAndPlay(current.id);
  }
  function changeMode(mode: PlaybackMode, skipCurrent = false) {
    const state = live.current;
    if (state.mode === mode || !current) {
      setOfferAudioSkip(false);
      return;
    }
    const updated = { ...state, mode };
    const candidate = playbackSources(current, mode)[0];
    if (!candidate) {
      const nextEntry = nextIndex(1, updated, true);
      if (mode === "audio" && skipCurrent && nextEntry >= 0) {
        finishAttempt("manual");
        failed.current.clear();
        playEntry(updated, nextEntry, "manual");
        showSkipped(updated, state.queueIndex, nextEntry);
        return;
      }
      setOfferAudioSkip(mode === "audio" && nextEntry >= 0);
      setError(mode === "audio"
        ? soundUnavailableReason(current) ?? "Источник звука недоступен"
        : "Источник недоступен");
      return;
    }
    setOfferAudioSkip(false);
    setError("");
    failed.current.clear();
    setFailedSources(new Set());
    sourceIdentity.current = undefined;
    const position = readPosition() ?? state.position;
    const needsReattach = source?.id !== candidate.id || presentationKind !== playbackKind(current, candidate, mode);
    if (needsReattach) {
      measureProgress();
      attempt.paused();
      mediaKey.current = "";
      setDuration(0);
    }
    seekOnLoad.current = position;
    playIntent(playingRef.current && canAutoplayPlayback(current, candidate, mode, onPlayerScreen));
    patch({ mode, position });
  }
  function watchQueueVideo(index: number) {
    const state = live.current;
    const item = itemsById.get(state.queue[index]!);
    if (!item || playbackKind(item, playbackSources(item)[0]) !== "video") return;
    finishAttempt("manual");
    failed.current.delete(item.id);
    playEntry({ ...state, mode: "original" }, index, "manual");
  }
  function addToQueue(item: ItemDto, placement: "next" | "last", playlistId?: string) {
    const wasEmpty = !live.current.queue.length;
    const updated = addToPlaybackQueue(live.current, item.id, placement, playlistId);
    if (updated === live.current) return;
    patch(updated);
    if (wasEmpty) selectAttempt(updated, "manual");
    if (removal?.id === item.id) setRemoval(undefined);
  }
  function reorder(id: string, target: number) {
    const updated = moveQueueItem(live.current, id, target);
    if (updated !== live.current) patch(updated);
  }
  function removeFromQueue(id: string) {
    const state = live.current;
    const result = removeUpcomingItem(state, id);
    if (!result) return;
    const queuePlaylistIds = { ...state.queuePlaylistIds };
    setRemoval({
      ...result.removal,
      title: itemsById.get(id)?.title ?? "Запись",
      playlistId: queuePlaylistIds[id],
    });
    delete queuePlaylistIds[id];
    patch({ ...result.queue, queuePlaylistIds });
  }
  function undoRemoval() {
    if (!removal) return;
    const state = live.current;
    const order = undoQueueRemoval(state, removal);
    if (order !== state && itemsById.has(removal.id)) patch({
      ...order,
      queuePlaylistIds: removal.playlistId
        ? { ...state.queuePlaylistIds, [removal.id]: removal.playlistId }
        : state.queuePlaylistIds,
    });
    setRemoval(undefined);
  }
  function clearQueue() {
    finishAttempt("manual");
    attempt.select(null);
    playIntent(false);
    playOnPlayerOpen.current = undefined;
    mediaKey.current = "";
    resetSources();
    failed.current.clear();
    setError("");
    setOfferAudioSkip(false);
    setRemoval(undefined);
    setShowSavePlaylist(false);
    patch({ queue: [], queueIndex: 0, position: 0, queuePlaylistIds: {} });
  }

  useLayoutEffect(() => {
    attempt.paused();
    youtubeRestart.current = null;
    mediaKey.current = sourceKey;
  }, [sourceKey]);
  useLayoutEffect(() => {
    if (onPlayerScreen && current && playOnPlayerOpen.current === current.id) {
      playOnPlayerOpen.current = undefined;
      playIntent(true);
      return;
    }
    if (!waitingForVideo) return;
    const position = positionOnVideoExit ?? live.current.position;
    seekOnLoad.current = position;
    if (position !== live.current.position) patch({ position });
    playIntent(false);
  }, [onPlayerScreen, waitingForVideo, sourceKey]);
  useEffect(() => {
    if (!live.current.queue.length || current) return;
    finishAttempt("interrupted");
    const recovered = recoverDeletedQueueEntry(live.current, itemsRef.current, failed.current);
    const item = itemsById.get(recovered.queue[recovered.queueIndex]!);
    if (item) {
      const autoplay = playingRef.current && !failed.current.has(item.id) && playbackSources(item, recovered.mode).length > 0;
      playEntry(recovered, recovered.queueIndex, "advance", { autoplay });
      setError("Текущая запись удалена. Выбрана другая запись из очереди.");
    } else {
      resetSources();
      patch(recovered);
      attempt.select(null);
      playIntent(false);
      setError("В очереди больше нет доступных записей.");
    }
  }, [current?.id, items.length]);
  useEffect(() => {
    if (native.current) {
      native.current.volume = settings.volume;
      if (playingRef.current) playNative(native.current);
      else native.current.pause();
    }
  }, [playing, sourceKey]);
  useEffect(() => {
    if (native.current) native.current.volume = settings.volume;
  }, [settings.volume]);
  const lastInitialSettings = useRef(initialSettings);
  useLayoutEffect(() => {
    if (lastInitialSettings.current !== initialSettings) {
      lastInitialSettings.current = initialSettings;
      finishAttempt("interrupted");
      const restored = restorePlayback(initialSettings ?? {}, itemsRef.current);
      playOnPlayerOpen.current = undefined;
      serverSignature.current = playbackSettingsSignature(restored);
      resetSources();
      patch(restored);
      playIntent(false);
      positionMedia(restored.position);
      failed.current.clear();
      setRemoval(undefined);
    }
    selectAttempt(live.current, "manual");
  }, [initialSettings]);
  useEffect(() => () => attempt.finish("interrupted"), [attempt]);

  function cachePlayback() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        ...live.current, serverSignature: serverSignature.current,
      }));
    } catch {}
  }
  useEffect(cachePlayback, [settings, storageKey]);
  useEffect(() => {
    const save = () => {
      if (savingSuspended.current) return;
      fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(live.current),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, [userId]);
  useEffect(() => {
    let last = "";
    let latestRequest = 0;
    let mounted = true;
    const save = () => {
      if (savingSuspended.current) return;
      const submitted = live.current;
      const serialized = JSON.stringify(submitted);
      if (serialized === last) return;
      last = serialized;
      const request = ++latestRequest;
      const initial = lastInitialSettings.current;
      const responseIsCurrent = () => mounted && !savingSuspended.current &&
        request === latestRequest && initial === lastInitialSettings.current;
      api<Partial<PlaybackSettings>>("/settings", "PUT", submitted)
        .then((saved) => {
          if (!responseIsCurrent()) return;
          serverSignature.current = playbackSettingsSignature(restorePlayback(saved, itemsRef.current));
          const current = live.current;
          const queuePlaylistIds = reconcileQueuePlaylistIds(
            current.queuePlaylistIds, submitted.queuePlaylistIds, saved.queuePlaylistIds,
          );
          if (queuePlaylistIds !== current.queuePlaylistIds) {
            patch({ queuePlaylistIds });
            const itemId = current.queue[current.queueIndex];
            if (itemId) attempt.updatePlaylistId(itemId, queuePlaylistIds?.[itemId]);
          }
          cachePlayback();
          setSaveError("");
        })
        .catch(() => {
          if (!responseIsCurrent()) return;
          last = "";
          setSaveError(
            "Не удалось сохранить настройки. Локальная копия сохранена.",
          );
        });
    };
    const timer = setInterval(save, 5000);
    return () => {
      clearInterval(timer);
      mounted = false;
      save();
    };
  }, [userId]);
  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession || !current) return;
    mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: "Hibiki",
      album: current.kind === "audio" ? "Аудио" : "Видео",
    });
    mediaSession.setActionHandler("play", () => { if (!playingRef.current) toggle(); });
    mediaSession.setActionHandler("pause", () => { if (playingRef.current) toggle(); });
    mediaSession.setActionHandler("nexttrack", () => next());
    mediaSession.setActionHandler("previoustrack", () => {
      if (live.current.position > 3) seek(0);
      else next(-1);
    });
    mediaSession.setActionHandler("stop", () => {
      finishAttempt("manual");
      playIntent(false);
      seek(0, false);
      selectAttempt(live.current, "manual");
    });
    return () => {
      ["play", "pause", "nexttrack", "previoustrack", "stop"].forEach((a) =>
        mediaSession.setActionHandler(a as MediaSessionAction, null),
      );
    };
  }, [current?.id, sourceKey, duration, onPlayerScreen]);
  function shuffleToggle() {
    patch(togglePlaybackShuffle(live.current));
  }
  const fullscreen = nativeFullscreen || viewportFullscreen;
  function showFullscreenControls() {
    controlsIdleTimer.current?.activity();
  }
  useEffect(() => {
    setControlsIdle(false);
    if (!fullscreen || !current) return;
    const timer = createFullscreenIdleTimer(setControlsIdle);
    controlsIdleTimer.current = timer;
    return () => {
      timer.dispose();
      if (controlsIdleTimer.current === timer) controlsIdleTimer.current = null;
    };
  }, [fullscreen, current?.id, sourceKey]);
  async function toggleFullscreen() {
    if (viewportFullscreen) {
      setViewportFullscreen(false);
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    const element = stage.current;
    if (!element) return;
    const mode = await enterPlayerFullscreen(
      element.requestFullscreen ? () => element.requestFullscreen() : undefined,
    );
    // The queue may have been cleared while the browser handled the request.
    if (stage.current !== element || !element.isConnected) return;
    if (mode === "viewport") {
      viewportRestore.current = { x: window.scrollX, y: window.scrollY, focus: document.activeElement };
      setViewportFullscreen(true);
    }
  }
  useEffect(() => {
    const changed = () => setNativeFullscreen(!!stage.current && document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!current || !onPlayerScreen) {
      setViewportFullscreen(false);
      setNativeFullscreen(false);
      setShowSavePlaylist(false);
    }
  }, [current?.id, onPlayerScreen]);
  useLayoutEffect(() => {
    if (onPlayerScreen) window.scrollTo({ top: 0, behavior: "instant" });
  }, [onPlayerScreen]);
  useLayoutEffect(() => {
    if (!viewportFullscreen || !current) return;
    const restore = viewportRestore.current;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    stage.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setViewportFullscreen(false);
    };
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      if (restore?.focus instanceof HTMLElement && restore.focus.isConnected)
        restore.focus.focus({ preventScroll: true });
      if (restore) window.scrollTo({ left: restore.x, top: restore.y, behavior: "instant" });
      viewportRestore.current = null;
    };
  }, [viewportFullscreen, !!current]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      showFullscreenControls();
      if (!current || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      const action = playbackShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        repeat: event.repeat,
        target: event.target instanceof HTMLElement ? event.target : null,
      });
      if (!action) return;
      if (action === "fullscreen" && !onPlayerScreen) return;
      event.preventDefault();
      if (action === "toggle") toggle();
      if (action === "fullscreen") void toggleFullscreen();
      if (action === "mute") patch({ volume: settings.volume ? 0 : 0.8 });
      if (action === "backward") seek(live.current.position - 10);
      if (action === "forward") seek(live.current.position + 10);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [current?.id, playing, duration, settings.volume, sourceKey, viewportFullscreen, onPlayerScreen]);
  const total = duration || current?.duration || 0;
  const seekBar = {
    position: settings.position,
    duration: total,
    onSeek: seekFromSlider,
    onScrubStart: () => { scrub.current ??= {}; },
    onScrubEnd: finishScrub,
  };
  const artwork = playbackArtwork(current, source);
  const showArtwork = artwork && failedArtwork !== artwork;
  const audioFallback = current?.kind === "video" && settings.mode === "original" &&
    source && presentationKind === "audio";
  const sourceLabel = isYoutube ? "YouTube" : source ? "Локальный файл" : "Источник недоступен";
  function queueRow(id: string, index: number, editable = false) {
    const item = itemsById.get(id);
    const title = item?.title ?? "Запись удалена";
    const thumbnail = playbackArtwork(item);
    const active = index === settings.queueIndex;
    const canPlay = item && playbackSources(item, settings.mode).length > 0;
    const available = canPlay && !failed.current.has(id);
    const unavailableReason = item && settings.mode === "audio" && soundUnavailableReason(item);
    const canWatch = unavailableReason && item && playbackSources(item).some(
      (candidate) => playbackKind(item, candidate) === "video",
    );
    const canMoveUp = index > settings.queueIndex + 1;
    const canMoveDown = index < settings.queue.length - 1;
    return (
      <div
        key={id}
        className={`queue-entry${dragOver === id ? " is-drop-target" : ""}`}
        onDragOver={editable ? (event) => {
          if (!draggingId.current || draggingId.current === id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragOver(id);
        } : undefined}
        onDrop={editable ? (event) => {
          event.preventDefault();
          const dragging = draggingId.current;
          if (dragging) reorder(dragging, live.current.queue.indexOf(id));
          draggingId.current = undefined;
          setDragOver(undefined);
        } : undefined}
      >
        {editable && (
          <span
            className="queue-drag"
            aria-hidden="true"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", id);
              event.dataTransfer.effectAllowed = "move";
              draggingId.current = id;
            }}
            onDragEnd={() => { draggingId.current = undefined; setDragOver(undefined); }}
          ><GripVertical size={16} /></span>
        )}
        <button className={`watch-queue-row ${active ? "active" : ""}`} aria-current={active ? "true" : undefined} aria-disabled={!canPlay} onClick={() => switchTo(index)}>
          <span className="watch-queue-number">{active && playing ? <span className="equalizer" aria-hidden="true"><i /><i /><i /></span> : index + 1}</span>
          <span className={`watch-queue-art art-${title.length % 6}`}>
            {item?.kind === "video" ? <Video size={18} /> : <Music2 size={18} />}
            {thumbnail && <img src={thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
            <span className="watch-queue-duration">{formatDuration(item?.duration)}</span>
          </span>
          <span className="watch-queue-info">
            <strong>{title}</strong>
            <small>{item ? available ? item.kind === "video" ? "Видео" : "Аудио" : unavailableReason || "Источник недоступен" : "Нет в медиатеке"}</small>
          </span>
        </button>
        {canWatch && (
          <button className="icon-button queue-watch-video" aria-label={`Смотреть ${title}`} title="Смотреть" onClick={() => watchQueueVideo(index)}>
            <Video size={16} />
          </button>
        )}
        {editable && (
          <div className="queue-entry-actions">
            <button className="icon-button" aria-disabled={!canMoveUp} aria-label={`Переместить выше: ${title}`} title="Переместить выше" onClick={() => reorder(id, index - 1)}><ArrowUp size={14} /></button>
            <button className="icon-button" aria-disabled={!canMoveDown} aria-label={`Переместить ниже: ${title}`} title="Переместить ниже" onClick={() => reorder(id, index + 1)}><ArrowDown size={14} /></button>
            <button className="icon-button" aria-label={`Удалить из очереди: ${title}`} title="Удалить из очереди" onClick={() => removeFromQueue(id)}><X size={14} /></button>
          </div>
        )}
      </div>
    );
  }
  const player = onPlayerScreen && (
    <section className={`watch-player ${current ? "" : "is-empty"}`} aria-label="Плеер">
      {!current ? (
        <div className="watch-welcome">
          <span className="watch-welcome-icon"><AudioLines size={25} /></span>
          <div>
            <h1>Плеер</h1>
            <p>Включите запись в медиатеке или откройте плейлист.</p>
            <Link className="text-button" to="/">Перейти в медиатеку</Link>
          </div>
        </div>
      ) : (
        <>
          <header className="watch-heading">
            <h1>Плеер</h1>
            <div className="playback-mode" role="group" aria-label="Режим воспроизведения">
              <button type="button" aria-pressed={settings.mode === "original"} onClick={() => changeMode("original")}>
                <Video size={15} /> Аудио и видео
              </button>
              <button type="button" aria-pressed={settings.mode === "audio"} onClick={() => changeMode("audio")}>
                <Headphones size={15} /> Только звук
              </button>
            </div>
          </header>
          <div className="watch-layout">
            <div className="watch-main">
              <div
                ref={stage}
                className={`watch-stage ${presentationKind === "audio" ? "is-audio" : ""} ${viewportFullscreen ? "is-viewport-fullscreen" : ""} ${fullscreen && controlsIdle ? "is-controls-idle" : ""}`}
                aria-label="Сцена воспроизведения"
                tabIndex={-1}
                onPointerMove={showFullscreenControls}
                onPointerDownCapture={showFullscreenControls}
                onTouchStart={showFullscreenControls}
                onFocusCapture={showFullscreenControls}
                onKeyDownCapture={showFullscreenControls}
              >
                <div className="watch-media">
                  {source && youtubeId ? (
                    <Youtube
                      key={sourceKey}
                      id={youtubeId}
                      playing={playing}
                      volume={settings.volume}
                      position={seekOnLoad.current}
                      engine={youtube}
                      onTime={(...reading) => {
                        if (!currentMedia() || scrub.current?.target !== undefined) return;
                        const [position, d] = reading;
                        patch({ position });
                        setDuration(d ?? 0);
                        const confirmRestart = youtubeRestart.current;
                        if (confirmRestart && playingRef.current && youtube.current?.getPlayerState?.() === 1 &&
                            confirmRestart(position, reading[2])) {
                          youtubeRestart.current = null;
                          attempt.playing(...reading);
                        }
                        attempt.progress(...reading);
                      }}
                      onEnded={() => next(1, true)}
                      onError={sourceError}
                      onPaused={() => {
                        if (!currentMedia()) return;
                        measureProgress();
                        attempt.paused();
                        showFullscreenControls();
                        playIntent(false);
                      }}
                      onBuffering={() => { if (currentMedia()) attempt.paused(); }}
                      onPlaying={(...reading) => {
                        if (!currentMedia()) return;
                        youtubeRestart.current = null;
                        if (scrub.current?.target === undefined) attempt.playing(...reading);
                        showFullscreenControls();
                        playIntent(true);
                      }}
                    />
                  ) : source && presentationKind === "video" ? (
                    <video
                      key={sourceKey}
                      ref={attachNative}
                      src={source.streamUrl!}
                      playsInline
                      {...nativeEvents}
                      onClick={toggle}
                    />
                  ) : (
                    <div className={`audio-scene art-${current.title.length % 6}`}>
                      {showArtwork && <img className="audio-backdrop" src={artwork} alt="" onError={() => setFailedArtwork(artwork)} />}
                      <div className={`audio-cover art-${current.title.length % 6}`}>
                        {showArtwork ? <img src={artwork} alt={`Обложка: ${current.title}`} onError={() => setFailedArtwork(artwork)} /> : (
                          <div className="audio-cover-fallback" aria-label="Обложка отсутствует">
                            <span className="audio-cover-orbit" /><span className="audio-cover-orbit second" />
                            <span className="audio-cover-mark" aria-hidden="true">響</span>
                            <span className="audio-cover-brand"><AudioLines size={16} /> HIBIKI</span>
                          </div>
                        )}
                      </div>
                      {!source && <span className="audio-scene-label">Источник недоступен</span>}
                    </div>
                  )}
                </div>
                <div className="watch-fullscreen-reveal" aria-hidden="true" />
                <div className="watch-controls">
                  <div className="watch-fullscreen-title">{current.title}</div>
                  <div className="seek-row">
                    <span>{formatDuration(settings.position)}</span>
                    <PlaybackSeekBar {...seekBar} />
                    <span>{formatDuration(total)}</span>
                  </div>
                  <div className="watch-control-row">
                    <div className="watch-transport">
                      <button className="main-play" aria-label={playing ? "Приостановить" : "Воспроизвести"} title={playing ? "Приостановить (Пробел)" : "Воспроизвести (Пробел)"} onClick={toggle}>
                        {playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}
                      </button>
                      <button className="icon-button" aria-label="Предыдущая запись" title="Предыдущая запись" onClick={() => live.current.position > 3 ? seek(0) : next(-1)}><SkipBack size={19} fill="currentColor" /></button>
                      <button className="icon-button" aria-label="Следующая запись" title="Следующая запись" onClick={() => next()}><SkipForward size={19} fill="currentColor" /></button>
                      <span className="watch-control-divider" />
                      <button className={`icon-button ${settings.shuffle ? "selected" : ""}`} aria-label="Перемешать" title="Перемешать очередь" aria-pressed={settings.shuffle} onClick={shuffleToggle}><Shuffle size={18} /></button>
                      <button
                        className={`icon-button ${settings.repeat !== "off" ? "selected" : ""}`}
                        aria-label={`Повтор: ${settings.repeat === "off" ? "выключен" : settings.repeat === "all" ? "вся очередь" : "одна запись"}`}
                        title={`Повтор: ${settings.repeat === "off" ? "выключен" : settings.repeat === "all" ? "вся очередь" : "одна запись"}`}
                        onClick={() => patch({ repeat: settings.repeat === "off" ? "all" : settings.repeat === "all" ? "one" : "off" })}
                      >{settings.repeat === "one" ? <Repeat1 size={18} /> : <Repeat size={18} />}</button>
                    </div>
                    <div className="watch-tools">
                      <button className="icon-button" aria-label={settings.volume ? "Выключить звук" : "Включить звук"} title="Звук (M)" onClick={() => patch({ volume: settings.volume ? 0 : 0.8 })}>{settings.volume ? <Volume2 size={19} /> : <VolumeX size={19} />}</button>
                      <input aria-label="Громкость" aria-valuetext={`${Math.round(settings.volume * 100)}%`} type="range" min="0" max="1" step="0.01" value={settings.volume} onChange={(e) => patch({ volume: Number(e.target.value) })} style={{ "--progress": `${settings.volume * 100}%` } as any} />
                      <span className="watch-control-divider" />
                      <button className="icon-button fullscreen-button" aria-label={fullscreen ? "Выйти из полноэкранного режима" : "Полный экран"} title="Полный экран (F)" onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}</button>
                    </div>
                  </div>
                  {(error || saveError) && (
                    <div className="watch-notice" role="status">
                      <CircleAlert size={16} /><span>{error || saveError}</span>
                      {offerAudioSkip && <button className="text-button" onClick={() => changeMode("audio", true)}>Слушать со следующей доступной</button>}
                      <button className="icon-button" aria-label="Скрыть уведомление" onClick={dismissNotice}><X size={15} /></button>
                    </div>
                  )}
                </div>
              </div>
              <div className="watch-metadata">
                <span className="watch-kind-icon">{presentationKind === "video" ? <Video size={20} /> : <Music2 size={20} />}</span>
                <div><h2>{current.title}</h2><p>{audioFallback ? "Доступен только звук" : presentationKind === "video" ? "Видео" : "Аудио"}<span>·</span>{sourceLabel}{current.tags.slice(0, 2).map((tag) => <span className="watch-tag" key={tag.id}>{tag.name}</span>)}</p></div>
              </div>
              <p className="watch-shortcuts"><kbd>Пробел</kbd> пауза <span>·</span> <kbd>←</kbd> <kbd>→</kbd> 10 секунд <span>·</span> <kbd>F</kbd> полный экран</p>
            </div>
            <aside className="watch-queue" aria-label="Очередь воспроизведения">
              <div className="watch-queue-heading"><div><ListMusic size={18} /><h2>Очередь</h2></div><span>{settings.queue.length} {mediaWord(settings.queue.length)}</span></div>
              <div className="watch-queue-list">
                {settings.queueIndex > 0 && (
                  <details className="queue-past">
                    <summary>Предыдущие <span>{settings.queueIndex}</span></summary>
                    {settings.queue.slice(0, settings.queueIndex).map((id, index) => queueRow(id, index))}
                  </details>
                )}
                <h3 className="queue-section-heading">Сейчас</h3>
                {queueRow(current.id, settings.queueIndex)}
                <h3 className="queue-section-heading">Далее</h3>
                {settings.queue.slice(settings.queueIndex + 1).map((id, index) => queueRow(id, index + settings.queueIndex + 1, true))}
                {settings.queueIndex === settings.queue.length - 1 && <p className="queue-empty">Дальше записей нет.</p>}
              </div>
              {removal && (
                <div className="queue-notice">
                  <span role="status">«{removal.title}» удалена из очереди</span>
                  <button className="text-button" onClick={undoRemoval}>Отменить</button>
                </div>
              )}
              <div className="watch-queue-footer">
                <button className="text-button" onClick={() => { setCreatedPlaylist(undefined); setShowSavePlaylist(true); }}>Сохранить как плейлист</button>
                <button className="text-button" onClick={clearQueue}>Очистить</button>
              </div>
              {createdPlaylist && (
                <div className="queue-notice">
                  <span role="status">Плейлист сохранён</span>
                  <Link to={`/playlists/${createdPlaylist.id}`}>Открыть</Link>
                </div>
              )}
            </aside>
          </div>
        </>
      )}
      {current && showSavePlaylist && (
        <QueuePlaylistDialog
          ids={settings.queue}
          close={() => setShowSavePlaylist(false)}
          saved={(playlist) => {
            setShowSavePlaylist(false);
            setCreatedPlaylist(playlist);
            onPlaylistSaved?.(playlist);
          }}
        />
      )}
      {!current && (error || saveError) && <p className="watch-empty-notice" role="status"><CircleAlert size={15} />{error || saveError}</p>}
    </section>
  );
  function dismissNotice() {
    setError("");
    setSaveError("");
    setOfferAudioSkip(false);
  }
  const miniPlayer = !onPlayerScreen && (current || error || saveError) ? (
    <div className="mini-player">
      {(error || saveError) && (
        <div className="mini-player-notice" role="status">
          <CircleAlert size={16} /><span>{error || saveError}</span>
          <button className="icon-button" aria-label="Скрыть уведомление" onClick={dismissNotice}><X size={16} /></button>
        </div>
      )}
      {current && (
        <section className="mini-player-body" aria-label="Управление воспроизведением">
          <PlaybackSeekBar {...seekBar} className="mini-player-seek" />
          <Link className="mini-player-track" to="/player" aria-label={`Открыть плеер: ${current.title}`}>
            <span className={`mini-player-art art-${current.title.length % 6}`}>
              {presentationKind === "video" ? <Video size={18} /> : <Music2 size={18} />}
              {showArtwork && <img src={artwork} alt="" onError={() => setFailedArtwork(artwork)} />}
            </span>
            <span className="mini-player-info">
              <strong>{current.title}</strong>
              <small>{waitingForVideo ? "Видео готово к просмотру"
                : audioFallback ? "Доступен только звук"
                : settings.mode === "audio" ? "Только звук" : playing ? "Сейчас играет" : "На паузе"}</small>
            </span>
          </Link>
          <div className="mini-player-transport">
            <button className="icon-button" aria-label="Предыдущая запись" onClick={() => live.current.position > 3 ? seek(0) : next(-1)}>
              <SkipBack size={17} fill="currentColor" />
            </button>
            {waitingForVideo ? (
              <button className="button primary compact" onClick={watchCurrent}><Video size={16} /> Смотреть</button>
            ) : (
              <button className="mini-player-play" aria-label={playing ? "Приостановить" : "Воспроизвести"} onClick={toggle}>
                {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
              </button>
            )}
            <button className="icon-button" aria-label="Следующая запись" onClick={() => next()}>
              <SkipForward size={17} fill="currentColor" />
            </button>
          </div>
          <div className="mini-player-side">
            <span>{formatDuration(settings.position)} / {formatDuration(total)}</span>
            <CompactPlaybackQueue key={routeKey} settings={settings} itemsById={itemsById} failedIds={failed.current} />
          </div>
        </section>
      )}
    </div>
  ) : null;
  return (
    <PlayerContext.Provider value={{
      current, playing, waitingForVideo, settings, start, toggle, watchCurrent,
      enqueue: (item, playlistId) => addToQueue(item, "last", playlistId),
      playNext: (item, playlistId) => addToQueue(item, "next", playlistId),
    }}>
      {children(player, miniPlayer)}
      {source && presentationKind === "audio" && (
        <audio key={sourceKey} ref={attachNative} src={source.streamUrl!} {...nativeEvents} />
      )}
    </PlayerContext.Provider>
  );
}
