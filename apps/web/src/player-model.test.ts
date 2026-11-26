import { afterEach, describe, expect, it, vi } from "vitest";
import {
  playbackSources,
  playbackVolume,
  playableVideoSource,
  canStartSelectedItem,
  sourceLoadPosition,
  restorePlayback,
  nextPlayableIndex,
  firstPlayableIndex,
  playbackShortcut,
  playbackArtwork,
  playbackKind,
  enterPlayerFullscreen,
  createFullscreenIdleTimer,
  createVideoClickGesture,
  startPlaybackQueue,
  queuePlaylistInput,
  togglePlaybackShuffle,
  addToPlaybackQueue,
  playbackSourceForAttempt,
  playbackTransport,
  createPlaybackAttempt,
  restoreCachedPlayback,
  playbackSettingsSignature,
  nativePlaybackReading,
  NativePlaybackPosition,
  youtubePlaybackReading,
  prepareYoutubePlayback,
  nativeRestartHasProgress,
  createYoutubeRestartConfirmation,
  recoverDeletedQueueEntry,
  reconcileQueuePlaylistIds,
  canAutoplayPlayback,
  soundUnavailableReason,
  itemActivation,
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

describe("native playback position across source changes", () => {
  it("keeps a pending seek through a failed relay, then accepts positions from the direct source", () => {
    const position = new NativePlaybackPosition();
    const audio = {currentSrc:"blob:m4a", currentTime:162, readyState:4, seeking:false};
    position.loaded(audio);
    const requested = position.handoff(audio, 0);
    expect(requested).toBe(162);
    expect(position.read(audio)).toBeUndefined();
    Object.assign(audio,{currentSrc:"/files/a?hibiki-audio=t",currentTime:0,readyState:0});
    position.loaded(audio);
    expect(position.handoff(audio, requested)).toBe(162);
    Object.assign(audio,{currentSrc:"/files/a",readyState:1,seeking:true});
    position.loaded(audio);
    expect(position.read(audio)).toBeUndefined();
    Object.assign(audio,{currentTime:162.3,readyState:4,seeking:false});
    position.loaded(audio);
    expect(position.read(audio)).toBe(162.3);
    audio.currentSrc = "/files/other";
    expect(position.read(audio)).toBeUndefined();
  });
});

describe("activation of an individual item", () => {
  const state = { queue: [audio.id, video.id, lost.id], queueIndex: 1, mode: "audio" } as const;

  it("toggles the active item in its current mode when no mode was requested", () => {
    expect(itemActivation({ ...state, queue: [...state.queue] }, video.id)).toBe("toggle");
  });

  it("changes the presentation of the active item when a different mode was requested", () => {
    expect(itemActivation({ ...state, queue: [...state.queue] }, video.id, "original")).toBe("changeMode");
  });

  it("rebinds the same recording to a different playlist without starting it again", () => {
    const queue = { ...state, queue: [...state.queue], queuePlaylistIds: { [video.id]: "first" } };
    expect(itemActivation(queue, video.id, "audio", "second", "first")).toBe("rebind");
    expect(itemActivation(queue, video.id, "audio", "first", "first")).toBe("toggle");
  });

  it("starts the context for a different selected item", () => {
    expect(itemActivation({ ...state, queue: [...state.queue] }, audio.id, "audio")).toBe("start");
  });
});

describe("player listening lifecycle", () => {
  it("requires playback beyond the completed seek before counting a restarted native item", () => {
    const media = { paused: false, ended: false, seeking: true, currentTime: 1 };
    expect(nativeRestartHasProgress(media, 0)).toBe(false);
    media.seeking = false;
    expect(nativeRestartHasProgress(media, 1)).toBe(false);
    media.currentTime = 1.2;
    expect(nativeRestartHasProgress(media, 1)).toBe(true);
    media.paused = true;
    expect(nativeRestartHasProgress(media, 1)).toBe(false);
  });

  it("waits for the YouTube seek before confirming progress on a restarted item", () => {
    const confirm = createYoutubeRestartConfirmation(8, 0);
    expect(confirm(8.5, 2)).toBe(false);
    expect(confirm(0, 2)).toBe(false);
    expect(confirm(8.6, 2)).toBe(false);
    expect(confirm(0.3, 2)).toBe(false);
    expect(confirm(0.3, 2)).toBe(false);
    expect(confirm(0.8, 2)).toBe(true);
  });

  it("accepts YouTube progress from an already verified seek target", () => {
    const confirm = createYoutubeRestartConfirmation(0, 0);
    expect(confirm(0, 1)).toBe(false);
    expect(confirm(0.4, 1)).toBe(true);
  });

  it("ignores backward jitter on the old YouTube clock near the seek target", () => {
    const confirm = createYoutubeRestartConfirmation(0.65, 0);
    expect(confirm(0.64, 1)).toBe(false);
    expect(confirm(0.72, 1)).toBe(false);
  });

  it("forwards the current native and YouTube playback rates to history with each sample", () => {
    const samples: { event: string; position: number; duration?: number; rate?: number }[] = [];
    const attempt = createPlaybackAttempt({
      select() {},
      playing: (position, duration, rate) => samples.push({ event: "playing", position, duration, rate }),
      progress: (position, duration, rate) => samples.push({ event: "progress", position, duration, rate }),
      paused() {},
      seek() {},
      finish() {},
    });
    const media = { currentTime: 4, duration: 60, playbackRate: 2 };
    let iframeRate = 1.5;
    const iframe = {
      getCurrentTime: () => 7,
      getDuration: () => 60,
      getPlaybackRate: () => iframeRate,
    };
    attempt.select(audio);
    attempt.playing(...nativePlaybackReading(media));
    media.currentTime = 6;
    attempt.progress(...nativePlaybackReading(media));
    attempt.paused();
    attempt.playing(...youtubePlaybackReading(iframe));
    iframeRate = 2;
    attempt.progress(...youtubePlaybackReading(iframe));
    expect(samples).toEqual([
      { event: "playing", position: 4, duration: 60, rate: 2 },
      { event: "progress", position: 6, duration: 60, rate: 2 },
      { event: "playing", position: 7, duration: 60, rate: 1.5 },
      { event: "progress", position: 7, duration: 60, rate: 2 },
    ]);
  });

  it("uses normalized context for a pending start and preserves the active attempt", () => {
    const { attempt, events } = capturePlayback();
    attempt.select(audio, "deleted", "advance");
    attempt.updatePlaylistId("video", undefined);
    attempt.updatePlaylistId("audio", undefined);
    attempt.playing(0);
    attempt.updatePlaylistId("audio", "new");
    attempt.finish("ended");
    expect(events).toEqual([
      ["select", "audio", "deleted", "advance"],
      ["select", "audio", undefined, "advance"],
      ["playing", 0],
      ["finish", "ended"],
    ]);
  });

  function capturePlayback() {
    const events: unknown[][] = [];
    const attempt = createPlaybackAttempt({
      select: (item, playlistId, trigger) => events.push(["select", item?.id, playlistId, trigger]),
      playing: (position) => events.push(["playing", position]),
      progress: (position) => events.push(["progress", position]),
      paused: () => events.push(["paused"]),
      seek: (position) => events.push(["seek", position]),
      finish: (reason) => events.push(["finish", reason]),
    });
    return { attempt, events };
  }

  it("ignores ticks and final errors before the first confirmed playback", () => {
    const { attempt, events } = capturePlayback();
    attempt.select(lost, "playlist", "advance");
    attempt.progress(15);
    attempt.finish("error");
    expect(events).toEqual([["select", "lost", "playlist", "advance"]]);
  });

  it("keeps one attempt through buffering and fallback, then records a post-start error", () => {
    const { attempt, events } = capturePlayback();
    attempt.select(audio, undefined, "manual");
    attempt.playing(0);
    attempt.progress(3);
    attempt.paused();
    attempt.progress(15);
    attempt.playing(3);
    attempt.progress(8);
    attempt.finish("error");
    expect(events).toEqual([
      ["select", "audio", undefined, "manual"], ["playing", 0], ["progress", 3],
      ["paused"], ["playing", 3], ["progress", 8], ["finish", "error"],
    ]);
  });

  it("records a repeated cycle as a separate attempt", () => {
    const { attempt, events } = capturePlayback();
    attempt.select(audio, "playlist", "manual");
    attempt.playing(0);
    attempt.progress(60);
    attempt.finish("ended");
    attempt.select(audio, "playlist", "repeat");
    attempt.playing(0);
    attempt.finish("manual");
    expect(events).toEqual([
      ["select", "audio", "playlist", "manual"], ["playing", 0],
      ["progress", 60], ["finish", "ended"], ["select", "audio", "playlist", "repeat"],
      ["playing", 0], ["finish", "manual"],
    ]);
  });
});

describe("browser playback model", () => {
  const videoWithSound = {
    ...video,
    sources: [
      { id: "copy", provider: "local", status: "available", streamUrl: "/files/copy", mime: "audio/mp4", hasAudio: true },
      { id: "movie", provider: "local", status: "available", streamUrl: "/files/movie", mime: "video/mp4", hasAudio: true },
      { id: "youtube", provider: "youtube", status: "available", externalId: "abcdefghijk" },
    ],
  };
  const youtubeOnly = { ...videoWithSound, id: "yt-only", sources: [videoWithSound.sources[2]!] };
  const silent = { ...videoWithSound, id: "silent", sources: [{ ...videoWithSound.sources[1]!, hasAudio: false }] };

  it("keeps the leading audio clock and exposes the original picture together", () => {
    const movie = { ...videoWithSound.sources[1], audioStreamUrl: "/files/movie/audio", audioBytes: 1024, audioMime: "audio/mp4" };
    const transport = playbackTransport({ ...video, sources: [movie] }, new Set());
    expect(transport.source?.streamUrl).toBe("/files/movie/audio");
    expect(transport.kind).toBe("audio");
    expect(transport.video?.streamUrl).toBe("/files/movie");
    const fallback = playbackTransport({ ...video, sources: [movie] }, new Set(["movie:audio"]));
    expect(fallback.source?.streamUrl).toBe("/files/movie");
    expect(fallback.kind).toBe("audio");
  });

  it("allows video-only sources to lead playback in the visible scene", () => {
    for (const item of [silent, youtubeOnly]) {
      const transport = playbackTransport(item, new Set());
      expect(transport.kind).toBe("video");
      expect(transport.source?.id).toBe(item.sources[0].id);
    }
  });

  it("plays a video in its original form and prefers its audio copy when listening", () => {
    const item = { ...videoWithSound, preferredSourceId: "copy" };
    expect(playbackSources(item, "original").map((source) => source.id)).toEqual(["movie", "youtube", "copy"]);
    expect(playbackSources(item, "audio").map((source) => source.id)).toEqual(["copy", "movie"]);
    expect(playbackKind(item, item.sources[1], "audio")).toBe("audio");
    expect(playbackSources(silent, "original")).toHaveLength(1);
    expect(playbackSources(silent, "audio")).toEqual([]);
    expect(soundUnavailableReason(silent)).toBe("В видео нет звуковой дорожки");
    expect(soundUnavailableReason(youtubeOnly)).toBe("Для прослушивания нужна локальная копия");
    expect(soundUnavailableReason(video)).toBe("Звуковая дорожка ещё не проверена");
  });

  it.each([youtubeOnly, silent])("keeps a video selected by cover when its audio is unavailable ($id)", (selected) => {
    expect(canStartSelectedItem(selected, "audio", true)).toBe(true);
    expect(canStartSelectedItem(selected, "audio")).toBe(false);
  });

  it("locates the available video even when audio mode uses another source", () => {
    const unavailableMovie = { ...videoWithSound, sources: [videoWithSound.sources[0], { ...videoWithSound.sources[1], status: "unavailable" }] };
    expect(playableVideoSource(videoWithSound)?.id).toBe("movie");
    expect(playableVideoSource(videoWithSound, new Set(["movie"]))?.id).toBe("youtube");
    expect(playableVideoSource(silent)?.id).toBe("movie");
    expect(playableVideoSource(youtubeOnly)?.id).toBe("youtube");
    expect(playableVideoSource(unavailableMovie)).toBeUndefined();
    expect(playableVideoSource(lost)).toBeUndefined();
  });

  it("continues local sound outside the player and scopes video-only playback to the scene", () => {
    for (const item of [videoWithSound, silent, youtubeOnly]) {
      const transport = playbackTransport(item, new Set());
      expect(canAutoplayPlayback(transport, false)).toBe(item === videoWithSound);
      expect(canAutoplayPlayback(transport, true)).toBe(true);
    }
    expect(canAutoplayPlayback(undefined, true)).toBe(false);
  });

  it("only uses the YouTube fallback on the watch screen after local sound fails", () => {
    const failed = new Set(["copy", "movie"]);
    const fallback = playbackTransport(videoWithSound, failed);
    expect(fallback.source?.provider).toBe("youtube");
    expect(canAutoplayPlayback(fallback, false)).toBe(false);
    expect(canAutoplayPlayback(fallback, true)).toBe(true);
  });

  it("finds the next compatible entry without changing the saved queue or wrapping by default", () => {
    const entries = [audio, silent, youtubeOnly, videoWithSound];
    const queue = entries.map((item) => item.id);
    expect(nextPlayableIndex(queue, 0, entries, 1, false, "audio")).toBe(3);
    expect(firstPlayableIndex(queue, 1, entries, "audio", false)).toBe(3);
    expect(nextPlayableIndex(queue, 3, entries, 1, false, "audio")).toBe(-1);
    expect(restorePlayback({ queue, queueIndex: 3, mode: "audio" }, entries)).toMatchObject({ queue, mode: "audio" });
    expect(restorePlayback({ queue }, entries).mode).toBe("original");
  });
  it("cues a paused YouTube restore at its saved position and loads an active one", () => {
    const operations: unknown[][] = [];
    const iframe = {
      cueVideoById: (value: unknown) => operations.push(["cue", value]),
      loadVideoById: (value: unknown) => operations.push(["load", value]),
      playVideo: () => operations.push(["play"]),
    };
    prepareYoutubePlayback(iframe, "a-video", 12, false);
    prepareYoutubePlayback(iframe, "a-video", 20, true);
    prepareYoutubePlayback(iframe, "a-video", 0, true);
    expect(operations).toEqual([
      ["cue", { videoId: "a-video", startSeconds: 12 }],
      ["load", { videoId: "a-video", startSeconds: 20 }],
      ["play"],
    ]);
  });

  it("selects the previous surviving item after deletion at the end with repeat off", () => {
    const state = restorePlayback({
      queue: ["audio", "video"], queueIndex: 1, position: 16,
      queuePlaylistIds: { audio: "playlist", video: "other" },
    }, [audio, video]);
    expect(recoverDeletedQueueEntry(state, [audio])).toMatchObject({
      queue: ["audio"], queueIndex: 0, position: 0, queuePlaylistIds: { audio: "playlist" },
    });
  });

  it("prefers an available later entry and retains unavailable survivors", () => {
    const state = restorePlayback({
      queue: ["audio", "video", "lost"], queueIndex: 0, position: 16,
    }, [audio, video, lost]);
    expect(recoverDeletedQueueEntry(state, [video, lost])).toMatchObject({
      queue: ["video", "lost"], queueIndex: 0, position: 0,
    });
    expect(recoverDeletedQueueEntry(state, [lost])).toMatchObject({
      queue: ["lost"], queueIndex: 0, position: 0,
    });
    expect(recoverDeletedQueueEntry(state, [])).toMatchObject({
      queue: [], queueIndex: 0, position: 0,
    });
  });

  it("prefers the local source while keeping YouTube as a fallback", () => {
    expect(playbackSources(audio).map((s) => s.id)).toEqual(["local", "yt"]);
    expect(playbackSources(lost)).toEqual([]);
  });
  it("tries an available preferred source before the usual local default", () => {
    expect(playbackSources({ ...audio, preferredSourceId: "yt" }).map((s) => s.id)).toEqual(["yt", "local"]);
    expect(playbackSources({ ...audio, preferredSourceId: "gone" }).map((s) => s.id)).toEqual(["local", "yt"]);
  });
  it("keeps the active source when a new preference arrives and applies it at the next start", () => {
    const updated = { ...audio, preferredSourceId: "yt" };
    expect(playbackSourceForAttempt(updated, new Set(), { sourceId: "local" })?.id).toBe("local");
    expect(playbackSourceForAttempt(updated, new Set(["local"]), { sourceId: "local" })?.id).toBe("yt");
    expect(playbackSourceForAttempt(updated, new Set())?.id).toBe("yt");
  });
  it("keeps launch scope per entry and clears it for a manually moved entry", () => {
    const queue = startPlaybackQueue([audio, video, lost], 1, false, "playlist");
    expect(queue).toEqual({
      queue: ["audio", "video", "lost"], queueIndex: 1, position: 0,
      queuePlaylistIds: { audio: "playlist", video: "playlist", lost: "playlist" },
    });
    const state = { ...restorePlayback({}, [audio, video, lost]), ...queue, position: 24 };
    expect(addToPlaybackQueue(state, "audio", "next")).toMatchObject({
      queue: ["video", "audio", "lost"], queueIndex: 0, position: 24,
      queuePlaylistIds: { video: "playlist", lost: "playlist" },
    });
    expect(addToPlaybackQueue(state, "audio", "next", "other")).toMatchObject({
      queue: ["video", "audio", "lost"], queueIndex: 0, position: 24,
      queuePlaylistIds: { audio: "other", video: "playlist", lost: "playlist" },
    });
    expect(addToPlaybackQueue(state, "new", "last", "other")).toMatchObject({
      queue: ["audio", "video", "lost", "new"], queuePlaylistIds: { new: "other" },
    });
    expect(addToPlaybackQueue(state, "video", "next", "other")).toBe(state);
  });
  it("deduplicates playback starts and pins the selection when starting shuffled", () => {
    expect(startPlaybackQueue([audio, video, audio], 2, false).queue).toEqual(["audio", "video"]);
    expect(startPlaybackQueue([audio, video, lost], 1, true)).toMatchObject({
      queue: ["video", expect.any(String), expect.any(String)], queueIndex: 0,
    });
  });
  it("retains legacy effective order and per-entry context after reload", () => {
    const restored = restorePlayback({
      queue: ["video", "audio", "lost"], queueIndex: 1, position: 21, shuffle: true,
      originalQueue: ["audio", "lost", "video"],
      queuePlaylistIds: { audio: "playlist", lost: "", missing: "other" },
    }, [video, audio, lost]);
    expect(restored).toMatchObject({
      queue: ["video", "audio", "lost"], queueIndex: 1, position: 21,
      queuePlaylistIds: { audio: "playlist" },
    });
    expect(togglePlaybackShuffle(restored)).toMatchObject({
      shuffle: false, queue: ["video", "audio", "lost"], queueIndex: 1, position: 21,
    });
  });
  it("saves the complete visible order as a new manual playlist", () => {
    const queue = ["past", "playing", "unavailable", "next"];
    const input = queuePlaylistInput("  Моя очередь  ", queue);
    queue.reverse();
    expect(input).toEqual({
      title: "Моя очередь",
      definition: { version: 1, rule: { type: "items", ids: ["past", "playing", "unavailable", "next"] }, sort: "source" },
    });
  });
  it("restores an unsynced queue edit after immediate reload", () => {
    const items = [audio, video, lost];
    const server = restorePlayback({ queue: ["audio", "video", "lost"], position: 5 }, items);
    const cache = {
      ...server, queue: ["audio", "lost"], position: 18,
      serverSignature: playbackSettingsSignature(server),
    };
    expect(restoreCachedPlayback(server, cache, items)).toMatchObject({
      queue: ["audio", "lost"], position: 18,
    });
    const imported = { ...server, queue: ["video", "audio"], position: 0 };
    expect(restoreCachedPlayback(imported, cache, items)).toMatchObject({
      queue: ["video", "audio"], position: 0,
    });
  });
  it("keeps unsynced cached edits across the upgrade from a signature without a mode", () => {
    const server = { queue: ["audio", "video"], queueIndex: 0, position: 5, volume: 0.8, repeat: "off", shuffle: false } as const;
    const initial = { ...server, queue: [...server.queue] };
    const legacySignature = JSON.stringify([server.queue, 0, 5, 0.8, "off", false, []]);
    const restored = restoreCachedPlayback(initial, {
      queue: ["video", "audio"], queueIndex: 0, position: 24, serverSignature: legacySignature,
    }, [audio, video]);
    expect(restored).toMatchObject({ queue: ["video", "audio"], position: 24, mode: "original" });
    expect(playbackSettingsSignature({ ...restored, mode: "audio" })).not.toBe(playbackSettingsSignature(restored));
  });
  it("drops playlist contexts rejected by the server without reverting later queue edits", () => {
    const submitted = { audio: "deleted", video: "old", lost: "deleted" };
    const latest = { audio: "deleted", video: "new", fresh: "another" };
    expect(reconcileQueuePlaylistIds(latest, submitted, {})).toEqual({
      video: "new", fresh: "another",
    });
    expect(reconcileQueuePlaylistIds(latest, submitted, undefined)).toBe(latest);
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
    expect(playbackShortcut({ key: "ArrowLeft" })).toBe("backFive");
    expect(playbackShortcut({ key: "ArrowRight" })).toBe("forwardFive");
    expect(playbackShortcut({ key: "f", ctrlKey: true })).toBeNull();
    expect(playbackShortcut({ key: "k", metaKey: true })).toBeNull();
    expect(playbackShortcut({ key: "ArrowLeft", altKey: true })).toBeNull();
    expect(playbackShortcut({ key: " ", repeat: true })).toBeNull();
    expect(playbackShortcut({ key: "x" })).toBeNull();
  });
  it("uses physical letters in Russian and keeps native control activation", () => {
    expect(playbackShortcut({ key: "л", code: "KeyK", target: {tagName:"BUTTON"} }, true)).toBe("toggle");
    expect(playbackShortcut({ key: "а", code: "KeyF", target: {tagName:"BUTTON"} }, true)).toBe("fullscreen");
    expect(playbackShortcut({ key: " ", code: "Space", target: {tagName:"BUTTON"} }, true)).toBeNull();
    expect(playbackShortcut({ key: "л", code: "KeyK", target: {tagName:"INPUT"} }, true)).toBeNull();
    expect(playbackShortcut({ key: "3", code: "Digit3" })).toBe(0.3);
    expect(playbackShortcut({ key: "0", code: "Digit0" })).toBe(0);
    expect(playbackShortcut({ key: "ArrowUp" })).toBe("louder");
    expect(playbackShortcut({ key: "ArrowDown" })).toBe("quieter");
    expect(playbackShortcut({ key: "о", code: "KeyJ" })).toBe("backward");
    expect(playbackShortcut({ key: "д", code: "KeyL" })).toBe("forward");
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
    expect(states).toEqual([true]);
    timer.activity();
    vi.advanceTimersByTime(2999);
    expect(states).toEqual([true, false]);
    vi.advanceTimersByTime(1);
    expect(states).toEqual([true, false, true]);
    timer.dispose();
  });
  it("reveals controls on activity and replaces the previous inactivity deadline", () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    const timer = createFullscreenIdleTimer((idle) => states.push(idle));
    vi.advanceTimersByTime(2000);
    timer.activity();
    vi.advanceTimersByTime(2999);
    expect(states).toEqual([true, false]);
    vi.advanceTimersByTime(1);
    expect(states).toEqual([true, false, true]);
    timer.activity();
    expect(states).toEqual([true, false, true, false]);
    timer.dispose();
  });
  it("cancels pending work on exit and cannot restart a disposed timer", () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    const timer = createFullscreenIdleTimer((idle) => states.push(idle));
    vi.advanceTimersByTime(2000);
    timer.dispose();
    timer.activity();
    vi.advanceTimersByTime(6000);
    expect(states).toEqual([true]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("video click gesture", () => {
  afterEach(() => vi.useRealTimers());
  it("honors a longer OS double-click interval and restores the initial playback state", () => {
    vi.useFakeTimers();
    const gesture = createVideoClickGesture();
    let paused = true;
    const toggle = vi.fn(() => { paused = !paused; });
    const full = vi.fn();
    gesture.click(1, toggle, full);
    vi.advanceTimersByTime(900);
    expect(toggle).not.toHaveBeenCalled();
    gesture.click(2, toggle, full);
    vi.runAllTimers();
    expect(paused).toBe(true);
    expect(toggle).not.toHaveBeenCalled();
    expect(full).toHaveBeenCalledOnce();
  });
  it("applies only fullscreen for a double click and cancels a pending click on unmount", () => {
    vi.useFakeTimers();
    const single = vi.fn(), double = vi.fn();
    const gesture = createVideoClickGesture();
    gesture.click(1, single, double);
    vi.advanceTimersByTime(450);
    gesture.click(2, single, double);
    vi.runAllTimers();
    expect(single).not.toHaveBeenCalled();
    expect(double).toHaveBeenCalledOnce();
    gesture.click(1, single, double);
    vi.runAllTimers();
    gesture.click(1, single, double);
    gesture.cancel();
    vi.runAllTimers();
    expect(single).toHaveBeenCalledOnce();
  });
});

it("remembers the muted account's previous level on reload, independently of stale local settings", () => {
  const settings = restorePlayback({queue: ["track"], volume: 0, lastNonzeroVolume: 0.35});
  const cached = {...settings, queue: ["old"], serverSignature: playbackSettingsSignature(settings)};
  expect(settings.lastNonzeroVolume).toBe(0.35);
  expect(restoreCachedPlayback({...settings, lastNonzeroVolume: 0.2}, cached)).toMatchObject({
    queue: ["track"], volume: 0, lastNonzeroVolume: 0.2,
  });
});

it("preserves an existing fractional account volume and its legacy cache signature", () => {
  const initial = {queue: ["track"], volume: 0.125};
  const legacySignature = JSON.stringify([["track"], 0, 0, 0.125, "off", false, []]);
  expect(playbackSettingsSignature(restorePlayback(initial))).toBe(legacySignature);
  expect(restoreCachedPlayback(initial, {...initial, position: 12, serverSignature: legacySignature})).toMatchObject({
    position: 12, volume: 0.125,
  });
});

it("reaches mute after six five-point decreases from 30% and remembers the last audible step", () => {
  let level = playbackVolume(0.3);
  for (let i = 0; i < 6; i++) level = playbackVolume(level.volume - 0.05, level.lastNonzeroVolume);
  expect(level.volume).toBe(0);
  expect(level.lastNonzeroVolume).toBeCloseTo(0.05);
});

it("plays the derived MP4 audio source, falling back to the original on a decoder error", () => {
  const movie = { id: "v", provider: "local" as const, status: "available" as const, mime: "video/mp4",
    streamUrl: "/files/movie", hasAudio: true, bytes: 1000, audioViewStart: 32, audioBytes: 210,
    audioStreamUrl: "/files/movie/audio", audioMime: "audio/mp4" };
  const item = { kind: "video" as const, sources: [movie] };
  expect(playbackSources(item, "audio")[0]).toMatchObject({ id: "v:audio", streamUrl: "/files/movie/audio",
    mime: "audio/mp4", bytes: 210, playbackHints: {audioStart: 32} });
  expect(playbackSourceForAttempt(item, new Set(["v:audio"]), undefined, "audio")).toBe(movie);
  expect(playbackSources(item, "original")).toEqual([movie]);
});

it("writes the queue once, throttles playing positions and flushes a pause", async () => {
  const { PlaybackCache, playbackSettingsPatch } = await import("./player-model");
  const entries = new Map<string,string>();
  const write = vi.fn((key: string, value: string) => entries.set(key, value));
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: write };
  const state = restorePlayback({queue: ["a","b"], position: 1});
  const cache = new PlaybackCache(storage, "player", state);
  for (let time = 0; time < 10_000; time += 250)
    cache.save({...state, position: time / 1000}, state, time);
  expect(write.mock.calls.filter(([key]) => key === "player")).toHaveLength(2);
  expect(write.mock.calls.filter(([key]) => key === "player.queue")).toHaveLength(1);
  expect(entries.get("player")).not.toContain('"queue"');
  cache.save({...state, position: 9.99}, state, 9990, true);
  expect(cache.restore(state)).toMatchObject({queue: ["a","b"], position: 9.99});
  expect(playbackSettingsPatch({...state, queue: ["a","b"], position: 11}, state)).toMatchObject({position: 11});
  expect(playbackSettingsPatch({...state, queue: ["a","b"], position: 11}, state)).not.toHaveProperty("queue");
  expect(playbackSettingsPatch({...state, queue: ["b","a"]}, state)).toHaveProperty("queue", ["b","a"]);
});

it("changes only the previous and next card snapshots when playback moves", async () => {
  const { PlayerCards } = await import("./player-model");
  const cards = new PlayerCards();
  const state = {active:true, playing:true, loadingLabel:"", waitingForVideo:false, mode:"audio" as const};
  cards.update("a", state, true);
  const initial = ["a","b","c"].map(id => cards.read(id));
  cards.update("b", state, false);
  const changed = ["a","b","c"].filter((id,index) => cards.read(id) !== initial[index]);
  expect(changed).toEqual(["a","b"]);
  expect(cards.queueEditable()).toBe(false);
});

it("prefers the selected full video with sound over an earlier short local audio in listening mode", () => {
  const movie = {id:"movie",provider:"local" as const,status:"available",streamUrl:"/files/full",mime:"video/webm",hasAudio:true};
  const short = {...movie,id:"short",streamUrl:"/files/short",mime:"audio/mpeg"};
  expect(playbackSources({kind:"video",sources:[short,movie],preferredSourceId:"movie"},"audio")[0]).toBe(movie);
});

it("keeps the assigned sound of a composition as the same audio engine in both modes", () => {
  const item = { ...video, visual: { soundSourceId: "concert" }, sources: [
    {id:"other", provider:"youtube", status:"available", externalId:"different"},
    {id:"concert", provider:"local", status:"available", streamUrl:"/files/concert", mime:"video/mp4", hasAudio:true,
      audioStreamUrl:"/files/concert/audio", audioMime:"audio/mp4", audioBytes:100},
  ] };
  for (const mode of ["original", "audio"] as const) {
    const source = playbackSourceForAttempt(item, new Set(), undefined, mode);
    expect(source?.streamUrl).toBe("/files/concert/audio");
    expect(playbackKind(item, source, mode)).toBe("audio");
    expect(playbackSourceForAttempt(item, new Set(["concert", "concert:audio"]), undefined, mode)).toBeUndefined();
  }
});

it("corrects the clip to the leading audio phase and tolerates adjacent frames across a wrap", async () => {
  const { clipSeekTime } = await import("./clip-clock");
  expect(clipSeekTime(80, 4, 30)).toBe(20);
  expect(clipSeekTime(60.01, 29.99, 30)).toBeUndefined();
  expect(clipSeekTime(3, 0, NaN)).toBeUndefined();
  expect(clipSeekTime(3, 0, 0)).toBeUndefined();
  expect(clipSeekTime(60, 0.13, 30)).toBe(0);
});

it("holds the last original video frame if a separate audio source runs longer", async () => {
  const { clipSeekTime } = await import("./clip-clock");
  expect(clipSeekTime(80, 4, 30, false)).toBe(30);
  expect(clipSeekTime(80, 30, 30, false)).toBeUndefined();
});

it("shows Play in another playlist until the active recording has been rebound", async () => {
  const { PlayerCards } = await import("./player-model");
  const cards = new PlayerCards();
  const card = { active: true, playing: true, waitingForVideo: false, loadingLabel: "", mode: "audio" as const };
  cards.update("recording", card, true, "first");
  expect(cards.read("recording", "second").playing).toBe(false);
  cards.update("recording", card, true, "second");
  expect(cards.read("recording", "second").playing).toBe(true);
  expect(cards.read("recording", "first").active).toBe(false);
});

it("keeps a visible YouTube picture silent and synchronized to the local recording", async () => {
  const { syncYoutubePicture } = await import("./player-model");
  const commands: unknown[] = [];
  const picture = {
    getPlayerState: () => 2, getDuration: () => 60, getCurrentTime: () => 2, isMuted: () => false,
    mute: () => commands.push("mute"), seekTo: (time: number) => commands.push(time),
    playVideo: () => commands.push("play"), pauseVideo: () => commands.push("pause"),
  };
  syncYoutubePicture(picture, { currentTime: 42, paused: false, seeking: false }, true);
  expect(commands).toEqual(["mute", 42, "play"]);
  commands.length = 0;
  syncYoutubePicture({ ...picture, getPlayerState: () => 1, isMuted: () => true, getCurrentTime: () => 47.1 },
    { currentTime: 47, paused: true, seeking: false }, false);
  expect(commands).toEqual(["pause"]);
});

it("advances failed companion pictures without dropping their working audio or recycling a failed picture", () => {
  const movie = { id: "movie", provider: "local" as const, status: "available", mime: "video/mp4", streamUrl: "/files/movie", hasAudio: true };
  const online = { id: "online", provider: "youtube" as const, status: "available", externalId: "abcdefghijk" };
  const item = { id: "film", kind: "video" as const, sources: [movie, online] };
  const second = playbackTransport(item, new Set(), undefined, new Set(["movie"]));
  expect(second.source?.id).toBe("movie");
  expect(second.video?.id).toBe("online");
  const exhausted = playbackTransport(item, new Set(), undefined, new Set(["movie", "online"]));
  expect(exhausted.source?.id).toBe("movie");
  expect(exhausted.video).toBeUndefined();
});
