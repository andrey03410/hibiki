import { expect, it, vi } from "vitest";
import { LibrarySelections } from "./library-selections";

const input = (ids: string[]) => ({ key: "filter", revision: "1", ids, tagCounts: { a: 3 } });

it("keeps an oversized order independent of the source array and serves slices crossing disk pages", () => {
  const cache = new LibrarySelections({ idBudget: 3 });
  const ids = Array.from({ length: 206 }, (_, i) => "ID-🎵-" + i);
  const expected = [...ids];
  const id = cache.add(input(ids));
  ids.fill("released");
  const saved = cache.get(id, "filter", "1");
  expect(saved.ids.slice(98, 103)).toEqual(expected.slice(98, 103));
  expect(saved.ids.slice(200, 300)).toEqual(expected.slice(200));
  expect(saved.ids.slice()).toEqual(expected);
  const small = cache.add(input(["a", "b", "c"]));
  expect(cache.get(id, "filter", "1").ids.length).toBe(206);
  expect(cache.get(small, "filter", "1").ids.slice()).toEqual(["a", "b", "c"]);
  cache.close();
});

it("releases the disk order on idle expiry, capacity eviction, and server shutdown", () => {
  vi.useFakeTimers();
  try {
    const cache = new LibrarySelections({ idBudget: 1, maxSelections: 1, ttl: 10_000 });
    const open = () => cache.get(cache.add(input(["first", "last"])), "filter", "1").ids;
    const expired = open();
    vi.advanceTimersByTime(10_000);
    expect(() => expired.slice()).toThrow();
    const evicted = open();
    const remaining = open();
    expect(() => evicted.slice()).toThrow();
    expect(remaining.slice()).toEqual(["first", "last"]);
    cache.close();
    expect(() => remaining.slice()).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
