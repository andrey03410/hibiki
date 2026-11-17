import {
  createContext,
  useContext,
  useEffect,
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
}) {
  const target = useRef<HTMLDivElement>(null),
    callbacks = useRef({ onTime, onEnded, onError, onPaused });
  callbacks.current = { onTime, onEnded, onError, onPaused };
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
  children: ReactNode;
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
    [queueOpen, setQueueOpen] = useState(false),
    [saveError, setSaveError] = useState("");
  const baseSettings = useRef(initialSettings),
    savingSuspended = useRef(suspendSaving);
  baseSettings.current = initialSettings;
  savingSuspended.current = suspendSaving;
  const native = useRef<HTMLMediaElement | null>(null),
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
  const total = duration || current?.duration || 0;
  return (
    <PlayerContext.Provider
      value={{
        current,
        playing,
        settings,
        start,
        enqueue: (item) =>
          setSettings((old) => ({
            ...old,
            queue: [...old.queue, item.id],
            originalQueue: [...(old.originalQueue ?? old.queue), item.id],
          })),
        toggle,
      }}
    >
      {children}
      {queueOpen && (
        <aside
          className={`queue-panel ${current && source && (isYoutube || current.kind === "video") ? "with-media" : ""}`}
        >
          <div className="panel-heading">
            <div>
              <span className="eyebrow">СЕЙЧАС ИГРАЕТ</span>
              <h2>
                Очередь <span>{settings.queue.length}</span>
              </h2>
            </div>
            <button
              className="icon-button"
              aria-label="Закрыть очередь"
              onClick={() => setQueueOpen(false)}
            >
              <X size={19} />
            </button>
          </div>
          <p className="muted small">
            Состав сохранён на момент запуска. Изменения плейлистов не прерывают
            прослушивание.
          </p>
          <div className="queue-list">
            {settings.queue.map((id, index) => {
              const item = items.find((i) => i.id === id);
              return (
                <button
                  key={`${id}-${index}`}
                  className={`queue-row ${index === settings.queueIndex ? "active" : ""}`}
                  onClick={() => switchTo(index)}
                >
                  <span className="queue-number">
                    {index === settings.queueIndex && playing ? (
                      <span className="equalizer">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="truncate">
                    {item?.title ?? "Запись удалена"}
                    <small>{item?.kind === "video" ? "Видео" : "Аудио"}</small>
                  </span>
                  <span>{formatDuration(item?.duration)}</span>
                </button>
              );
            })}
          </div>
          <button
            className="button subtle full"
            onClick={() => {
              setPlaying(false);
              patch({
                queue: [],
                queueIndex: 0,
                position: 0,
                originalQueue: [],
              });
            }}
          >
            Очистить очередь
          </button>
        </aside>
      )}
      {current && source && (isYoutube || current.kind === "video") && (
        <aside className="media-view">
          <div className="media-caption">
            <span>{isYoutube ? "YouTube" : "Локальное видео"}</span>
            <button
              className="icon-button"
              aria-label="Развернуть видео"
              onClick={() => {
                const element = document.querySelector(
                  ".media-view video, .media-view iframe",
                );
                element?.requestFullscreen?.();
              }}
            >
              <Maximize2 size={14} />
            </button>
          </div>
          {isYoutube ? (
            <Youtube
              key={sourceKey}
              id={
                source.externalId ||
                new URL(source.url!).searchParams.get("v") ||
                source.url!.split("/").pop()!
              }
              playing={playing}
              volume={settings.volume}
              position={seekOnLoad.current}
              engine={youtube}
              onTime={(position, d) => {
                patch({ position });
                setDuration(d);
              }}
              onEnded={() => next(1, true)}
              onError={sourceError}
              onPaused={() => setPlaying(false)}
            />
          ) : (
            <video
              key={sourceKey}
              ref={(element) => {
                native.current = element;
              }}
              src={source.streamUrl!}
              playsInline
              onLoadedMetadata={(event) => {
                event.currentTarget.currentTime = seekOnLoad.current;
                event.currentTarget.volume = live.current.volume;
                setDuration(event.currentTarget.duration);
                if (playingRef.current)
                  event.currentTarget.play().catch(() => setPlaying(false));
              }}
              onTimeUpdate={(event) =>
                patch({ position: event.currentTarget.currentTime })
              }
              onEnded={() => next(1, true)}
              onError={sourceError}
              onClick={toggle}
            />
          )}
        </aside>
      )}
      {current && source && !isYoutube && current.kind === "audio" && (
        <audio
          key={sourceKey}
          ref={(element) => {
            native.current = element;
          }}
          src={source.streamUrl!}
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = seekOnLoad.current;
            event.currentTarget.volume = live.current.volume;
            setDuration(event.currentTarget.duration);
            if (playingRef.current)
              event.currentTarget.play().catch(() => setPlaying(false));
          }}
          onTimeUpdate={(event) =>
            patch({ position: event.currentTarget.currentTime })
          }
          onEnded={() => next(1, true)}
          onError={sourceError}
        />
      )}
      {(error || saveError) && (
        <div className="player-notice" role="status">
          <CircleAlert size={15} />
          {error || saveError}
          <button
            aria-label="Скрыть уведомление"
            onClick={() => {
              setError("");
              setSaveError("");
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <footer className="player-bar">
        <div className="now-playing">
          <div className={`mini-art art-${(current?.title.length ?? 0) % 6}`}>
            {current?.sources.find((s) => s.thumbnail)?.thumbnail ? (
              <img
                src={current.sources.find((s) => s.thumbnail)!.thumbnail!}
                alt=""
              />
            ) : (
              <Music2 size={23} />
            )}
          </div>
          <div className="truncate">
            <strong>{current?.title ?? "Всё начинается со звука"}</strong>
            <span>
              {current
                ? `${current.kind === "video" ? "Видео" : "Аудио"} · ${isYoutube ? "YouTube" : source ? "На этом устройстве" : "Источник недоступен"}`
                : "Выберите запись в медиатеке"}
            </span>
          </div>
        </div>
        <div className="playback-controls">
          <div className="playback-buttons">
            <button
              className={`icon-button ${settings.shuffle ? "selected" : ""}`}
              aria-label="Перемешать"
              aria-pressed={settings.shuffle}
              onClick={shuffleToggle}
            >
              <Shuffle size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="Предыдущая запись"
              disabled={!current}
              onClick={() => (live.current.position > 3 ? seek(0) : next(-1))}
            >
              <SkipBack size={18} fill="currentColor" />
            </button>
            <button
              className="main-play"
              aria-label={playing ? "Приостановить" : "Воспроизвести"}
              disabled={!current}
              onClick={toggle}
            >
              {playing ? (
                <Pause size={20} fill="currentColor" />
              ) : (
                <Play size={20} fill="currentColor" />
              )}
            </button>
            <button
              className="icon-button"
              aria-label="Следующая запись"
              disabled={!current}
              onClick={() => next()}
            >
              <SkipForward size={18} fill="currentColor" />
            </button>
            <button
              className={`icon-button ${settings.repeat !== "off" ? "selected" : ""}`}
              aria-label={`Повтор: ${settings.repeat === "off" ? "выключен" : settings.repeat === "all" ? "вся очередь" : "одна запись"}`}
              onClick={() =>
                patch({
                  repeat:
                    settings.repeat === "off"
                      ? "all"
                      : settings.repeat === "all"
                        ? "one"
                        : "off",
                })
              }
            >
              {settings.repeat === "one" ? (
                <Repeat1 size={17} />
              ) : (
                <Repeat size={17} />
              )}
            </button>
          </div>
          <div className="seek-row">
            <span>{formatDuration(settings.position)}</span>
            <input
              aria-label="Позиция воспроизведения"
              type="range"
              min="0"
              max={total || 1}
              step="0.1"
              value={Math.min(settings.position, total || 1)}
              onChange={(event) => seek(Number(event.target.value))}
              style={
                {
                  "--progress": `${total ? (settings.position / total) * 100 : 0}%`,
                } as any
              }
              disabled={!current || !total}
            />
            <span>{formatDuration(total)}</span>
          </div>
        </div>
        <div className="player-tools">
          <button
            className={`icon-button ${queueOpen ? "selected" : ""}`}
            aria-label="Показать очередь"
            aria-expanded={queueOpen}
            onClick={() => setQueueOpen(!queueOpen)}
          >
            <ListMusic size={20} />
          </button>
          <span className="tool-divider" />
          <button
            className="icon-button"
            aria-label={settings.volume ? "Выключить звук" : "Включить звук"}
            onClick={() => patch({ volume: settings.volume ? 0 : 0.8 })}
          >
            {settings.volume ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
          <input
            aria-label="Громкость"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={settings.volume}
            onChange={(e) => patch({ volume: Number(e.target.value) })}
            style={{ "--progress": `${settings.volume * 100}%` } as any}
          />
        </div>
      </footer>
    </PlayerContext.Provider>
  );
}
