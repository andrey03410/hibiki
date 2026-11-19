import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CompactPlaybackQueue, LibraryPlaybackButton, PlaybackSeekBar } from "./PlaybackControls";

it("renders a labeled seek control with shared playback time", () => {
  const handlers = { onSeek: vi.fn(), onScrubStart: vi.fn(), onScrubEnd: vi.fn() };
  const html = renderToStaticMarkup(createElement(PlaybackSeekBar, { position: 25.4, duration: 70, ...handlers }));
  expect(html).toContain('type="range"');
  expect(html).toContain('aria-valuetext="0:25 из 1:10"');
  expect(html).toContain('max="70"');
  expect(html).toContain('value="25.4"');
  expect(html).not.toContain("disabled");
});

it("disables seeking when the duration is unknown", () => {
  const html = renderToStaticMarkup(createElement(PlaybackSeekBar, {
    position: 0, duration: 0, onSeek: vi.fn(), onScrubStart: vi.fn(), onScrubEnd: vi.fn(),
  }));
  expect(html).toContain("disabled");
  expect(html).toContain('aria-valuetext="Длительность неизвестна"');
});

it("renders the compact queue trigger as a collapsed button on the current page", () => {
  const html = renderToStaticMarkup(createElement(CompactPlaybackQueue, {
    settings: { queue: ["a"], queueIndex: 0, mode: "original" },
    itemsById: new Map(),
    failedIds: new Set<string>(),
  }));
  expect(html).toMatch(/<button[^>]*aria-label="Очередь воспроизведения"[^>]*aria-expanded="false"/);
  expect(html).not.toContain('href="/player"');
});

it("keeps an icon-only library action named and describes an unavailable source", () => {
  const html = renderToStaticMarkup(createElement(LibraryPlaybackButton, {
    action: "listen", itemTitle: "Опенинг",
    unavailableReason: "Для прослушивания нужна локальная копия", onActivate: vi.fn(),
  }));
  expect(html).toMatch(/<button[^>]*aria-label="Слушать Опенинг"[^>]*aria-disabled="true"[^>]*aria-describedby/);
  expect(html).toContain('role="tooltip"');
  expect(html).toContain("Для прослушивания нужна локальная копия");
  expect(html.slice(0, html.indexOf("</button>"))).not.toContain(">Слушать<");
});
