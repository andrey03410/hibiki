import type { ItemDto } from "@hibiki/contracts";
import { useEffect, useMemo } from "react";
import { api } from "./api";
import { announceHistoryChanged } from "./history-events";

export type ListeningTrigger = "manual" | "advance" | "repeat";
export type ListeningEnd = "ended" | "manual" | "error" | "interrupted";
export type ListeningOutcome = "active" | "completed" | "partial" | "skipped" | "error";
export type HistoryPreference = {
  enabled: boolean;
  serverTime: number;
  recordAfter: number;
  resetAt: string | null;
  pruned: boolean;
};

export type ListeningSnapshot = {
  id: string;
  ownerId: string;
  itemId: string;
  playlistId?: string;
  trigger: ListeningTrigger;
  endedAt: string;
  duration?: number;
  maxPlaybackRate?: number;
  reason: ListeningEnd | "playing";
  listened: number;
  covered: number;
  seeks: number;
};

type Selection = { item: ItemDto; playlistId?: string; trigger: ListeningTrigger };
type Range = [number, number];
type Attempt = Selection & {
  uuid: string;
  startedAt: number;
  serverStart?: number;
  lastSent: number;
  listened: number;
  seeks: number;
  covered: number;
  ranges: Range[];
  duration?: number;
  playbackRate: number;
  maxPlaybackRate: number;
  anchor?: { position: number; at: number; playbackRate: number };
  playing: boolean;
};
type Draft = {
  attempt: Attempt;
  at: number;
  reason: ListeningSnapshot["reason"];
  duration?: number;
  maxPlaybackRate: number;
  listened: number;
  covered: number;
  seeks: number;
};

const checkpointMs = 15_000;
const preferenceEvent = "hibiki:history-preference";
const pageWarmupBuffer = 64;

function randomId() {
  // getRandomValues is also available when Hibiki is served over HTTP on a LAN.
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

function addCoverage(attempt: Attempt, start: number, end: number) {
  let index = 0;
  while (index < attempt.ranges.length && attempt.ranges[index]![1] < start) ++index;
  while (index < attempt.ranges.length && attempt.ranges[index]![0] <= end) {
    const [from, to] = attempt.ranges.splice(index, 1)[0]!;
    start = Math.min(start, from);
    end = Math.max(end, to);
    attempt.covered -= to - from;
  }
  attempt.ranges.splice(index, 0, [start, end]);
  attempt.covered += end - start;
}

function positionIsValid(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function mediaPosition(attempt: Attempt, position: number, duration?: number) {
  if (duration && Number.isFinite(duration) && duration > 0 && duration <= 7 * 86_400)
    attempt.duration = duration;
  const total = attempt.duration ?? attempt.item.duration;
  return total && Number.isFinite(total) && total > 0 ? Math.min(position, total) : position;
}

function playbackRateOr(value: number | undefined, fallback: number) {
  return value != null && value >= 0.0625 && value <= 16 ? value : fallback;
}

export function createListeningTracker(
  ownerId: string,
  send: (snapshot: ListeningSnapshot) => void,
  { now = () => performance.timeOrigin + performance.now(), uuid = randomId } = {},
) {
  let selected: Selection | undefined;
  let current: Attempt | undefined;
  let preference: Pick<HistoryPreference, "enabled" | "serverTime" | "recordAfter"> | undefined;
  let offset = 0;
  const pending: Draft[] = [];

  function serverStart(attempt: Attempt) {
    return attempt.serverStart ??= Math.floor(attempt.startedAt + offset);
  }
  function publish(draft: Draft) {
    if (!preference?.enabled) return;
    const { attempt, at, reason, duration, maxPlaybackRate, listened, covered, seeks } = draft;
    const start = serverStart(attempt);
    if (start <= preference.recordAfter) return;
    send({
      id: `${start}.${attempt.uuid}`,
      ownerId,
      itemId: attempt.item.id,
      playlistId: attempt.playlistId,
      trigger: attempt.trigger,
      endedAt: new Date(start + Math.floor(at - attempt.startedAt)).toISOString(),
      reason, duration, maxPlaybackRate, listened, covered, seeks,
    });
  }
  function snapshot(attempt: Attempt, reason: Draft["reason"], at = now()) {
    attempt.lastSent = at;
    const { duration, maxPlaybackRate, listened, covered, seeks } = attempt;
    const draft = { attempt, reason, at, duration, maxPlaybackRate, listened, covered, seeks };
    if (preference) publish(draft);
    else {
      if (pending.length === pageWarmupBuffer) pending.shift();
      pending.push(draft);
    }
  }
  function finish(reason: ListeningEnd) {
    if (current) snapshot(current, reason);
    current = undefined;
    if (selected) selected = { ...selected, trigger: "manual" };
  }
  function checkpoint() {
    if (current && (current.listened > 0 || current.seeks > 0) && Math.floor(now()) > Math.floor(current.lastSent))
      snapshot(current, "playing");
  }

  const controls = {
    select(item: ItemDto | null, playlistId?: string, trigger: ListeningTrigger = "manual") {
      finish("interrupted");
      selected = item ? { item, playlistId, trigger } : undefined;
    },
    playing(position: number, duration?: number, playbackRate?: number) {
      if (!selected || preference?.enabled === false || !positionIsValid(position)) return;
      const at = now();
      const rate = playbackRateOr(playbackRate, current?.playbackRate ?? 1);
      const starting = !current;
      if (!current) {
        current = {
          ...selected, uuid: uuid(), startedAt: at, lastSent: at,
          listened: 0, covered: 0, seeks: 0, ranges: [], playing: true,
          playbackRate: rate, maxPlaybackRate: rate,
        };
        // Events after an observed reset/opt-in belong to the new generation,
        // even if this callback falls on the same millisecond.
        if (preference) current.serverStart = Math.max(Math.floor(at + offset), preference.recordAfter + 1);
      }
      current.playing = true;
      current.playbackRate = rate;
      current.maxPlaybackRate = Math.max(current.maxPlaybackRate, rate);
      current.anchor = { position: mediaPosition(current, position, duration), at, playbackRate: rate };
      if (starting) snapshot(current, "playing", at);
    },
    progress(position: number, duration?: number, playbackRate?: number) {
      if (!current?.playing || !positionIsValid(position)) return;
      const at = now();
      const rate = playbackRateOr(playbackRate, current.playbackRate);
      position = mediaPosition(current, position, duration);
      const previous = current.anchor;
      current.anchor = { position, at, playbackRate: rate };
      current.playbackRate = rate;
      current.maxPlaybackRate = Math.max(current.maxPlaybackRate, rate);
      if (previous) {
        const elapsed = (at - previous.at) / 1000;
        const advance = position - previous.position;
        const faster = Math.max(previous.playbackRate, rate);
        // A jump larger than either observed rate can explain is a discontinuity.
        if (advance > 0 && elapsed > 0 && advance <= elapsed * faster * 1.2 + 0.15) {
          const slower = Math.min(previous.playbackRate, rate);
          const intervalRate = Math.max(slower, Math.min(faster, advance / elapsed));
          current.listened += Math.min(elapsed, advance / intervalRate);
          addCoverage(current, previous.position, position);
        }
      }
      if (at - current.lastSent >= checkpointMs) snapshot(current, "playing", at);
    },
    paused() {
      if (!current?.playing) return;
      current.playing = false;
      current.anchor = undefined;
      checkpoint();
    },
    seek(position: number) {
      if (!current || !positionIsValid(position)) return;
      ++current.seeks;
      current.anchor = undefined;
    },
    finish,
  };

  return {
    ...controls,
    setPreference(next: Pick<HistoryPreference, "enabled" | "serverTime" | "recordAfter">) {
      preference = next;
      offset = next.serverTime - now();
      if (!next.enabled) {
        current = undefined;
        pending.length = 0;
        return;
      }
      if (current && serverStart(current) <= next.recordAfter) current = undefined;
      for (const draft of pending.splice(0)) publish(draft);
    },
    checkpoint,
    leave(persisted: boolean) {
      if (persisted) {
        if (current) current.anchor = undefined;
        checkpoint();
      } else {
        finish("interrupted");
        pending.length = 0;
      }
    },
  };
}

export function notifyHistoryPreference({ historyReset = false } = {}) {
  window.dispatchEvent(new Event(preferenceEvent));
  try {
    localStorage.setItem(preferenceEvent, randomId());
  } catch {
    // Same-tab updates still work when browser storage is unavailable.
  }
  if (historyReset) announceHistoryChanged();
}

export async function sendListeningSnapshot(snapshot: ListeningSnapshot) {
  const body = JSON.stringify(snapshot);
  const send = () => fetch("/api/history/attempts", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => null);
  // A later cumulative snapshot recovers a lost start or checkpoint.
  let response = await send();
  if (snapshot.reason !== "playing" && (!response || response.status >= 500))
    response = await send();
  if (!response?.ok) return;
  const receipt = await response.json().catch(() => null);
  if (receipt?.recorded === true && receipt.historyChanged === true)
    announceHistoryChanged();
}

export function useListeningAttempt(userId: string) {
  const tracker = useMemo(() => createListeningTracker(userId, snapshot => {
    void sendListeningSnapshot(snapshot);
  }), [userId]);

  useEffect(() => {
    let live = true;
    let request = 0;
    function refresh() {
      const sequence = ++request;
      void api<HistoryPreference>("/history/preference")
        .then(data => {
          if (live && request === sequence) tracker.setPreference(data);
        })
        .catch(() => {});
    }
    const leave = (event: PageTransitionEvent) => tracker.leave(event.persisted);
    function visibility() {
      if (document.hidden) tracker.checkpoint();
      else refresh();
    }
    function storage(event: StorageEvent) {
      if (event.key === preferenceEvent) refresh();
    }
    refresh();
    window.addEventListener(preferenceEvent, refresh);
    window.addEventListener("storage", storage);
    window.addEventListener("online", refresh);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      live = false;
      window.removeEventListener(preferenceEvent, refresh);
      window.removeEventListener("storage", storage);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", visibility);
      tracker.leave(false);
    };
  }, [tracker]);

  return tracker;
}
