import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CompactPlaybackQueue, CompactPlaybackQueueRow, PlaybackSeekBar, PlaybackVolume } from "./PlaybackControls";

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
    onSelect: vi.fn(),
  }));
  expect(html).toMatch(/<button[^>]*aria-label="Очередь воспроизведения"[^>]*aria-expanded="false"/);
  expect(html).not.toContain('href="/player"');
});

it("exposes the current compact queue entry as a native button", () => {
  const html = renderToStaticMarkup(createElement(CompactPlaybackQueueRow, {
    title: "Опенинг", kind: "video", duration: 90, current: true, onSelect: vi.fn(),
  }));
  expect(html).toMatch(/<li><button[^>]*type="button"[^>]*aria-current="true"/);
  expect(html).toContain("Опенинг");
  expect(html).not.toContain("aria-disabled");
});

it("explains why a compact queue entry cannot be selected", () => {
  const html = renderToStaticMarkup(createElement(CompactPlaybackQueueRow, {
    title: "Опенинг", kind: "video", current: false, onSelect: vi.fn(),
    unavailableReason: "В видео нет звуковой дорожки",
  }));
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="([^"]+)"[\s\S]*<small id="\1">В видео нет звуковой дорожки/);
});

it("shows separated local buffered ranges beneath the shared progress fill", () => {
  const html = renderToStaticMarkup(createElement(PlaybackSeekBar, {
    position: 12, duration: 100, buffered: [[0, 20], [70, 85]],
    onSeek() {}, onScrubStart() {}, onScrubEnd() {},
  }));
  expect(html).toContain("--buffered:");
  expect(html).toMatch(/0% 20%, transparent 20% 70%, var\(--buffer-color\) 70% 85%/);
});

it("shows a volume trigger in the mini-player and a slider with the same level in the watch player", () => {
  const props = {volume: 0.35, onVolume() {}, onMute() {}};
  const mini = renderToStaticMarkup(createElement(PlaybackVolume, {...props, compact: true}));
  const watch = renderToStaticMarkup(createElement(PlaybackVolume, props));
  expect(mini).toMatch(/<button[^>]*aria-label="Громкость, 35%"[^>]*aria-expanded="false"/);
  expect(watch).toContain('aria-valuetext="35%"');
  expect(watch).toContain('aria-label="Выключить звук"');
});
