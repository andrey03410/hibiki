import { describe, expect, it } from "vitest";
import {
  playbackSources,
  sourceLoadPosition,
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
  it("preserves live position when a preferred local copy appears during YouTube playback", () => {
    const remote = {
      ...audio,
      sources: audio.sources.filter(
        (source: any) => source.provider === "youtube",
      ),
    };
    const before = {
      itemId: remote.id,
      sourceId: playbackSources(remote)[0]!.id,
    };
    const after = { itemId: audio.id, sourceId: playbackSources(audio)[0]!.id };
    expect(sourceLoadPosition(before, after, 37, 0)).toBe(37);
  });
  it("preserves position on source failure, resets different items and respects restored starts", () => {
    const local = { itemId: audio.id, sourceId: "local" };
    const fallback = { itemId: audio.id, sourceId: "yt" };
    expect(sourceLoadPosition(local, fallback, 28, 0)).toBe(28);
    expect(
      sourceLoadPosition(fallback, { itemId: video.id, sourceId: "v" }, 0, 0),
    ).toBe(0);
    expect(sourceLoadPosition(undefined, local, 42, 42)).toBe(42);
    expect(sourceLoadPosition(local, local, 50, 42)).toBe(42);
  });
});
