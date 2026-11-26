import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { PlaylistCard } from "./PlaylistCard";

it("offers separate controls for listening, editing, opening the track list and sharing", () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PlaylistCard, {
    playlist: { id: "sample", title: "My list", description: "", revision: 1,
      createdAt: "", updatedAt: "", manual: true, trackCount: 80 },
    hasNote: false, onShare: () => {}, onPlay: () => {}, onEdit: () => {},
  })));

  expect(html).toMatch(/<button[^>]+aria-label="Воспроизвести плейлист «My list»"/);
  expect(html).toMatch(/<button[^>]+aria-label="Редактировать плейлист «My list»"/);
  expect(html).toMatch(/<a[^>]+class="playlist-card-title"[^>]+href="\/playlists\/sample"[^>]*>My list<\/a>/);
  expect(html.match(/<button\b/g)).toHaveLength(3);
  expect(html).toMatch(/<button[^>]*playlist-card-share[^>]*>[\s\S]*?Поделиться<\/button>/);
});
