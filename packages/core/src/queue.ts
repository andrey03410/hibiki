import type { RepeatMode } from "@hibiki/contracts";
export interface QueueOrder {
  queue: string[];
  queueIndex: number;
}
export interface QueueState extends QueueOrder {
  repeat: RepeatMode;
}

/** A single Fisher–Yates permutation is the persisted listening order. */
export function shuffle(ids: string[], seed?: number | string): string[] {
  const result = [...new Set(ids)];
  let state = 2166136261;
  for (const character of String(seed ?? Math.random()))
    state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  const random = (): number => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export function normalizeQueue(
  queue: string[],
  queueIndex = 0,
): { queue: string[]; queueIndex: number } {
  const unique = [...new Set(queue)];
  if (!unique.length) return { queue: unique, queueIndex: -1 };
  const safeIndex = Number.isFinite(queueIndex)
    ? Math.min(Math.max(0, Math.trunc(queueIndex)), queue.length - 1)
    : 0;
  return { queue: unique, queueIndex: unique.indexOf(queue[safeIndex]!) };
}

export function moveQueueItem(
  state: QueueOrder,
  id: string,
  destination: "next" | "last" | number,
): QueueOrder {
  const from = state.queue.indexOf(id);
  const active = state.queue[state.queueIndex];
  if (id === active) return state;
  if (typeof destination === "number" && (
    from <= state.queueIndex || !Number.isInteger(destination) ||
    destination <= state.queueIndex || destination >= state.queue.length ||
    destination === from
  )) return state;

  const queue = state.queue.filter((entry) => entry !== id);
  const to = destination === "next"
    ? queue.indexOf(active!) + 1
    : destination === "last" ? queue.length : destination;
  if (to === from) return state;
  queue.splice(to, 0, id);
  return { queue, queueIndex: Math.max(0, queue.indexOf(active!)) };
}

export interface QueueRemoval {
  id: string;
  before?: string;
  after?: string;
}

export function removeUpcomingItem(
  state: QueueOrder,
  id: string,
): { queue: QueueOrder; removal: QueueRemoval } | undefined {
  const index = state.queue.indexOf(id);
  if (index < 0 || index <= state.queueIndex) return;
  return {
    queue: { queue: state.queue.filter((entry) => entry !== id), queueIndex: state.queueIndex },
    removal: { id, before: state.queue[index - 1], after: state.queue[index + 1] },
  };
}

export function undoQueueRemoval(state: QueueOrder, removal: QueueRemoval): QueueOrder {
  if (state.queue.includes(removal.id)) return state;
  const after = state.queue.indexOf(removal.after!);
  const before = state.queue.indexOf(removal.before!);
  const index = after > state.queueIndex
    ? after
    : before >= state.queueIndex ? before + 1 : state.queueIndex + 1;
  const queue = [...state.queue];
  queue.splice(index, 0, removal.id);
  return { queue, queueIndex: Math.max(0, state.queueIndex) };
}

export function shuffleUpcoming(state: QueueOrder, seed?: number | string): QueueOrder {
  const boundary = state.queueIndex + 1;
  return {
    queue: [...state.queue.slice(0, boundary), ...shuffle(state.queue.slice(boundary), seed)],
    queueIndex: state.queueIndex,
  };
}

/** `ended` distinguishes natural completion from an explicit next/previous click. */
export function advanceQueue(
  state: QueueState,
  direction: 1 | -1 = 1,
  ended = false,
): { queueIndex: number; ended: boolean } {
  const length = state.queue.length;
  if (!length) return { queueIndex: -1, ended: true };
  const queueIndex = Number.isFinite(state.queueIndex)
    ? Math.min(Math.max(0, Math.trunc(state.queueIndex)), length - 1)
    : 0;
  if (ended && state.repeat === "one") return { queueIndex, ended: false };
  const next = queueIndex + direction;
  if (state.repeat === "all")
    return { queueIndex: (next + length) % length, ended: false };
  if (next < 0) return { queueIndex: 0, ended: false };
  if (next >= length) return { queueIndex: length - 1, ended: true };
  return { queueIndex: next, ended: false };
}
