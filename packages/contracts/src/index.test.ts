import { describe, expect, it } from "vitest";
import {
  jobCreateSchema,
  jobSchema,
  playlistDefinitionSchema,
  ruleSchema,
  settingsSchema,
  sourceSchema,
} from "./index.js";

describe("playlist contracts", () => {
  it("accepts versioned mixed-media composition", () => {
    const input = {
      version: 1,
      rule: {
        type: "union",
        rules: [
          { type: "items", ids: ["audio", "video"] },
          { type: "filter", local: true, minDuration: 30, maxDuration: 300 },
        ],
      },
      sort: "source",
      manualOrder: ["video", "audio"],
    };
    expect(playlistDefinitionSchema.parse(input)).toEqual(input);
  });

  it.each([
    { version: 2, rule: { type: "items", ids: [] }, sort: "source" },
    { version: 1, rule: { type: "sql", query: "SELECT *" }, sort: "source" },
    {
      version: 1,
      rule: { type: "filter", minDuration: 20, maxDuration: 10 },
      sort: "source",
    },
    { version: 1, rule: { type: "filter", minDuration: -1 }, sort: "source" },
    { version: 1, rule: { type: "filter", kind: "image" }, sort: "source" },
    { version: 1, rule: { type: "items", ids: [""] }, sort: "source" },
    {
      version: 1,
      rule: { type: "items", ids: [] },
      sort: "source",
      execute: "anything",
    },
  ])("rejects invalid and executable rule documents: %j", (input) => {
    expect(playlistDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it("rejects deeply nested, oversized and cyclic input without a stack overflow", () => {
    let deep: unknown = { type: "items", ids: [] };
    for (let i = 0; i < 100; i++) deep = { type: "union", rules: [deep] };
    expect(ruleSchema.safeParse(deep).success).toBe(false);
    expect(
      ruleSchema.safeParse({
        type: "union",
        rules: Array.from({ length: 600 }, () => ({ type: "items", ids: [] })),
      }).success,
    ).toBe(false);
    expect(
      ruleSchema.safeParse({
        type: "items",
        ids: Array.from({ length: 10001 }, (_, i) => String(i)),
      }).success,
    ).toBe(false);
    const cyclic: Record<string, unknown> = { type: "union" };
    cyclic.rules = [cyclic];
    expect(ruleSchema.safeParse(cyclic).success).toBe(false);
  });

  it("accepts reused rule objects when their serialized document has no cycle", () => {
    const leaf = { type: "items", ids: ["a"] };
    expect(
      ruleSchema.safeParse({ type: "union", rules: [leaf, leaf] }).success,
    ).toBe(true);
  });

  it("validates persisted player settings and preserves additional preferences", () => {
    expect(
      settingsSchema.parse({
        volume: 0.5,
        repeat: "all",
        shuffle: true,
        queue: ["audio", "video"],
        queueIndex: 1,
        position: 20,
        theme: "dark",
      }),
    ).toEqual({
      volume: 0.5,
      repeat: "all",
      shuffle: true,
      queue: ["audio", "video"],
      queueIndex: 1,
      position: 20,
      theme: "dark",
    });
    expect(
      settingsSchema.safeParse({
        volume: 2,
        repeat: "all",
        shuffle: false,
        queue: [],
        queueIndex: 0,
      }).success,
    ).toBe(false);
  });

  it("uses input for job requests and a fractional progress contract", () => {
    expect(
      jobCreateSchema.parse({
        kind: "youtube-import",
        input: { url: "https://youtube.com/watch?v=abcdefghijk" },
      }),
    ).toEqual({
      kind: "youtube-import",
      input: { url: "https://youtube.com/watch?v=abcdefghijk" },
    });
    expect(
      jobSchema.safeParse({
        id: "job",
        kind: "export",
        state: "running",
        progress: 50,
        completed: 1,
        total: 2,
        attempt: 1,
        createdAt: "",
        updatedAt: "",
      }).success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({
        id: "job",
        kind: "export",
        state: "running",
        progress: 0.5,
        completed: 1,
        total: 2,
        attempt: 1,
        createdAt: "",
        updatedAt: "",
      }).success,
    ).toBe(true);
  });
});

it("accepts a local source with a known absence of an audio track", () => {
  expect(sourceSchema.parse({
    id: "silent", provider: "local", status: "available", hasAudio: false,
  }).hasAudio).toBe(false);
});

it("validates optional playback mode in serialized settings", () => {
  const legacy = { volume: 0.5, repeat: "off", shuffle: false, queue: [], queueIndex: 0 };
  expect(settingsSchema.parse(legacy)).not.toHaveProperty("mode");
  expect(settingsSchema.parse({ ...legacy, mode: "audio" }).mode).toBe("audio");
  expect(settingsSchema.safeParse({ ...legacy, mode: "video" }).success).toBe(false);
});
