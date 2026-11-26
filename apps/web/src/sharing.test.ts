import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, it, vi } from "vitest";
import type { ItemDto, ShareLinkDto, SharedViewDto } from "@hibiki/contracts";
import { SavedSharedPlaylistCard, ShareLinkFields, SharedMediaPage } from "./Sharing";
import { useSharingRequest } from "./use-sharing-request";
import { formatShareExpiry, kanameLoginHref, orderedSharedItems, shareExpiry, shareLocalTime } from "./sharing-model";

vi.mock("./use-sharing-request", () => ({ useSharingRequest: vi.fn() }));
vi.mock("./player", () => ({ usePlayer: () => ({ sharedId: () => undefined }) }));

const now = new Date(2026, 10, 23, 12, 0).getTime();

const link: ShareLinkDto = {
  id: "link-1", kind: "playlist", targetId: "pl-1", title: "Первая подборка",
  url: "/share/public-key", createdAt: new Date(now).toISOString(), expiresAt: null,
  status: "active", allowReshare: false, trackCount: null, totalCount: null,
  missingPermissionCount: null, unavailableCount: null,
};

it("offers the issued URL while a playlist count is still loading", () => {
  const html = renderToStaticMarkup(createElement(ShareLinkFields, {
    link,
    origin: "https://hibiki.test",
    patch: async () => {},
  }));
  expect(html).toContain("https://hibiki.test/share/public-key");
  expect(html).toContain("Считаем записи…");
  expect(html).toMatch(/<button type="button" class="button primary"[^>]*>(?:(?!<\/button>).)*Скопировать/s);
  expect(html).not.toMatch(/<button [^>]*disabled[^>]*>(?:(?!<\/button>).)*Скопировать/s);
});

it("computes one day as exactly 24 hours and clears the expiry for indefinite access", () => {
  expect(shareExpiry("day", "", now)).toBe(new Date(now + 24 * 60 * 60 * 1000).toISOString());
  expect(shareExpiry("never", "", now)).toBeNull();
  expect(formatShareExpiry(null)).toBe("Бессрочно");
});

it("interprets the selected date and time in the owner's time zone", () => {
  const local = "2026-11-24T15:45";
  const date = new Date(2026, 10, 24, 15, 45);
  const expiry = shareExpiry("custom", local, now);
  expect(expiry).toBe(date.toISOString());
  expect(shareLocalTime(expiry!)).toBe(local);
  expect(formatShareExpiry(expiry)).toContain("15:45");
  expect(() => shareExpiry("custom", "2026-11-22T15:45", now)).toThrow("Укажите время в будущем");
  expect(() => shareExpiry("custom", "2026-11-31T15:45", now)).toThrow();
});

it("passes only supported paths through Kaname login", () => {
  const key = "abc_DEF-123".padEnd(43, "0");
  expect(kanameLoginHref("/share/" + key)).toBe("/api/auth/kaname/login?next=%2Fshare%2F" + key);
  expect(kanameLoginHref("/settings")).toBe("/api/auth/kaname/login?next=%2Fsettings");
  expect(kanameLoginHref("//example.test/share/key")).toBe("/api/auth/kaname/login");
  expect(kanameLoginHref("/share/key%2Fother")).toBe("/api/auth/kaname/login");
});

it("shows the permission scope and distinguishes blocked positions from missing originals", () => {
  const fields = (allowReshare: boolean) => renderToStaticMarkup(createElement(ShareLinkFields, {
    link: { ...link, allowReshare, trackCount: 17, totalCount: 75, missingPermissionCount: 57, unavailableCount: 1 },
    origin: "https://hibiki.test", patch: async () => {},
  }));
  const html = fields(false);
  expect(html).toMatch(/17 из 75/);
  expect(html).toMatch(/разрешение автора[^<]*<\/dt><dd>57/i);
  expect(html).toMatch(/оригинал недоступен[^<]*<\/dt><dd>1/i);
  expect(html).toMatch(/<input[^>]*type="checkbox"(?![^>]*checked)[^>]*>/);
  expect(html).toContain("Разрешить слушать в плейлистах других пользователей");
  expect(html).toMatch(/вошедш/i);
  expect(html).toMatch(/уже выданным и будущим ссылкам/);
  expect(fields(true)).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
});

function sharedTrack(id: string, title: string): ItemDto {
  return {
    id, title, originalTitle: title, kind: "audio", duration: 50, tags: [],
    createdAt: "", updatedAt: "",
    sources: [{ id: id + "-source", provider: "local", status: "available", streamUrl: "/api/media/" + id }],
  };
}
const direct = sharedTrack("one", "Свой трек");
const delegated = { ...sharedTrack("two", "Полученный трек"), shared: { sharedBy: "Автор оригинала", available: true, delegated: true as const } };
const mixed: SharedViewDto = {
  kind: "playlist", title: "Подборка", sharedBy: "Составитель", items: [delegated, direct],
  trackCount: 2, totalCount: 3, positions: [direct.id, null, delegated.id],
};

function sharedPage(data: SharedViewDto, saved = false) {
  vi.mocked(useSharingRequest).mockReturnValue({
    data, error: undefined, refresh: async () => {}, setData: () => {},
  });
  const path = saved ? "/shared-playlists" : "/share";
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path + "/test"] },
    createElement(Routes, {}, createElement(Route, { path: path + (saved ? "/:id" : "/:token"),
      element: createElement(SharedMediaPage, { saved, refreshLibrary: async () => {} }),
    }))));
}

it.each([false, true])("preserves closed positions and allows saving only direct rows (saved %s)", saved => {
  const html = sharedPage(mixed, saved);
  const rows = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? [];
  expect(html).toContain("2 из 3");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toContain("Добавить в медиатеку: Свой трек");
  expect(rows[1]).toContain("Запись недоступна");
  expect(rows[1]).not.toMatch(/Свой трек|Полученный трек|Автор оригинала|<button|<img|href=/);
  expect(rows[2]).toContain("Автор оригинала");
  expect(rows[2]).toContain("Воспроизвести Полученный трек");
  expect(rows[2]).not.toContain("Добавить");
});

it("explains why playback cannot start while every position is closed", () => {
  const html = sharedPage({ ...mixed, items: [], trackCount: 0, totalCount: 2, positions: [null, null] });
  expect(html).toContain("0 из 2");
  expect(html.match(/Запись недоступна/g)).toHaveLength(2);
  expect(html).toContain("Все записи в подборке закрыты для прослушивания");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Воспроизвести/s);
  expect(html).toContain("Добавить в медиатеку");
});

it("uses the curator's order for playback and preserves legacy views without a position list", () => {
  expect(orderedSharedItems(mixed).filter(Boolean)).toEqual([direct, delegated]);
  expect(orderedSharedItems({ items: [delegated, direct] })).toEqual([delegated, direct]);
});

it("offers a background start on a saved cover and keeps its title linked to the full list", () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(SavedSharedPlaylistCard, {
    onPlay: () => {}, playlist: { id: "saved", title: "Подборка", sharedBy: "Составитель", status: "active", trackCount: 2, totalCount: 3 },
  })));
  expect(html).toContain("2 из 3");
  expect(html).toMatch(/<button[^>]+aria-label="Воспроизвести плейлист «Подборка»"/);
  expect(html).toMatch(/<a[^>]+href="\/shared-playlists\/saved"[^>]*>Подборка<\/a>/);
});

it("keeps the order at launch and drops stale metadata when shared positions change", () => {
  const nowClosed = {...mixed, items: [delegated, direct], positions: [delegated.id, null]};
  expect(orderedSharedItems(nowClosed, [direct.id, null, delegated.id])).toEqual([null, null, delegated]);
});

it("explains silent video at its playlist row", () => {
  const silent = {...direct, kind: "video" as const, sources: [{...direct.sources[0]!, hasAudio: false, mime: "video/mp4"}]};
  const html = sharedPage({...mixed, items: [silent, delegated]});
  const row = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/)?.[0];
  expect(row).toContain("В видео нет звуковой дорожки");
  expect(row).toMatch(/<button[^>]+disabled/);
});
