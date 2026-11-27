import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TagDto } from "@hibiki/contracts";
import { TagCatalog } from "./taxonomy";
import {
  AutosaveQueue, bulkChanges, bulkState, completeness, describeChange, draftOf, effectiveState, nextBulkTarget,
  sameDraft, setPerformance, toggleDraftTag, toggleVoice, type Draft,
} from "./tag-editing";

const tag = (id: string, group: TagDto["group"], archived = false): TagDto => ({ id, name: id.toUpperCase(), color: "#b8a5ff", group, archived });
const tags = [tag("src", "source"), tag("art", "artist"), tag("gen", "genre"), tag("calm", "mood"), tag("epic", "mood"), tag("old", "extra", true)];
const catalog = new TagCatalog(tags);
const draft = (tagIds: string[], performance: Draft["performance"] = "unknown", voices: Draft["voices"] = []): Draft => ({ tagIds, performance, voices });

describe("draft", () => {
  it("drops archived tags and compares regardless of order", () => {
    const value = draftOf({ tags: [tags[1]!, tags[5]!], performance: "vocal", voices: ["male"] });
    expect(value).toEqual(draft(["art"], "vocal", ["male"]));
    expect(sameDraft(draft(["a", "b"]), draft(["b", "a"]))).toBe(true);
    expect(sameDraft(draft(["a"]), draft(["a"], "ost"))).toBe(false);
  });
  it("toggles tags, performance and voices", () => {
    expect(toggleDraftTag(draft(["a"]), "b").tagIds).toEqual(["a", "b"]);
    expect(toggleDraftTag(draft(["a", "b"]), "a").tagIds).toEqual(["b"]);
    expect(setPerformance(draft([], "vocal", ["male"]), "ost")).toEqual(draft([], "ost"));
    expect(toggleVoice(draft([], "unknown"), "female")).toEqual(draft([], "vocal", ["female"]));
    expect(toggleVoice(draft([], "vocal", ["female"]), "female").voices).toEqual([]);
  });
  it("counts six required parts", () => {
    expect(completeness(draft([]), catalog).done).toBe(0);
    expect(completeness(draft(["src", "art", "gen", "calm"], "ost"), catalog)).toMatchObject({ done: 6, total: 6, missing: [] });
    expect(completeness(draft(["src", "art", "gen", "calm"], "vocal"), catalog)).toMatchObject({ done: 5, missing: ["voice"] });
  });
  it("describes a change for the undo toast", () => {
    expect(describeChange(draft(["calm"]), draft(["epic"]), catalog)).toBe("Разметка: + EPIC, − CALM");
    expect(describeChange(draft([]), draft([], "ost"), catalog)).toBe("Разметка: исполнение");
  });
});

describe("autosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces edits and sends only the latest draft", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const saved = vi.fn();
    const queue = new AutosaveQueue(draft([]), send, { saved });
    queue.schedule(draft(["a"]));
    queue.schedule(draft(["a", "b"]));
    await vi.advanceTimersByTimeAsync(449);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(draft(["a", "b"]));
    expect(saved).toHaveBeenCalledWith(draft([]), draft(["a", "b"]));
    queue.schedule(draft(["b", "a"]));
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("waits for the request in flight before sending the next draft", async () => {
    const resolvers: (() => void)[] = [];
    const send = vi.fn(() => new Promise<void>(resolve => resolvers.push(resolve)));
    const queue = new AutosaveQueue(draft([]), send);
    queue.schedule(draft(["a"]));
    await vi.advanceTimersByTimeAsync(450);
    queue.schedule(draft(["b"]));
    queue.schedule(draft(["c"]));
    await vi.advanceTimersByTimeAsync(450);
    expect(send).toHaveBeenCalledTimes(1);
    resolvers.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(draft(["c"]));
    resolvers.shift()!();
    await queue.flush();
    expect(queue.saved).toEqual(draft(["c"]));
    expect(queue.dirty).toBe(false);
  });

  it("keeps the last saved state when a request fails", async () => {
    const failed = vi.fn();
    const queue = new AutosaveQueue(draft([]), vi.fn().mockRejectedValue(new Error("offline")), { failed });
    queue.schedule(draft(["a"]));
    await queue.flush();
    expect(failed).toHaveBeenCalledWith(new Error("offline"), draft(["a"]));
    expect(queue.saved).toEqual(draft([]));
  });
});

describe("bulk tagging", () => {
  const items = [
    { id: "1", tags: [tags[3]!, tags[2]!], performance: "ost" as const, voices: [] },
    { id: "2", tags: [tags[3]!], performance: "vocal" as const, voices: ["male" as const] },
    { id: "3", tags: [tags[3]!, tags[5]!], performance: "unknown" as const, voices: [] },
  ];
  it("reports none, partial and full states", () => {
    expect(bulkState(items, "calm")).toEqual({ state: "on", count: 3 });
    expect(bulkState(items, "gen")).toEqual({ state: "part", count: 1 });
    expect(bulkState(items, "epic")).toEqual({ state: "off", count: 0 });
  });
  it("cycles partial → all → none → as before", () => {
    const seen: (string | undefined)[] = [];
    let target: boolean | undefined;
    for (let i = 0; i < 4; i++) { target = nextBulkTarget("part", target); seen.push(effectiveState("part", target)); }
    expect(seen).toEqual(["on", "off", "part", "on"]);
    expect(nextBulkTarget("on", undefined)).toBe(false);
    expect(nextBulkTarget("on", false)).toBeUndefined();
    expect(nextBulkTarget("off", undefined)).toBe(true);
    expect(nextBulkTarget("off", true)).toBeUndefined();
  });
  it("builds only real changes and keeps archived tags out", () => {
    const plan = new Map([["gen", true], ["calm", false]]);
    expect(bulkChanges(items, plan)).toEqual([
      { id: "1", tagIds: ["gen"] },
      { id: "2", tagIds: ["gen"] },
      { id: "3", tagIds: ["gen"] },
    ]);
    expect(bulkChanges(items, new Map([["calm", true]]))).toEqual([]);
    expect(bulkChanges(items, new Map(), { performance: "ost", voices: [] }).map(change => change.id)).toEqual(["2", "3"]);
  });
});
