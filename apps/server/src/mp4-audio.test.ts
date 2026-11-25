import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { buildAudioView, buildHeader, readAudioRange } from "./mp4-audio";

const run = (args: string[]) => promisify(execFile)(String(ffmpeg), ["-hide_banner", "-loglevel", "error", ...args]);
describe("virtual M4A", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "hibiki-mp4-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  it.each([
    { codec: "aac", fast: false }, { codec: "aac", fast: true },
    { codec: "libopus", fast: false }, { codec: "flac", fast: false },
  ])("preserves default $codec packets, edit list and length (faststart $fast)", async ({ codec, fast }) => {
    const input = join(dir, `interleaved-${codec}-${fast}.mp4`);
    const output = join(dir, `audio-${codec}-${fast}.m4a`);
    await run(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=200:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=800:duration=1.7",
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-c:a", codec, "-strict", "experimental",
      "-disposition:a:0", "0", "-disposition:a:1", "default", ...(fast ? ["-movflags", "+faststart"] : []), input]);
    const handle = await open(input);
    try {
      const view = (await buildAudioView(handle, (await handle.stat()).size))!;
      expect(view).toBeTruthy();
      const read = async (start: number, end: number) => {
        const chunks = [];
        for await (const data of readAudioRange(handle, view, start, end)) chunks.push(data);
        return Buffer.concat(chunks);
      };
      const all = await read(0, view.bytes - 1);
      expect(all.length).toBe(view.bytes);
      const slices: Buffer[] = [];
      for (let start = 0; start < all.length;) {
        const end = Math.min(start + 199 + (start % 577), all.length);
        slices.push(await read(start, end - 1));
        start = end;
      }
      expect(Buffer.concat(slices)).toEqual(all);
      await writeFile(output, all);
      for (const outputCodec of ["copy", "pcm_s32le"]) {
        const hash = async (file: string, stream: string) =>
          (await run(["-i", file, "-map", stream, "-c:a", outputCodec, "-f", "streamhash", "-hash", "sha256", "-"])).stdout;
        expect(await hash(output, "0:a:0")).toEqual(await hash(input, "0:a:1"));
      }
      const { parseFile } = await import("music-metadata");
      expect((await parseFile(output)).format.duration).toBeCloseTo(1.7, 1);
    } finally { await handle.close(); }
  });
  it("does not expose a view for a silent video", async () => {
    const input = join(dir, "silent.mp4");
    await run(["-f", "lavfi", "-i", "color=s=32x32:d=0.1", "-an", input]);
    const handle = await open(input);
    try { expect(await buildAudioView(handle, (await handle.stat()).size)).toBeNull(); }
    finally { await handle.close(); }
  });
  it("leaves unsupported audio sample entries on the original MP4", async () => {
    const input = join(dir, "alac.mp4");
    await run(["-f", "lavfi", "-i", "color=s=32x32:d=0.2", "-f", "lavfi", "-i", "sine=duration=0.2",
      "-c:v", "libx264", "-c:a", "alac", input]);
    const handle = await open(input);
    try { expect(await buildAudioView(handle, (await handle.stat()).size)).toBeNull(); }
    finally { await handle.close(); }
  });
  it("promotes offsets when adding the header places a chunk beyond 4 GiB", () => {
    const starts = new Float64Array([0, 0xffffffff - 16]);
    const { head, base } = buildHeader(starts, table => [Buffer.alloc(12), table]);
    expect(head.toString("ascii", 16, 20)).toBe("co64");
    expect(head.readBigUInt64BE(28)).toBe(BigInt(base));
    expect(head.readBigUInt64BE(36)).toBe(BigInt(base + starts[1]));
  });
});
