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
