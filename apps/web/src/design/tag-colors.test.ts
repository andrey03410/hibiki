import { describe, expect, it } from "vitest";
import { DEFAULT_TAG_COLOR, generativeCover, groupColors, tagColor } from "./tag-colors";

describe("tagColor", () => {
  it("uses the group colour for default-coloured tags", () => {
    expect(tagColor({ name: "Rock", color: DEFAULT_TAG_COLOR, group: "genre" })).toBe(groupColors.genre);
    expect(tagColor({ name: "x", color: DEFAULT_TAG_COLOR })).toBe(groupColors.extra);
  });
  it("prefers the owner's explicit colour", () => {
    expect(tagColor({ name: "Rock", color: "#FF0000", group: "genre" })).toBe("#ff0000");
  });
  it("gives moods their own stable hue", () => {
    expect(tagColor({ name: "Эпичная", color: DEFAULT_TAG_COLOR, group: "mood" })).toBe("#ff9a62");
    const unknown = tagColor({ name: "Странная", color: DEFAULT_TAG_COLOR, group: "mood" });
    expect(unknown).toMatch(/^#[0-9a-f]{6}$/);
    expect(tagColor({ name: "Странная", color: DEFAULT_TAG_COLOR, group: "mood" })).toBe(unknown);
  });
});

describe("generativeCover", () => {
  it("is deterministic and builds a monogram", () => {
    expect(generativeCover("The Witcher 3")).toEqual(generativeCover("The Witcher 3"));
    expect(generativeCover("The Witcher 3").monogram).toBe("TW");
    expect(generativeCover("Clannad").monogram).toBe("CL");
  });
});
