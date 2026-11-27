import type { ItemDto, TagDto } from "@hibiki/contracts";
import { missingClassification } from "@hibiki/contracts/classification";
import { groupOf, type Performance, type TagCatalog, type Voice } from "./taxonomy";

/** Classification of one item as edited in the drawer. */
export type Draft = { tagIds: string[]; performance: Performance; voices: Voice[] };

export function draftOf(item: Pick<ItemDto, "tags" | "performance" | "voices">): Draft {
  return {
    tagIds: item.tags.filter(tag => !tag.archived).map(tag => tag.id),
    performance: item.performance ?? "unknown",
    voices: item.voices ?? [],
  };
}

export function sameDraft(a: Draft, b: Draft) {
  const ids = new Set(a.tagIds);
  return a.performance === b.performance && a.tagIds.length === b.tagIds.length && b.tagIds.every(id => ids.has(id))
    && a.voices.length === b.voices.length && b.voices.every(voice => a.voices.includes(voice));
}

export function toggleDraftTag(draft: Draft, id: string): Draft {
  return { ...draft, tagIds: draft.tagIds.includes(id) ? draft.tagIds.filter(other => other !== id) : [...draft.tagIds, id] };
}

export function setPerformance(draft: Draft, performance: Performance): Draft {
  return { ...draft, performance, voices: performance === "vocal" ? draft.voices : [] };
}

export function toggleVoice(draft: Draft, voice: Voice): Draft {
  const voices = draft.voices.includes(voice) ? draft.voices.filter(other => other !== voice) : [...draft.voices, voice];
  return { ...draft, performance: "vocal", voices };
}

export const REQUIRED_PARTS = 6;

/** Filled required parts: source, artist, genre, mood, performance and voice (voice counts for OST). */
export function completeness(draft: Draft, catalog: TagCatalog) {
  const tags = draft.tagIds.flatMap(id => catalog.byId.get(id) ?? []);
  const missing = missingClassification(tags, draft.performance, draft.voices);
  // The voice part is decided together with the performance.
  const undecided = draft.performance === "unknown" ? 1 : 0;
  return { done: REQUIRED_PARTS - missing.length - undecided, total: REQUIRED_PARTS, missing };
}

/** Human summary of what changed, for the undo toast. */
export function describeChange(before: Draft, after: Draft, catalog: TagCatalog): string {
  const added = after.tagIds.filter(id => !before.tagIds.includes(id)).flatMap(id => catalog.byId.get(id) ?? []);
  const removed = before.tagIds.filter(id => !after.tagIds.includes(id)).flatMap(id => catalog.byId.get(id) ?? []);
  const parts = [...added.map(tag => "+ " + tag.name), ...removed.map(tag => "− " + tag.name)];
  if (before.performance !== after.performance || !sameDraft({ ...before, tagIds: [] }, { ...after, tagIds: [] })) parts.push("исполнение");
  if (!parts.length) return "Разметка сохранена";
  return "Разметка: " + (parts.length > 3 ? parts.slice(0, 3).join(", ") + ` и ещё ${parts.length - 3}` : parts.join(", "));
}

type Sender = (draft: Draft) => Promise<unknown>;

/**
 * Debounced, strictly sequential autosave. The latest draft wins: while one
 * request is in flight the next draft waits and only its newest value is sent.
 */
export class AutosaveQueue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Draft | undefined;
  private running: Promise<void> | undefined;
  saved: Draft;

  constructor(initial: Draft, private send: Sender, private events: {
    saved?: (before: Draft, after: Draft) => void;
    failed?: (error: Error, draft: Draft) => void;
    busy?: (busy: boolean) => void;
  } = {}, private delay = 450) {
    this.saved = initial;
  }

  schedule(draft: Draft) {
    this.pending = draft;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }

  /** Sends the pending draft now and resolves when everything queued is saved. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.running) await this.running;
    const draft = this.pending;
    this.pending = undefined;
    if (!draft || sameDraft(draft, this.saved)) return;
    const before = this.saved;
    this.events.busy?.(true);
    this.running = this.send(draft).then(() => {
      this.saved = draft;
      this.events.saved?.(before, draft);
    }, error => {
      this.events.failed?.(error as Error, draft);
    }).finally(() => {
      this.running = undefined;
      if (!this.pending) this.events.busy?.(false);
    });
    await this.running;
    if (this.pending && !this.timer) await this.flush();
  }

  get dirty() {
    return !!this.pending || !!this.running;
  }

  cancel() {
    clearTimeout(this.timer);
    this.pending = undefined;
  }
}

/* ---------------- bulk tagging ---------------- */

export type BulkState = "off" | "part" | "on";
export type BulkItem = Pick<ItemDto, "id" | "tags" | "performance" | "voices">;

export function bulkState(items: readonly BulkItem[], id: string): { state: BulkState; count: number } {
  const count = items.filter(item => item.tags.some(tag => tag.id === id)).length;
  return { state: !count ? "off" : count === items.length ? "on" : "part", count };
}

/** Target per tag: true = everybody gets it, false = nobody keeps it. */
export type BulkPlan = ReadonlyMap<string, boolean>;

/** Click cycle: partial → everybody → nobody → as before; off ⇄ everybody; on ⇄ nobody. */
export function nextBulkTarget(state: BulkState, target: boolean | undefined): boolean | undefined {
  if (target === undefined) return state !== "on";
  if (target) return state === "off" ? undefined : false;
  return undefined;
}

export function effectiveState(state: BulkState, target: boolean | undefined): BulkState {
  return target === undefined ? state : target ? "on" : "off";
}

export function bulkChanges(items: readonly BulkItem[], plan: BulkPlan, performance?: { performance: Performance; voices: Voice[] }) {
  const changes: { id: string; tagIds?: string[]; performance?: Performance; voices?: Voice[] }[] = [];
  for (const item of items) {
    const before = item.tags.filter(tag => !tag.archived).map(tag => tag.id);
    const kept = before.filter(id => plan.get(id) !== false);
    const added = [...plan].filter(([id, on]) => on && !kept.includes(id)).map(([id]) => id);
    const tagIds = [...kept, ...added];
    const change: (typeof changes)[number] = { id: item.id };
    if (tagIds.length !== before.length || added.length) change.tagIds = tagIds;
    if (performance && (item.performance !== performance.performance
      || (item.voices ?? []).length !== performance.voices.length || performance.voices.some(voice => !(item.voices ?? []).includes(voice)))) {
      change.performance = performance.performance;
      change.voices = performance.voices;
    }
    if (change.tagIds || change.performance) changes.push(change);
  }
  return changes;
}

/** Tags any selected item has, grouped for the bulk popover. */
export function bulkTags(items: readonly BulkItem[], catalog: TagCatalog) {
  const ids = new Set(items.flatMap(item => item.tags.filter(tag => !tag.archived).map(tag => tag.id)));
  return [...ids].flatMap(id => catalog.byId.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

export function sourceLabel(tag: TagDto, catalog: TagCatalog) {
  return groupOf(tag) === "source" ? catalog.paths(tag.id)[0] ?? tag.name : tag.name;
}
