import { describe, expect, it } from "vitest";
import { advanceQueue, normalizeQueue, shuffle } from "./index.js";

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
});
