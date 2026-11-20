import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ItemTagList } from "./LibraryItemControls.tsx";

describe("media entry tags", () => {
  const tags = ["OST", "Key", "Clannad", "Instrumental", "Piano", "Strings", "Opening"].map((name, index) => ({
    id: String(index),
    name,
    color: "#b09be2",
  }));

  it("shows five tags and puts only the two remaining tag filters in a dismissible popup", () => {
    const markup = renderToStaticMarkup(createElement(ItemTagList, { tags, onTag: () => {} }));
    const [visible, overflow] = markup.split('popover="auto"');
    expect(visible).toContain('aria-label="Показать ещё 2 тега"');
    expect(visible).toMatch(/>Piano<\/button>/);
    expect(visible).not.toContain("Strings");
    expect(overflow).toMatch(/>Strings<\/button>.*>Opening<\/button>/);
  });

  it("needs no overflow control for five tags", () => {
    const markup = renderToStaticMarkup(createElement(ItemTagList, { tags: tags.slice(0, 5) }));
    expect(markup).not.toContain("Показать ещё");
    expect(markup).toContain("Piano");
  });
});
