import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import { ItemArtwork } from "./ItemArtwork.tsx";
import { fetchItems } from "./library-pages";
import { completeLibraryOrder, LibraryQueueLoad, QueueCatalog, QueueIntents } from "./queue-catalog";
import { CompactPlaybackQueue, QueueRows, playbackBuffer, PlaybackSeekBar, PlaybackVolume, type BufferedRanges } from "./PlaybackControls";
import { AudioDelivery, ownedAudioFile } from "./audio-delivery";
import { audioRelayReady, listenForAudioRanges, subscribeAudioRelay } from "./audio-relay";
import { PlaybackFeedback } from "./playback-feedback";
import { useListeningAttempt } from "./listening-client";
import "./queue.css";
import {
  playbackSources,
  playbackVolume,
  playableVideoSource,
  canStartSelectedItem,
  sourceLoadPosition,
  restorePlayback,
  playbackShortcut,
  playbackArtwork,
  playbackKind,
  canAutoplayPlayback,
  soundUnavailableReason,
  queueEntryUnavailableReason,
  enterPlayerFullscreen,
  createFullscreenIdleTimer,
  createVideoClickGesture,
  addToPlaybackQueue,
  createPlaybackAttempt,
  playbackSourceForAttempt,
  queuePlaylistInput,
  itemActivation,
  startPlaybackQueue,
  togglePlaybackShuffle,
  PlaybackCache,
  PlayerCards,
  playbackSettingsPatch,
  nativePlaybackReading,
  youtubePlaybackReading,
  prepareYoutubePlayback,
  nativeRestartHasProgress,
  createYoutubeRestartConfirmation,
  reconcileQueuePlaylistIds,
  type PlaybackFinish,
  type PlaybackReading,
  type PlaybackSettings,
  type PlaybackTrigger,
} from "./player-model.ts";

interface Controller {
  queueEditable: boolean;
  current?: ItemDto;
  playing: boolean;
  waitingForVideo: boolean;
  loadingLabel: string;
  mode: PlaybackMode;
  start: (items: ItemDto[], index?: number, playlistId?: string, options?: StartOptions) => Promise<void>;
  activateItem: (items: ItemDto[], index: number, playlistId?: string, options?: StartOptions) => void;
  playShared: (path: string, items: ItemDto[], index: number, load: () => Promise<ItemDto[]>, options: SharedStartOptions) => Promise<void>;
  sharedId: (path: string, id: string) => string | undefined;
  enqueue: (item: ItemDto, playlistId?: string) => void;
  playNext: (item: ItemDto, playlistId?: string) => void;
  toggle: () => void;
  watchCurrent: () => void;
}
type StartOptions = {
  mode?: PlaybackMode;
  fromLibrary?: boolean;
  loadQueueIds?: () => Promise<string[]>;
  queueIds?: string[];
  isCurrent?: () => boolean;
  openPlayer?: boolean;
};
type SharedStartOptions = Pick<StartOptions, "mode" | "isCurrent" | "openPlayer"> & { activate?: boolean };
const PlayerContext = createContext<Controller | null>(null);
export const usePlayer = () => useContext(PlayerContext)!;
type PlayerCommands = Pick<Controller, "start" | "activateItem" | "playShared" | "sharedId" | "toggle" | "watchCurrent" | "enqueue" | "playNext">;
const CommandsContext = createContext<PlayerCommands | null>(null);
const CardsContext = createContext<PlayerCards | null>(null);
export const usePlayerCommands = () => useContext(CommandsContext)!;
export function usePlayerCard(id: string) {
  const store = useContext(CardsContext)!;
  return useSyncExternalStore(store.subscribe, () => store.read(id));
}
export function useHasPlayer() {
  const store = useContext(CardsContext)!;
  return useSyncExternalStore(store.subscribe, store.hasCurrent);
}
export function useQueueEditable() {
  const store = useContext(CardsContext)!;
  return useSyncExternalStore(store.subscribe, store.queueEditable);
}

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
function applyYoutubeVolume(player: any, volume: number) {
  player.setVolume(volume * 100);
  if (volume > 0) player.unMute();
  else player.mute();
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
  onAutoplayBlocked,
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
  onAutoplayBlocked: () => void;
  onBuffering: () => void;
  onPlaying: (...reading: PlaybackReading) => void;
}) {
  const target = useRef<HTMLDivElement>(null),
    callbacks = useRef({ onTime, onEnded, onError, onPaused, onAutoplayBlocked, onBuffering, onPlaying });
  callbacks.current = { onTime, onEnded, onError, onPaused, onAutoplayBlocked, onBuffering, onPlaying };
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
              applyYoutubeVolume(player, volume);
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
            onAutoplayBlocked: () => { if (!disposed) callbacks.current.onAutoplayBlocked(); },
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
    if (engine.current) applyYoutubeVolume(engine.current, volume);
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
  revision,
  initialSettings,
  userId,
  children,
  suspendSaving = false,
  onPlaylistSaved,
}: {
  revision: string;
  initialSettings: any;
  userId: string;
  children: (player: ReactNode, miniPlayer: ReactNode) => ReactNode;
  suspendSaving?: boolean;
  onPlaylistSaved?: (playlist: PlaylistDto) => void;
}) {
  const navigate = useNavigate();
  const { key: routeKey } = useLocation();
  const onPlayerScreen = !!useMatch("/player");
  const [catalog] = useState(() => new QueueCatalog(fetchItems, ids => fetchItems(ids, true)));
  const catalogVersion = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const itemsById = catalog.rows;
  const [intent] = useState(() => new QueueIntents());
  const firstSound = useRef<(() => void) | undefined>(undefined);
  const [libraryOrder] = useState(() => new LibraryQueueLoad());
  const orderStatus = useSyncExternalStore(libraryOrder.subscribe, libraryOrder.snapshot);
  const queueEditable = orderStatus === "complete";
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueLoadError, setQueueLoadError] = useState("");
  const [queueRetry, setQueueRetry] = useState(0);
  const retryNavigation = useRef<(() => void) | undefined>(undefined);
  const [selectionFailure, setSelectionFailure] = useState<{ token: number; message: string; retry: () => void }>();
  const history = useListeningAttempt(userId);
  const [attempt] = useState(() => createPlaybackAttempt(history));
  const [cards] = useState(() => new PlayerCards());
  const [initialState] = useState(() => restorePlayback(initialSettings ?? {}));
  const savedSettings = useRef(initialState);
  const [cache] = useState(() => new PlaybackCache({
    getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value),
  }, `hibiki.player.${userId}`, initialState));
  const [settings, setSettings] = useState(() => cache.restore(initialSettings));
  const [playing, setPlaying] = useState(false),
    [duration, setDuration] = useState(0),
    [failedSources, setFailedSources] = useState<ReadonlySet<string>>(() => new Set()),
    [error, setError] = useState(""),
    [offerAudioSkip, setOfferAudioSkip] = useState(false),
    [nativeFullscreen, setNativeFullscreen] = useState(false),
    [viewportFullscreen, setViewportFullscreen] = useState(false),
    [controlsIdle, setControlsIdle] = useState(true),
    [failedArtwork, setFailedArtwork] = useState<string>(),
    [saveError, setSaveError] = useState(""),
    [removal, setRemoval] = useState<(QueueRemoval & { title: string; playlistId?: string })>(),
    [dragOver, setDragOver] = useState<string>(),
    [showSavePlaylist, setShowSavePlaylist] = useState(false),
    [createdPlaylist, setCreatedPlaylist] = useState<PlaylistDto>();
  const savingSuspended = useRef(suspendSaving);
  savingSuspended.current = suspendSaving;
  const [videoClick] = useState(createVideoClickGesture);
  const pointerPosition = useRef<{x: number; y: number} | null>(null);
  const controlsIdleTimer = useRef<ReturnType<typeof createFullscreenIdleTimer> | null>(null);
  const viewportRestore = useRef<{ x: number; y: number; focus: Element | null } | null>(null);
  const stage = useRef<HTMLDivElement>(null),
    native = useRef<HTMLMediaElement | null>(null),
    youtube = useRef<any>(null),
    seekOnLoad = useRef(settings.position),
    live = useRef(settings),
    playOnPlayerOpen = useRef<string | undefined>(undefined),
    requestedVideoSourceId = useRef<string | undefined>(undefined),
    playingRef = useRef(playing),
    failed = useRef(new Set<string>()),
    sourceCheck = useRef<{ key: string; token: number } | undefined>(undefined),
    nativeStarted = useRef(new WeakSet<HTMLMediaElement>()),
    nativePositionReady = useRef(new WeakSet<HTMLMediaElement>()),
    nativeRestart = useRef<{ element: HTMLMediaElement; position: number } | null>(null),
    youtubeRestart = useRef<ReturnType<typeof createYoutubeRestartConfirmation> | null>(null),
    draggingId = useRef<string | undefined>(undefined),
    scrub = useRef<{ target?: number } | null>(null);
  const attachNative = useCallback((element: HTMLMediaElement | null) => {
    if (!element) return;
    native.current = element;
    return () => {
      if (native.current === element) native.current = null;
      queueMicrotask(() => {
        // A ref can detach and reattach to the same live element in one commit.
        if (native.current !== element) element.pause();
      });
    };
  }, []);
  const current = itemsById.get(settings.queue[settings.queueIndex]!);
  const sourceIdentity = useRef<{ itemId?: string; sourceId?: string; preferredSourceId?: string }>(undefined);
  const previousSource = sourceIdentity.current;
  const source = current ? playbackSourceForAttempt(
    current,
    failedSources,
    playing && previousSource?.itemId === current.id && previousSource.sourceId
      ? { sourceId: previousSource.sourceId, preferredSourceId: previousSource.preferredSourceId }
      : undefined,
    settings.mode,
    requestedVideoSourceId.current,
  ) : undefined;
  const videoSource = current && playableVideoSource(current, failedSources);
  const isYoutube = source?.provider === "youtube";
  const youtubeId = isYoutube
    ? source.externalId || new URL(source.url!).searchParams.get("v") || source.url!.split("/").pop()
    : undefined;
  const presentationKind = current ? playbackKind(current, source, settings.mode) : undefined;
  const needsVideoForPlayback = !!videoSource && settings.mode === "audio" && !source;
  const waitingForVideo = !onPlayerScreen && (!!source && presentationKind === "video" || needsVideoForPlayback);
  const identity = { itemId: current?.id, sourceId: source?.id };
  const sourceKey = JSON.stringify([identity, presentationKind, waitingForVideo]);
  const delivery = useMemo(() => new AudioDelivery(), [userId]);
  const [audioReplay, setAudioReplay] = useState(0);
  const [directAudioKey, setDirectAudioKey] = useState("");
  const completedAudio = useRef(false);
  const deniedToken = useRef<string | undefined>(undefined);
  const coverage = useSyncExternalStore(delivery.subscribe, delivery.snapshot);
  const file = useMemo(() => presentationKind === "audio" ? ownedAudioFile(source, current?.duration) : undefined,
    [presentationKind, source?.id, source?.streamUrl, source?.shared, source?.bytes, source?.mime, source?.playbackHints?.audioStart, source?.playbackHints?.tailStart, current?.duration]);
  const relayReady = useSyncExternalStore(subscribeAudioRelay, audioRelayReady);
  const relayKey = useMemo(() => file ? crypto.randomUUID?.() : undefined,
    [delivery, sourceKey, file?.url, file?.size, audioReplay]);
  const audioToken = relayReady && relayKey !== directAudioKey ? relayKey : undefined;
  useLayoutEffect(() => {
    if (playing && relayKey && !relayReady) setDirectAudioKey(relayKey);
  }, [playing, relayKey, relayReady]);
  const audioUrl = file && audioToken ? `${file.url}?hibiki-audio=${audioToken}` : source?.streamUrl;
  useLayoutEffect(() => () => delivery.clear(), [delivery]);
  useLayoutEffect(() => listenForAudioRanges(delivery), [delivery, audioToken]);
  useLayoutEffect(() => {
    delivery.select(audioToken ? file : undefined, audioToken ?? "", reason => {
      const element = native.current;
      seekOnLoad.current = readPosition() ?? live.current.position;
      if (reason === "denied") {
        deniedToken.current = audioToken;
        finishAttempt("error");
        playIntent(false);
        element?.pause();
        element?.removeAttribute("src");
        element?.load();
        completedAudio.current = true;
        setError("Доступ к записи закрыт.");
      } else if (reason === "unsupported" && source) {
        setFailedSources(failed => new Set([...failed, source.id]));
        setError("Звуковая дорожка недоступна. Открываем исходный файл.");
      } else if (audioToken) {
        setDirectAudioKey(audioToken);
      }
    });
    completedAudio.current = false;
  }, [delivery, audioToken, sourceKey]);
  useLayoutEffect(() => {
    if (playing && audioToken) void delivery.start().catch(() => {});
  }, [delivery, playing, audioToken]);
  const mediaKey = useRef(sourceKey);
  const feedback = useMemo(() => new PlaybackFeedback(), [sourceKey]);
  const phase = useSyncExternalStore(feedback.subscribe, feedback.snapshot);
  useEffect(() => { if (phase === "playing") firstSound.current?.(); }, [phase, sourceKey]);
  const loadingLabel = feedback.label;
  const [buffer, setBuffer] = useState<{source: PlaybackFeedback; ranges: BufferedRanges}>();
  const canPrepareNext = !!audioToken && playing && phase === "playing" && !!coverage?.complete;
  useEffect(() => {
    let active = true;
    // Keep the prepared prefix across the brief ended → next selection.
    if (native.current?.ended && playingRef.current) return;
    if (!audioRelayReady() || settings.repeat === "one") { void delivery.prepare(); return; }
    if (!canPrepareNext) {
      // A native seek can report waiting while every byte of this track is already in memory.
      if (!playing || !coverage?.complete) delivery.suspendPreparation();
      return;
    }
    void catalog.nextInQueue(() => live.current, 1, true, failed.current, () => active, () => libraryOrder.tail)
      .then(target => {
        if (!active || !target) return;
        const id = target.state.queue[target.index];
        const item = id && id !== current?.id ? itemsById.get(id) : undefined;
        const preferred = item && playbackSources(item, target.state.mode)[0];
        const next = item && preferred && playbackKind(item, preferred, target.state.mode) === "audio"
          ? ownedAudioFile(preferred, item.duration) : undefined;
        return delivery.prepare(next);
      }).catch(() => { if (active) void delivery.prepare(); });
    return () => { active = false; };
  }, [delivery, canPrepareNext, sourceKey, settings.queue, settings.queueIndex, settings.mode, settings.repeat, revision]);
  const cancelledYoutubeStart = useRef(false);
  const clock = useMemo(() => ({
    read: () => native.current?.currentTime ?? feedback.position(),
    refresh: () => {
      if (youtube.current?.getPlayerState?.() === 1) {
        const [position, , rate] = youtubePlaybackReading(youtube.current);
        feedback.sample(position, rate);
      }
    },
  }), [feedback]);
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
  function setVolume(value: number) {
    patch(playbackVolume(value, live.current.volume || live.current.lastNonzeroVolume));
  }
  function toggleMute() {
    setVolume(live.current.volume ? 0 : live.current.lastNonzeroVolume ?? 0.8);
  }
  function playIntent(value: boolean) {
    if (!value) { feedback.pause(); delivery.paused(); }
    playingRef.current = value;
    setPlaying(value);
  }
  function currentMedia() {
    return mediaKey.current === sourceKey;
  }
  function currentNative(element: HTMLMediaElement) {
    return currentMedia() && native.current === element;
  }
  function confirmPosition(position: number, rate?: number) {
    feedback.sample(position, rate);
    if (!scrub.current && Number.isFinite(position) && position !== live.current.position)
      patch({ position });
  }
  function readPosition(): number | undefined {
    const element = native.current;
    if (element && nativePositionReady.current.has(element)) return element.currentTime;
    const iframe = youtube.current;
    const iframeState = iframe?.getPlayerState?.();
    if (iframeState === 1 || iframeState === 2) {
      const position = iframe.getCurrentTime?.();
      if (typeof position === "number" && position > 0) return position;
    }
  }
  function playNative(element: HTMLMediaElement) {
    element.play().catch((reason: unknown) => {
      if (native.current !== element || !currentMedia() || !playingRef.current) return;
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      if (reason instanceof DOMException && reason.name === "NotAllowedError") {
        playIntent(false);
        setError("Нажмите «Воспроизвести», чтобы продолжить.");
      } else {
        void sourceError();
      }
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
  function selectAttempt(state: PlaybackSettings, trigger: PlaybackTrigger) {
    const id = state.queue[state.queueIndex];
    const item = id && !catalog.isShared(id) ? itemsById.get(id) : undefined;
    const playlistIds = state.queuePlaylistIds;
    attempt.select(item ?? null, id && playlistIds && Object.hasOwn(playlistIds, id) ? playlistIds[id] : undefined, trigger);
  }
  function resetSources() {
    requestedVideoSourceId.current = undefined;
    setFailedSources(new Set());
    sourceIdentity.current = undefined;
    seekOnLoad.current = 0;
  }
  function playEntry(
    state: PlaybackSettings,
    index: number,
    trigger: PlaybackTrigger,
    { autoplay = true }: { autoplay?: boolean } = {},
  ) {
    const id = state.queue[index];
    const entry = id ? itemsById.get(id) : undefined;
    const preferred = entry && playbackSources(entry, state.mode)[0];
    const canPlay = !!entry && canAutoplayPlayback(entry, preferred, state.mode, onPlayerScreen);
    const shouldPlay = autoplay && canPlay;
    const sameSource = !!current && !!preferred && id === current.id &&
      source?.id === preferred.id && presentationKind === playbackKind(current, preferred, state.mode);
    playOnPlayerOpen.current = undefined;
    resetSources();
    patch({ ...state, queueIndex: index, position: 0 });
    selectAttempt(live.current, trigger);
    setError("");
    setOfferAudioSkip(false);
    playIntent(shouldPlay);
    if (sameSource && file && relayReady) {
      // Give the new native element its own playback token.
      feedback.reset();
      if (shouldPlay) feedback.wait();
      setAudioReplay(value => value + 1);
      return;
    }
    if (sameSource) {
      feedback.reset();
      if (shouldPlay) feedback.wait();
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
  async function reloadPlaybackEntry(id: string, token: number) {
    const active = () => intent.navigation === token;
    try {
      return await catalog.refreshPlayback(id, active);
    } catch (failure) {
      if (active()) setError((failure as Error).message);
    }
  }
  async function switchTo(index: number) {
    const token = intent.command();
    const state = live.current;
    const id = state.queue[index];
    if (!id) return;
    if (index === state.queueIndex) {
      toggle();
      return;
    }
    const guarded = catalog.rechecksPlayback(id) && !preparedSource(id, state.mode);
    const item = guarded ? await reloadPlaybackEntry(id, token) : itemsById.get(id);
    if (token !== intent.navigation || !item || live.current.queue !== state.queue) return;
    if (queueEntryUnavailableReason(item, state.mode)) {
      if (guarded) setError(`«${item.title}» недоступна для воспроизведения.`);
      return;
    }
    finishAttempt("manual");
    failed.current.delete(item.id);
    playEntry(state, index, "manual");
  }
  async function start(entries: ItemDto[], index = 0, playlistId?: string, options: StartOptions = {}, selectedItem = false) {
    if (!entries.length || options.isCurrent?.() === false) return;
    const token = intent.command();
    const isCurrent = () => token === intent.selection && options.isCurrent?.() !== false;
    setSelectionFailure(undefined);
    catalog.put(entries);
    let selected: ItemDto | undefined = entries[index];
    if (!selected) return;
    if (selected.shared && !catalog.isShared(selected.id) && !preparedSource(selected.id, options.fromLibrary ? "audio" : options.mode ?? "original")) {
      try {
        selected = await catalog.refreshPlayback(selected.id, isCurrent);
        if (!selected || !isCurrent()) return;
      } catch (e) {
        if (isCurrent()) setError((e as Error).message);
        return;
      }
    }
    const { fromLibrary = false, loadQueueIds, queueIds } = options;
    const mode = fromLibrary ? "audio" : options.mode ?? "original";
    const shuffle = !fromLibrary && live.current.shuffle;
    let newOrder = queueIds
      ? startPlaybackQueue(queueIds.map(id => ({ id })), queueIds.indexOf(selected.id), shuffle, playlistId)
      : startPlaybackQueue(entries, index, shuffle, playlistId);
    let state = { ...live.current, ...newOrder, mode, shuffle };
    let playable = canStartSelectedItem(selected, mode, fromLibrary && selectedItem) ? state.queueIndex : -1;
    let complete = !loadQueueIds;
    if (playable < 0 && fromLibrary) {
      const candidate = await findNext(1, state, token, true, false, setError, isCurrent);
      if (candidate === undefined || !isCurrent()) return;
      playable = candidate;
      if (playable < 0 && loadQueueIds) {
        // No playable row on screen. Keep the existing player until the search
        // finds a playable entry in the full filtered order.
        try {
          const ids = await loadQueueIds();
          if (!isCurrent()) return;
          newOrder = startPlaybackQueue(ids.map(id => ({id})), 0, false);
          state = {...live.current, ...newOrder, mode, shuffle};
          playable = await catalog.findPlayable(state.queue, -1, 1, false, mode, undefined, isCurrent);
          complete = true;
        } catch (e) {
          if (isCurrent()) {
            setSelectionFailure({
              token, message: (e as Error).message,
              retry: () => { if (isCurrent()) void start(entries, index, playlistId, options, selectedItem); },
            });
          }
          return;
        }
      }
    } else if (playable < 0) {
      const candidate = await findNext(1, state, token, true, true, setError, isCurrent);
      if (candidate === undefined) return;
      playable = candidate;
    }
    if (!isCurrent()) return;
    if (playable < 0) {
      setOfferAudioSkip(false);
      setError(mode === "audio"
        ? "В этой подборке нет записей, доступных для прослушивания."
        : "В этой очереди нет доступных источников.");
      return;
    }
    const entry = itemsById.get(state.queue[playable]!)!;
    const chosenSource = playbackSources(entry, mode)[0];
    const opensPlayer = mode === "original" &&
      (!!playlistId || options.openPlayer || entry.kind === "video" || playbackKind(entry, chosenSource, mode) === "video");
    intent.advance(); // Ignore old automatic navigation once the new queue takes over.
    firstSound.current?.();
    firstSound.current = undefined;
    libraryOrder.cancel();
    finishAttempt("manual");
    failed.current.clear();
    setRemoval(undefined);
    setShowSavePlaylist(false);
    playEntry({...live.current, ...newOrder, mode, shuffle}, playable, playable === state.queueIndex ? "manual" : "advance");
    if (!complete && loadQueueIds) {
      const gate = new AbortController();
      const release = () => gate.abort();
      const timer = window.setTimeout(release, 300);
      firstSound.current = release;
      libraryOrder.start(async () => {
        if (!gate.signal.aborted) await new Promise<void>(resolve => gate.signal.addEventListener("abort", () => resolve(), {once:true}));
        clearTimeout(timer);
        if (firstSound.current !== release) return [];
        // A retry after a network error reuses this already-open gate.
        return loadQueueIds();
      }, ids => patch(completeLibraryOrder(live.current, ids)));
    }
    if (opensPlayer && !onPlayerScreen) openAndPlay(entry.id);
    if (playable !== state.queueIndex) showSkipped(state, state.queueIndex, playable);
  }
  function activateItem(entries: ItemDto[], index: number, playlistId?: string, options: StartOptions = {}) {
    const item = entries[index];
    if (!item) return;
    const state = live.current;
    const mode = options.fromLibrary ? "audio" : options.mode ?? state.mode;
    switch (itemActivation(state, item.id, mode)) {
      case "start": start(entries, index, playlistId, options, true); break;
      case "changeMode": changeMode(mode, { activate: true, keepSelectedVideo: options.fromLibrary }); break;
      case "toggle":
        if (waitingForVideo && !options.fromLibrary) watchCurrent();
        else toggle();
    }
  }
  async function playShared(path: string, items: ItemDto[], index: number, load: () => Promise<ItemDto[]>, options: SharedStartOptions) {
    if (options.isCurrent?.() === false) return;
    const entries = catalog.sharedEntries(path, items, load);
    if (options.activate) activateItem(entries, index, undefined, options);
    else await start(entries, index, undefined, options);
  }
  async function findNext(direction: 1 | -1, state: PlaybackSettings, token: number, retry = false, wrap = state.repeat === "all", onError = setError, active = () => intent.navigation === token) {
    try {
      return await catalog.findPlayable(state.queue, state.queueIndex, direction, wrap, state.mode,
        retry ? undefined : failed.current, active);
    } catch (e) {
      if (active()) onError((e as Error).message);
    }
  }
  function preparedSource(id: string | undefined, mode: PlaybackMode) {
    const item = id && itemsById.get(id);
    if (!item || !audioRelayReady()) return false;
    const source = playbackSources(item, mode)[0];
    return playbackKind(item, source, mode) === "audio" && delivery.isPrepared(ownedAudioFile(source, item.duration));
  }
  async function advanceTarget(direction: 1 | -1, ended: boolean, retry: () => void, manual = false) {
    const token = manual ? intent.command() : intent.advance();
    const state = live.current;
    const nextIndex = state.queueIndex + direction;
    const index = state.repeat === "all" && !libraryOrder.tail
      ? (nextIndex + state.queue.length) % state.queue.length : nextIndex;
    const id = state.queue[index];
    if (!(ended && state.repeat === "one") && id && !failed.current.has(id) && preparedSource(id, state.mode))
      return {index, state};
    try {
      return await catalog.nextInQueue(() => live.current, direction, ended, failed.current, () => token === intent.navigation, () => libraryOrder.tail);
    } catch (e) {
      if (intent.navigation === token) {
        mediaKey.current = sourceKey;
        retryNavigation.current = () => {if (intent.navigation === token) retry();};
        setQueueLoadError((e as Error).message);
      }
    }
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
  async function next(direction: 1 | -1 = 1, ended = false) {
    if (!currentMedia()) return;
    if (ended) { feedback.pause(); finishAttempt("ended"); }
    const target = await advanceTarget(direction, ended, () => void next(direction, ended), !ended);
    if (!target) return;
    if (!ended) finishAttempt("manual");
    const {state, index} = target;
    if (index < 0) {
      playIntent(false);
      if (ended) {
        seek(0, false);
        completedAudio.current = !!file;
      }
      selectAttempt(live.current, "manual");
      if (direction === 1) showSkipped(state, state.queueIndex + 1, -1);
      return;
    }
    const trigger = ended ? (index === state.queueIndex ? "repeat" : "advance") : "manual";
    playEntry(state, index, trigger);
    if (direction === 1 && index !== state.queueIndex)
      showSkipped(state, (state.queueIndex + 1) % state.queue.length, index);
  }
  async function sourceError() {
    if (!currentMedia() || (audioToken && deniedToken.current === audioToken)) return;
    if (audioToken && native.current?.error) {
      seekOnLoad.current = readPosition() ?? live.current.position;
      setDirectAudioKey(audioToken);
      return;
    }
    feedback.pause();
    let entry = current;
    if (current && catalog.rechecksPlayback(current.id)) {
      const check = { key: sourceKey, token: intent.navigation };
      if (sourceCheck.current?.key === check.key && sourceCheck.current.token === check.token) return;
      sourceCheck.current = check;
      const active = () => sourceCheck.current === check && intent.navigation === check.token && currentMedia();
      try {
        entry = await catalog.readPlayback(current.id);
        if (!active()) return;
      } catch (failure) {
        if (active()) {
          playIntent(false);
          setError((failure as Error).message);
        }
        return;
      } finally {
        if (sourceCheck.current === check) sourceCheck.current = undefined;
      }
    }
    mediaKey.current = "";
    const unsuccessful = new Set(failedSources);
    if (source) unsuccessful.add(source.id);
    if (entry && entry !== current) catalog.put([entry]);
    if (entry && playbackSourceForAttempt(entry, unsuccessful, undefined, settings.mode)) {
      measureProgress();
      attempt.paused();
      setFailedSources(unsuccessful);
      setError("Основной источник недоступен. Переключено на другой.");
      return;
    }
    finishAttempt("error");
    if (current) failed.current.add(current.id);
    const target = await advanceTarget(1, false, () => void sourceError());
    if (!target) return;
    const {state, index} = target;
    if (index >= 0) playEntry(state, index, "advance", { autoplay: playingRef.current });
    else {
      setFailedSources(unsuccessful);
      playIntent(false);
    }
    setError(index >= 0
      ? `«${current?.title ?? "Запись"}» недоступна. Переходим к следующей.`
      : "В очереди больше нет доступных источников.");
  }
  function positionMedia(position: number, confirmYoutubeRestart = false) {
    feedback.sample(position);
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
  function readNativeRanges(element: HTMLMediaElement) {
    if (!currentNative(element)) return;
    const {buffered} = element;
    const ranges: BufferedRanges = Array.from({length: buffered.length}, (_, index) => [buffered.start(index), buffered.end(index)]);
    setBuffer(old => old?.source === feedback && old.ranges.length === ranges.length &&
      ranges.every(([start, end], index) => old.ranges[index][0] === start && old.ranges[index][1] === end)
      ? old : {source: feedback, ranges});
  }
  function updateNativeRanges(event: SyntheticEvent<HTMLMediaElement>) {
    readNativeRanges(event.currentTarget);
  }
  useEffect(() => {
    const refreshBuffer = () => {
      if (!document.hidden && native.current) readNativeRanges(native.current);
    };
    document.addEventListener("visibilitychange", refreshBuffer);
    return () => document.removeEventListener("visibilitychange", refreshBuffer);
  }, [feedback]);
  function nativeWaiting(event: SyntheticEvent<HTMLMediaElement>) {
    if (!currentNative(event.currentTarget) || !playingRef.current) return;
    feedback.wait();
    if (nativePositionReady.current.has(event.currentTarget))
      confirmPosition(event.currentTarget.currentTime, event.currentTarget.playbackRate);
    attempt.paused();
  }
  const nativeEvents = {
    onProgress: updateNativeRanges,
    onDurationChange(event: SyntheticEvent<HTMLMediaElement>) {
      if (!currentNative(event.currentTarget)) return;
      setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
      updateNativeRanges(event);
    },
    onLoadedMetadata(event: SyntheticEvent<HTMLMediaElement>) {
      if (!currentNative(event.currentTarget)) return;
      const element = event.currentTarget;
      if (seekOnLoad.current > 0) element.currentTime = seekOnLoad.current;
      nativePositionReady.current.add(element);
      updateNativeRanges(event);
      element.volume = live.current.volume;
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
    },
    onPlaying(event: SyntheticEvent<HTMLMediaElement>) {
      if (!currentNative(event.currentTarget)) return;
      const element = event.currentTarget;
      if (!playingRef.current || element.paused || element.ended) return;
      if (nativeRestart.current?.element === element && (element.seeking || element.readyState < 3)) return;
      nativeRestart.current = null;
      nativeStarted.current.add(element);
      delivery.playing();
      feedback.play(element.currentTime, element.playbackRate);
      if (scrub.current?.target === undefined) attempt.playing(...nativePlaybackReading(element));
      playIntent(true);
    },
    onTimeUpdate(event: SyntheticEvent<HTMLMediaElement>) {
      const element = event.currentTarget;
      if (!currentNative(element) || element.seeking || scrub.current) return;
      const reading = nativePlaybackReading(element);
      confirmPosition(reading[0], reading[2]);
      const restart = nativeRestart.current;
      if (restart?.element === element && playingRef.current && nativeRestartHasProgress(element, restart.position)) {
        nativeRestart.current = null;
        nativeStarted.current.add(element);
        feedback.play(element.currentTime, element.playbackRate);
        attempt.playing(...reading);
      }
      attempt.progress(...reading);
    },
    onRateChange(event: SyntheticEvent<HTMLMediaElement>) {
      if (currentNative(event.currentTarget) && !event.currentTarget.seeking && scrub.current?.target === undefined)
        attempt.progress(...nativePlaybackReading(event.currentTarget));
    },
    onWaiting: nativeWaiting,
    onSeeking: nativeWaiting,
    onSeeked(event: SyntheticEvent<HTMLMediaElement>) {
      const element = event.currentTarget;
      if (!currentNative(element)) return;
      readNativeRanges(element);
      if (nativeRestart.current?.element === element) {
        nativeRestart.current.position = element.currentTime;
        return;
      }
      if (
        playingRef.current && !element.paused &&
        element.readyState >= 3 && nativeStarted.current.has(element)
      ) {
        feedback.play(element.currentTime, element.playbackRate);
        if (scrub.current?.target === undefined) attempt.playing(...nativePlaybackReading(element));
      }
    },
    onPause(event: SyntheticEvent<HTMLMediaElement>) {
      if (!currentNative(event.currentTarget) || !event.currentTarget.paused || event.currentTarget.ended) return;
      if (nativePositionReady.current.has(event.currentTarget))
        confirmPosition(event.currentTarget.currentTime, event.currentTarget.playbackRate);
      measureProgress();
      attempt.paused();
      playIntent(false);
    },
    onEnded(event: SyntheticEvent<HTMLMediaElement>) {
      if (currentNative(event.currentTarget)) void next(1, true);
    },
    onError(event: SyntheticEvent<HTMLMediaElement>) {
      if (currentNative(event.currentTarget)) void sourceError();
    },
  };
  async function toggle() {
    const token = intent.command();
    if (!current || waitingForVideo) return;
    if (!playingRef.current && catalog.rechecksPlayback(current.id) && !(source?.shared && file && audioToken)) {
      const item = await reloadPlaybackEntry(current.id, token);
      if (!item || token !== intent.navigation) return;
      if (!playbackSources(item, live.current.mode).length) {
        setError(`«${item.title}» недоступна для воспроизведения.`);
        return;
      }
      if (!source) {
        finishAttempt("manual");
        failed.current.delete(item.id);
        playEntry(live.current, live.current.queueIndex, "manual");
        return;
      }
      if (!playbackSources(item, live.current.mode).some(candidate => candidate.id === source.id)) {
        setFailedSources(new Set());
        setError("");
        playIntent(true);
        return;
      }
    }
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
      const position = readPosition();
      if (position !== undefined) {
        seekOnLoad.current = position;
        if (position !== live.current.position) patch({ position });
      }
      measureProgress();
      attempt.paused();
      const iframeState = youtube.current?.getPlayerState?.();
      cancelledYoutubeStart.current = iframeState === -1 || iframeState === 3 || iframeState === 5;
      native.current?.pause();
      youtube.current?.pauseVideo?.();
      playIntent(false);
    } else {
      setError("");
      cancelledYoutubeStart.current = false;
      playIntent(true);
      if (completedAudio.current && file && relayReady) setAudioReplay(value => value + 1);
      else if (native.current) playNative(native.current);
      youtube.current?.playVideo?.();
    }
  }
  function openAndPlay(itemId: string) {
    playOnPlayerOpen.current = itemId;
    navigate("/player");
  }
  async function watchCurrent() {
    if (!current || !videoSource) return;
    if (settings.mode === "original" && source?.id === videoSource.id) {
      if (catalog.rechecksPlayback(current.id)) {
        const token = intent.command();
        const item = await reloadPlaybackEntry(current.id, token);
        if (!item || token !== intent.navigation) return;
        if (!playableVideoSource(item)) {
          setError(`«${item.title}» недоступна для просмотра.`);
          return;
        }
      }
      openAndPlay(current.id);
    }
    else changeMode("original", { activate: true, videoSourceId: videoSource.id });
  }
  async function changeMode(mode: PlaybackMode, {
    skipCurrent = false, activate = false, keepSelectedVideo = false, videoSourceId,
  }: { skipCurrent?: boolean; activate?: boolean; keepSelectedVideo?: boolean; videoSourceId?: string } = {}) {
    const state = live.current;
    if (!current || (state.mode === mode && !videoSourceId)) {
      setOfferAudioSkip(false);
      return;
    }
    const token = intent.command();
    const item = catalog.rechecksPlayback(current.id) ? await reloadPlaybackEntry(current.id, token) : current;
    if (!item || token !== intent.navigation || state.queue !== live.current.queue) return;
    const updated = { ...state, mode };
    const latestVideo = item === current ? videoSource : playableVideoSource(item, failedSources);
    const candidate = videoSourceId ? latestVideo : playbackSources(item, mode)[0];
    if (!candidate && !(keepSelectedVideo && latestVideo)) {
      const nextEntry = await findNext(1, updated, token, true);
      if (token !== intent.navigation || state.queue !== live.current.queue || nextEntry === undefined) return;
      if (mode === "audio" && skipCurrent && nextEntry >= 0) {
        finishAttempt("manual");
        failed.current.clear();
        playEntry({...live.current, mode}, nextEntry, "manual");
        showSkipped(updated, state.queueIndex, nextEntry);
        return;
      }
      setOfferAudioSkip(mode === "audio" && nextEntry >= 0);
      setError(mode === "audio"
        ? soundUnavailableReason(item) ?? "Источник звука недоступен"
        : "Источник недоступен");
      return;
    }
    setOfferAudioSkip(false);
    setError("");
    playOnPlayerOpen.current = undefined;
    failed.current.clear();
    setFailedSources(new Set());
    sourceIdentity.current = undefined;
    requestedVideoSourceId.current = videoSourceId ? candidate?.id : undefined;
    const position = readPosition() ?? state.position;
    const needsReattach = source?.id !== candidate?.id || presentationKind !== playbackKind(item, candidate, mode);
    if (needsReattach) {
      measureProgress();
      attempt.paused();
      mediaKey.current = "";
      setDuration(0);
    }
    seekOnLoad.current = position;
    const canPlay = canAutoplayPlayback(item, candidate, mode, onPlayerScreen);
    playIntent((activate || playingRef.current) && canPlay);
    patch({ mode, position });
    if (activate && !canPlay && mode === "original") openAndPlay(current.id);
  }
  async function watchQueueVideo(index: number) {
    const token = intent.command();
    const state = live.current;
    const id = state.queue[index];
    if (!id) return;
    const item = catalog.rechecksPlayback(id) ? await reloadPlaybackEntry(id, token) : itemsById.get(id);
    if (!item || token !== intent.navigation || live.current.queue !== state.queue ||
      playbackKind(item, playbackSources(item)[0]) !== "video") return;
    finishAttempt("manual");
    failed.current.delete(item.id);
    playEntry({ ...state, mode: "original" }, index, "manual");
  }
  function addToQueue(item: ItemDto, placement: "next" | "last", playlistId?: string) {
    if (libraryOrder.tail) return;
    catalog.put([item]);
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
    intent.command();
    firstSound.current?.();
    firstSound.current = undefined;
    libraryOrder.cancel();
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
    cancelledYoutubeStart.current = false;
    scrub.current = null;
    setDuration(0);
    return () => feedback.reset();
  }, [sourceKey]);
  useLayoutEffect(() => {
    if (source && playing && !waitingForVideo && feedback.snapshot() === "idle") feedback.wait();
    else if (!playing || !source || waitingForVideo) feedback.pause();
  }, [feedback, playing, waitingForVideo, source?.id]);
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
  useLayoutEffect(() => {
    catalog.invalidate();
  }, [catalog, revision]);
  useEffect(() => () => {firstSound.current?.(); firstSound.current = undefined; intent.command(); libraryOrder.cancel();}, [libraryOrder]);
  useEffect(() => {
    let active = true;
    const {queue, queueIndex} = settings;
    const visible = queue.length <= 200 && (onPlayerScreen || queueOpen) ? queue : queue.slice(Math.max(0, queueIndex - 1), queueIndex + 3);
    // Fetch the current entry first, including on reload in the middle of a long queue.
    const id = queue[queueIndex];
    setQueueLoadError("");
    retryNavigation.current = undefined;
    if (id) void catalog.ensure([id], () => active, true).then(() => catalog.ensure(visible, () => active))
      .catch(e => {if (active) setQueueLoadError(e.message);});
    return () => {active = false;};
  }, [catalog, revision, settings.queue, settings.queueIndex, onPlayerScreen, queueOpen, queueRetry]);
  const loadVisible = useCallback((ids: string[]) => {
    void catalog.ensure(ids).catch(e => setQueueLoadError(e.message));
  }, [catalog, revision, queueRetry]);
  const pendingEntry = useRef<string | undefined>(undefined);
  useEffect(() => {
    const state = live.current;
    const id = state.queue[state.queueIndex];
    if (!id) return;
    if (current) {
      if (pendingEntry.current === id) selectAttempt(state, "manual");
      pendingEntry.current = undefined;
      return;
    }
    if (!catalog.deleted(id)) {pendingEntry.current = id; return;}
    // Find a surviving neighbor without dropping IDs that haven't been loaded yet.
    const token = intent.advance();
    let active = true;
    void (async () => {
      let candidate = await findNext(1, state, token, false, false, setQueueLoadError);
      if (candidate === -1) candidate = await findNext(-1, state, token, false, false, setQueueLoadError);
      if (!active || token !== intent.navigation || candidate === undefined) return;
      finishAttempt("interrupted");
      const queue = state.queue.filter(entry => !catalog.deleted(entry));
      if (!queue.length) {clearQueue(); setError("В очереди больше нет доступных записей."); return;}
      const nextId = candidate >= 0 ? state.queue[candidate] : queue[Math.min(queue.length - 1, state.queueIndex)];
      const index = queue.indexOf(nextId!);
      playEntry({...live.current, queue}, index, "advance", {autoplay: candidate >= 0 && playingRef.current});
      setError("Текущая запись удалена. Выбрана другая запись из очереди.");
    })();
    return () => {active = false;};
  }, [current?.id, settings.queue, settings.queueIndex, revision, queueRetry, catalog.deleted(settings.queue[settings.queueIndex]!)]);
  useEffect(() => {
    if (native.current) {
      native.current.volume = settings.volume;
      if (playingRef.current) playNative(native.current);
      else native.current.pause();
    }
  }, [playing, sourceKey, audioUrl]);
  useEffect(() => {
    if (native.current) native.current.volume = settings.volume;
  }, [settings.volume]);
  const lastInitialSettings = useRef(initialSettings);
  useLayoutEffect(() => {
    if (lastInitialSettings.current !== initialSettings) {
      lastInitialSettings.current = initialSettings;
      intent.command();
      libraryOrder.cancel();
      finishAttempt("interrupted");
      const restored = restorePlayback(initialSettings ?? {});
      playOnPlayerOpen.current = undefined;
      savedSettings.current = restored;
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

  // Partial library results and access-scoped playback stay in this tab.
  // Keep the last complete personal queue when saving preferences.
  const persistable = useRef(settings);
  const sharedQueue = useMemo(() => settings.queue.some(catalog.isShared), [catalog, settings.queue]);
  useLayoutEffect(() => {
    if (!libraryOrder.tail && !sharedQueue) {
      persistable.current = settings;
    } else {
      const { volume, lastNonzeroVolume } = settings;
      if (volume !== persistable.current.volume || lastNonzeroVolume !== persistable.current.lastNonzeroVolume)
        persistable.current = { ...persistable.current, volume, lastNonzeroVolume };
    }
  }, [settings, orderStatus, libraryOrder, sharedQueue]);
  useEffect(() => {
    cache.save(persistable.current, savedSettings.current, Date.now(), !playing);
  }, [settings, playing, cache]);
  useEffect(() => {
    let mounted = true;
    let sending = false;
    const save = async () => {
      if (sending || savingSuspended.current) return;
      const submitted = persistable.current;
      const baseline = savedSettings.current;
      const delta = playbackSettingsPatch(submitted, baseline);
      if (!Object.keys(delta).length) return;
      sending = true;
      try {
        const saved = await api<Partial<PlaybackSettings>>("/settings?patch=1", "PUT", delta);
        if (!mounted || savingSuspended.current || savedSettings.current !== baseline) return;
        savedSettings.current = {...submitted, ...saved};
        const state = live.current;
        const queuePlaylistIds = reconcileQueuePlaylistIds(state.queuePlaylistIds, submitted.queuePlaylistIds, saved.queuePlaylistIds);
        if (queuePlaylistIds !== state.queuePlaylistIds) {
          patch({ queuePlaylistIds });
          const id = state.queue[state.queueIndex];
          if (id) attempt.updatePlaylistId(id, queuePlaylistIds?.[id]);
        }
        setSaveError("");
      } catch {
        if (mounted && !savingSuspended.current) setSaveError("Не удалось сохранить настройки. Локальная копия сохранена.");
      } finally { sending = false; }
    };
    const flush = () => {
      if (savingSuspended.current) return;
      cache.save(persistable.current, savedSettings.current, Date.now(), true);
      const delta = playbackSettingsPatch(persistable.current, savedSettings.current);
      if (!Object.keys(delta).length) return;
      void fetch("/api/settings?patch=1", {
        method: "PUT", credentials: "same-origin", keepalive: true,
        headers: { "Content-Type": "application/json", "X-Hibiki-Workspace": userId },
        body: JSON.stringify(delta),
      }).catch(() => {});
    };
    const timer = setInterval(save, 5000);
    window.addEventListener("pagehide", flush);
    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener("pagehide", flush);
      void save();
    };
  }, [cache, userId]);
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
    if (libraryOrder.tail) return;
    patch(togglePlaybackShuffle(live.current));
  }
  const fullscreen = nativeFullscreen || viewportFullscreen;
  useLayoutEffect(() => () => videoClick.cancel(), [sourceKey, onPlayerScreen, videoClick]);
  useLayoutEffect(() => {
    if (!fullscreen) return;
    stage.current?.focus({ preventScroll: true });
    const timer = createFullscreenIdleTimer(setControlsIdle);
    controlsIdleTimer.current = timer;
    return () => {
      timer.dispose();
      controlsIdleTimer.current = null;
      setControlsIdle(true);
    };
  }, [fullscreen]);
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
      if (!current || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const inPlayer = !!target?.closest(".watch-stage, .mini-player");
      const action = playbackShortcut({
        key: event.key, code: event.code, target, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
        altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, isComposing: event.isComposing,
      }, inPlayer && !!target?.closest("button"));
      if (action === null || (action === "fullscreen" && !onPlayerScreen)) return;
      if ((typeof action === "number" || event.key.startsWith("Arrow")) &&
          !inPlayer && !(onPlayerScreen && target === document.body)) return;
      const totalTime = duration || current.duration || 0;
      if (typeof action === "number" && !totalTime) return;
      event.preventDefault();
      videoClick.cancel();
      switch (action) {
        case "toggle": toggle(); break;
        case "fullscreen": void toggleFullscreen(); break;
        case "mute": toggleMute(); break;
        case "louder": setVolume(live.current.volume + 0.05); break;
        case "quieter": setVolume(live.current.volume - 0.05); break;
        case "backward": seek((readPosition() ?? live.current.position) - 10); break;
        case "forward": seek((readPosition() ?? live.current.position) + 10); break;
        case "backFive": seek((readPosition() ?? live.current.position) - 5); break;
        case "forwardFive": seek((readPosition() ?? live.current.position) + 5); break;
        default: seek(totalTime * action);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [current?.id, playing, duration, settings.volume, sourceKey, viewportFullscreen, onPlayerScreen]);
  const total = duration || current?.duration || 0;
  const seekBar = {
    position: settings.position,
    duration: total,
    moving: playing && phase === "playing",
    buffered: playbackBuffer(buffer?.source === feedback ? buffer.ranges : [], audioToken ? coverage : undefined, total),
    clock,
    onSeek: seekFromSlider,
    onScrubStart: () => { scrub.current ??= {}; },
    onScrubEnd: finishScrub,
  };
  const artwork = playbackArtwork(current, source);
  const showArtwork = artwork && failedArtwork !== artwork;
  const audioFallback = current?.kind === "video" && settings.mode === "original" &&
    source && presentationKind === "audio";
  const sourceLabel = source?.shared ? "Источник по ссылке" : isYoutube ? "YouTube" : source ? "Локальный файл" : "Источник недоступен";
  const rowCommands = useRef({switchTo, watchQueueVideo, reorder, removeFromQueue});
  useLayoutEffect(() => { rowCommands.current = {switchTo, watchQueueVideo, reorder, removeFromQueue}; });
  const selectRow = useCallback((index: number) => { void rowCommands.current.switchTo(index); }, []);
  const queueSettings = useMemo(() => ({queue: settings.queue, queueIndex: settings.queueIndex, mode: settings.mode}),
    [settings.queue, settings.queueIndex, settings.mode]);
  const queueRow = useCallback((id: string, index: number) => {
    const editable = queueEditable && index > settings.queueIndex;
    const item = itemsById.get(id);
    const title = item?.title ?? (catalog.deleted(id) ? "Запись удалена" : "Загружаем запись…");
    const artworkSource = item?.sources.find(candidate => candidate.thumbnail);
    const active = index === settings.queueIndex;
    const unavailableReason = queueEntryUnavailableReason(item, settings.mode);
    const failedReason = failed.current.has(id) ? "Источник недоступен" : undefined;
    const canWatch = settings.mode === "audio" && unavailableReason && item && playbackSources(item).some(
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
          if (dragging) rowCommands.current.reorder(dragging, live.current.queue.indexOf(id));
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
        <button type="button" className={`watch-queue-row ${active ? "active" : ""}`} aria-current={active ? "true" : undefined} aria-disabled={!!unavailableReason && !catalog.rechecksPlayback(id)} onClick={() => selectRow(index)}>
          <span className="watch-queue-number">{active && playing ? <span className="equalizer" aria-hidden="true"><i /><i /><i /></span> : index + 1}</span>
          <span className={`watch-queue-art art-${title.length % 6}`}>
            <ItemArtwork source={artworkSource} kind={item?.kind ?? "audio"} />
            <span className="watch-queue-duration">{formatDuration(item?.duration)}</span>
          </span>
          <span className="watch-queue-info">
            <strong>{title}</strong>
            <small>{unavailableReason ?? failedReason ?? (item?.kind === "video" ? "Видео" : "Аудио")}</small>
          </span>
        </button>
        {canWatch && (
          <button className="icon-button queue-watch-video" aria-label={`Смотреть ${title}`} title="Смотреть" onClick={() => rowCommands.current.watchQueueVideo(index)}>
            <Video size={16} />
          </button>
        )}
        {editable && (
          <div className="queue-entry-actions">
            <button className="icon-button" aria-disabled={!canMoveUp} aria-label={`Переместить выше: ${title}`} title="Переместить выше" onClick={() => rowCommands.current.reorder(id, index - 1)}><ArrowUp size={14} /></button>
            <button className="icon-button" aria-disabled={!canMoveDown} aria-label={`Переместить ниже: ${title}`} title="Переместить ниже" onClick={() => rowCommands.current.reorder(id, index + 1)}><ArrowDown size={14} /></button>
            <button className="icon-button" aria-label={`Удалить из очереди: ${title}`} title="Удалить из очереди" onClick={() => rowCommands.current.removeFromQueue(id)}><X size={14} /></button>
          </div>
        )}
      </div>
    );
  }, [catalogVersion, queueSettings, queueEditable, playing, dragOver, error, failedSources]);
  const failedSelection = selectionFailure?.token === intent.selection ? selectionFailure : undefined;
  const queueMessage = failedSelection?.message ?? (orderStatus === "error" ? "Не удалось загрузить всю очередь." : queueLoadError);
  const queueRetryNotice = queueMessage && (
    <div className="mini-player-notice" role="alert">
      <span>{queueMessage}</span>
      <button className="text-button" onClick={() => {
        if (failedSelection) { failedSelection.retry(); return; }
        if (libraryOrder.snapshot() === "error") { libraryOrder.retry(); return; }
        const retry = retryNavigation.current;
        retryNavigation.current = undefined;
        setQueueLoadError("");
        if (retry) retry();
        else setQueueRetry(value => value + 1);
      }}>Повторить загрузку очереди</button>
    </div>
  );
  const player = onPlayerScreen && (
    <section className={`watch-player ${current ? "" : "is-empty"}`} aria-label="Плеер">
      {queueRetryNotice}
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
                className={`watch-stage ${presentationKind === "audio" ? "is-audio" : ""} ${youtubeId ? "is-youtube" : ""} ${viewportFullscreen ? "is-viewport-fullscreen" : ""} ${fullscreen && controlsIdle ? "is-controls-idle" : ""}`}
                aria-label="Сцена воспроизведения"
                tabIndex={-1}
                onPointerMove={(event) => {
                  const last = pointerPosition.current;
                  pointerPosition.current = {x: event.clientX, y: event.clientY};
                  if (last?.x !== event.clientX || last.y !== event.clientY) controlsIdleTimer.current?.activity();
                }}
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
                        if (!currentMedia() || scrub.current) return;
                        const [position, d, rate] = reading;
                        confirmPosition(position, rate);
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
                      onAutoplayBlocked={() => {
                        if (!currentMedia()) return;
                        attempt.paused();
                        playIntent(false);
                        setError("Нажмите «Воспроизвести», чтобы продолжить.");
                      }}
                      onPaused={() => {
                        if (!currentMedia()) return;
                        cancelledYoutubeStart.current = false;
                        if (youtube.current) {
                          const [seconds, , rate] = youtubePlaybackReading(youtube.current);
                          confirmPosition(seconds, rate);
                        }
                        measureProgress();
                        attempt.paused();
                        playIntent(false);
                      }}
                      onBuffering={() => {
                        if (!currentMedia() || !playingRef.current || cancelledYoutubeStart.current) return;
                        feedback.wait();
                        if (youtube.current) {
                          const [seconds, , rate] = youtubePlaybackReading(youtube.current);
                          confirmPosition(seconds, rate);
                        }
                        attempt.paused();
                      }}
                      onPlaying={(...reading) => {
                        if (!currentMedia()) return;
                        if (cancelledYoutubeStart.current && !playingRef.current) {
                          youtube.current?.pauseVideo?.();
                          return;
                        }
                        feedback.play(reading[0], reading[2]);
                        setDuration(reading[1] ?? 0);
                        youtubeRestart.current = null;
                        if (scrub.current?.target === undefined) attempt.playing(...reading);
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
                      onClick={event => {
                        const element = event.currentTarget;
                        videoClick.click(event.detail, () => {
                          if (native.current === element) toggle();
                        }, () => { void toggleFullscreen(); });
                      }}
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
                {loadingLabel && <div className="playback-loading" role="status">{loadingLabel}</div>}
                <div className="watch-controls">
                  <div className="watch-fullscreen-title">{current.title}</div>
                  <div className="seek-row">
                    <span>{formatDuration(settings.position)}</span>
                    <PlaybackSeekBar key={sourceKey} {...seekBar} />
                    <span>{formatDuration(total)}</span>
                  </div>
                  <div className="watch-control-row">
                    <div className="watch-transport">
                      <button className="main-play" aria-label={playing ? "Приостановить" : "Воспроизвести"} title={playing ? "Приостановить (K / Пробел)" : "Воспроизвести (K / Пробел)"} onClick={toggle}>
                        {playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}
                      </button>
                      <button className="icon-button" aria-label="Предыдущая запись" title="Предыдущая запись" onClick={() => live.current.position > 3 ? seek(0) : next(-1)}><SkipBack size={19} fill="currentColor" /></button>
                      <button className="icon-button" aria-label="Следующая запись" title="Следующая запись" onClick={() => next()}><SkipForward size={19} fill="currentColor" /></button>
                      <span className="watch-control-divider" />
                      <button className={`icon-button ${settings.shuffle ? "selected" : ""}`} disabled={!queueEditable} aria-label="Перемешать" title="Перемешать очередь" aria-pressed={settings.shuffle} onClick={shuffleToggle}><Shuffle size={18} /></button>
                      <button
                        className={`icon-button ${settings.repeat !== "off" ? "selected" : ""}`}
                        aria-label={`Повтор: ${settings.repeat === "off" ? "выключен" : settings.repeat === "all" ? "вся очередь" : "одна запись"}`}
                        title={`Повтор: ${settings.repeat === "off" ? "выключен" : settings.repeat === "all" ? "вся очередь" : "одна запись"}`}
                        onClick={() => patch({ repeat: settings.repeat === "off" ? "all" : settings.repeat === "all" ? "one" : "off" })}
                      >{settings.repeat === "one" ? <Repeat1 size={18} /> : <Repeat size={18} />}</button>
                    </div>
                    <div className="watch-tools">
                      <PlaybackVolume volume={settings.volume} onMute={toggleMute} onVolume={setVolume} />
                      <span className="watch-control-divider" />
                      <button className="icon-button fullscreen-button" aria-label={fullscreen ? "Выйти из полноэкранного режима" : "Полный экран"} title="Полный экран (F)" onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}</button>
                    </div>
                  </div>
                  {(error || saveError) && (
                    <div className="watch-notice" role="status">
                      <CircleAlert size={16} /><span>{error || saveError}</span>
                      {offerAudioSkip && <button className="text-button" onClick={() => changeMode("audio", { skipCurrent: true })}>Слушать со следующей доступной</button>}
                      <button className="icon-button" aria-label="Скрыть уведомление" onClick={dismissNotice}><X size={15} /></button>
                    </div>
                  )}
                </div>
              </div>
              <div className="watch-metadata">
                <span className="watch-kind-icon">{presentationKind === "video" ? <Video size={20} /> : <Music2 size={20} />}</span>
                <div><h2>{current.title}</h2><p>{audioFallback ? "Доступен только звук" : presentationKind === "video" ? "Видео" : "Аудио"}<span>·</span>{sourceLabel}{current.tags.slice(0, 2).map((tag) => <span className="watch-tag" key={tag.id}>{tag.name}</span>)}</p></div>
              </div>
              <p className="watch-shortcuts"><kbd>K</kbd> пауза <span>·</span> <kbd>← →</kbd> 5 с <span>·</span> <kbd>J L</kbd> 10 с <span>·</span> <kbd>0–9</kbd> позиция <span>·</span> <kbd>↑ ↓</kbd> громкость <span>·</span> <kbd>F</kbd> полный экран</p>
            </div>
            <aside className="watch-queue" aria-label="Очередь воспроизведения">
              <div className="watch-queue-heading"><div><ListMusic size={18} /><h2>Очередь</h2></div><span>{!queueEditable && "Загружено: "}{settings.queue.length} {mediaWord(settings.queue.length)}</span></div>
              <div className="watch-queue-list">
                {settings.queueIndex > 0 && (
                  <details className="queue-past">
                    <summary>Предыдущие <span>{settings.queueIndex}</span></summary>
                    <QueueRows queue={settings.queue} start={0} end={settings.queueIndex} row={queueRow} onVisible={loadVisible} />
                  </details>
                )}
                <h3 className="queue-section-heading">Сейчас</h3>
                <QueueRows queue={settings.queue} start={settings.queueIndex} end={settings.queueIndex + 1} row={queueRow} />
                <h3 className="queue-section-heading">Далее</h3>
                <QueueRows queue={settings.queue} start={settings.queueIndex + 1} end={settings.queue.length} row={queueRow} onVisible={loadVisible} />
                {queueEditable && settings.queueIndex === settings.queue.length - 1 && <p className="queue-empty">Дальше записей нет.</p>}
              </div>
              {removal && (
                <div className="queue-notice">
                  <span role="status">«{removal.title}» удалена из очереди</span>
                  <button className="text-button" onClick={undoRemoval}>Отменить</button>
                </div>
              )}
              <div className="watch-queue-footer">
                {!sharedQueue && <button className="text-button" disabled={!queueEditable} onClick={() => { setCreatedPlaylist(undefined); setShowSavePlaylist(true); }}>Сохранить как плейлист</button>}
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
  const miniPlayer = !onPlayerScreen && (current || error || saveError || queueRetryNotice) ? (
    <div className="mini-player">
      {queueRetryNotice}
      {(error || saveError) && (
        <div className="mini-player-notice" role="status">
          <CircleAlert size={16} /><span>{error || saveError}</span>
          <button className="icon-button" aria-label="Скрыть уведомление" onClick={dismissNotice}><X size={16} /></button>
        </div>
      )}
      {current && (
        <section className="mini-player-body" aria-label="Управление воспроизведением">
          <PlaybackSeekBar key={sourceKey} {...seekBar} className="mini-player-seek" />
          <Link className="mini-player-track" to="/player" aria-label={`Открыть плеер: ${current.title}`}>
            <span className={`mini-player-art art-${current.title.length % 6}`}>
              <ItemArtwork source={source?.thumbnail ? source : current.sources.find(candidate => candidate.thumbnail)}
                kind={presentationKind ?? current.kind} />
            </span>
            <span className="mini-player-info">
              <strong>{current.title}</strong>
              <small role="status">{loadingLabel || (needsVideoForPlayback ? soundUnavailableReason(current) ?? "Источник звука недоступен"
                : waitingForVideo ? "Видео готово к просмотру"
                : audioFallback ? "Доступен только звук"
                : playing && phase === "playing" ? "Сейчас играет" : playing ? "Только звук" : "На паузе")}</small>
            </span>
          </Link>
          <div className="mini-player-transport">
            <button className="icon-button" aria-label="Предыдущая запись" onClick={() => live.current.position > 3 ? seek(0) : next(-1)}>
              <SkipBack size={17} fill="currentColor" />
            </button>
            {!waitingForVideo && (
              <button className="mini-player-play" aria-label={playing ? "Приостановить" : "Воспроизвести"} onClick={toggle}>
                {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
              </button>
            )}
            {videoSource && (
              <button type="button" className="icon-button" aria-label="Открыть видео" title="Открыть видео" onClick={watchCurrent}>
                <Video size={18} aria-hidden="true" />
              </button>
            )}
            <button className="icon-button" aria-label="Следующая запись" onClick={() => next()}>
              <SkipForward size={17} fill="currentColor" />
            </button>
          </div>
          <div className="mini-player-side">
            <span>{formatDuration(settings.position)} / {formatDuration(total)}</span>
            <PlaybackVolume compact volume={settings.volume} onMute={toggleMute} onVolume={setVolume} />
            <CompactPlaybackQueue incomplete={!queueEditable} key={routeKey} onOpenChange={setQueueOpen} deleted={catalog.deleted} canRecheck={catalog.rechecksPlayback} settings={queueSettings} version={catalogVersion} onVisible={loadVisible} itemsById={itemsById} failedIds={failed.current} onSelect={selectRow} />
          </div>
        </section>
      )}
    </div>
  ) : null;
  // Media time updates are frequent. Library rows subscribe only to changes
  // that affect their buttons and cover, while commands use the latest state.
  const commands = useRef({start, activateItem, playShared, toggle, watchCurrent, addToQueue});
  useLayoutEffect(() => {commands.current = {start, activateItem, playShared, toggle, watchCurrent, addToQueue};});
  const stableCommands = useMemo<PlayerCommands>(() => ({
    start: (...args) => commands.current.start(...args),
    activateItem: (...args) => commands.current.activateItem(...args),
    playShared: (...args) => commands.current.playShared(...args),
    sharedId: (path, id) => catalog.sharedId(path, id),
    toggle: () => commands.current.toggle(),
    watchCurrent: () => commands.current.watchCurrent(),
    enqueue: (item, playlistId) => commands.current.addToQueue(item, "last", playlistId),
    playNext: (item, playlistId) => commands.current.addToQueue(item, "next", playlistId),
  }), [catalog]);
  const controller = useMemo<Controller>(() => ({ ...stableCommands, current, playing, waitingForVideo, loadingLabel, mode: settings.mode, queueEditable }),
    [stableCommands, current, playing, waitingForVideo, loadingLabel, settings.mode, queueEditable]);
  useLayoutEffect(() => {
    cards.update(current?.id, {active: !!current, playing, waitingForVideo, loadingLabel, mode: settings.mode}, queueEditable);
  }, [cards, current?.id, playing, waitingForVideo, loadingLabel, settings.mode, queueEditable]);
  return (
    <CardsContext.Provider value={cards}><CommandsContext.Provider value={stableCommands}><PlayerContext.Provider value={controller}>
      {children(player, miniPlayer)}
      {source && presentationKind === "audio" && (
        <audio key={audioToken ?? sourceKey} ref={attachNative} src={audioUrl} preload={playing ? "auto" : "none"} {...nativeEvents} />
      )}
    </PlayerContext.Provider></CommandsContext.Provider></CardsContext.Provider>
  );
}
