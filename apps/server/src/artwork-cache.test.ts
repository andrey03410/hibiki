import { describe, expect, it } from "vitest";
import { ArtworkCache } from "./artwork";

describe("artwork processing load", () => {
  it("bounds simultaneous work and shares pending and missing results across a scroll", async () => {
    const cache = new ArtworkCache(3, 2);
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const starts: string[] = [];
    const request = (key: string) => cache.get(key, async () => {
      starts.push(key);
      await paused;
      return undefined;
    });
    const requests = ["a", "b", "c", "d", "a"].map(request);
    await Promise.resolve();
    expect(starts).toEqual(["a", "b"]);
    release();
    await Promise.all(requests);
    await request("d");
    expect(starts).toEqual(["a", "b", "c", "d"]);
  });

  it("can retry a failed operation", async () => {
    const cache = new ArtworkCache(3, 1);
    await expect(cache.get("a", async () => { throw Error("interrupted"); })).rejects.toThrow("interrupted");
    const jpeg = { bytes: Buffer.from([0xff, 0xd8, 0xff]), mime: "image/jpeg" as const };
    expect(await cache.get("a", async () => jpeg)).toEqual(jpeg);
  });

  it("admits two cold pages of covers, rejects excess queued work and recovers after the burst", async () => {
    const cache = new ArtworkCache(3, 1);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const load = async () => { await waiting; return undefined; };
    const burst = Promise.allSettled(Array.from({ length: 300 }, (_, i) => cache.get(String(i), load)));
    try {
      await expect(cache.get("overflow", async () => undefined)).rejects.toMatchObject({ status: 503 });
    } finally {
      release();
    }
    const results = await burst;
    expect(results.slice(0, 200).filter(r => r.status === "rejected")).toHaveLength(0);
    expect(results.some(r => r.status === "rejected")).toBe(true);
    expect(await cache.get("overflow", async () => undefined)).toBeUndefined();
  });
});
