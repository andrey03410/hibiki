import { afterEach, expect, it, vi } from "vitest";
import { activeJobsInterval, overviewInterval, pollWhileVisible } from "./use-sharing-request";
import { PlaylistDetails } from "./playlist-detail";
import { validateOverview } from "./library-pages";
import type { LibraryCardOverviewDto } from "@hibiki/contracts";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("polls progress at three seconds and the overview at ten, resumes on focus and visibility", async () => {
  vi.useFakeTimers();
  const doc = Object.assign(new EventTarget(), {hidden:false});
  const win = Object.assign(new EventTarget(), {setInterval, clearInterval});
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  const overview = vi.fn(async () => {});
  const jobs = vi.fn(async () => {});
  const endOverview = pollWhileVisible(overview, overviewInterval);
  const endJobs = pollWhileVisible(jobs, activeJobsInterval);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(overview).toHaveBeenCalledTimes(1);
  expect(jobs).toHaveBeenCalledTimes(3);
  endJobs();
  doc.hidden = true;
  await vi.advanceTimersByTimeAsync(30_000);
  win.dispatchEvent(new Event("focus"));
  expect(overview).toHaveBeenCalledTimes(1);
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  win.dispatchEvent(new Event("focus"));
  expect(overview).toHaveBeenCalledTimes(2);
  expect(jobs).toHaveBeenCalledTimes(3);
  endOverview();
});

it("rejects malformed overviews before they can replace the last valid state", () => {
  const prior: LibraryCardOverviewDto = {tags:[],playlists:[],jobs:[],total:2,revision:"5",overviewToken:"cards.5.1",tagCounts:{}};
  let visible = validateOverview(prior);
  expect(() => {
    visible = validateOverview({...prior, jobs:[null]} as unknown as LibraryCardOverviewDto);
  }).toThrow();
  expect(visible).toBe(prior);
});

it("coalesces detail reads across effect replacement but discards the obsolete reader", async () => {
  let finish!: (value: Response) => void;
  const read = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;}));
  vi.stubGlobal("fetch", read);
  const details = new PlaylistDetails();
  const old = new AbortController();
  const first = details.read("/playlists/p/detail?limit=24", "v1", "high", old.signal);
  old.abort();
  const second = details.read("/playlists/p/detail?limit=24", "v1", "high", new AbortController().signal);
  expect(read).toHaveBeenCalledTimes(1);
  finish(Response.json({usesHistory:true}));
  await expect(first).rejects.toMatchObject({name:"AbortError"});
  await expect(second).resolves.toMatchObject({usesHistory:true});
});
