import { describe, expect, it } from "vitest";
import type { ItemDto, SourceDto } from "@hibiki/contracts";
import { defaultLibrarySearch, matchesSearch, searchLibrary } from "./library-search";

const tag = { id: "tag", name: "Саундтрек", color: "#b8a5ff" };
const extra = { id: "extra", name: "Аниме", color: "#b8a5ff" };
const remote: SourceDto = { id: "yt", provider: "youtube", status: "available" };
const local: SourceDto = { id: "local", provider: "local", status: "available", streamUrl: "/files/a" };

function item(id: string, change: Partial<ItemDto> = {}): ItemDto {
  return {
    id, title: `Запись ${id}`, originalTitle: "Opening", kind: "video",
    duration: 120, createdAt: new Date(2026, 10, 18, 23, 59).toISOString(),
    updatedAt: "2026-11-18T15:00:00.000Z", tags: [tag, extra], sources: [remote],
    favorite: true, ...change,
  };
}

describe("library search", () => {
  it("intersects text, selected tags, kind, duration, inclusive date bounds, provider, availability and favorite", () => {
    const items = [
      item("match"), item("other-kind", { kind: "audio" }),
      item("missing-tag", { tags: [tag] }), item("too-short", { duration: 59 }),
      item("too-long", { duration: 181 }), item("no-duration", { duration: null }),
      item("old", { createdAt: new Date(2026, 10, 17, 23, 59).toISOString() }),
      item("new", { createdAt: new Date(2026, 10, 19).toISOString() }),
      item("local-only", { sources: [local] }),
      item("unknown", { sources: [{ ...remote, status: "unknown" }] }),
      item("unmarked", { favorite: undefined }),
      item("other-title", { originalTitle: "Ending" }),
    ];
    const result = searchLibrary(items, {
      ...defaultLibrarySearch,
      query: "OPENING саундтрек", kind: "video", tagIds: [tag.id, extra.id],
      minDuration: "60", maxDuration: "180", addedFrom: "2026-11-18",
      addedThrough: "2026-11-18", provider: "youtube", availability: "available",
      favoriteOnly: true,
    });
    expect(result.map(({ id }) => id)).toEqual(["match"]);
  });

  it("finds records from their own or their sources’ notes", () => {
    const items = [item("entry"), item("source", { sources: [local] }), item("other")];
    const result = searchLibrary(items, { ...defaultLibrarySearch, query: "  ВЕЧЕР " }, {
      item: { entry: "Тихий вечер" }, source: { local: "На вечер в дорогу" },
      tag: { tag: "вечер" }, playlist: { other: "вечер" },
    });
    expect(result.map(({ id }) => id)).toEqual(["entry", "source"]);
  });

  it("distinguishes a local copy from a working one and unknown from unavailable", () => {
    const items = [
      item("working", { sources: [local] }),
      item("broken", { sources: [{ ...local, status: "unavailable" }] }),
      item("unknown", { sources: [{ ...local, status: "unknown" }] }),
      item("mixed", { sources: [local, { ...remote, status: "unknown" }] }),
      item("none", { sources: [] }),
    ];
    const find = (filter: Partial<typeof defaultLibrarySearch>) =>
      searchLibrary(items, { ...defaultLibrarySearch, ...filter }).map(({ id }) => id);
    expect(find({ provider: "local" })).toEqual(["broken", "mixed", "unknown", "working"]);
    expect(find({ provider: "working-local" })).toEqual(["mixed", "working"]);
    expect(find({ availability: "unknown" })).toEqual(["unknown"]);
    expect(find({ availability: "unavailable" })).toEqual(["broken", "none"]);
  });

  it("sorts in both directions and keeps unknown duration after known values", () => {
    const items = [
      item("x", { title: "В", duration: 0 }),
      item("y", { title: "А", duration: 45, createdAt: "2026-01-01T00:00:00.000Z" }),
      item("z", { title: "Б", duration: null, createdAt: "2026-03-01T00:00:00.000Z" }),
    ];
    const ids = (sort: typeof defaultLibrarySearch.sort) =>
      searchLibrary(items, { ...defaultLibrarySearch, sort }).map(({ id }) => id);
    expect(ids("duration-asc")).toEqual(["x", "y", "z"]);
    expect(ids("duration-desc")).toEqual(["y", "x", "z"]);
    expect(ids("title-asc")).toEqual(["y", "z", "x"]);
    expect(ids("title-desc")).toEqual(["x", "z", "y"]);
    expect(ids("added-asc")).toEqual(["y", "z", "x"]);
    expect(ids("added-desc")).toEqual(["x", "z", "y"]);
  });

  it("matches the same normalized terms on tag and playlist screens", () => {
    expect(matchesSearch("  НОЧЬ город ", "Прогулки: город", "Слушать ночью")).toBe(true);
    expect(matchesSearch("ночь город", "Прогулки: город")).toBe(false);
  });
});
