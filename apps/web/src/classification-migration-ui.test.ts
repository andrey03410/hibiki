import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SkippedChanges } from "./ClassificationMigration";
import { TagNavigation } from "./TagNavigation";
import { defaultLibrarySearch } from "./library-search";
import { TagCatalog } from "./taxonomy";

it("labels an archived saved condition without adding it to selectable navigation", () => {
  const html = renderToStaticMarkup(
    createElement(TagNavigation, {
      catalog: new TagCatalog([]),
      archivedTagNames: { saved: "Архивная метка" },
      counts: {},
      search: { ...defaultLibrarySearch, tagIds: ["saved"] },
      userId: "test",
      hasPlayer: false,
      children: null,
      onChange: () => {},
    }),
  );
  expect(html).toContain('aria-label="Снять Архивная метка"');
  expect(html).not.toContain('class="node-choice"');
});

it("shows the item or tag name and the preserved field after undo", () => {
  const html = renderToStaticMarkup(
    createElement(SkippedChanges, {
      skipped: 2,
      changes: [
        {
          itemId: "i",
          label: "Изменённая запись",
          field: "Исполнение и голоса",
        },
        { tagId: "t", label: "Новый псевдоним", field: "Значение каталога" },
      ],
    }),
  );
  expect(html).toMatch(/Изменённая запись.*Исполнение и голоса/);
  expect(html).toMatch(/Новый псевдоним.*Значение каталога/);
});

it("starts narrow tag navigation closed with the active selection count on its control", () => {
  vi.stubGlobal("window", { matchMedia: () => ({matches: true}) });
  try {
    const html = renderToStaticMarkup(createElement(TagNavigation, {
      catalog: new TagCatalog([]), search: { ...defaultLibrarySearch, tagIds: ["one", "two"] },
      userId: "mobile", children: "results", hasPlayer: false, onChange: () => {},
    }));
    const controls = html.match(/<button[^>]+class="tag-nav-toggle"[^>]+aria-expanded="false"[^>]+aria-controls="([^"]+)"/);
    expect(controls).toBeTruthy();
    expect(html).toContain(`<aside id="${controls![1]}" hidden=""`);
    expect(html).toMatch(/Теги<span[^>]*>Выбрано: 2<\/span>/);
    expect(html.indexOf('class="tag-nav-toggle"')).toBeLessThan(html.indexOf('class="library-results-column"'));
  } finally { vi.unstubAllGlobals(); }
});
