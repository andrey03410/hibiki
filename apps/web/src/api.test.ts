import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("omits the JSON header for a request without a body", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await api("/auth/logout", "POST");
  const request = new Request("http://localhost/api/auth/logout", fetch.mock.calls[0]?.[1]);
  expect(request.headers.has("content-type")).toBe(false);
  expect(await request.text()).toBe("");
});

it("sends a JSON body with the matching header", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await api("/settings", "PUT", { mode: "audio" });
  const request = new Request("http://localhost/api/settings", fetch.mock.calls[0]?.[1]);
  expect(request.headers.get("content-type")).toBe("application/json");
  expect(await request.json()).toEqual({ mode: "audio" });
});

it("lets the full library order yield network priority to the selected media file", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ids: []}));
  vi.stubGlobal("fetch", fetch);
  await api("/library/ids", "POST", {}, "low");
  expect(fetch.mock.calls[0]?.[1]?.priority).toBe("low");
});

it("passes library cancellation to the network request", async () => {
  const controller = new AbortController();
  const read = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ items: [] }));
  vi.stubGlobal("fetch", read);
  await api("/library/page", "POST", {}, undefined, controller.signal);
  controller.abort();
  expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
