import { afterEach, describe, expect, it, vi } from "vitest";
import {
  playbackSources,
  sourceLoadPosition,
  restorePlayback,
  nextPlayableIndex,
  firstPlayableIndex,
  playbackShortcut,
  playbackArtwork,
  playbackKind,
  enterPlayerFullscreen,
  createFullscreenIdleTimer,
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


describe("watch player controls", () => {
  it("keeps keyboard shortcuts out of editable fields and interactive controls", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]) {
      expect(playbackShortcut({ key: " ", target: { tagName } })).toBeNull();
      expect(playbackShortcut({ key: "f", target: { tagName } })).toBeNull();
    }
    expect(playbackShortcut({ key: "k", target: { isContentEditable: true } })).toBeNull();
    expect(playbackShortcut({ key: "ArrowRight", target: { closest: () => ({}) } })).toBeNull();
  });
  it("maps unmodified playback keys without stealing browser combinations or held toggles", () => {
    expect(playbackShortcut({ key: " " })).toBe("toggle");
    expect(playbackShortcut({ key: "K" })).toBe("toggle");
    expect(playbackShortcut({ key: "f" })).toBe("fullscreen");
    expect(playbackShortcut({ key: "m" })).toBe("mute");
    expect(playbackShortcut({ key: "ArrowLeft" })).toBe("backward");
    expect(playbackShortcut({ key: "ArrowRight" })).toBe("forward");
    expect(playbackShortcut({ key: "f", ctrlKey: true })).toBeNull();
    expect(playbackShortcut({ key: "k", metaKey: true })).toBeNull();
    expect(playbackShortcut({ key: "ArrowLeft", altKey: true })).toBeNull();
    expect(playbackShortcut({ key: " ", repeat: true })).toBeNull();
    expect(playbackShortcut({ key: "x" })).toBeNull();
  });
  it("shows the active source artwork before other source thumbnails", () => {
    const item = {
      sources: [
        { ...audio.sources[0], thumbnail: "https://example.test/video.jpg" },
        { ...audio.sources[1], thumbnail: "/api/items/audio/artwork" },
      ],
    };
    expect(playbackArtwork(item, item.sources[1])).toBe("/api/items/audio/artwork");
    expect(playbackArtwork(item, { ...audio.sources[1] })).toBe("https://example.test/video.jpg");
    expect(playbackArtwork({ sources: [] })).toBeUndefined();
    expect(playbackArtwork(undefined)).toBeUndefined();
  });
});


describe("watch source presentation", () => {
  it("shows audio artwork for a downloaded audio source of a video item", () => {
    expect(playbackKind(video, { provider: "local", mime: "audio/mp4" })).toBe("audio");
    expect(playbackKind(video, { provider: "local", mime: "audio/mpeg" })).toBe("audio");
  });
  it("uses the playable source format and retains a visible YouTube stage", () => {
    expect(playbackKind(audio, { provider: "local", mime: "video/mp4" })).toBe("video");
    expect(playbackKind(audio, { provider: "youtube" })).toBe("video");
    expect(playbackKind(audio, { provider: "local" })).toBe("audio");
    expect(playbackKind(video, { provider: "local" })).toBe("video");
  });
});


describe("watch fullscreen availability", () => {
  it("prefers the browser fullscreen API when it accepts the request", async () => {
    let requested = false;
    const mode = await enterPlayerFullscreen(async () => { requested = true; });
    expect(requested).toBe(true);
    expect(mode).toBe("native");
  });
  it("uses the viewport when browser fullscreen is rejected or unsupported", async () => {
    expect(await enterPlayerFullscreen(async () => { throw new Error("NotAllowedError"); })).toBe("viewport");
    expect(await enterPlayerFullscreen()).toBe("viewport");
  });
});


describe("fullscreen controls inactivity", () => {
  afterEach(() => vi.useRealTimers());

  it("hides controls after three seconds of inactivity", () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    const timer = createFullscreenIdleTimer((idle) => states.push(idle));
    expect(states).toEqual([false]);
    vi.advanceTimersByTime(2999);
    expect(states).toEqual([false]);
    vi.advanceTimersByTime(1);
    expect(states).toEqual([false, true]);
    timer.dispose();
  });
  it("reveals controls on activity and replaces the previous inactivity deadline", () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    const timer = createFullscreenIdleTimer((idle) => states.push(idle));
    vi.advanceTimersByTime(2000);
    timer.activity();
    vi.advanceTimersByTime(2999);
    expect(states).toEqual([false, false]);
    vi.advanceTimersByTime(1);
    expect(states).toEqual([false, false, true]);
    timer.activity();
    expect(states).toEqual([false, false, true, false]);
    timer.dispose();
  });
  it("cancels pending work on exit or item change and cannot restart a disposed timer", () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    const timer = createFullscreenIdleTimer((idle) => states.push(idle));
    vi.advanceTimersByTime(2000);
    timer.dispose();
    timer.activity();
    vi.advanceTimersByTime(6000);
    expect(states).toEqual([false]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
