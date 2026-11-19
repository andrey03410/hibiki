import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ItemTagList } from "./LibraryItemControls.tsx";

describe("media entry tags", () => {
  const tags = ["OST", "Key", "Clannad", "Instrumental"].map((name, index) => ({
    id: String(index),
    name,
    color: "#b09be2",
  }));

  it("gives access to every tag through a labeled disclosure", () => {
    const markup = renderToStaticMarkup(createElement(ItemTagList, { tags, onTag: () => {} }));
    expect(markup).toMatch(/<details[^>]*>.*<summary[^>]*>\+2<\/summary>.*Clannad.*Instrumental.*<\/details>/);
    expect(markup).toContain('aria-label="Показать ещё 2 тега"');
    expect(markup).toMatch(/<button[^>]*>.*OST.*<\/button>/);
  });

  it("skips the disclosure when both tags already fit", () => {
    const markup = renderToStaticMarkup(createElement(ItemTagList, { tags: tags.slice(0, 2) }));
    expect(markup).not.toContain("<details");
    expect(markup).toContain("Key");
  });
});
