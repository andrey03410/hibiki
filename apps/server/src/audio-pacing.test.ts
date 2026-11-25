import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { bulkAudioStream } from "./audio-pacing";

it("paces only explicitly requested audio ranges and preserves every original byte", async () => {
  const data = Buffer.from(Array.from({length:16_384}, (_, i) => i % 251));
  for (const [mime,range,rate] of [
    ["video/mp4", true, "65536"], ["audio/mpeg", false, "65536"], ["audio/mpeg", true, ""], ["audio/mp4", true, "bad"],
  ] as const) {
    const source = Readable.from([data]);
    expect(bulkAudioStream(source, mime, range, rate)).toBe(source);
  }
  const start = performance.now();
  const result: Buffer[] = [];
  for await (const part of bulkAudioStream(Readable.from([data]), "audio/mp4", true, "65536")) result.push(part);
  expect(Buffer.concat(result)).toEqual(data);
  expect(performance.now() - start).toBeGreaterThan(140);
});
