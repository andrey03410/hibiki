import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  ChevronDown,
  Minimize2,
  X,
  Music2,
  Maximize2,
  CircleAlert,
} from "lucide-react";
import { shuffle as shuffleIds } from "@hibiki/core";
import type { ItemDto } from "@hibiki/contracts";
import { api, formatDuration } from "./api.ts";
import {
  nextPlayableIndex,
  firstPlayableIndex,
  playbackSources,
  sourceLoadPosition,
  restorePlayback,
  playbackShortcut,
  playbackArtwork,
  playbackKind,
  enterPlayerFullscreen,
  createFullscreenIdleTimer,
  type PlaybackSettings,
} from "./player-model.ts";

interface Controller {
  current?: ItemDto;
  playing: boolean;
  settings: PlaybackSettings;
  start: (items: ItemDto[], index?: number) => void;
  enqueue: (item: ItemDto) => void;
  toggle: () => void;
}
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
  onPlaying,
}: {
  id: string;
  playing: boolean;
  volume: number;
  position: number;
  engine: React.RefObject<any>;
  onTime: (p: number, d: number) => void;
  onEnded: () => void;
  onError: () => void;
  onPaused: () => void;
  onPlaying: () => void;
}) {
  const target = useRef<HTMLDivElement>(null),
    callbacks = useRef({ onTime, onEnded, onError, onPaused, onPlaying });
  callbacks.current = { onTime, onEnded, onError, onPaused, onPlaying };
  const active = useRef(playing);
  active.current = playing;
  const initial = useRef({ position, volume });
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setInterval>,
      player: any;
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
              engine.current = player;
              player.setVolume(initial.current.volume * 100);
              if (initial.current.position)
                player.seekTo(initial.current.position, true);
              if (active.current) player.playVideo();
              timer = setInterval(
                () =>
                  callbacks.current.onTime(
                    player.getCurrentTime?.() || 0,
                    player.getDuration?.() || 0,
                  ),
                500,
              );
            },
            onStateChange: (event: any) => {
              if (event.data === 0) callbacks.current.onEnded();
              if (event.data === 1) callbacks.current.onPlaying();
              if (event.data === 2 && active.current)
                callbacks.current.onPaused();
            },
            onError: () => callbacks.current.onError(),
            onAutoplayBlocked: () => callbacks.current.onPaused(),
          },
        });
      })
      .catch(() => callbacks.current.onError());
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

export function PlayerProvider({
  items,
  initialSettings,
  userId,
  children,
  suspendSaving = false,
}: {
  items: ItemDto[];
  initialSettings: any;
  userId: string;
  children: (player: ReactNode) => ReactNode;
  suspendSaving?: boolean;
}) {
  const [settings, setSettings] = useState<PlaybackSettings>(() => {
    let cached;
    try {
      cached = JSON.parse(
        localStorage.getItem(`hibiki.player.${userId}`) || "null",
      );
    } catch {}
    return restorePlayback(
      initialSettings?.queue ? initialSettings : (cached ?? initialSettings),
      items,
    );
  });
  const [playing, setPlaying] = useState(false),
    [duration, setDuration] = useState(0),
    [sourceIndex, setSourceIndex] = useState(0),
    [error, setError] = useState(""),
    [nativeFullscreen, setNativeFullscreen] = useState(false),
    [viewportFullscreen, setViewportFullscreen] = useState(false),
    [controlsIdle, setControlsIdle] = useState(false),
    [failedArtwork, setFailedArtwork] = useState<string>(),
    [saveError, setSaveError] = useState("");
  const baseSettings = useRef(initialSettings),
    savingSuspended = useRef(suspendSaving);
  baseSettings.current = initialSettings;
  savingSuspended.current = suspendSaving;
  const controlsIdleTimer = useRef<ReturnType<typeof createFullscreenIdleTimer> | null>(null);
  const viewportRestore = useRef<{ x: number; y: number; focus: Element | null } | null>(null);
  const stage = useRef<HTMLDivElement>(null),
    watch = useRef<HTMLElement>(null),
    native = useRef<HTMLMediaElement | null>(null),
    youtube = useRef<any>(null),
    seekOnLoad = useRef(settings.position),
    live = useRef(settings),
    playingRef = useRef(playing),
    itemsRef = useRef(items),
    failed = useRef(new Set<string>());
  live.current = settings;
  playingRef.current = playing;
  itemsRef.current = items;
  const current = items.find(
    (i) => i.id === settings.queue[settings.queueIndex],
  );
  const sources = current ? playbackSources(current) : [],
    source = sources[sourceIndex];
  const isYoutube = source?.provider === "youtube";
  const presentationKind = current ? playbackKind(current, source) : undefined;
  const sourceIdentity = useRef<
    { itemId?: string; sourceId?: string } | undefined
  >(undefined);
  const identity = { itemId: current?.id, sourceId: source?.id };
  // Refreshing the library can add a preferred local source while this item is playing.
  // Capture the live position before the new keyed media element mounts.
  seekOnLoad.current = sourceLoadPosition(
    sourceIdentity.current,
    identity,
    settings.position,
    seekOnLoad.current,
  );
  sourceIdentity.current = identity;
  function patch(value: Partial<PlaybackSettings>) {
    setSettings((old) => ({ ...old, ...value }));
  }
  function switchTo(index: number, queue = live.current.queue) {
    const requested = index;
    index = firstPlayableIndex(queue, index, itemsRef.current);
    if (index < 0) {
      setPlaying(false);
      setError(
        "В очереди нет доступных источников. Записи остаются в медиатеке.",
      );
      return;
    }
    if (queue[index] === live.current.queue[live.current.queueIndex]) {
      if (native.current) native.current.currentTime = 0;
      youtube.current?.seekTo?.(0, true);
      native.current?.play().catch(() => setPlaying(false));
      youtube.current?.playVideo?.();
    }
    seekOnLoad.current = 0;
    setSourceIndex(0);
    setError(index === requested ? "" : "Недоступная запись пропущена.");
    setDuration(0);
    setSettings((old) => ({ ...old, queue, queueIndex: index, position: 0 }));
    setPlaying(true);
  }
  function start(list: ItemDto[], index = 0) {
    if (!list.length) return;
    requestAnimationFrame(() => watch.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    failed.current.clear();
    const queue = list.map((i) => i.id);
    const selected = queue[index];
    const ordered = live.current.shuffle
      ? [selected!, ...shuffleIds(queue.filter((id) => id !== selected))]
      : queue;
    const playable = firstPlayableIndex(
      ordered,
      live.current.shuffle ? 0 : index,
      list,
    );
    if (playable < 0) {
      setSettings((old) => ({
        ...old,
        queue: ordered,
        queueIndex: 0,
        position: 0,
        originalQueue: queue,
      }));
      setPlaying(false);
      setError(
        "В этой очереди нет доступных источников. Записи сохранены в медиатеке.",
      );
      return;
    }
    switchTo(playable, ordered);
    if (ordered[playable] !== selected)
      setError("Источник выбранной записи недоступен. Начинаем со следующей.");
    setSettings((old) => ({ ...old, originalQueue: queue }));
  }
  function next(direction: 1 | -1 = 1, ended = false) {
    if (ended && live.current.repeat === "one" && current) {
      seek(0);
      setPlaying(true);
      native.current?.play().catch(() => setPlaying(false));
      youtube.current?.playVideo?.();
      return;
    }
    const index = nextPlayableIndex(
      live.current.queue,
      live.current.queueIndex,
      itemsRef.current.filter((i) => !failed.current.has(i.id)),
      direction,
      live.current.repeat === "all",
    );
    if (index < 0) {
      setPlaying(false);
      if (ended) seek(0);
      return;
    }
    switchTo(index);
  }
  function sourceError() {
    if (sourceIndex + 1 < sources.length) {
      seekOnLoad.current = live.current.position;
      setSourceIndex((n) => n + 1);
      setError("Основной источник недоступен. Переключено на другой.");
      return;
    }
    if (current) failed.current.add(current.id);
    setError(
      `«${current?.title ?? "Запись"}» недоступна. Переходим к следующей.`,
    );
    const index = nextPlayableIndex(
      live.current.queue,
      live.current.queueIndex,
      itemsRef.current.filter((i) => !failed.current.has(i.id)),
      1,
      live.current.repeat === "all",
    );
    if (index >= 0) {
      seekOnLoad.current = 0;
      setSourceIndex(0);
      patch({ queueIndex: index, position: 0 });
    } else setPlaying(false);
  }
  function seek(position: number) {
    const bounded = Math.max(
      0,
      Math.min(duration || current?.duration || Infinity, position),
    );
    if (isYoutube) youtube.current?.seekTo?.(bounded, true);
    else if (native.current) native.current.currentTime = bounded;
    patch({ position: bounded });
    seekOnLoad.current = bounded;
  }
  function toggle() {
    if (!current) return;
    if (!source) {
      setPlaying(true);
      sourceError();
      return;
    }
    if (!playing) {
      setError("");
      if (isYoutube) youtube.current?.playVideo?.();
      else
        native.current?.play().catch(() => {
          setPlaying(false);
          setError("Нажмите на плеер, чтобы разрешить воспроизведение.");
        });
    } else {
      native.current?.pause();
      youtube.current?.pauseVideo?.();
    }
    setPlaying(!playing);
  }
  useEffect(() => {
    if (!live.current.queue.length || current) return;
    const index = nextPlayableIndex(
      live.current.queue,
      live.current.queueIndex,
      itemsRef.current,
      1,
      true,
    );
    seekOnLoad.current = 0;
    setSourceIndex(0);
    if (index >= 0) {
      patch({ queueIndex: index, position: 0 });
      setError("Текущая запись удалена. Выбрана следующая.");
    } else {
      setPlaying(false);
      setError("В очереди больше нет доступных записей.");
    }
  }, [current?.id, items.length]);
  const sourceKey = `${current?.id ?? ""}:${source?.id ?? ""}`;
  useEffect(() => {
    if (native.current) {
      native.current.volume = settings.volume;
      if (playing)
        native.current.play().catch(() => {
          setPlaying(false);
          setError("Нажмите «Воспроизвести», чтобы продолжить.");
        });
      else native.current.pause();
    }
  }, [playing, sourceKey]);
  useEffect(() => {
    if (native.current) native.current.volume = settings.volume;
  }, [settings.volume]);
  useEffect(() => {
    const restored = restorePlayback(initialSettings, itemsRef.current);
    setSettings(restored);
    seekOnLoad.current = restored.position;
    setPlaying(false);
    if (native.current?.readyState)
      native.current.currentTime = restored.position;
    youtube.current?.seekTo?.(restored.position, true);
  }, [initialSettings]);

  useEffect(() => {
    localStorage.setItem(`hibiki.player.${userId}`, JSON.stringify(settings));
  }, [settings, userId]);
  useEffect(() => {
    const save = () => {
      if (savingSuspended.current) return;
      fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...baseSettings.current, ...live.current }),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, [userId]);
  useEffect(() => {
    let last = "";
    const save = () => {
      if (savingSuspended.current) return;
      const serialized = JSON.stringify(live.current);
      if (serialized === last) return;
      last = serialized;
      api("/settings", "PUT", { ...baseSettings.current, ...live.current })
        .then(() => setSaveError(""))
        .catch(() => {
          last = "";
          setSaveError(
            "Не удалось сохранить настройки. Локальная копия сохранена.",
          );
        });
    };
    const timer = setInterval(save, 5000);
    return () => {
      clearInterval(timer);
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
    mediaSession.setActionHandler("play", () => {
      setPlaying(true);
      native.current?.play();
      youtube.current?.playVideo?.();
    });
    mediaSession.setActionHandler("pause", () => setPlaying(false));
    mediaSession.setActionHandler("nexttrack", () => next());
    mediaSession.setActionHandler("previoustrack", () => next(-1));
    return () => {
      ["play", "pause", "nexttrack", "previoustrack"].forEach((a) =>
        mediaSession.setActionHandler(a as MediaSessionAction, null),
      );
    };
  }, [current?.id]);
  function shuffleToggle() {
    if (!settings.queue.length) {
      patch({ shuffle: !settings.shuffle });
      return;
    }
    const id = current?.id;
    const queue = settings.shuffle
      ? (settings.originalQueue ?? settings.queue)
      : [id!, ...shuffleIds(settings.queue.filter((q) => q !== id))];
    patch({
      shuffle: !settings.shuffle,
      originalQueue: settings.shuffle ? settings.originalQueue : settings.queue,
      queue,
      queueIndex: Math.max(0, queue.indexOf(id!)),
    });
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
    if (!current) {
      setViewportFullscreen(false);
      setNativeFullscreen(false);
    }
  }, [current?.id]);
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
      event.preventDefault();
      if (action === "toggle") toggle();
      if (action === "fullscreen") void toggleFullscreen();
      if (action === "mute") patch({ volume: settings.volume ? 0 : 0.8 });
      if (action === "backward") seek(live.current.position - 10);
      if (action === "forward") seek(live.current.position + 10);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [current?.id, playing, duration, settings.volume, sourceKey, viewportFullscreen]);
  const total = duration || current?.duration || 0;
  const artwork = playbackArtwork(current, source);
  const showArtwork = artwork && failedArtwork !== artwork;
  const sourceLabel = isYoutube ? "YouTube" : source ? "Локальный файл" : "Источник недоступен";
  const player = (
    <section ref={watch} className={`watch-player ${current ? "" : "is-empty"}`} aria-label="Плеер">
      {!current ? (
        <div className="watch-welcome">
          <span className="watch-welcome-icon"><AudioLines size={25} /></span>
          <div>
            <strong>Ваше место в первом ряду</strong>
            <p>Включите запись или плейлист — видео и музыка зазвучат здесь.</p>
          </div>
          <span className="watch-welcome-mark" aria-hidden="true">響</span>
        </div>
      ) : (
        <>
          <header className="watch-heading">
            <span className="eyebrow"><span className={`watch-status-dot ${playing ? "playing" : ""}`} />{playing ? "СЕЙЧАС ИГРАЕТ" : "ГОТОВО К ПРОСМОТРУ"}</span>
            <a href="#browse-content" className="watch-browse-link">Медиатека и плейлисты <ChevronDown size={14} /></a>
          </header>
          <div className="watch-layout">
            <div className="watch-main">
              <div
                ref={stage}
                className={`watch-stage ${viewportFullscreen ? "is-viewport-fullscreen" : ""} ${fullscreen && controlsIdle ? "is-controls-idle" : ""}`}
                aria-label="Сцена воспроизведения"
                tabIndex={-1}
                onPointerMove={showFullscreenControls}
                onPointerDownCapture={showFullscreenControls}
                onTouchStart={showFullscreenControls}
                onFocusCapture={showFullscreenControls}
                onKeyDownCapture={showFullscreenControls}
              >
                <div className="watch-media">
                  {source && isYoutube ? (
                    <Youtube
                      key={sourceKey}
                      id={source.externalId || new URL(source.url!).searchParams.get("v") || source.url!.split("/").pop()!}
                      playing={playing}
                      volume={settings.volume}
                      position={seekOnLoad.current}
                      engine={youtube}
                      onTime={(position, d) => { patch({ position }); setDuration(d); }}
                      onEnded={() => next(1, true)}
                      onError={sourceError}
                      onPaused={() => { showFullscreenControls(); setPlaying(false); }}
                      onPlaying={() => { showFullscreenControls(); setPlaying(true); }}
                    />
                  ) : source && presentationKind === "video" ? (
                    <video
                      key={sourceKey}
                      ref={(element) => { native.current = element; }}
                      src={source.streamUrl!}
                      playsInline
                      onLoadedMetadata={(event) => {
                        event.currentTarget.currentTime = seekOnLoad.current;
                        event.currentTarget.volume = live.current.volume;
                        setDuration(event.currentTarget.duration);
                        if (playingRef.current) event.currentTarget.play().catch(() => setPlaying(false));
                      }}
                      onTimeUpdate={(event) => patch({ position: event.currentTarget.currentTime })}
                      onEnded={() => next(1, true)}
                      onError={sourceError}
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
                      <span className="audio-scene-label"><Music2 size={12} /> {source ? "ТОЛЬКО ЗВУК · ПОЛНОЕ ПОГРУЖЕНИЕ" : "ИСТОЧНИК НЕДОСТУПЕН"}</span>
                      {source && (
                        <audio
                          key={sourceKey}
                          ref={(element) => { native.current = element; }}
                          src={source.streamUrl!}
                          onLoadedMetadata={(event) => {
                            event.currentTarget.currentTime = seekOnLoad.current;
                            event.currentTarget.volume = live.current.volume;
                            setDuration(event.currentTarget.duration);
                            if (playingRef.current) event.currentTarget.play().catch(() => setPlaying(false));
                          }}
                          onTimeUpdate={(event) => patch({ position: event.currentTarget.currentTime })}
                          onEnded={() => next(1, true)}
                          onError={sourceError}
                        />
                      )}
                    </div>
                  )}
                </div>
                <div className="watch-fullscreen-reveal" aria-hidden="true" />
                <div className="watch-controls">
                  <div className="watch-fullscreen-title">{current.title}</div>
                  <div className="seek-row">
                    <span>{formatDuration(settings.position)}</span>
                    <input
                      aria-label="Позиция воспроизведения"
                      aria-valuetext={`${formatDuration(settings.position)} из ${formatDuration(total)}`}
                      type="range" min="0" max={total || 1} step="0.1"
                      value={Math.min(settings.position, total || 1)}
                      onChange={(event) => seek(Number(event.target.value))}
                      style={{ "--progress": `${total ? (settings.position / total) * 100 : 0}%` } as any}
                      disabled={!total}
                    />
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
                    <div className="watch-notice" role="status"><CircleAlert size={16} /><span>{error || saveError}</span><button className="icon-button" aria-label="Скрыть уведомление" onClick={() => { setError(""); setSaveError(""); }}><X size={15} /></button></div>
                  )}
                </div>
              </div>
              <div className="watch-metadata">
                <span className="watch-kind-icon">{presentationKind === "video" ? <Video size={20} /> : <Music2 size={20} />}</span>
                <div><h2>{current.title}</h2><p>{presentationKind === "video" ? "Видео" : "Аудио"}<span>·</span>{sourceLabel}{current.tags.slice(0, 2).map((tag) => <span className="watch-tag" key={tag.id}>{tag.name}</span>)}</p></div>
              </div>
              <p className="watch-shortcuts"><kbd>Пробел</kbd> пауза <span>·</span> <kbd>←</kbd> <kbd>→</kbd> 10 секунд <span>·</span> <kbd>F</kbd> полный экран</p>
            </div>
            <aside className="watch-queue" aria-label="Очередь воспроизведения">
              <div className="watch-queue-heading"><div><ListMusic size={18} /><h2>Далее в очереди</h2></div><span>{settings.queueIndex + 1} / {settings.queue.length}</span></div>
              <p className="watch-queue-description">Ваша подборка, один непрерывный поток.</p>
              <div className="watch-queue-list">
                {settings.queue.map((id, index) => {
                  const item = items.find((i) => i.id === id);
                  const thumbnail = playbackArtwork(item);
                  const active = index === settings.queueIndex;
                  return (
                    <button key={`${id}-${index}`} className={`watch-queue-row ${active ? "active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => switchTo(index)}>
                      <span className="watch-queue-number">{active && playing ? <span className="equalizer" aria-hidden="true"><i /><i /><i /></span> : index + 1}</span>
                      <span className={`watch-queue-art art-${(item?.title.length ?? 0) % 6}`}>
                        {item?.kind === "video" ? <Video size={18} /> : <Music2 size={18} />}
                        {thumbnail && <img src={thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
                        <span className="watch-queue-duration">{formatDuration(item?.duration)}</span>
                      </span>
                      <span className="watch-queue-info"><strong>{item?.title ?? "Запись удалена"}</strong><small>{item ? playbackSources(item).length ? `${item.kind === "video" ? "Видео" : "Аудио"}${active ? " · Сейчас играет" : ""}` : "Источник недоступен" : "Нет в медиатеке"}</small></span>
                    </button>
                  );
                })}
              </div>
              <div className="watch-queue-footer"><span>Очередь сохранена при запуске</span><button className="text-button" onClick={() => { setPlaying(false); patch({ queue: [], queueIndex: 0, position: 0, originalQueue: [] }); }}>Очистить</button></div>
            </aside>
          </div>
        </>
      )}
      {!current && (error || saveError) && <p className="watch-empty-notice" role="status"><CircleAlert size={15} />{error || saveError}</p>}
    </section>
  );
  return (
    <PlayerContext.Provider value={{ current, playing, settings, start, enqueue: (item) => setSettings((old) => ({ ...old, queue: [...old.queue, item.id], originalQueue: [...(old.originalQueue ?? old.queue), item.id] })), toggle }}>
      {children(player)}
    </PlayerContext.Provider>
  );
}
