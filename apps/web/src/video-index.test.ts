import { describe, expect, it } from "vitest";
import { progressiveMp4 } from "./test-mp4";
import { intersectTimes, keyFrameTime, parseVideoIndex, playableTimes, tableFromSamples, windowBytes, type VideoIndex } from "./video-index";

function synthetic(): VideoIndex {
  // 1 s video frames at offsets 0, 100, …; key frames every 4 s; audio after each frame.
  const video = Array.from({ length: 20 }, (_, i) => ({ dts: i, duration: 1, timescale: 1, offset: i * 100, size: 60, is_sync: i % 4 === 0 }));
  const audio = Array.from({ length: 20 }, (_, i) => ({ dts: i, duration: 1, timescale: 1, offset: i * 100 + 60, size: 40, is_sync: true }));
  return { duration: 20, tracks: [tableFromSamples("video", video), tableFromSamples("audio", audio)] };
}

describe("video sample index", () => {
  it("starts a time window at the preceding key frame and covers interleaved audio", () => {
    const index = synthetic();
    expect(keyFrameTime(index, 6.5)).toBe(4);
    expect(windowBytes(index, 6.5, 9)).toEqual([400, 1000]);
    expect(windowBytes(index, -3, 1)).toEqual([0, 200]);
  });
  it("reports only moments decodable from a loaded key frame", () => {
    const index = synthetic();
    // Bytes from frame 2 to 10: frames 2–3 lack their key frame 0.
    expect(playableTimes(index, [[200, 1000]])).toEqual([[4, 10]]);
    expect(playableTimes(index, [[0, 2000]])).toEqual([[0, 20]]);
    expect(intersectTimes([[0, 5], [8, 12]], [[3, 9]])).toEqual([[3, 5], [8, 9]]);
  });
  it.each([false, true])("parses a progressive movie header without sample data (moov at end: %s)", async atEnd => {
    const { file, mdatBody, tailStart } = progressiveMp4(50, 10, atEnd);
    const parts = [{ offset: 0, bytes: file.subarray(0, mdatBody) }];
    if (tailStart) parts.push({ offset: tailStart, bytes: file.subarray(tailStart) });
    const index = (await parseVideoIndex(parts))!;
    expect(index.duration).toBe(5);
    expect(index.tracks.map(track => track.kind)).toEqual(["video", "audio"]);
    expect(keyFrameTime(index, 2.35)).toBe(2);
    const [start, end] = windowBytes(index, 2.35, 3)!;
    expect(start).toBe(index.tracks[0]!.offset[20]);
    expect(end).toBe(index.tracks[1]!.offset[30]! + 200);
  });
});
