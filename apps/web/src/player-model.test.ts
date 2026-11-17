import { describe, expect, it } from "vitest";
import {
  playbackSources,
  restorePlayback,
  nextPlayableIndex,
  firstPlayableIndex,
} from "./player-model.ts";

const audio = {
  id: "audio",
  title: "Piano",
  kind: "audio",
  duration: 60,
  tags: [],
  sources: [
    {
      id: "yt",
      provider: "youtube",
      externalId: "abcdefghijk",
      status: "available",
    },
    {
      id: "local",
      provider: "local",
      streamUrl: "/files/song",
      status: "available",
    },
  ],
} as any;
const video = {
  ...audio,
  id: "video",
  kind: "video",
  sources: [
    {
      id: "v",
      provider: "local",
      streamUrl: "/files/video",
      status: "available",
    },
  ],
} as any;
const lost = {
  ...audio,
  id: "lost",
  sources: [
    {
      id: "x",
      provider: "youtube",
      externalId: "deleted",
      status: "unavailable",
    },
  ],
} as any;

describe("browser playback model", () => {
  it("prefers the local source while keeping YouTube as a fallback", () => {
    expect(playbackSources(audio).map((s) => s.id)).toEqual(["local", "yt"]);
    expect(playbackSources(lost)).toEqual([]);
  });
  it("restores the current mixed item and its position after stale ids are removed", () => {
    expect(
      restorePlayback(
        {
          queue: ["missing", "audio", "video"],
          queueIndex: 2,
          position: 24,
          volume: 0.6,
          repeat: "all",
          shuffle: false,
        },
        [audio, video],
      ),
    ).toMatchObject({
      queue: ["audio", "video"],
      queueIndex: 1,
      position: 24,
      volume: 0.6,
    });
  });
  it("resets position when the current item no longer exists", () => {
    expect(
      restorePlayback(
        { queue: ["audio", "missing", "video"], queueIndex: 1, position: 24 },
        [audio, video],
      ),
    ).toMatchObject({ queue: ["audio", "video"], queueIndex: 0, position: 0 });
  });
  it("starts on the first available item when the selected source is gone", () => {
    expect(
      firstPlayableIndex(["lost", "video", "audio"], 0, [audio, lost, video]),
    ).toBe(1);
    expect(firstPlayableIndex(["lost"], 0, [lost])).toBe(-1);
  });
  it("advances audio to video and skips unavailable sources without looping forever", () => {
    expect(
      nextPlayableIndex(
        ["audio", "lost", "video"],
        0,
        [audio, lost, video],
        1,
        false,
      ),
    ).toBe(2);
    expect(nextPlayableIndex(["lost"], 0, [lost], 1, true)).toBe(-1);
    expect(
      nextPlayableIndex(["audio", "video"], 1, [audio, video], 1, false),
    ).toBe(-1);
    expect(
      nextPlayableIndex(["audio", "video"], 1, [audio, video], 1, true),
    ).toBe(0);
  });
});
