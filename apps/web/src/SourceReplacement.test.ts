import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SourceReplacement } from "./SourceReplacement";

it("offers separate YouTube and file previews within the existing edit form", () => {
  const html = renderToStaticMarkup(createElement(
    "form", null, createElement(SourceReplacement, { item: { id: "record" }, reload: () => {} }),
  ));
  expect(html.match(/<form\b/g)).toHaveLength(1);
  expect(html).toMatch(/<input[^>]+inputMode="url"/i);
  expect(html).toMatch(/<input[^>]+type="file"/);
  expect(html.match(/<button[^>]+type="button"/g)).toHaveLength(2);
  expect(html).not.toContain("Подтвердить замену");
});

it("offers the recipient a file upload for a borrowed item", () => {
  const html = renderToStaticMarkup(createElement(SourceReplacement, {
    item: { id: "borrowed" }, localOnly: true, reload: () => {},
  }));
  expect(html).toContain("Добавить свой файл");
  expect(html).toMatch(/type="file"/);
  expect(html).not.toContain("YouTube");
});
