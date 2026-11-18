import { describe, expect, it } from "vitest";
import type {
  ItemDto,
  PlaylistDefinition,
  PlaylistDto,
  Rule,
  TagDto,
} from "@hibiki/contracts";
import {
  collectReferences,
  resolvePlaylist,
  validatePlaylist,
} from "./index.js";

const opening: TagDto = { id: "opening", name: "Опенинги", color: "#ff0000" };
const ending: TagDto = { id: "ending", name: "Эндинги", color: "#00ff00" };
const item = (
  id: string,
  title: string,
  kind: "audio" | "video",
  duration: number | null,
  tags: TagDto[],
  local = true,
): ItemDto => ({
  id,
  title,
  originalTitle: title,
  kind,
  duration,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tags,
  sources: [
    {
      id: `s-${id}`,
      provider: local ? "local" : "youtube",
      status: "available",
    },
  ],
});
const items = [
  item("a", "Z song", "audio", 180, [opening]),
  item("b", "A video", "video", 90, [opening, ending], false),
  item("c", "A video", "video", null, [ending]),
  item("d", "D song", "audio", 60, []),
];
const definition = (
  rule: Rule,
  sort: PlaylistDefinition["sort"] = "source",
): PlaylistDefinition => ({ version: 1, rule, sort });
const playlist = (id: string, rule: Rule): PlaylistDto => ({
  id,
  title: id,
  description: "",
  definition: definition(rule),
  revision: 1,
  createdAt: "",
  updatedAt: "",
});
const library = {
  items,
  tags: [opening, ending],
  playlists: [playlist("op", { type: "tag", id: "opening" })],
};
const ids = (result: ReturnType<typeof resolvePlaylist>) =>
  result.items.map((entry) => entry.id);

describe("playlist resolution", () => {
  it("composes favorite/history rules using private summaries without leaking them", () => {
    const listeningLibrary = {
      ...library,
      items: library.items.map((entry) => ({ ...entry, favorite: true })),
      history: new Map([
        ["a", { launches: 1, completed: 1, skipped: 0, lastStartedAt: new Date(1) }],
        ["b", { launches: 5, completed: 0, skipped: 3, lastStartedAt: new Date(2) }],
      ]),
      now: new Date("2026-11-18T12:00:00Z"),
    };
    const neverStarted = resolvePlaylist(
      definition({ type: "intersection", rules: [
        { type: "tag", id: "ending" },
        { type: "history", condition: "never-started" },
      ] }),
      listeningLibrary,
    );
    expect(ids(neverStarted)).toEqual(["c"]);
    const oldFavorites = resolvePlaylist(
      definition({ type: "intersection", rules: [
        { type: "favorite" },
        { type: "history", condition: "last-started-before", days: 30 },
      ] }, "last-started"),
      listeningLibrary,
    );
    expect(ids(oldFavorites)).toEqual(["a", "b"]);
    expect(oldFavorites.items[0]).not.toHaveProperty("history");
    expect(ids(resolvePlaylist(
      definition({ type: "history", condition: "skipped-at-least", count: 3 }),
      listeningLibrary,
    ))).toEqual(["b"]);
  });

  it("combines dynamic playlists, tags and manual items in stable mixed-media order", () => {
    const input = definition({
      type: "union",
      rules: [
        { type: "playlist", id: "op" },
        { type: "tag", id: "ending" },
        { type: "items", ids: ["d", "a"] },
      ],
    });
    const result = resolvePlaylist(input, library);
    expect(ids(result)).toEqual(["a", "b", "c", "d"]);
    expect(result.total).toBe(4);
    expect(result.duration).toBe(330);
    expect(result.reasons.b?.join(" ")).toMatch(/Опенинги/);
    expect(result.reasons.b?.join(" ")).toMatch(/Эндинги/);
    expect(result.reasons.b?.join(" ")).toMatch(/op/);
    const updated = {
      ...library,
      items: [...items, item("e", "New", "audio", 10, [opening])],
    };
    expect(ids(resolvePlaylist(input, updated))).toEqual([
      "a",
      "b",
      "e",
      "c",
      "d",
    ]);
  });

  it("makes explicit exclusions win even when another union branch includes the item", () => {
    const input = definition({
      type: "union",
      rules: [
        {
          type: "difference",
          include: { type: "tag", id: "opening" },
          exclude: { type: "items", ids: ["b"] },
        },
        { type: "items", ids: ["b", "d"] },
      ],
    });
    const result = resolvePlaylist(input, library);
    expect(ids(result)).toEqual(["a", "d"]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]).toMatchObject({ id: "b", title: "A video" });
    expect(result.excluded[0]?.reasons.join(" ")).toMatch(/Исключ/);
  });

  it("intersects rules and filters by ready local sources and known duration", () => {
    const result = resolvePlaylist(
      definition({
        type: "intersection",
        rules: [
          { type: "tag", id: "ending" },
          { type: "filter", kind: "video", local: true },
        ],
      }),
      library,
    );
    expect(ids(result)).toEqual(["c"]);
    expect(
      ids(
        resolvePlaylist(
          definition({ type: "filter", minDuration: 60, maxDuration: 100 }),
          library,
        ),
      ),
    ).toEqual(["b", "d"]);
    expect(
      ids(
        resolvePlaylist(definition({ type: "filter", local: false }), library),
      ),
    ).toEqual(["b"]);
    const unavailable = {
      ...library,
      items: [
        {
          ...items[0]!,
          sources: [
            {
              id: "source",
              provider: "local" as const,
              status: "unavailable" as const,
            },
          ],
        },
      ],
    };
    expect(
      ids(
        resolvePlaylist(
          definition({ type: "filter", local: true }),
          unavailable,
        ),
      ),
    ).toEqual([]);
  });

  it("preserves stable ties, manual source order and unknown durations at the end", () => {
    const rule: Rule = { type: "items", ids: ["c", "b", "a", "d", "b"] };
    expect(
      ids(
        resolvePlaylist(
          { ...definition(rule), manualOrder: ["d", "a"] },
          library,
        ),
      ),
    ).toEqual(["d", "a", "c", "b"]);
    expect(ids(resolvePlaylist(definition(rule, "title"), library))).toEqual([
      "c",
      "b",
      "d",
      "a",
    ]);
    expect(ids(resolvePlaylist(definition(rule, "duration"), library))).toEqual(
      ["d", "b", "a", "c"],
    );
    expect(ids(resolvePlaylist(definition(rule, "newest"), library))).toEqual([
      "c",
      "b",
      "a",
      "d",
    ]);
  });

  it("respects ordering and exclusions inherited from referenced playlists", () => {
    const nested = playlist("nested", {
      type: "difference",
      include: { type: "items", ids: ["a", "b", "d"] },
      exclude: { type: "items", ids: ["b"] },
    });
    nested.definition.sort = "title";
    expect(
      ids(
        resolvePlaylist(
          definition({
            type: "union",
            rules: [
              { type: "playlist", id: "nested" },
              { type: "items", ids: ["b", "c"] },
            ],
          }),
          { ...library, playlists: [nested] },
        ),
      ),
    ).toEqual(["d", "a", "c"]);
  });

  it("does not exclude an item twice through a nested difference", () => {
    const rule: Rule = {
      type: "difference",
      include: { type: "items", ids: ["a", "b", "c"] },
      exclude: {
        type: "difference",
        include: { type: "items", ids: ["b", "c"] },
        exclude: { type: "items", ids: ["c"] },
      },
    };
    expect(ids(resolvePlaylist(definition(rule), library))).toEqual(["a", "c"]);
  });
});

describe("playlist graph validation", () => {
  it.each<Rule>([
    { type: "items", ids: ["foreign-item"] },
    { type: "tag", id: "foreign-tag" },
    { type: "playlist", id: "foreign-playlist" },
  ])("rejects missing or foreign references: %j", (rule) => {
    expect(validatePlaylist(definition(rule), library).valid).toBe(false);
    expect(() => resolvePlaylist(definition(rule), library)).toThrow(
      /не найден|недоступ/i,
    );
  });

  it("rejects direct and indirect cycles on a proposed replacement", () => {
    const graph = {
      ...library,
      playlists: [
        playlist("one", { type: "items", ids: ["a"] }),
        playlist("two", { type: "playlist", id: "one" }),
      ],
    };
    expect(
      validatePlaylist(
        definition({ type: "playlist", id: "one" }),
        graph,
        "one",
      ).valid,
    ).toBe(false);
    expect(
      validatePlaylist(
        definition({ type: "playlist", id: "two" }),
        graph,
        "one",
      ).valid,
    ).toBe(false);
    expect(() =>
      resolvePlaylist(
        definition({ type: "playlist", id: "two" }),
        graph,
        "one",
      ),
    ).toThrow(/цикл/i);
  });

  it("detects invalid existing references and bounds expanded graphs", () => {
    const bad = {
      ...library,
      playlists: [playlist("broken", { type: "tag", id: "missing" })],
    };
    expect(
      validatePlaylist(definition({ type: "playlist", id: "broken" }), bad)
        .valid,
    ).toBe(false);
    const graph = Array.from({ length: 60 }, (_, i) =>
      playlist(
        `p${i}`,
        i === 59
          ? { type: "items", ids: ["a"] }
          : { type: "playlist", id: `p${i + 1}` },
      ),
    );
    expect(
      validatePlaylist(definition({ type: "playlist", id: "p0" }), {
        ...library,
        playlists: graph,
      }).valid,
    ).toBe(false);
  });

  it("rejects exponential reference expansion within the per-document depth limit", () => {
    const graph = Array.from({ length: 15 }, (_, i) =>
      playlist(
        `p${i}`,
        i === 14
          ? { type: "items", ids: ["a"] }
          : {
              type: "union",
              rules: [
                { type: "playlist", id: `p${i + 1}` },
                { type: "playlist", id: `p${i + 1}` },
              ],
            },
      ),
    );
    const result = validatePlaylist(
      definition({ type: "playlist", id: "p0" }),
      { ...library, playlists: graph },
    );
    expect(result.valid).toBe(false);
    expect(result.issues.join(" ")).toMatch(/бюджет/);
  });

  it("rejects hidden missing references in the manual order and malformed dependencies", () => {
    expect(
      validatePlaylist(
        {
          ...definition({ type: "items", ids: ["a"] }),
          manualOrder: ["foreign-item"],
        },
        library,
      ).valid,
    ).toBe(false);
    const malformed = playlist("bad", { type: "items", ids: ["a"] });
    malformed.definition.version = 2 as 1;
    expect(
      validatePlaylist(definition({ type: "playlist", id: "bad" }), {
        ...library,
        playlists: [malformed],
      }).valid,
    ).toBe(false);
  });

  it("collects and deduplicates every explicit reference including exclusions", () => {
    expect(
      collectReferences({
        type: "difference",
        include: {
          type: "union",
          rules: [
            { type: "playlist", id: "op" },
            { type: "items", ids: ["a", "a"] },
          ],
        },
        exclude: { type: "tag", id: "ending" },
      }),
    ).toEqual({
      itemIds: ["a"],
      tagIds: ["ending"],
      playlistIds: ["op"],
    });
  });
});
