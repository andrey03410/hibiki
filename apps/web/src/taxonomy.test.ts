import { expect, it } from "vitest";
import type { TagDto } from "@hibiki/contracts";
import { TagCatalog, nextPerformanceFilter, batchTagChanges, compositionDelta } from "./taxonomy";
const tag = (
  id: string,
  name: string,
  group: TagDto["group"],
  parentIds: string[] = [],
  aliases: string[] = [],
): TagDto => ({ id, name, group, color: "#abc", parentIds, aliases });

it("resolves joint productions through both paths and normalizes aliases without hiding collisions", () => {
  const first = tag("a", "Аниме", "source"),
    second = tag("b", "ВН", "source");
  const production = tag("c", "Работа", "source", ["a", "b"], ["  Title  "]);
  const artist = tag("d", "Автор", "artist", [], ["Title"]);
  const catalog = new TagCatalog([first, second, production, artist, { ...artist, id: "e", archived: true }]);
  expect(catalog.paths("c")).toEqual(["Аниме › Работа", "ВН › Работа"]);
  expect(catalog.find(" tiTLE ", "source").map((t) => t.id)).toEqual(["c"]);
  expect(
    catalog
      .find(" title ")
      .map((t) => t.id)
      .sort(),
  ).toEqual(["c", "d"]);
});
it("toggles each vocal half independently and gives OST priority when chosen", () => {
  expect(nextPerformanceFilter("male", "female")).toBe("vocal");
  expect(nextPerformanceFilter("vocal", "male")).toBe("female");
  expect(nextPerformanceFilter("female", "female")).toBe("");
  expect(nextPerformanceFilter("vocal", "ost")).toBe("ost");
  expect(nextPerformanceFilter("ost", "male")).toBe("male");
});
it("replaces only the edited group and previews the exact losses per record", () => {
  const a = tag("a", "Первая", "mood"),
    b = tag("b", "Другая", "mood"),
    g = tag("g", "Жанр", "genre");
  const items = [
    { id: "one", tags: [a, g] },
    { id: "two", tags: [b, g] },
  ];
  const result = batchTagChanges(items, ["b"], "mood", "replace");
  expect(result.changes).toEqual([{ id: "one", tagIds: ["g", "b"] }]);
  expect(result.removed).toEqual([{ tag: a, count: 1 }]);
});

it("previews additions and removals even when an exact rule and its replacement have the same count", () => {
  const old = [
    { id: "a", title: "Первая" },
    { id: "b", title: "Общая" },
  ];
  const next = [
    { id: "b", title: "Общая" },
    { id: "c", title: "Новая" },
  ];
  expect(compositionDelta(old, next)).toEqual({
    added: [{ id: "c", title: "Новая" }],
    removed: [{ id: "a", title: "Первая" }],
  });
});
