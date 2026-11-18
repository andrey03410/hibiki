import type { ItemDto } from "@hibiki/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createListeningTracker, sendListeningSnapshot, type ListeningSnapshot } from "./listening-client";

const epoch = 1_700_000_000_000;
const track = {
  id: "item", title: "One", duration: 100,
} as ItemDto;
const other = { ...track, id: "other", title: "Two" };

function fixture(enabled = true, hydrate = true) {
  let clock = epoch;
  let sequence = 0;
  const sent: ListeningSnapshot[] = [];
  const tracker = createListeningTracker("owner", (snapshot) => sent.push(snapshot), {
    now: () => clock,
    uuid: () => String(++sequence),
  });
  if (hydrate) tracker.setPreference({ enabled, serverTime: epoch, recordAfter: 0 });
  return { tracker, sent, tick: (seconds: number) => { clock += seconds * 1000; } };
}

describe("listening attempt tracker", () => {
  it("records actual start, not selection or an error before playback", () => {
    const { tracker, sent, tick } = fixture();
    tracker.select(track, "playlist", "advance");
    tracker.progress(0, 100);
    tracker.finish("error");
    expect(sent).toEqual([]);
    tracker.playing(0, 100);
    expect(sent[0]).toMatchObject({
      id: `${epoch}.1`, itemId: "item", ownerId: "owner", playlistId: "playlist",
      reason: "playing", trigger: "manual", listened: 0, covered: 0,
    });
    tick(3);
    tracker.progress(3, 100);
    tracker.finish("error");
    expect(sent.at(-1)).toMatchObject({ id: sent[0]!.id, reason: "error", listened: 3 });
  });

  it("counts elapsed playback separately from unique coverage over the same section", () => {
    const { tracker, sent, tick } = fixture();
    tracker.select(track, "playlist", "advance");
    tracker.playing(0, 100);
    tick(10);
    tracker.progress(10, 100);
    tracker.seek(0);
    tracker.progress(0, 100);
    tick(10);
    tracker.progress(10, 100);
    tracker.finish("ended");
    expect(sent.at(-1)).toMatchObject({
      id: sent[0]!.id, reason: "ended", listened: 20, covered: 10, seeks: 1,
      playlistId: "playlist", trigger: "advance",
    });
  });

  it("ignores buffering, jumps, and programmatic positioning during a source fallback", () => {
    const { tracker, sent, tick } = fixture();
    tracker.select(track);
    tracker.playing(0, 100);
    tick(4);
    tracker.progress(4, 100);
    tracker.paused();
    tick(30);
    tracker.progress(40, 100);
    tracker.playing(4, 100);
    tick(1);
    tracker.progress(98, 100);
    tick(1);
    tracker.progress(99, 100);
    tracker.finish("ended");
    expect(new Set(sent.map(snapshot => snapshot.id)).size).toBe(1);
    expect(sent.at(-1)).toMatchObject({ listened: 5, covered: 5, seeks: 0 });
  });

  it("checkpoints during playback and finishes each repeat and selection with its own identifier", () => {
    const { tracker, sent, tick } = fixture();
    tracker.select(track);
    tracker.playing(0, 100);
    tick(20);
    tracker.progress(20, 100);
    expect(sent.at(-1)).toMatchObject({ id: sent[0]!.id, reason: "playing", listened: 20 });
    tracker.finish("ended");
    tracker.select(track, undefined, "repeat");
    tracker.playing(0, 100);
    expect(sent.at(-1)).toMatchObject({ id: `${epoch + 20_000}.2`, trigger: "repeat" });
    tracker.select(other);
    expect(sent.at(-1)).toMatchObject({ itemId: "item", reason: "interrupted", trigger: "repeat" });
    tracker.playing(0);
    expect(sent.at(-1)).toMatchObject({ id: `${epoch + 20_000}.3`, itemId: "other", reason: "playing" });
    tracker.leave(false);
    expect(sent.at(-1)).toMatchObject({ id: `${epoch + 20_000}.3`, reason: "interrupted" });
  });

  it("holds early events for owner preferences and uses server time for both milestones", () => {
    const { tracker, sent, tick } = fixture(true, false);
    tracker.select(track);
    tracker.playing(0);
    tick(2);
    tracker.progress(2);
    tracker.finish("manual");
    expect(sent).toEqual([]);
    tracker.setPreference({ enabled: true, serverTime: epoch - 3_000, recordAfter: 0 });
    expect(sent.map(({ id, endedAt, reason }) => [id, endedAt, reason])).toEqual([
      [`${epoch - 5_000}.1`, new Date(epoch - 5_000).toISOString(), "playing"],
      [`${epoch - 5_000}.1`, new Date(epoch - 3_000).toISOString(), "manual"],
    ]);
  });

  it("discards buffered and active attempts on opt-out and drops them after a generation change", () => {
    const { tracker, sent, tick } = fixture(true, false);
    tracker.select(track);
    tracker.playing(0);
    tracker.setPreference({ enabled: false, serverTime: epoch, recordAfter: epoch });
    tick(5);
    tracker.progress(5);
    tracker.finish("manual");
    expect(sent).toEqual([]);
    tracker.setPreference({ enabled: true, serverTime: epoch + 5_000, recordAfter: epoch + 5_000 });
    tracker.playing(5);
    tick(1);
    tracker.setPreference({ enabled: true, serverTime: epoch + 6_000, recordAfter: epoch + 6_000 });
    tracker.finish("manual");
    expect(sent.map(snapshot => snapshot.reason)).toEqual(["playing"]);
    tracker.playing(6);
    expect(sent).toHaveLength(2);
  });

  it("sends actual media duration after changing to a source of a different length", () => {
    const { tracker, sent, tick } = fixture();
    tracker.select(track);
    tracker.playing(0, 100);
    tick(5);
    tracker.progress(5, 100);
    tracker.paused();
    tracker.playing(5, 20);
    tick(15);
    tracker.progress(20, 20);
    tracker.finish("ended");
    expect(sent.at(-1)).toMatchObject({ duration: 20, covered: 20, listened: 20 });
  });

  it.each([[2, 20, 10], [0.5, 10, 20]])(
    "measures %sx playback in wall seconds while covering media seconds",
    (rate, covered, wallTime) => {
      const { tracker, sent, tick } = fixture();
      tracker.select(track);
      tracker.playing(0, 100, rate);
      tick(wallTime);
      tracker.progress(covered, 100, rate);
      tracker.finish("manual");
      expect(sent[0]).toMatchObject({ maxPlaybackRate: rate });
      expect(sent.at(-1)).toMatchObject({ listened: wallTime, covered, seeks: 0, maxPlaybackRate: rate });
    },
  );

  it("retains peak rate after slowing down and excludes jumps even during fast playback", () => {
    const { tracker, sent, tick } = fixture();
    tracker.select(track);
    tracker.playing(0, 100);
    tick(10);
    tracker.progress(15, 100, 2);
    tick(5);
    tracker.progress(25, 100, 2);
    tick(1);
    tracker.progress(70, 100, 2);
    tick(5);
    tracker.progress(75, 100, 1);
    tracker.finish("manual");
    expect(sent.at(-1)).toMatchObject({ listened: 20, covered: 30, seeks: 0, maxPlaybackRate: 2 });
  });

  it("keeps a back-forward cache visit in the same attempt and excludes suspended time", () => {
    const { tracker, sent, tick } = fixture();
    tracker.select(track);
    tracker.playing(0);
    tick(5);
    tracker.progress(5);
    tracker.leave(true);
    tick(30);
    tracker.progress(35);
    tick(1);
    tracker.progress(36);
    tracker.finish("interrupted");
    expect(new Set(sent.map(snapshot => snapshot.id)).size).toBe(1);
    expect(sent.at(-1)).toMatchObject({ listened: 6, covered: 6 });
  });
});

describe("history change notification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("announces recorded milestones and ignores checkpoints, rejected writes and error responses", async () => {
    const browser = new EventTarget();
    const changed = vi.fn();
    browser.addEventListener("hibiki:history-changed", changed);
    vi.stubGlobal("window", browser);
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    const responses = [
      Response.json({ recorded: true, historyChanged: true }),
      Response.json({ recorded: true, historyChanged: false }),
      Response.json({ recorded: false }),
      Response.json({ recorded: true, historyChanged: true }, { status: 403 }),
      Response.json({ error: "unavailable" }, { status: 503 }),
      Response.json({ recorded: true, historyChanged: true }),
    ];
    vi.stubGlobal("fetch", async () => responses.shift());
    const snapshot: ListeningSnapshot = {
      id: `${epoch}.1`, ownerId: "owner", itemId: "item", trigger: "manual",
      reason: "playing", endedAt: new Date(epoch).toISOString(), listened: 0, covered: 0, seeks: 0,
    };
    await sendListeningSnapshot(snapshot);
    expect(changed).toHaveBeenCalledTimes(1);
    await sendListeningSnapshot(snapshot);
    await sendListeningSnapshot(snapshot);
    await sendListeningSnapshot(snapshot);
    expect(changed).toHaveBeenCalledTimes(1);
    await sendListeningSnapshot({ ...snapshot, reason: "ended" });
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
