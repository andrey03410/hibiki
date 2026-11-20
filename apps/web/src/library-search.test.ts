import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ItemDto, SourceDto } from "@hibiki/contracts";
import { LibrarySearchControls } from "./LibrarySearchControls";
import {
  countLibraryTags,
  defaultLibrarySearch,
  libraryFilterConditions,
  librarySourceBadges,
  libraryTagChoices,
  matchesSearch,
  resetLibraryFilters,
  searchLibrary,
  selectLibraryResults,
} from "./library-search";

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
  it("shows YouTube and a working local audio copy as separate card sources", () => {
    const entry = item("mixed", { sources: [remote, { ...local, mime: "audio/mp4" }] });
    expect(librarySourceBadges(entry)).toEqual([
      { provider: "youtube", status: "available", label: "YouTube" },
      { provider: "local", status: "available", label: "Аудиокопия на устройстве" },
    ]);
  });

  it("distinguishes sources awaiting a check, missing local copies, and records without a source", () => {
    const entry = item("unknown", { sources: [
      { ...remote, status: "unknown" }, { ...local, streamUrl: undefined, status: "unavailable" },
    ] });
    expect(librarySourceBadges(entry)).toEqual([
      { provider: "youtube", status: "unknown", label: "YouTube · доступность не проверена" },
      { provider: "local", status: "unavailable", label: "Локальная копия недоступна" },
    ]);
    expect(librarySourceBadges(item("none", { sources: [] }))).toEqual([
      { provider: "none", status: "unavailable", label: "Нет источника" },
    ]);
  });
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

  it("counts each tagged record once", () => {
    expect(countLibraryTags([
      item("both"), item("repeat-tag", { tags: [tag, tag] }), item("untagged", { tags: [] }),
    ])).toEqual(new Map([[tag.id, 2], [extra.id, 1]]));
  });

  it("prioritizes popular tags in the preview and searches the entire catalog", () => {
    const catalog = Array.from({ length: 40 }, (_, index) => ({
      ...tag, id: String(index + 1), name: `Дорога ${index + 1}`,
    }));
    const counts = new Map([["8", 15], ["9", 15], ["1", 2]]);
    expect(libraryTagChoices(catalog, counts, "", false).map(({ id }) => id)).toEqual(["8", "9", "1", "2", "3", "4"]);
    expect(libraryTagChoices(catalog, counts, " 40 ДОРОГА ", false).map(({ id }) => id)).toEqual(["40"]);
    const allTags = libraryTagChoices(catalog, counts, "", true);
    expect(allTags).toHaveLength(40);
    expect(allTags[39].id).toBe("40");
  });

  it("removes just the requested active condition and counts advanced filters separately", () => {
    const search = {
      ...defaultLibrarySearch, kind: "video", tagIds: [tag.id, extra.id],
      provider: "youtube", minDuration: "0", maxDuration: "-1",
    } satisfies typeof defaultLibrarySearch;
    const conditions = libraryFilterConditions(search, [tag, extra]);

    expect(conditions.filter(({ advanced }) => advanced).map(({ key }) => key))
      .toEqual(["provider", "minDuration"]);
    const updated = conditions.find(({ key }) => key === "provider")!.clear(search);
    const items = [item("youtube"), item("local", { sources: [local] }),
      item("audio", { kind: "audio" }), item("partial", { tags: [extra] })];
    expect(searchLibrary(items, updated).map(({ id }) => id)).toEqual(["local", "youtube"]);
    expect(conditions.find(({ key }) => key === `tag:${tag.id}`)!.clear(updated).tagIds).toEqual([extra.id]);
  });

  it("resets filters while keeping the query and selected sort", () => {
    const cleared = resetLibraryFilters({
      ...defaultLibrarySearch,
      query: "  opening ", kind: "audio", tagIds: [tag.id], favoriteOnly: true,
      provider: "local", availability: "available", minDuration: "30", addedFrom: "2026-11-18",
      sort: "title-desc",
    });
    expect(cleared).toEqual({ ...defaultLibrarySearch, query: "  opening ", sort: "title-desc" });
    expect(searchLibrary([
      item("a", { title: "A" }), item("b", { title: "B", favorite: false, tags: [] }),
      item("c", { title: "C", originalTitle: "Ending" }),
    ], cleared).map(({ id }) => id)).toEqual(["b", "a"]);
  });

  it("applies select-all to current results while keeping hidden records selected", () => {
    const results = searchLibrary([item("b"), item("a"), item("hidden", { originalTitle: "Ending" })], {
      ...defaultLibrarySearch, query: "opening", sort: "title-asc",
    });
    const selected = selectLibraryResults(["hidden", "a"], results, true);
    expect(selected).toEqual(["hidden", "a", "b"]);
    expect(selectLibraryResults(selected, results, false)).toEqual(["hidden"]);
  });

  it("shows quick filters and removable advanced conditions while the advanced panel is collapsed", () => {
    const html = renderToStaticMarkup(createElement(LibrarySearchControls, {
      value: { ...defaultLibrarySearch, kind: "video", tagIds: [tag.id], provider: "youtube" },
      tags: [tag], count: 3, view: "cards", onViewChange: () => {}, onChange: () => {}, onPlay: () => {},
    }));
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Видео<\/button>/);
    expect(html).toContain('aria-label="Карточки" aria-pressed="true"');
    expect(html).toMatch(/<button[^>]*aria-label="Фильтры \(1\)"[^>]*aria-expanded="false"[^>]*>/);
    expect(html).toContain('aria-label="Снять фильтр «YouTube»"');
    expect(html).toContain('role="status">Найдено: 3');
    expect(html).toContain("Сбросить фильтры");
  });

  it("offers one direct playback action for a filtered collection", () => {
    const html = renderToStaticMarkup(createElement(LibrarySearchControls, {
      value: defaultLibrarySearch, tags: [], count: 3, view: "list",
      onViewChange: () => {}, onChange: () => {}, onPlay: () => {},
    }));
    expect(html).toMatch(/<button[^>]+aria-label="Играть выдачу"[^>]*>/);
    expect(html).not.toContain("Слушать найденное");
  });

  it("shows title search, tag search and counted tag choices without opening any filters", () => {
    const otherTags = Array.from({ length: 7 }, (_, index) => ({ ...extra, id: `tag-${index}`, name: `Тег ${index}` }));
    const html = renderToStaticMarkup(createElement(LibrarySearchControls, {
      value: { ...defaultLibrarySearch, tagIds: [tag.id, otherTags[6].id] },
      tags: [...otherTags, tag], tagCounts: new Map([[tag.id, 12]]), count: 3, view: "list",
      onViewChange: () => {}, onChange: () => {}, onPlay: () => {},
    }));
    expect(html).toContain('aria-label="Поиск по названию, тегам и заметкам" placeholder="Поиск по названию"');
    expect(html).toContain('type="search" aria-label="Поиск тегов"');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Все теги/);
    const pressedTags = html.match(/<button class="library-tag-choice"[^>]*aria-pressed="true"[^>]*>[^]*?<\/button>/g) ?? [];
    expect(pressedTags).toHaveLength(1);
    expect(pressedTags[0]).toMatch(/>Саундтрек<\/span><span[^>]*>12<\/span>/);
    expect(html).not.toContain('aria-label="Снять фильтр «Саундтрек»"');
    expect(html).toContain('aria-label="Снять фильтр «Тег 6»"');
  });
});
