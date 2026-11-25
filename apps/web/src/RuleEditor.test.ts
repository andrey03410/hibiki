import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import RuleEditor from "./RuleEditor";
import { RuleItemPicker } from "./RuleItemPicker";

it("can remove a nested rule without submitting the playlist form", () => {
  const html = renderToStaticMarkup(createElement(RuleEditor, {
    rule: { type: "union", rules: [{ type: "items", ids: [] }] },
    library: { playlists: [], tags: [] },
    onChange: () => {},
  }));

  const remove = html.match(/<button\b[^>]*aria-label="Удалить правило 1"[^>]*>/)?.[0];
  expect(remove).toContain('type="button"');
});

it("renders the form and preserves selections before the first search page arrives", () => {
  const html = renderToStaticMarkup(createElement(RuleItemPicker, {
    ids: ["249", "1", "160"], onChange: () => {},
  }));
  expect(html).toContain("Найти запись для правила");
  expect(html).toContain("Выбрано: 3.");
  expect(html).not.toContain('type="checkbox"');
});
