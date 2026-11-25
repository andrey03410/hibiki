import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { mediaRangeStream } from "./media-pacing";

const data = Buffer.from(Array.from({ length: 16_384 }, (_, i) => i % 251));
const audioRate = { "x-hibiki-audio-rate": "65536" };
const videoRate = { "x-hibiki-video-rate": "65536" };
const range = "bytes=0-16383";

it.each([
  ["video/mp4", { range, ...audioRate }],
  ["audio/mp4", { range, ...videoRate }],
  ["video/webm", { range, ...videoRate }],
  ["video/mp4", { range }],
  ["video/mp4", videoRate],
  ["audio/mpeg", audioRate],
  ["audio/mp4", { range, "x-hibiki-audio-rate": "bad" }],
] satisfies Array<[string, IncomingHttpHeaders]>)("keeps normal %s transfers unrestricted", (mime, headers) => {
  const stream = Readable.from([data]);
  expect(mediaRangeStream(stream, mime, headers)).toBe(stream);
});

it.each([
  ["audio/mp4", { range, ...audioRate }],
  ["video/mp4", { range, ...videoRate }],
] satisfies Array<[string, IncomingHttpHeaders]>)("paces an explicitly requested %s range without changing bytes", async (mime, headers) => {
  const start = performance.now();
  const received: Buffer[] = [];
  for await (const part of mediaRangeStream(Readable.from([data]), mime, headers)) received.push(part);
  expect(Buffer.concat(received)).toEqual(data);
  expect(performance.now() - start).toBeGreaterThan(140);
});
