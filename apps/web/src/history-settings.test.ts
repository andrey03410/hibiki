import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { cleanupPrompt, historyDateRange, HistorySettings } from "./HistorySettings";

describe("history settings", () => {
  it("opens the item journal directly and leaves destructive actions behind preview", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, {
      initialEntries: ["/settings?historyItem=track#history"],
      children: createElement(HistorySettings, { items: [{ id: "track", title: "My track" }] }),
    }));
    expect(html).toContain('id="history"');
    expect(html).toContain('<option value="track" selected="">My track</option>');
    expect(html).toContain('href="/api/history/attempts.csv?itemId=track"');
    expect(html).toContain('href="/api/history/summary.csv"');
    expect(html).not.toContain("Подтвердить удаление");
  });

  it("uses inclusive calendar day inputs with an exclusive API end", () => {
    const range = historyDateRange("2026-11-03", "2026-11-03");
    expect(new Date(range.from!).getDate()).toBe(3);
    expect(new Date(range.to!).getDate()).toBe(4);
    expect(historyDateRange("", "2026-12-31").to).toBe(new Date(2027, 0, 1).toISOString());
    expect(() => historyDateRange("2026-11-05", "2026-11-03")).toThrow();
  });

  it("creates copyable month aggregates without individual track or account data", () => {
    const periods = [{
      month: "2026-01", count: 17, bytes: 7200,
      itemTitle: "secret title", ownerId: "secret owner",
    }];
    const prompt = cleanupPrompt(periods);
    expect(prompt).toContain("2026-01, 17, 7200");
    expect(prompt).not.toContain("secret");
    expect(prompt).toMatch(/предложи.*период/);
  });
});
