import type { ItemDto, PlaybackMode, PlaylistDefinition } from "@hibiki/contracts";
import { moveQueueItem, normalizeQueue, shuffleUpcoming, type QueueOrder } from "@hibiki/core";

export interface PlayableItem {
  id: string;
  kind: "audio" | "video";
  preferredSourceId?: string;
  visual?: { soundSourceId: string };
  sources: PlaybackSource[];
}
export interface PlaybackSource {
  id: string;
  provider: "local" | "youtube";
  status: string;
  streamUrl?: string | null;
  externalId?: string | null;
  url?: string | null;
  mime?: string | null;
  hasAudio?: boolean;
  audioStreamUrl?: string;
  audioBytes?: number;
  audioMime?: string;
  audioViewStart?: number;
}
export interface PlaybackSettings extends QueueOrder {
  position: number;
  volume: number;
  lastNonzeroVolume?: number;
  repeat: "off" | "all" | "one";
  shuffle: boolean;
  mode: PlaybackMode;
  queuePlaylistIds?: Record<string, string>;
  originalQueue?: string[];
}

export type PlaybackTrigger = "manual" | "advance" | "repeat";
export type PlaybackFinish = "ended" | "manual" | "error" | "interrupted";
export type PlaybackReading = [position: number, duration?: number, playbackRate?: number];

type NativeResource = Pick<HTMLMediaElement, "currentSrc" | "currentTime" | "readyState" | "seeking">;

export class NativePlaybackPosition {
  private loadedSources = new WeakMap<NativeResource, string>();
  loaded(element: NativeResource) {
    if (element.readyState >= 1 && element.currentSrc && !element.seeking)
      this.loadedSources.set(element, element.currentSrc);
  }
  read(element: NativeResource | null) {
    if (element && element.readyState >= 1 && this.loadedSources.get(element) === element.currentSrc)
      return element.currentTime;
  }
  handoff(element: NativeResource | null, requestedPosition: number) {
    const position = this.read(element) ?? requestedPosition;
    if (element) this.loadedSources.delete(element);
    return position;
  }
}

export function nativePlaybackReading(
  media: Pick<HTMLMediaElement, "currentTime" | "duration" | "playbackRate">,
  position = media.currentTime,
): PlaybackReading {
  return [position, media.duration, media.playbackRate];
}

export function nativeRestartHasProgress(
  media: Pick<HTMLMediaElement, "paused" | "ended" | "seeking" | "currentTime">,
  seekPosition: number,
): boolean {
  return !media.paused && !media.ended && !media.seeking && media.currentTime > seekPosition;
}

type YoutubePosition = { videoId: string; startSeconds: number };

export function createYoutubeRestartConfirmation(positionBeforeSeek: number, target: number) {
  let previous = positionBeforeSeek;
  let verified = previous === target ? target : undefined;
  return (position: number, playbackRate = 1) => {
    // The first 500 ms poll can land just after the target.
    const maxSampleTravel = 0.75 * Math.max(1, playbackRate);
    if (verified !== undefined && position > verified && position - verified <= maxSampleTravel)
      return true;
    if (position === target || (previous - position >= 0.1 && position > target && position - target <= maxSampleTravel))
      verified = position;
    else if (position !== verified)
      verified = undefined;
    previous = position;
    return false;
  };
}

export function prepareYoutubePlayback(
  player: {
    cueVideoById(input: YoutubePosition): void;
    loadVideoById(input: YoutubePosition): void;
    playVideo(): void;
  },
  videoId: string,
  startSeconds: number,
  playing: boolean,
) {
  if (!playing) player.cueVideoById({ videoId, startSeconds });
  else if (startSeconds > 0) player.loadVideoById({ videoId, startSeconds });
  else player.playVideo();
}

export function syncYoutubePicture(
  player: {
    getPlayerState(): number; getCurrentTime(): number; getDuration(): number;
    isMuted(): boolean; mute(): void; seekTo(position: number, allowSeekAhead: boolean): void;
    playVideo(): void; pauseVideo(): void;
  },
  audio: Pick<HTMLMediaElement, "currentTime" | "paused" | "seeking">,
  running: boolean,
) {
  const state = player.getPlayerState();
  const duration = player.getDuration();
  const target = duration > 0 ? Math.min(audio.currentTime, duration) : audio.currentTime;
  if (!player.isMuted()) player.mute();
  if (Math.abs(target - player.getCurrentTime()) > 0.5) player.seekTo(target, true);
  if (running && !audio.paused && !audio.seeking && (!duration || audio.currentTime < duration)) {
    if (state !== 1 && state !== 3) player.playVideo();
  } else if (state === 1 || state === 3) player.pauseVideo();
}

export function youtubePlaybackReading(
  player: {
    getCurrentTime?(): number;
    getDuration?(): number;
    getPlaybackRate?(): number;
  },
  position = player.getCurrentTime?.() ?? 0,
): PlaybackReading {
  return [position, player.getDuration?.(), player.getPlaybackRate?.()];
}

interface ListeningAttempt {
  select(item: ItemDto | null, playlistId?: string, trigger?: PlaybackTrigger): void;
  playing(...reading: PlaybackReading): void;
  progress(...reading: PlaybackReading): void;
  paused(): void;
  seek(position: number): void;
  finish(reason: PlaybackFinish): void;
}

export function createPlaybackAttempt(history: ListeningAttempt) {
  let selected: { item: ItemDto; playlistId?: string; trigger?: PlaybackTrigger } | undefined;
  let started = false;
  let running = false;
  const attempt: ListeningAttempt = {
    select(item, playlistId, trigger) {
      selected = item ? { item, playlistId, trigger } : undefined;
      started = running = false;
      history.select(item, playlistId, trigger);
    },
    playing(...reading) {
      if (!selected || running) return;
      started = running = true;
      history.playing(...reading);
    },
    progress(...reading) {
      if (running) history.progress(...reading);
    },
    paused() {
      if (!running) return;
      running = false;
      history.paused();
    },
    seek(position) {
      if (selected) history.seek(position);
    },
    finish(reason) {
      if (started) history.finish(reason);
      selected = undefined;
      started = running = false;
    },
  };
  return {
    ...attempt,
    updatePlaylistId(itemId: string, playlistId?: string) {
      if (selected?.item.id === itemId && !started && selected.playlistId !== playlistId)
        attempt.select(selected.item, playlistId, selected.trigger);
    },
  };
}
export function playbackSources<T extends PlaybackSource>(item: {
  kind: "audio" | "video";
  preferredSourceId?: string;
  visual?: { soundSourceId: string };
  sources: T[];
}, mode: PlaybackMode = "original"): T[] {
  const assigned = item.visual?.soundSourceId;
  const originals = assigned ? item.sources.filter(source => source.id === assigned) : item.sources;
  if (assigned) mode = "audio";
  const matchesKind = (source: T) => mode === "audio"
    ? playbackKind(item, source) === "audio"
    : item.kind !== "video" || playbackKind(item, source) === item.kind;
  const soundCapable = (source: T) => source.provider === "local" &&
    (source.hasAudio ?? (playbackKind(item, source) === "audio"));
  const sources = mode === "audio" ? originals.flatMap(source => {
    if (source.provider !== "local" || !source.audioStreamUrl || !source.audioBytes || !source.audioMime) return [source];
    const derived = { ...source, id: source.id + ":audio", streamUrl: source.audioStreamUrl,
      bytes: source.audioBytes, mime: source.audioMime, hasAudio: true,
      playbackHints: { audioStart: source.audioViewStart ?? 0 } };
    return [derived, source];
  }) : [...originals];
  const preferred = (source: T) => source.id === item.preferredSourceId ||
    (!!item.preferredSourceId && source.id === item.preferredSourceId + ":audio");
  return sources
    .filter(
      (s) =>
        s.status !== "unavailable" &&
        (mode !== "audio" || soundCapable(s)) &&
        (s.provider === "local" ? !!s.streamUrl : !!s.externalId || !!s.url),
    )
    .sort(
      (a, b) =>
        (mode === "audio" ? Number(preferred(b)) - Number(preferred(a)) : 0) ||
        Number(matchesKind(b)) - Number(matchesKind(a)) ||
        Number(preferred(b)) - Number(preferred(a)) ||
        Number(b.provider === "local") - Number(a.provider === "local"),
    );
}

export function playableVideoSource<T extends PlaybackSource>(
  item: Omit<PlayableItem, "sources"> & { sources: T[] }, failed?: ReadonlySet<string>, failedPictures?: ReadonlySet<string>,
) {
  return playbackSources(item).find(source => playbackKind(item, source) === "video" && !failed?.has(source.id) && !failedPictures?.has(source.id));
}

export function canStartSelectedItem(item: PlayableItem, mode: PlaybackMode, keepSelectedVideo = false): boolean {
  return playbackSources(item, mode).length > 0 || (keepSelectedVideo && !!playableVideoSource(item));
}

export function soundUnavailableReason(item: PlayableItem): string | undefined {
  if (playbackSources(item, "audio").length) return;
  const sources = playbackSources(item);
  if (sources.some((source) => source.provider === "local" && source.hasAudio === false))
    return "В видео нет звуковой дорожки";
  if (sources.some((source) => source.provider === "local" && source.hasAudio === undefined))
    return "Звуковая дорожка ещё не проверена";
  if (sources.some((source) => source.provider === "youtube"))
    return "Для прослушивания нужна локальная копия";
  return "Источник звука недоступен";
}

export function queueEntryUnavailableReason(item: PlayableItem | undefined, mode: PlaybackMode): string | undefined {
  if (!item) return "Нет в медиатеке";
  if (mode === "audio") return soundUnavailableReason(item);
  if (!playbackSources(item).length) return "Источник недоступен";
}

export function playbackSourceForAttempt<T extends PlaybackSource>(
  item: { kind: "audio" | "video"; preferredSourceId?: string; visual?: { soundSourceId: string }; sources: T[] },
  failed: ReadonlySet<string>,
  active?: { sourceId: string; preferredSourceId?: string },
  mode: PlaybackMode = "original",
): T | undefined {
  const sources = playbackSources(item, mode).filter((source) => !failed.has(source.id));
  if (active && active.preferredSourceId !== item.preferredSourceId) {
    const retained = sources.find((source) => source.id === active.sourceId);
    if (retained) return retained;
  }
  return sources[0];
}

// A recording with local sound has one leading native clock in both views.
// A video-only source can lead while the watch scene is mounted.
export function playbackTransport<T extends PlaybackSource>(
  item: Omit<PlayableItem, "sources"> & { sources: T[] },
  failed: ReadonlySet<string>,
  active?: { sourceId: string; preferredSourceId?: string },
  failedPictures?: ReadonlySet<string>,
) {
  const sound = playbackSourceForAttempt(item, failed, active, "audio");
  const video = playableVideoSource(item, failed, sound ? failedPictures : undefined);
  return { source: sound ?? video, kind: sound ? "audio" as const : "video" as const, video };
}

export function itemActivation(
  { queue, queueIndex, mode }: Pick<PlaybackSettings, "queue" | "queueIndex" | "mode">,
  itemId: string,
  requestedMode = mode,
  playlistId?: string,
  activePlaylistId?: string,
): "start" | "toggle" | "changeMode" | "rebind" {
  if (queue[queueIndex] !== itemId) return "start";
  if (playlistId && activePlaylistId !== playlistId) return "rebind";
  return requestedMode === mode ? "toggle" : "changeMode";
}

export function startPlaybackQueue(
  items: { id: string }[],
  index: number,
  shuffled: boolean,
  playlistId?: string,
): QueueOrder & Pick<PlaybackSettings, "position" | "queuePlaylistIds"> {
  let order = normalizeQueue(items.map((item) => item.id), index);
  if (shuffled && order.queue.length) {
    const selected = order.queue[order.queueIndex]!;
    order = shuffleUpcoming({
      queue: [selected, ...order.queue.filter((id) => id !== selected)],
      queueIndex: 0,
    });
  }
  return {
    ...order,
    position: 0,
    queuePlaylistIds: playlistId
      ? Object.fromEntries(order.queue.map((id) => [id, playlistId]))
      : {},
  };
}

export function addToPlaybackQueue(
  state: PlaybackSettings,
  id: string,
  placement: "next" | "last",
  playlistId?: string,
): PlaybackSettings {
  if (state.queue[state.queueIndex] === id) return state;
  const order = moveQueueItem(state, id, placement);
  const queuePlaylistIds = { ...state.queuePlaylistIds };
  if (playlistId) queuePlaylistIds[id] = playlistId;
  else delete queuePlaylistIds[id];
  return { ...state, queue: order.queue, queueIndex: order.queueIndex, queuePlaylistIds };
}

export function togglePlaybackShuffle(state: PlaybackSettings): PlaybackSettings {
  const order = state.shuffle ? state : shuffleUpcoming(state);
  return { ...state, ...order, shuffle: !state.shuffle };
}

export function queuePlaylistInput(
  title: string,
  ids: string[],
): { title: string; definition: PlaylistDefinition } {
  return {
    title: title.trim(),
    definition: { version: 1, rule: { type: "items", ids: [...ids] }, sort: "source" },
  };
}

export function playbackVolume(value: number, previous = 0.8) {
  const bounded = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
  // Keep fractional legacy preferences, but snap arithmetic noise from repeated 5% steps.
  const percentage = Math.round(bounded * 100) / 100;
  const volume = Math.abs(bounded - percentage) < Number.EPSILON ? percentage : bounded;
  return {volume, lastNonzeroVolume: volume || (previous > 0 && previous <= 1 ? previous : 0.8)};
}

export function restorePlayback(
  settings: Partial<PlaybackSettings>,
  items?: PlayableItem[],
): PlaybackSettings {
  const oldQueue = Array.isArray(settings.queue)
    ? settings.queue
    : [];
  const currentId = oldQueue[settings.queueIndex ?? 0];
  const valid = items && new Set(items.map(i => i.id));
  const retainedId = (id: unknown): id is string => typeof id === "string" && (!valid || valid.has(id));
  const queue = [...new Set(oldQueue.filter(retainedId))];
  const inQueue = new Set(queue);
  const retained = queue.indexOf(currentId ?? "");
  return {
    queue,
    queueIndex: Math.max(0, retained),
    position: retained >= 0 && Number.isFinite(settings.position) ? Math.max(0, settings.position!) : 0,
    ...playbackVolume(settings.volume ?? 0.8, settings.lastNonzeroVolume),
    repeat:
      settings.repeat === "all" || settings.repeat === "one"
        ? settings.repeat
        : "off",
    shuffle: !!settings.shuffle,
    mode: settings.mode === "audio" ? "audio" : "original",
    originalQueue: Array.isArray(settings.originalQueue)
      ? settings.originalQueue.filter(retainedId)
      : undefined,
    queuePlaylistIds: Object.fromEntries(
      Object.entries(settings.queuePlaylistIds ?? {}).filter(
        ([id, playlistId]) => inQueue.has(id) && typeof playlistId === "string" && !!playlistId,
      ),
    ),
  };
}

export function playbackSettingsSignature(settings: PlaybackSettings): string {
  const { queue, queueIndex, position, volume, repeat, shuffle, mode, queuePlaylistIds } = settings;
  const signature: unknown[] = [
    queue, queueIndex, position, volume, repeat, shuffle,
    Object.entries(queuePlaylistIds ?? {}).sort(),
  ];
  // Preserve the default signature used by older cached player state.
  if (mode === "audio") signature.push(mode);
  if (!volume && settings.lastNonzeroVolume && settings.lastNonzeroVolume !== 0.8)
    signature.push(settings.lastNonzeroVolume);
  return JSON.stringify(signature);
}

export function reconcileQueuePlaylistIds(
  current: PlaybackSettings["queuePlaylistIds"],
  submitted: PlaybackSettings["queuePlaylistIds"],
  saved: PlaybackSettings["queuePlaylistIds"],
): PlaybackSettings["queuePlaylistIds"] {
  if (!current || !submitted || !saved) return current;
  const retained = Object.entries(current).filter(([itemId, playlistId]) =>
    submitted[itemId] !== playlistId || saved[itemId] === playlistId,
  );
  return retained.length === Object.keys(current).length ? current : Object.fromEntries(retained);
}

export function restoreCachedPlayback(
  initial: Partial<PlaybackSettings> | undefined,
  cached: (Partial<PlaybackSettings> & { serverSignature?: string }) | null,
  items?: PlayableItem[],
): PlaybackSettings {
  // When the server still has the last known settings, keep edits made after that save.
  const server = restorePlayback(initial ?? {}, items);
  return cached && (!Array.isArray(initial?.queue) ||
    cached.serverSignature === playbackSettingsSignature(server))
    ? restorePlayback(cached, items)
    : server;
}
export function nextPlayableIndex(
  queue: string[],
  current: number,
  items: PlayableItem[],
  direction: number,
  wrap: boolean,
  mode: PlaybackMode = "original",
): number {
  const valid = new Set(
    items.filter((i) => playbackSources(i, mode).length > 0).map((i) => i.id),
  );
  for (let n = 1; n <= queue.length; n++) {
    let index = current + n * direction;
    if (!wrap && (index < 0 || index >= queue.length)) return -1;
    index = ((index % queue.length) + queue.length) % queue.length;
    if (valid.has(queue[index]!)) return index;
  }
  return -1;
}

export function firstPlayableIndex(
  queue: string[],
  selected: number,
  items: PlayableItem[],
  mode: PlaybackMode = "original",
  wrap = true,
): number {
  const item = items.find((i) => i.id === queue[selected]);
  return item && playbackSources(item, mode).length
    ? selected
    : nextPlayableIndex(queue, selected, items, 1, wrap, mode);
}

export function recoverDeletedQueueEntry(
  state: PlaybackSettings,
  items: PlayableItem[],
  failed: ReadonlySet<string> = new Set(),
): PlaybackSettings {
  const restored = restorePlayback(state, items);
  if (!restored.queue.length) return restored;
  const playable = items.filter((item) => !failed.has(item.id));
  const next = nextPlayableIndex(state.queue, state.queueIndex, playable, 1, false, state.mode);
  const neighbor = next >= 0
    ? next
    : nextPlayableIndex(state.queue, state.queueIndex, playable, -1, false, state.mode);
  const queueIndex = neighbor >= 0
    ? restored.queue.indexOf(state.queue[neighbor]!)
    : Math.min(restored.queue.length - 1, state.queueIndex);
  return { ...restored, queueIndex };
}

interface SourceIdentity {
  itemId?: string;
  sourceId?: string;
}
export function sourceLoadPosition(
  previous: SourceIdentity | undefined,
  current: SourceIdentity,
  livePosition: number,
  requestedPosition: number,
) {
  return previous?.itemId === current.itemId &&
    previous?.sourceId !== current.sourceId
    ? livePosition
    : requestedPosition;
}

interface ShortcutEvent {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target?: {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selectors: string) => unknown;
  } | null;
}

export function playbackShortcut(event: ShortcutEvent, onTransportButton = false) {
  const target = event.target;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing ||
      target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT|A)$/.test(target?.tagName ?? "") ||
      target?.closest?.("input, textarea, select, a, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='slider']")) return null;
  const key = event.code?.match(/^Key([A-Z])$/)?.[1]?.toLowerCase() ?? event.key.toLowerCase();
  if ((target?.tagName === "BUTTON" || target?.closest?.("button, [role='button']")) &&
      (!onTransportButton || key === " ")) return null;
  if (event.repeat && [" ", "k", "f", "m"].includes(key)) return null;
  if (/^[0-9]$/.test(key)) return Number(key) / 10;
  switch (key) {
    case " ":
    case "k": return "toggle";
    case "f": return "fullscreen";
    case "m": return "mute";
    case "arrowleft": return "backFive";
    case "arrowright": return "forwardFive";
    case "arrowup": return "louder";
    case "arrowdown": return "quieter";
    case "j": return "backward";
    case "l": return "forward";
    default: return null;
  }
}

// Delay only clicks on the video. Transport buttons and keys act immediately.
export function createVideoClickGesture() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: (() => void) | undefined;
  let applied = false;
  function cancel() {
    clearTimeout(timer);
    pending = undefined;
    applied = false;
  }
  return {
    cancel,
    click(detail: number, single: () => void, double: () => void) {
      if (detail > 0 && detail % 2 === 0) {
        // Browsers expose the OS click count, but not the user's time setting.
        // A slow OS double click can arrive after the first action was applied.
        const restore = applied;
        cancel();
        if (restore) single();
        double();
        return;
      }
      const previous = pending;
      cancel();
      previous?.();
      pending = single;
      timer = setTimeout(() => {
        pending = undefined;
        applied = true;
        single();
      }, 1000);
    },
  };
}

export function playbackArtwork(
  item?: { sources: { thumbnail?: string | null }[] },
  source?: { thumbnail?: string | null },
): string | undefined {
  return source?.thumbnail || item?.sources.find((entry) => entry.thumbnail)?.thumbnail || undefined;
}


export function playbackKind(
  item: { kind: "audio" | "video"; visual?: { soundSourceId: string } },
  source?: { provider: "local" | "youtube"; mime?: string | null },
  mode: PlaybackMode = "original",
): "audio" | "video" {
  if (item.visual || mode === "audio") return "audio";
  if (source?.provider === "youtube") return "video";
  if (source?.mime?.startsWith("audio/")) return "audio";
  if (source?.mime?.startsWith("video/")) return "video";
  return item.kind;
}

export function canAutoplayPlayback(
  transport: ReturnType<typeof playbackTransport> | undefined,
  onPlayerScreen: boolean,
): boolean {
  return !!transport?.source && (onPlayerScreen || transport.kind === "audio");
}

export async function enterPlayerFullscreen(
  request?: () => Promise<void>,
): Promise<"native" | "viewport"> {
  if (!request) return "viewport";
  try {
    await request();
    return "native";
  } catch {
    return "viewport";
  }
}


export function createFullscreenIdleTimer(onIdle: (idle: boolean) => void) {
  let timer: ReturnType<typeof setTimeout>;
  let disposed = false;
  function activity() {
    if (disposed) return;
    clearTimeout(timer);
    onIdle(false);
    timer = setTimeout(() => onIdle(true), 3000);
  }
  onIdle(true);
  return {
    activity,
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

function queueFields({queue, originalQueue, queuePlaylistIds}: PlaybackSettings) {
  return {queue, originalQueue: originalQueue ?? [], queuePlaylistIds: queuePlaylistIds ?? {}};
}
function controls({queueIndex, position, volume, lastNonzeroVolume, repeat, shuffle, mode}: PlaybackSettings) {
  return {queueIndex, position, volume, lastNonzeroVolume, repeat, shuffle, mode};
}
function sameQueueReferences(a: PlaybackSettings, b: PlaybackSettings) {
  return a.queue === b.queue && a.originalQueue === b.originalQueue && a.queuePlaylistIds === b.queuePlaylistIds;
}
export function playbackSettingsPatch(state: PlaybackSettings, previous: PlaybackSettings): Partial<PlaybackSettings> {
  const before = controls(previous);
  const patch = Object.fromEntries(Object.entries(controls(state)).filter(([key, value]) =>
    before[key as keyof typeof before] !== value));
  if (!sameQueueReferences(state, previous) && JSON.stringify(queueFields(state)) !== JSON.stringify(queueFields(previous)))
    Object.assign(patch, queueFields(state), {queueIndex: state.queueIndex, position: state.position});
  return patch;
}

export class PlaybackCache {
  private lastWrite = -Infinity;
  private lastState?: PlaybackSettings;
  private lastServer?: PlaybackSettings;
  private queueText = "";
  private serverQueueText = "";
  private previousQueueText = "";
  private queueStamp = "";
  private stateText = "";
  constructor(private storage: Pick<Storage, "getItem" | "setItem">, private key: string, private initial: PlaybackSettings) {}
  restore(initial: Partial<PlaybackSettings> | undefined) {
    try {
      const cached = JSON.parse(this.storage.getItem(this.key) || "null");
      if (cached?.version !== 2) return restoreCachedPlayback(initial, cached);
      const queues = JSON.parse(this.storage.getItem(this.key + ".queue") || "null");
      if (!queues || queues.stamp !== cached.stamp) return this.initial;
      const baseline = cached.serverQueue === "current" ? JSON.stringify(queues.state)
        : cached.serverQueue === "previous" ? queues.previous : undefined;
      if (!initial?.queue || (baseline === JSON.stringify(queueFields(this.initial)) &&
          cached.server === JSON.stringify(controls(this.initial))))
        return restorePlayback({...cached.state, ...queues.state});
    } catch {}
    return this.initial;
  }
  save(state: PlaybackSettings, server: PlaybackSettings, now: number, force = false) {
    const changedQueue = !this.lastState || !sameQueueReferences(this.lastState, state);
    const changedServerQueue = !this.lastServer || !sameQueueReferences(this.lastServer, server);
    if (!force && !changedQueue && now - this.lastWrite < 5000) return;
    try {
      if (changedServerQueue) this.serverQueueText = JSON.stringify(queueFields(server));
      if (changedQueue) {
        const fields = queueFields(state);
        const text = JSON.stringify(fields);
        if (text !== this.queueText) {
          const stamp = globalThis.crypto.randomUUID?.() ?? String(Math.random());
          // Until PUT succeeds the server can still have the preceding queue.
          // Keep both possible baselines here so position writes stay small.
          const previous = text !== this.serverQueueText ? this.serverQueueText : "";
          this.storage.setItem(this.key + ".queue", JSON.stringify({stamp, state: fields, previous}));
          this.queueStamp = stamp;
          this.previousQueueText = previous;
          this.queueText = text;
        }
      }
      const serverQueue = this.serverQueueText === this.queueText ? "current"
        : this.serverQueueText === this.previousQueueText ? "previous" : undefined;
      const text = JSON.stringify({version: 2, stamp: this.queueStamp, state: controls(state),
        serverQueue, server: JSON.stringify(controls(server))});
      if (text !== this.stateText) this.storage.setItem(this.key, text);
      this.stateText = text;
      this.lastState = state;
      this.lastServer = server;
      this.lastWrite = now;
    } catch {}
  }
}

export type PlayerCardState = { active: boolean; playing: boolean; waitingForVideo: boolean; loadingLabel: string; mode: PlaybackMode };
const inactiveCard: PlayerCardState = {active: false, playing: false, waitingForVideo: false, loadingLabel: "", mode: "original"};
export class PlayerCards {
  private listeners = new Set<() => void>();
  private id?: string;
  private playlistId?: string;
  private card = inactiveCard;
  private editable = true;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  read = (id: string, playlistId?: string) =>
    this.id === id && (!playlistId || playlistId === this.playlistId) ? this.card : inactiveCard;
  hasCurrent = () => !!this.id;
  queueEditable = () => this.editable;
  update(id: string | undefined, card: PlayerCardState, editable: boolean, playlistId?: string) {
    this.playlistId = playlistId;
    this.id = id;
    if (this.card.active !== card.active || this.card.playing !== card.playing || this.card.mode !== card.mode ||
        this.card.waitingForVideo !== card.waitingForVideo || this.card.loadingLabel !== card.loadingLabel) this.card = card;
    this.editable = editable;
    this.listeners.forEach(listener => listener());
  }
}
