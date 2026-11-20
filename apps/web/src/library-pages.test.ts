import { describe, expect, it, vi } from "vitest";
import type { ItemDto } from "@hibiki/contracts";
import { LibraryPages } from "./library-pages";

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
});
