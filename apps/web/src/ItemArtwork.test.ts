import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ItemArtwork } from "./ItemArtwork";

it("requests the library rendition with background image loading hints", () => {
  const markup = renderToStaticMarkup(createElement(ItemArtwork, {
    kind: "audio", source: { provider: "local", thumbnail: "/api/items/music/artwork" },
  }));
  expect(markup).toContain('src="/api/items/music/artwork?size=thumb"');
  expect(markup).toContain('loading="lazy"');
  expect(markup).toContain('decoding="async"');
  expect(markup).toMatch(/fetchPriority="low"/i);
});

it("uses YouTube's small thumbnail for legacy and imported video sources", () => {
  for (const thumbnail of [
    "https://i.ytimg.com/vi_webp/abcdefghijk/maxresdefault.webp",
    "https://example.test/a-large-archived-cover.jpg",
  ]) {
    const markup = renderToStaticMarkup(createElement(ItemArtwork, {
      kind: "video", source: { provider: "youtube", externalId: "abcdefghijk", thumbnail },
    }));
    expect(markup).toContain('src="https://i.ytimg.com/vi/abcdefghijk/default.jpg"');
  }
});

it("requests shared artwork through its protected URL", () => {
  const markup = renderToStaticMarkup(createElement(ItemArtwork, {
    kind: "audio", source: { provider: "local", shared: true, thumbnail: "/api/shared/access-key/items/music/artwork" },
  }));
  expect(markup).toContain('src="/api/shared/access-key/items/music/artwork?size=thumb"');
});

it("requests a card rendition for local and shared heroes using the original access path", () => {
  for (const thumbnail of [
    "/api/items/music/artwork", "/api/shared/access-key/items/music/artwork",
    "/api/shared-playlists/saved/items/music/artwork", "/api/shared-items/saved-music/artwork",
  ]) {
    const markup = renderToStaticMarkup(createElement(ItemArtwork, {
      size: "cover", kind: "audio", source: { provider: "local", shared: true, thumbnail },
    }));
    expect(markup).toContain(`src="${thumbnail}?size=cover"`);
  }
});

it("uses a large YouTube image for shared media heroes", () => {
  const markup = renderToStaticMarkup(createElement(ItemArtwork, {
    size: "cover", kind: "video", source: { provider: "youtube", shared: true, externalId: "abcdefghijk",
      thumbnail: "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg" },
  }));
  expect(markup).toContain('src="https://i.ytimg.com/vi/abcdefghijk/sddefault.jpg"');
});

it("keeps a fallback for missing artwork or an unrecognized external image", () => {
  for (const source of [
    undefined,
    { provider: "local" as const, thumbnail: "https://example.test/large.png" },
    { provider: "youtube" as const, externalId: "../other", thumbnail: "https://example.test/x" },
  ]) {
    const markup = renderToStaticMarkup(createElement(ItemArtwork, { kind: "video", source }));
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  }
});

it("leaves offscreen thumbnail requests unscheduled until their rows approach the viewport", () => {
  vi.stubGlobal("IntersectionObserver", class {});
  try {
    const markup = renderToStaticMarkup(createElement(ItemArtwork, {
      kind: "audio", source: { provider: "local", thumbnail: "/api/items/music/artwork" },
    }));
    expect(markup).toContain("<img");
    expect(markup).not.toContain('src=');
  } finally {
    vi.unstubAllGlobals();
  }
});
