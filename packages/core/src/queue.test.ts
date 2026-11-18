import { describe, expect, it } from "vitest";
import {
  advanceQueue,
  moveQueueItem,
  normalizeQueue,
  removeUpcomingItem,
  shuffle,
  shuffleUpcoming,
  undoQueueRemoval,
} from "./index.js";

describe("mixed-media queue", () => {
  it("shuffles without duplicates or mutation and reproduces a saved seed", () => {
    const input = ["audio", "video", "youtube", "other", "audio"];
    const result = shuffle(input, "hibiki");
    expect(result).toHaveLength(4);
    expect(new Set(result)).toEqual(
      new Set(["audio", "video", "youtube", "other"]),
    );
    expect(shuffle(input, "hibiki")).toEqual(result);
    expect(result).not.toEqual(["audio", "video", "youtube", "other"]);
    expect(input).toEqual(["audio", "video", "youtube", "other", "audio"]);
  });

  it("restores the current item after deduplication and clamps invalid indexes", () => {
    expect(normalizeQueue(["a", "a", "b"], 2)).toEqual({
      queue: ["a", "b"],
      queueIndex: 1,
    });
    expect(normalizeQueue(["a", "b"], 99)).toEqual({
      queue: ["a", "b"],
      queueIndex: 1,
    });
    expect(normalizeQueue([], 0)).toEqual({ queue: [], queueIndex: -1 });
  });

  it("advances through audio and video then stops at the end with repeat off", () => {
    expect(
      advanceQueue({ queue: ["audio", "video"], queueIndex: 0, repeat: "off" }),
    ).toEqual({ queueIndex: 1, ended: false });
    expect(
      advanceQueue(
        { queue: ["audio", "video"], queueIndex: 1, repeat: "off" },
        1,
        true,
      ),
    ).toEqual({ queueIndex: 1, ended: true });
    expect(advanceQueue({ queue: [], queueIndex: -1, repeat: "off" })).toEqual({
      queueIndex: -1,
      ended: true,
    });
  });

  it("repeats one only on track completion and wraps repeat all in both directions", () => {
    expect(
      advanceQueue(
        { queue: ["a", "b"], queueIndex: 0, repeat: "one" },
        1,
        true,
      ),
    ).toEqual({ queueIndex: 0, ended: false });
    expect(
      advanceQueue({ queue: ["a", "b"], queueIndex: 0, repeat: "one" }),
    ).toEqual({ queueIndex: 1, ended: false });
    expect(
      advanceQueue({ queue: ["a", "b"], queueIndex: 1, repeat: "all" }),
    ).toEqual({ queueIndex: 0, ended: false });
    expect(
      advanceQueue({ queue: ["a", "b"], queueIndex: 0, repeat: "all" }, -1),
    ).toEqual({ queueIndex: 1, ended: false });
    expect(
      advanceQueue({ queue: ["a", "b"], queueIndex: 0, repeat: "off" }, -1),
    ).toEqual({ queueIndex: 0, ended: false });
  });

  it("moves a played item after the current item without changing the active ID", () => {
    const state = { queue: ["past", "playing", "first", "last"], queueIndex: 1 };
    expect(moveQueueItem(state, "past", "next")).toEqual({
      queue: ["playing", "past", "first", "last"], queueIndex: 0,
    });
    expect(moveQueueItem(state, "first", "last")).toEqual({
      queue: ["past", "playing", "last", "first"], queueIndex: 1,
    });
    expect(moveQueueItem(state, "playing", "last")).toBe(state);
  });

  it("adds an item as current when the queue is empty", () => {
    expect(moveQueueItem({ queue: [], queueIndex: 0 }, "new", "next")).toEqual({
      queue: ["new"], queueIndex: 0,
    });
  });

  it("limits reordering and removal to upcoming entries", () => {
    const state = { queue: ["past", "playing", "first", "last"], queueIndex: 1 };
    expect(moveQueueItem(state, "last", 2)).toEqual({
      queue: ["past", "playing", "last", "first"], queueIndex: 1,
    });
    expect(moveQueueItem(state, "past", 2)).toBe(state);
    expect(moveQueueItem(state, "last", 1)).toBe(state);
    expect(removeUpcomingItem(state, "playing")).toBeUndefined();
    expect(removeUpcomingItem(state, "past")).toBeUndefined();
  });

  it("restores a removed entry without undoing later reordering or changing current", () => {
    const state = { queue: ["past", "playing", "a", "b", "c"], queueIndex: 1 };
    const result = removeUpcomingItem(state, "b")!;
    const edited = moveQueueItem(result.queue, "c", "last");
    const added = moveQueueItem(edited, "new", "next");
    expect(undoQueueRemoval(added, result.removal)).toEqual({
      queue: ["past", "playing", "new", "a", "b", "c"], queueIndex: 1,
    });
    expect(undoQueueRemoval({ ...added, queueIndex: 4 }, result.removal)).toEqual({
      queue: ["past", "playing", "new", "a", "c", "b"], queueIndex: 4,
    });
    const alreadyAdded = moveQueueItem(added, "b", "next");
    expect(undoQueueRemoval(alreadyAdded, result.removal)).toBe(alreadyAdded);
  });

  it("shuffles only upcoming entries", () => {
    const state = { queue: ["past", "playing", "a", "b", "c", "d"], queueIndex: 1 };
    const shuffled = shuffleUpcoming(state, "hibiki");
    expect(shuffled.queue.slice(0, 2)).toEqual(["past", "playing"]);
    expect(shuffled.queueIndex).toBe(1);
    expect(shuffled.queue.slice(2)).not.toEqual(["a", "b", "c", "d"]);
    expect(new Set(shuffled.queue.slice(2))).toEqual(new Set(["a", "b", "c", "d"]));
  });
});
