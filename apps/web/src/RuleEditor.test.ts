import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import RuleEditor from "./RuleEditor";
import { RuleItemPicker } from "./RuleItemPicker";

it("can remove a nested rule without submitting the playlist form", () => {
  const html = renderToStaticMarkup(createElement(RuleEditor, {
    rule: { type: "union", rules: [{ type: "items", ids: [] }] },
    library: { items: [], playlists: [], tags: [], jobs: [] },
    onChange: () => {},
  }));

  const remove = html.match(/<button\b[^>]*aria-label="Удалить правило 1"[^>]*>/)?.[0];
  expect(remove).toContain('type="button"');
});

it("limits the initial item list while counting selections across the whole catalog", () => {
  const items = Array.from({ length: 250 }, (_, n) => ({
    id: String(n), title: `Track ${n}`, kind: "audio" as const, duration: 90,
  }));
  const html = renderToStaticMarkup(createElement(RuleItemPicker, {
    items, ids: ["249", "1", "160"], onChange: () => {},
  }));

  expect(html.match(/type="checkbox"/g)).toHaveLength(100);
  expect(html.match(/checked=""/g)).toHaveLength(1);
  expect(html).toContain("Выбрано: 3.");
  expect(html).toContain("Показать ещё");
  expect(html).not.toContain("Track 249");
});
