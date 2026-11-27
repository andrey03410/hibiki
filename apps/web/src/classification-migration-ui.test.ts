import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SkippedChanges } from "./ClassificationMigration";
import { ActiveFilters } from "./LibraryFilters";
import { defaultLibrarySearch } from "./library-search";
import { TagCatalog } from "./taxonomy";

it("labels an archived saved condition without adding it to selectable navigation", () => {
  const html = renderToStaticMarkup(
    createElement(ActiveFilters, {
      catalog: new TagCatalog([]),
      archivedTagNames: { saved: "Архивная метка" },
      search: { ...defaultLibrarySearch, tagIds: ["saved"] },
      onChange: () => {},
    }),
  );
  expect(html).toContain('aria-label="Снять Архивная метка"');
  expect(html).not.toContain('role="menuitemcheckbox"');
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
