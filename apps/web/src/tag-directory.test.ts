import { expect, it } from "vitest";
import type { TagDto } from "@hibiki/contracts";
import { defaultLibrarySearch, librarySearchForTag } from "./library-search";
import { directoryRows } from "./tag-directory";
import { TagCatalog } from "./taxonomy";

const source = (id: string, name: string, parentIds: string[] = [], aliases: string[] = []): TagDto =>
  ({ id, name, parentIds, aliases, group: "source", color: "#bbaadd" });
const catalog = new TagCatalog([
  source("a", "Аниме"), source("b", "Игра"), source("k", "Kyoto Animation", ["a", "b"], ["KyoAni"]),
  source("w", "Ветер", ["k"]), source("s", "Ветер", ["b"]),
  { ...source("x", "Архив"), archived: true },
]);
const notes = { tag: { s: "аккорды" }, playlist: {}, item: {}, source: {} };
const counts = { a: 2, b: 2, k: 2, w: 1 };

it("enters all matching records using the last unrestricted library order", () => {
  const old = { ...defaultLibrarySearch, query: "текст", sort: "recent" as const, previousSort: "title-asc" as const,
    favoriteOnly: true, kind: "video" as const, tagMode: "or" as const, tagIds: ["old"], performanceFilter: "male" as const };
  expect(librarySearchForTag(old, "k")).toEqual({ ...defaultLibrarySearch, sort: "title-asc", previousSort: "title-asc", tagIds: ["k"] });
  expect(librarySearchForTag({ ...old, previousSort: undefined }, "a").sort).toBe("added-desc");
  expect(librarySearchForTag({ ...old, sort: "random", randomSeed: "seed" }, "a")).toMatchObject({ sort: "random", randomSeed: "seed" });
});

it("orders source siblings by unique count and expands the selected occurrence of a joint production", () => {
  const rows = directoryRows(catalog, counts, notes, "source", "", "count", new Set(['["a"]','["b"]','["b","k"]']));
  expect(rows.map(row => [row.tag.id, row.depth])).toEqual([["a",0],["k",1],["b",0],["k",1],["w",2],["s",1]]);
  expect(new Set(rows.map(row => row.key)).size).toBe(6);
});

it("finds paths, aliases and notes once per ID and uses the ID to resolve equal names", () => {
  const result = (query: string) => directoryRows(catalog, counts, notes, "all", query, "name", new Set());
  expect(result("KyoAni").map(row => row.tag.id)).toEqual(["k"]);
  expect(result("Игра ветер").map(row => row.tag.id)).toEqual(["s", "w"]);
  expect(result("аккорды").map(row => row.tag.id)).toEqual(["s"]);
  expect(result("").map(row => row.tag.id)).toEqual(["a", "s", "w", "b", "k"]);
  expect(result("ветер").find(row => row.tag.id === "w")?.path).toContain("Аниме › Kyoto Animation");
});
