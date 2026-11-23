import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ShareLinkFields } from "./Sharing";
import { formatShareExpiry, kanameLoginHref, shareExpiry, shareLocalTime } from "./sharing-model";

const now = new Date(2026, 10, 23, 12, 0).getTime();

it("offers the issued URL while a playlist count is still loading", () => {
  const html = renderToStaticMarkup(createElement(ShareLinkFields, {
    link: {
      id: "link-1", kind: "playlist", targetId: "pl-1", title: "Первая подборка",
      url: "/share/public-key", createdAt: new Date(now).toISOString(), expiresAt: null,
      status: "active", trackCount: null,
    },
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
