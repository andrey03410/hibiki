import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TagDto } from "@hibiki/contracts";
import { ItemTagList } from "./LibraryItemControls";

import { TagCatalog } from "./taxonomy";
import { rowSource } from "./library-filters";

describe("compact entry classification", () => {
  const tags: TagDto[] = [
    { id: "a", name: "Версия", group: "source" },
    { id: "b", name: "Альт", group: "genre" },
    { id: "c", name: "Джаз", group: "genre" },
    { id: "d", name: "Спокойная", group: "mood" },
    { id: "e", name: "Кавер", group: "extra" },
    { id: "f", name: "Автор", group: "artist" },
    { id: "g", name: "Архив", archived: true },
  ].map((t) => ({ color: "#aaa", ...t }) as TagDto);
  it("prefers a selected genre, counts only hidden assignments and keeps full groups and voices available", () => {
    const html = renderToStaticMarkup(
      createElement(ItemTagList, {
        tags,
        selected: ["c"],
        catalog: new TagCatalog(tags),
        performance: "vocal",
        voices: ["female", "male"],
        onTag: () => {},
      }),
    );
    const [row, detail] = html.split('popover="auto"');
    expect(row).toContain("Джаз");
    expect(row).not.toContain("Альт");
    expect(row).toContain("Спокойная");
    expect(row).not.toContain("Версия");
    // Source and artist are already in the row: only the hidden genre and extra count.
    expect(row).toContain("+2");
    expect(row).toContain("Мужской и женский вокал");
    expect(detail).toContain("Альт");
    expect(detail).toContain("Дополнительно");
    expect(detail).toContain("Автор");
    expect(html).not.toContain("Архив");
  });
  it("shows no bare counter when the row already shows every assigned tag", () => {
    const only = tags.filter(tag => tag.group === "source" || tag.group === "artist");
    const html = renderToStaticMarkup(createElement(ItemTagList, { tags: only, catalog: new TagCatalog(only) }));
    const [row] = html.split('popover="auto"');
    expect(row).not.toMatch(/\+\d/);
    expect(row).not.toContain("Без тегов");
  });
  it("prefers the assigned work below a selected studio over an alphabetically earlier unrelated work", () => {
    const studio: TagDto = { id: "s", name: "Студия", group: "source", color: "#acf" };
    const earlier: TagDto = { id: "a", name: "Альфа", group: "source", color: "#acf" };
    const matched: TagDto = { id: "b", name: "Бета", group: "source", color: "#acf", parentIds: ["s"] };
    const catalog = new TagCatalog([studio, earlier, matched]);
    expect(rowSource([earlier, matched], catalog, ["s"])?.id).toBe("b");
    expect(rowSource([earlier, matched], catalog)?.id).toBe("a");
    expect(rowSource([earlier, matched], catalog, ["a"])?.id).toBe("a");
  });

  it("exposes empty groups for an unclassified entry", () => {
    const html = renderToStaticMarkup(createElement(ItemTagList, { tags: [], catalog: new TagCatalog([]) }));
    expect(html).toContain("Исполнитель");
    expect(html).toContain("Не указано");
  });
});
