import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemDto } from "@hibiki/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { ScopedPlaylistPage } from "./PlaylistLibrary";
import { readPlaylistScope, readOwnedRows, type PlaylistScope } from "./playlist-library";

vi.mock("./player", () => ({
  usePlayerCommands: () => ({sharedId: () => undefined}),
  usePlayerCard: () => ({active: false, playing: false}),
}));
afterEach(() => vi.unstubAllGlobals());

function track(id: string): ItemDto {
  return {id, title: "Трек " + id, originalTitle: "", kind: "audio", duration: 8, tags: [], createdAt: "", updatedAt: "",
    sources: [{id: "s-" + id, provider: "local", status: "available", streamUrl: "/api/media/" + id}]};
}
it("hides cached shared titles until the reopened library has checked the saved grant", () => {
  const scope: PlaylistScope = {kind: "saved", id: "list", title: "Подборка", order: ["private"],
    initialRows: [track("private")]};
  const html = renderToStaticMarkup(createElement(ScopedPlaylistPage, {scope, clear: () => {}}));
  expect(html).not.toContain("Трек private");
  expect(html).toContain("Проверяем доступ");
});

it("keeps missing places in a large snapshot and reads only enough rows to start it", async () => {
  const ids = Array.from({length: 305}, (_, i) => String(i));
  const calls: string[][] = [];
  vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
    if (path === "/api/playlists/list/playback") return Response.json({ids, items: []});
    if (path !== "/api/library/items") throw new Error("Unexpected request " + path);
    const body = JSON.parse(String(options.body));
    calls.push(body.ids);
    return Response.json({items: body.ids.includes("129") ? [track("129")] : []});
  });
  const scope = await readPlaylistScope({kind: "own", id: "list", title: "Подборка"}, new AbortController().signal);
  expect(scope.order).toEqual(ids);
  expect(calls.map(page => [page[0], page.at(-1)])).toEqual([["0", "99"], ["100", "199"]]);
  expect(scope.initialRows).toHaveLength(200);
  expect(scope.initialRows[128]).toBeNull();
  expect(scope.initialRows[129]?.title).toBe("Трек 129");
});

it("hydrates the ordered page by id and marks removed rows unavailable", async () => {
  vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
    expect(JSON.parse(String(options.body))).toEqual({ids: ["b","gone","a"], verifyShared: true});
    return Response.json({items: [track("a"), track("b")]});
  });
  expect((await readOwnedRows(["b","gone","a"])).map(item => item?.id ?? null)).toEqual(["b",null,"a"]);
});
