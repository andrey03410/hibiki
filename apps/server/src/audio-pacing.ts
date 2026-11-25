import { Readable } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";

// HTTP/2 streams share a TCP send queue. Put only a few milliseconds of
// background audio into that queue at a time, so a new request can pass it.
export function bulkAudioStream(source: Readable, mime: string, range: boolean, hint?: string | string[]) {
  if (!range || !mime.startsWith("audio/") || typeof hint !== "string" || !/^\d{1,12}$/.test(hint)) return source;
  const rate = Math.max(64 * 1024, Number(hint));
  const quantum = Math.max(1024, Math.min(64 * 1024, Math.floor(rate / 50)));
  async function* paced() {
    let next = performance.now();
    for await (const buffer of source) {
      for (let start = 0; start < buffer.length; start += quantum) {
        const wait = next - performance.now();
        if (wait >= 1) await pause(wait);
        const part = buffer.subarray(start, start + quantum);
        next = Math.max(next, performance.now()) + part.length * 1000 / rate;
        yield part;
      }
    }
  }
  const output = Readable.from(paced(), {objectMode:false});
  output.once("close", () => source.destroy());
  return output;
}
