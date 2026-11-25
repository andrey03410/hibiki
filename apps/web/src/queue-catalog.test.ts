import { expect, it, vi } from "vitest";
import type { ItemDto } from "@hibiki/contracts";
import { QueueCatalog } from "./queue-catalog";
import { restorePlayback } from "./player-model";

it("keeps the saved queue while only its current window is loaded", () => {
  expect(restorePlayback({queue: ["a","b","c"], queueIndex: 1, position: 16})).toMatchObject({
    queue: ["a","b","c"], queueIndex: 1, position: 16
  });
});
it("crosses an unloaded page in queue order, skipping missing and silent entries", async () => {
  const ids = Array.from({length: 300}, (_, i) => String(i));
  const fetch = vi.fn(async (keys: string[]) => keys.filter(id => id !== "101").map(id => ({
    id, kind: "audio", sources: +id >= 103 ? [{id: "src", provider:"local", streamUrl:"/files/x", mime:"audio/mpeg", status:"available"}] : []
  }) as unknown as ItemDto));
  const catalog = new QueueCatalog(fetch);
  expect(await catalog.findPlayable(ids, 99, 1, false, "audio")).toBe(103);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0].length).toBeLessThanOrEqual(100);
  expect(await catalog.findPlayable(ids, 103, -1, false, "audio")).toBe(-1);
});

it("re-evaluates the next entry when play-next changes the queue during hydration", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {release = resolve;});
  const catalog = new QueueCatalog(async ids => {
    await waiting;
    return ids.map(id => ({id, kind: "audio", sources: [{provider:"local", streamUrl:"/files/song", status:"available"}]}) as ItemDto);
  });
  let settings = restorePlayback({queue:["one","two"], queueIndex:0});
  const advance = catalog.nextInQueue(() => settings, 1, false, new Set(), () => true);
  settings = {...settings, queue:["one","inserted","two"], volume:0.2};
  release();
  expect(await advance).toMatchObject({index:1, state:{queue:["one","inserted","two"],volume:0.2}});
});

function audioEntry(id: string) {
  return {id, kind: "audio", sources: [{provider:"local", streamUrl:"/files/" + id, status:"available"}]} as ItemDto;
}

it("scopes borrowed queue positions to the source link even for identical original items", async () => {
  const catalog = new QueueCatalog(async ids => ids.map(audioEntry));
  const original = audioEntry("song");
  const [first] = catalog.sharedEntries("/shared/first", [original], async () => [original]);
  const [second] = catalog.sharedEntries("/shared/second", [original], async () => [original]);
  const [same] = catalog.sharedEntries("/shared/first", [original], async () => [original]);
  expect(first!.id).not.toEqual(original.id);
  expect(first!.id).toEqual(same!.id);
  expect(first!.id).not.toEqual(second!.id);
  expect(first!.id).not.toContain("first");
});

it("rechecks link membership before advancing through the original queue order", async () => {
  const tracks = ["one", "two", "three", "four"].map(audioEntry);
  tracks[1] = { ...tracks[1]!, title: "Private title", originalTitle: "Private title", duration: 80,
    shared: { sharedBy: "Original author", available: true, delegated: true } };
  let allowed = tracks;
  const load = vi.fn(async () => allowed);
  const fetch = vi.fn(async (ids: string[]) => ids.map(audioEntry));
  const catalog = new QueueCatalog(fetch);
  const rows = catalog.sharedEntries("/shared/a", tracks, load);
  catalog.put(rows);
  const state = restorePlayback({ queue: rows.map(row => row.id), queueIndex: 0 });
  allowed = [tracks[3]!, tracks[2]!, tracks[0]!];
  catalog.invalidate();
  await catalog.ensure(state.queue);
  expect(fetch).not.toHaveBeenCalled();
  expect((await catalog.nextInQueue(() => state, 1, true, new Set(), () => true))?.index).toBe(2);
  expect(load).toHaveBeenCalledTimes(1);
  const closed = catalog.rows.get(rows[1]!.id);
  expect(closed).toMatchObject({ title: "Запись недоступна", originalTitle: "", duration: null, sources: [], tags: [] });
  expect(closed?.shared).toBeUndefined();
  allowed = [tracks[1]!, ...allowed];
  expect((await catalog.nextInQueue(() => state, 1, true, new Set(), () => true))?.index).toBe(1);
  expect(catalog.rows.get(rows[1]!.id)?.shared?.sharedBy).toBe("Original author");
});

it("rechecks repeat-one after access to the current track ends", async () => {
  const track = audioEntry("one");
  const catalog = new QueueCatalog(async ids => ids.map(audioEntry));
  const rows = catalog.sharedEntries("/shared/a", [track], async () => []);
  catalog.put(rows);
  const state = restorePlayback({ queue: [rows[0]!.id], repeat: "one" });
  expect((await catalog.nextInQueue(() => state, 1, true, new Set(), () => true))?.index).toBe(-1);
});

it("reads access before an asynchronous fallback without replacing the current entry", async () => {
  const track = audioEntry("one");
  const catalog = new QueueCatalog(async ids => ids.map(audioEntry));
  const [entry] = catalog.sharedEntries("/shared/a", [track], async () => []);
  catalog.put([entry!]);
  expect(await catalog.readPlayback(entry!.id)).toMatchObject({ sources: [] });
  expect(catalog.rows.get(entry!.id)).toBe(entry);
});

it("rechecks a borrowed library source and leaves the local copy playable", async () => {
  const borrowed = { ...audioEntry("saved"), shared: { sharedBy: "Автор", available: true } };
  borrowed.sources[0]!.shared = true;
  const localCopy = { ...audioEntry("saved"), shared: { sharedBy: "Автор", available: false } };
  const catalog = new QueueCatalog(async () => [localCopy]);
  catalog.put([borrowed]);
  expect(await catalog.refreshPlayback("saved")).toBe(localCopy);
});

it("verifies a borrowed source even when that queue row has just loaded", async () => {
  const cached = { ...audioEntry("saved"), shared: { sharedBy: "Автор", available: true } };
  const closed = { ...cached, sources: [], shared: { ...cached.shared, available: false } };
  const verify = vi.fn(async () => [closed]);
  const catalog = new QueueCatalog(async () => [cached], verify);
  expect(await catalog.findPlayable([cached.id], -1, 1, false, "audio")).toBe(-1);
  expect(verify).toHaveBeenCalledWith([cached.id]);
});

it("publishes only verified metadata when restoring the current playback row", async () => {
  const cached = { ...audioEntry("saved"), shared: { sharedBy: "Автор", available: true } };
  const closed = { ...cached, sources: [], shared: { ...cached.shared, available: false } };
  const catalog = new QueueCatalog(async () => [cached], async () => [closed]);
  await catalog.ensure([cached.id], undefined, true);
  expect(catalog.rows.get(cached.id)).toBe(closed);
});

it("uses known positions immediately and waits for the tail before wrapping", async () => {
  const catalog = new QueueCatalog(async ids => ids.map(audioEntry));
  let state = restorePlayback({queue: ["a", "b"], queueIndex: 0, repeat: "all"});
  let release!: () => void;
  let tail: Promise<void> | undefined = new Promise(resolve => { release = resolve; });
  const advance = () => catalog.nextInQueue(() => state, 1, false, new Set(), () => true, () => tail);
  expect((await advance())?.index).toBe(1);
  state = {...state, queueIndex: 1};
  let result: number | undefined;
  const boundary = advance().then(target => {result = target?.index;});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(result).toBeUndefined();
  state = {...state, queue: ["a", "b", "c"]};
  tail = undefined;
  release();
  await boundary;
  expect(result).toBe(2);
});

it("a late first queue cannot replace the second, and retry resumes boundary navigation", async () => {
  const { LibraryQueueLoad } = await import("./queue-catalog");
  const load = new LibraryQueueLoad();
  let release!: (ids: string[]) => void;
  const applied: string[][] = [];
  load.start(() => new Promise(resolve => {release = resolve;}), ids => {applied.push(ids);});
  const oldTail = load.tail;
  let failed = true;
  load.start(async () => {
    if (failed) throw new Error("offline");
    return ["new", "tail"];
  }, ids => {applied.push(ids);});
  const newTail = load.tail;
  await oldTail;
  release(["old"]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(load.snapshot()).toBe("error");
  expect(applied).toEqual([]);
  failed = false;
  load.retry();
  await newTail;
  expect(load.snapshot()).toBe("complete");
  expect(applied).toEqual([["new", "tail"]]);
});

it("fills the complete order around the item playing now without resetting its attempt or position", async () => {
  const { completeLibraryOrder } = await import("./queue-catalog");
  const state = restorePlayback({queue:["first", "current"], queueIndex:1, position:18, volume:0.2});
  expect({...state, ...completeLibraryOrder(state, ["inserted", "first", "current", "tail"])}).toEqual({
    ...state, queue:["inserted", "first", "current", "tail"], queueIndex:2
  });
  expect(completeLibraryOrder(state, ["first", "tail"])).toEqual({queue:["first", "current", "tail"], queueIndex:1});
});

it("a natural advance keeps a pending selection; a later command supersedes it", async () => {
  const {QueueIntents} = await import("./queue-catalog");
  const intents = new QueueIntents();
  const selecting = intents.command();
  const natural = intents.advance();
  expect(intents.selection).toBe(selecting);
  expect(intents.navigation).toBe(natural);
  const later = intents.command();
  expect(intents.selection).toBe(later);
  expect(intents.navigation).not.toBe(natural);
});
