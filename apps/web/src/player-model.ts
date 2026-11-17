export interface PlayableItem {
  id: string;
  kind: "audio" | "video";
  sources: PlaybackSource[];
}
export interface PlaybackSource {
  id: string;
  provider: "local" | "youtube";
  status: string;
  streamUrl?: string | null;
  externalId?: string | null;
  url?: string | null;
}
export interface PlaybackSettings {
  queue: string[];
  queueIndex: number;
  position: number;
  volume: number;
  repeat: "off" | "all" | "one";
  shuffle: boolean;
  originalQueue?: string[];
}
export function playbackSources<T extends PlaybackSource>(item: {
  sources: T[];
}): T[] {
  return item.sources
    .filter(
      (s) =>
        s.status !== "unavailable" &&
        (s.provider === "local" ? !!s.streamUrl : !!s.externalId || !!s.url),
    )
    .sort(
      (a, b) => Number(b.provider === "local") - Number(a.provider === "local"),
    );
}
export function restorePlayback(
  settings: Partial<PlaybackSettings>,
  items: PlayableItem[],
): PlaybackSettings {
  const oldQueue = Array.isArray(settings.queue)
    ? settings.queue.filter((id) => typeof id === "string")
    : [];
  const currentId = oldQueue[settings.queueIndex ?? 0];
  const valid = new Set(items.map((i) => i.id));
  const queue = [...new Set(oldQueue.filter((id) => valid.has(id)))];
  const retained = queue.indexOf(currentId ?? "");
  return {
    queue,
    queueIndex: Math.max(0, retained),
    position: retained >= 0 ? Math.max(0, Number(settings.position) || 0) : 0,
    volume: Math.min(
      1,
      Math.max(0, Number.isFinite(settings.volume) ? settings.volume! : 0.8),
    ),
    repeat:
      settings.repeat === "all" || settings.repeat === "one"
        ? settings.repeat
        : "off",
    shuffle: !!settings.shuffle,
    originalQueue: settings.originalQueue?.filter((id) => valid.has(id)),
  };
}
export function nextPlayableIndex(
  queue: string[],
  current: number,
  items: PlayableItem[],
  direction: number,
  wrap: boolean,
): number {
  const valid = new Set(
    items.filter((i) => playbackSources(i).length > 0).map((i) => i.id),
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
): number {
  const item = items.find((i) => i.id === queue[selected]);
  return item && playbackSources(item).length
    ? selected
    : nextPlayableIndex(queue, selected, items, 1, true);
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
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selectors: string) => unknown;
  } | null;
}
export function playbackShortcut(event: ShortcutEvent):
  | "toggle" | "fullscreen" | "mute" | "backward" | "forward" | null {
  const target = event.target;
  if (
    event.ctrlKey || event.metaKey || event.altKey || event.repeat ||
    target?.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target?.tagName ?? "") ||
    target?.closest?.("input, textarea, select, button, a, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='slider']")
  ) return null;
  switch (event.key.toLowerCase()) {
    case " ":
    case "k": return "toggle";
    case "f": return "fullscreen";
    case "m": return "mute";
    case "arrowleft":
    case "j": return "backward";
    case "arrowright":
    case "l": return "forward";
    default: return null;
  }
}
export function playbackArtwork(
  item?: { sources: { thumbnail?: string | null }[] },
  source?: { thumbnail?: string | null },
): string | undefined {
  return source?.thumbnail || item?.sources.find((entry) => entry.thumbnail)?.thumbnail || undefined;
}


export function playbackKind(
  item: { kind: "audio" | "video" },
  source?: { provider: "local" | "youtube"; mime?: string },
): "audio" | "video" {
  if (source?.provider === "youtube") return "video";
  if (source?.mime?.startsWith("audio/")) return "audio";
  if (source?.mime?.startsWith("video/")) return "video";
  return item.kind;
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
  activity();
  return {
    activity,
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
