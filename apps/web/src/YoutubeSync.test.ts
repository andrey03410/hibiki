import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { YoutubeLinkImport, YoutubeSyncDetails, YoutubeSyncSettings } from "./YoutubeSync";

describe("YouTube sync controls", () => {
  it("offers linked import without submitting the ordinary import form", () => {
    const html = renderToStaticMarkup(
      createElement(YoutubeLinkImport, {
        url: "https://www.youtube.com/playlist?list=PLtest",
      }),
    );
    expect(html).toMatch(
      /<button type="button"[^>]*>Создать связанный плейлист/,
    );
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it("keeps linked import disabled for an empty input", () => {
    const html = renderToStaticMarkup(
      createElement(YoutubeLinkImport, { url: " " }),
    );
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("leaves the catalog picker unmounted while its disclosure is closed", () => {
    function CatalogPicker(): never { throw new Error("closed section mounted"); }
    const html = renderToStaticMarkup(createElement(YoutubeSyncDetails, {
      summary: "Локальные дополнения (2)", children: createElement(CatalogPicker),
    }));
    expect(html).toBe("<details><summary>Локальные дополнения (2)</summary></details>");
  });

  it("offers all sync modes in account settings", () => {
    const html = renderToStaticMarkup(createElement(YoutubeSyncSettings));
    expect(html).toContain("YouTube-плейлисты");
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="review"');
    expect(html).toContain('value="manual"');
  });
});
