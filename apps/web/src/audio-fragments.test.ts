import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { expect, it, vi } from "vitest";
import { playAudioFragments } from "./audio-fragments";

it("preserves every original AAC packet across fragment boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibiki-aac-fragments-"));
  vi.stubGlobal("MediaSource", {isTypeSupported: (type: string) => type.includes("mp4a.40.2")});
  try {
    const original = join(dir, "original.m4a"), output = join(dir, "from-decoder.m4a");
    execFileSync(String(ffmpeg), ["-v","error","-f","lavfi","-i","sine=frequency=440:duration=8",
      "-c:a","aac","-b:a","192k","-movflags","+faststart",original]);
    const data = await readFile(original);
    const chunks: Buffer[] = [];
    const events = new EventTarget();
    const buffer = Object.assign(events, {
      buffered: {length: 0},
      appendBuffer(value: ArrayBuffer) { chunks.push(Buffer.from(value)); queueMicrotask(() => events.dispatchEvent(new Event("updateend"))); },
    });
    const source = { addSourceBuffer: () => buffer, endOfStream: vi.fn() };
    const audioStart = data.indexOf("mdat") + 4;
    const read = (range: string) => {
      const [first, last] = range.slice(6).split("-");
      return new Response(data.subarray(Number(first), last ? Number(last) + 1 : data.length), {status: 206});
    };
    await playAudioFragments({currentTime: 0} as HTMLMediaElement, source as unknown as MediaSource, {
      url: "/files/a", size: data.length, mime: "audio/mp4", prefix: data.length, audioStart, duration: 8,
    }, read, new AbortController().signal);
    expect(source.endOfStream).toHaveBeenCalledOnce();
    expect(chunks.length).toBeGreaterThan(3);
    await writeFile(output, Buffer.concat(chunks));
    const digest = (file: string) => execFileSync(String(ffmpeg),
      ["-v","error","-i",file,"-map","0:a:0","-c","copy","-f","streamhash","-hash","sha256","-"], {encoding:"utf8"});
    expect(digest(output)).toBe(digest(original));
  } finally { vi.unstubAllGlobals(); await rm(dir, {recursive:true, force:true}); }
});
