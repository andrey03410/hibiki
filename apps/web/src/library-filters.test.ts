import { describe, expect, it } from "vitest";
import type { TagDto } from "@hibiki/contracts";
import { TagCatalog } from "./taxonomy";
import { defaultLibrarySearch } from "./library-search";
import { currentSource, facetOptions, setGroupMode, sourceChildren, sourceSiblings, sourceTrail, tagSetsFor, tagSuggestions, toggleTag, withSource } from "./library-filters";
import { searchBody } from "./library-pages";

const tag = (id: string, name: string, group: TagDto["group"], parentIds: string[] = [], aliases: string[] = []): TagDto =>
  ({ id, name, color: "#b8a5ff", group, parentIds, aliases });
const tags = [
  tag("game", "Игра", "source"), tag("vn", "ВН", "source"),
  tag("w3", "The Witcher 3", "source", ["game"]), tag("bw", "Blood and Wine", "source", ["w3"]), tag("hos", "Hearts of Stone", "source", ["w3"]),
  tag("key", "Key", "source", ["vn"], ["key ost"]), tag("cl", "CLANNAD", "source", ["key"], ["Кланнад"]),
  tag("piano", "Piano", "genre"), tag("celtic", "Celtic", "genre"), tag("folk", "Folk", "genre"),
  tag("calm", "Спокойная", "mood"), tag("epic", "Эпичная", "mood"),
  tag("old", "Old", "genre"),
];
tags[tags.length - 1]!.archived = true;
const catalog = new TagCatalog(tags);
const search = (tagIds: string[], extra = {}) => ({ ...defaultLibrarySearch, tagIds, ...extra });

describe("tag sets", () => {
  it("groups selected tags: AND between groups, OR inside", () => {
    expect(tagSetsFor(search(["calm", "piano", "w3", "celtic"]), catalog.byId)).toEqual([
      { group: "source", ids: ["w3"] },
      { group: "genre", ids: ["piano", "celtic"] },
      { group: "mood", ids: ["calm"] },
    ]);
  });
  it("marks groups that require all tags", () => {
    const value = setGroupMode(search(["piano", "celtic", "calm"]), "genre", true);
    expect(tagSetsFor(value, catalog.byId)).toEqual([
      { group: "genre", ids: ["piano", "celtic"], all: true },
      { group: "mood", ids: ["calm"] },
    ]);
    expect(setGroupMode(value, "genre", false).tagAll).toEqual([]);
  });
  it("sends no tag sets without tags so the plain request stays unchanged", () => {
    const body = searchBody(search([]), undefined, catalog.byId);
    expect(body.filters).not.toHaveProperty("tagSets");
    expect(body.filters).not.toHaveProperty("tagAll");
    const tagged = searchBody(search(["piano", "w3"], { tagAll: ["genre"] }), "sel", catalog.byId);
    expect(tagged.filters.tagSets).toEqual([{ group: "source", ids: ["w3"] }, { group: "genre", ids: ["piano"] }]);
    expect(tagged.selectionId).toBe("sel");
  });
  it("keeps archived and deleted saved tags as one strict set", () => {
    const byId = new Map([...catalog.byId, ["old", tags[tags.length - 1]!]]);
    expect(tagSetsFor(search(["piano", "missing", "old"]), byId)).toEqual([
      { group: "genre", ids: ["piano"] },
      { group: "extra", ids: ["missing", "old"], all: true },
    ]);
  });
});

describe("source navigation", () => {
  it("keeps one source node and other groups", () => {
    let value = toggleTag(search(["piano"]), catalog, "game");
    value = toggleTag(value, catalog, "w3");
    expect(value.tagIds).toEqual(["piano", "w3"]);
    expect(currentSource(value, catalog)?.id).toBe("w3");
    expect(withSource(value, catalog, undefined).tagIds).toEqual(["piano"]);
    expect(toggleTag(value, catalog, "piano").tagIds).toEqual(["w3"]);
  });
  it("builds the trail, children and siblings", () => {
    expect(sourceTrail(catalog, "bw").map(t => t.id)).toEqual(["game", "w3", "bw"]);
    expect(sourceChildren(catalog, "w3", { bw: 1, hos: 5 }).map(t => t.id)).toEqual(["hos", "bw"]);
    expect(sourceSiblings(catalog, "bw", {}).map(t => t.id)).toEqual(["hos"]);
    expect(sourceChildren(catalog, "", { vn: 3, game: 9 }).map(t => t.id)).toEqual(["game", "vn"]);
  });
});

describe("facets and suggestions", () => {
  it("puts selected first and zero counts apart", () => {
    const options = facetOptions(catalog, "genre", "", { piano: 2, celtic: 0, folk: 7 }, ["celtic"]);
    expect(options.present.map(t => t.id)).toEqual(["celtic", "folk", "piano"]);
    expect(options.absent).toEqual([]);
    const free = facetOptions(catalog, "genre", "", { piano: 2, celtic: 0, folk: 7 }, []);
    expect(free.present.map(t => t.id)).toEqual(["folk", "piano"]);
    expect(free.absent.map(t => t.id)).toEqual(["celtic"]);
    expect(facetOptions(catalog, "genre", "pi", undefined, []).present.map(t => t.id)).toEqual(["piano"]);
  });
  it("suggests tags by name, prefix and alias", () => {
    expect(tagSuggestions(catalog, "c", {})).toEqual([]);
    const result = tagSuggestions(catalog, "клан", { cl: 4 });
    expect(result).toEqual([{ tag: catalog.byId.get("cl"), path: "ВН › Key › CLANNAD", alias: "Кланнад", count: 4 }]);
    expect(tagSuggestions(catalog, "c", {}, 3).length).toBe(0);
    expect(tagSuggestions(catalog, "ce", { celtic: 1 }).map(s => s.tag.id)).toEqual(["celtic"]);
    expect(tagSuggestions(catalog, "in", { bw: 2 }).map(s => s.tag.id)).toEqual(["bw"]);
  });
});
