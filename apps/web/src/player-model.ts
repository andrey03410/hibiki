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
