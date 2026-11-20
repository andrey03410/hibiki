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
