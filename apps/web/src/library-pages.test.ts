import { describe, expect, it, vi } from "vitest";
import type { ItemDto } from "@hibiki/contracts";
import { ApiError } from "./api";
import { defaultLibrarySearch } from "./library-search";
import { LibraryPages, searchBody } from "./library-pages";

const rows = (start: number, count: number) => Array.from({length: count}, (_, i) => ({id: String(i + start)} as ItemDto));
const first = {items: rows(1, 100), total: 201, nextCursor: "100"};

describe("library pages", () => {
  it("fetches one page until requested, coalesces repeated intersections and stops at the end", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({items: rows(101, 100), total: 201, nextCursor: "200"})
      .mockResolvedValueOnce({items: rows(201, 1), total: 201, nextCursor: null});
    const pages = new LibraryPages(fetch);
    await pages.refresh();
    expect(pages.snapshot().items).toHaveLength(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    await Promise.all([pages.more(), pages.more()]);
    await pages.more();
    await pages.more();
    expect(fetch.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "100", "200"]);
    expect(pages.snapshot().items.map(row => row.id)).toEqual(rows(1, 201).map(row => row.id));
  });

  it("retains fresh first-page facet counts when refreshing several loaded pages", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({...first, tagCounts: {artist: 3}})
      .mockResolvedValueOnce({items: rows(101, 1), total: 101, nextCursor: null})
      .mockResolvedValueOnce({...first, tagCounts: {artist: 2}})
      .mockResolvedValueOnce({items: rows(101, 1), total: 101, nextCursor: null});
    const pages = new LibraryPages(fetch);
    await pages.refresh();
    await pages.more();
    await pages.refresh();
    expect(pages.snapshot().tagCounts).toEqual({artist: 2});
  });

  it("keeps successful pages when appending fails and retries the failed cursor", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(Error("offline"))
      .mockResolvedValueOnce({items: rows(101, 1), total: 101, nextCursor: null});
    const pages = new LibraryPages(fetch);
    await pages.refresh();
    await pages.more();
    expect(pages.snapshot().error).toBe("offline");
    expect(pages.snapshot().items).toEqual(first.items);
    await pages.retry();
    expect(pages.snapshot().items).toHaveLength(101);
    expect(pages.snapshot().error).toBe("");
  });

  it("ignores an obsolete page that arrives after a refresh", async () => {
    let finish!: (value: typeof first) => void;
    const fetch = vi.fn().mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}))
      .mockResolvedValueOnce({items: rows(900, 1), total: 1, nextCursor: null});
    const pages = new LibraryPages(fetch);
    await pages.refresh();
    const pending = pages.more();
    await pages.refresh();
    finish(first);
    await pending;
    expect(pages.snapshot().items).toEqual(rows(900, 1));
  });

  it("updates displayed borrowed rows without fetching or replacing the rest of the page", async () => {
    const [local, next] = rows(1, 2);
    const shared: ItemDto = { ...next!, shared: { available: true, sharedBy: "Автор" } };
    const closed: ItemDto = { ...shared, shared: { available: false, sharedBy: "Автор" } };
    const load = vi.fn(async () => ({ items: [local!, shared], total: 2, nextCursor: null }));
    const check = vi.fn(async () => [closed]);
    const pages = new LibraryPages(load);
    await pages.refresh();
    await pages.revalidateShared(check);
    expect(check).toHaveBeenCalledWith([shared.id]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(pages.snapshot().items).toEqual([local, closed]);
    expect(pages.snapshot().items[0]).toBe(local);
    expect(pages.snapshot().loading).toBe(false);
  });

  it("refreshes loaded filter pages without interrupting the view when a poll fails", async () => {
    const pages = new LibraryPages(vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("offline")));
    await pages.refresh();
    const before = pages.snapshot();
    await pages.refresh(true);
    expect(pages.snapshot()).toBe(before);
  });
});

it("aborts an obsolete network read while debouncing the next text request", async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn().mockResolvedValue(first);
    const pages = new LibraryPages(read);
    pages.open(defaultLibrarySearch);
    const signal: AbortSignal = read.mock.calls[0]![1];
    const query = { ...defaultLibrarySearch, query: "a" };
    pages.open(query, defaultLibrarySearch);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    pages.open({ ...query, query: "ab" }, query);
    await vi.advanceTimersByTimeAsync(149);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    pages.open({ ...query, tagIds: ["tag"] }, query);
    expect(read).toHaveBeenCalledTimes(3);
    pages.open(defaultLibrarySearch, query);
    expect(read).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});

it("keeps the page selection for subsequent pages, revalidation and the full-order request", async () => {
  const firstPage = { ...first, selectionId: "snapshot1", tagCounts: { mood: 2 } };
  const second = { items: rows(101, 1), total: 101, nextCursor: null };
  const read = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(second)
    .mockResolvedValueOnce(firstPage).mockResolvedValueOnce(second);
  const pages = new LibraryPages(read);
  await pages.refresh();
  await pages.more();
  await pages.refresh(true);
  expect(read.mock.calls[2]![2]).toBe("snapshot1");
  expect(pages.snapshot()).toMatchObject({ selectionId: "snapshot1", tagCounts: { mood: 2 } });
  const body = searchBody({ ...defaultLibrarySearch, sort: "recent", previousSort: "popular" }, pages.snapshot().selectionId);
  expect(body.selectionId).toBe("snapshot1");
  expect(body.filters).not.toHaveProperty("previousSort");
});

it("refetches the loaded depth with one current snapshot when the old snapshot expires", async () => {
  const read = vi.fn().mockResolvedValueOnce({ ...first, selectionId: "old" })
    .mockResolvedValueOnce({ ...first, nextCursor: "200" })
    .mockRejectedValueOnce(new ApiError("library_changed", "expired", 409))
    .mockResolvedValueOnce({ ...first, items: rows(500, 100), selectionId: "new" })
    .mockResolvedValueOnce({ items: rows(600, 100), total: 300, nextCursor: "200" });
  const pages = new LibraryPages(read);
  await pages.refresh();
  await pages.more();
  await pages.more();
  expect(read).toHaveBeenCalledTimes(5);
  expect(pages.snapshot()).toMatchObject({ selectionId: "new", items: rows(500, 200), nextCursor: "200", error: "" });
});

it("recovers the full queue from a new first page when its original snapshot expired", async () => {
  const read = vi.fn()
    .mockResolvedValueOnce({...first, selectionId: "expired"})
    .mockResolvedValueOnce({...first, items: rows(400, 100), selectionId: "fresh"});
  const pages = new LibraryPages(read);
  await pages.refresh();
  const ids = vi.fn()
    .mockRejectedValueOnce(new ApiError("library_changed", "expired", 409))
    .mockResolvedValueOnce(["new-order"]);
  expect(await pages.fullOrder("expired", ids)).toEqual(["new-order"]);
  expect(ids.mock.calls).toEqual([["expired"], ["fresh"]]);
  expect(pages.snapshot()).toMatchObject({ selectionId: "fresh", items: rows(400, 100) });
});

it("dispatches a pasted or replaced search immediately", () => {
  const read = vi.fn().mockResolvedValue(first);
  new LibraryPages(read).open({...defaultLibrarySearch,query:"Название записи"}, {...defaultLibrarySearch,query:"Другая запись"});
  expect(read).toHaveBeenCalledTimes(1);
});

it("debounces single-character insertions and deletions at any position", async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn().mockResolvedValue(first);
    const pages = new LibraryPages(read);
    const steps = ["трек", "тАрек", "тБАрек", "БАрек", "Арек", "Ар🎵ек", "Арек"];
    for (let i = 1; i < steps.length; i++) {
      pages.open({...defaultLibrarySearch,query:steps[i]!}, {...defaultLibrarySearch,query:steps[i-1]!});
      await vi.advanceTimersByTimeAsync(100);
      expect(read).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(50);
    expect(read).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("keeps mounted rows and loaded depth while a favorite change replaces a ranked selection", async () => {
  const next = {items: rows(101, 2), total: 102, nextCursor: null};
  let deliver!: (value: typeof first & {selectionId: string}) => void;
  const read = vi.fn().mockResolvedValueOnce({...first, selectionId: "before"})
    .mockResolvedValueOnce(next)
    .mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }))
    .mockResolvedValueOnce(next);
  const pages = new LibraryPages(read);
  await pages.refresh();
  await pages.more();
  const filters = {...defaultLibrarySearch, sort: "popular" as const};
  pages.open(filters, filters);
  expect(pages.snapshot().items).toHaveLength(102);
  deliver({...first, items: first.items.map((row, i) => i ? row : {...row, favorite:true}), selectionId: "after"});
  await vi.waitFor(() => expect(pages.snapshot().selectionId).toBe("after"));
  expect(pages.snapshot().items).toHaveLength(102);
  expect(pages.snapshot().items[0]?.favorite).toBe(true);
});

it("updates only the affected row and removes it from a favorites-only result", async () => {
  const pages = new LibraryPages(vi.fn().mockResolvedValue(first));
  await pages.refresh();
  const [before, other] = pages.snapshot().items;
  pages.favoriteChanged(before!.id, true, false);
  expect(pages.snapshot().items[0]).toMatchObject({ id: before!.id, favorite: true });
  expect(pages.snapshot().items[1]).toBe(other);
  pages.favoriteChanged(before!.id, false, true);
  expect(pages.snapshot().items[0]).toBe(other);
  expect(pages.snapshot().total).toBe(first.total - 1);
});
