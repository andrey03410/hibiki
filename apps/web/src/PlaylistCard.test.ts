import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { PlaylistCard } from "./PlaylistCard";

it("links the cover to editing, the title to the track list and exposes sharing as a separate button", () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PlaylistCard, {
    playlist: { id: "sample", title: "My list", description: "", revision: 1,
      createdAt: "", updatedAt: "", manual: true, trackCount: 80 },
    hasNote: false, onShare: () => {},
  })));

  expect(html).toMatch(/<a[^>]+class="playlist-cover-wrap"[^>]+href="\/playlists\/sample\?edit=1"/);
  expect(html).toMatch(/<a[^>]+class="playlist-card-title"[^>]+href="\/playlists\/sample"[^>]*>My list<\/a>/);
  expect(html.match(/<button\b/g)).toHaveLength(1);
  expect(html).toMatch(/<button[^>]*playlist-card-share[^>]*>[\s\S]*?Поделиться<\/button>/);
});
