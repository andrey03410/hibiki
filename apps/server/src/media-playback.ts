import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { audioViewVersion, buildAudioView, readBytes, topLevelBoxes } from "./mp4-audio";
import { invariant } from "./errors";

export const hintsVersion = 1;
export const readOnlyMediaFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export interface PlaybackMetadata {
  audioStart: number;
  tailStart: number | null;
  hintsVersion: number;
  audioViewStart: number | null;
  audioViewBytes: number | null;
  audioViewVersion: number;
}

export async function inspectPlaybackMetadata(path: string, mime: string, expectedBytes?: bigint): Promise<PlaybackMetadata> {
  const handle = await open(path, readOnlyMediaFlags);
  try {
    const info = await handle.stat();
    invariant(info.isFile() && info.size > 0 && (expectedBytes === undefined || BigInt(info.size) === expectedBytes),
      404, "file_changed", "Файл отсутствует или изменился");
    const result: PlaybackMetadata = {
      hintsVersion, audioStart: 0, tailStart: null, audioViewStart: null, audioViewBytes: null, audioViewVersion,
    };
    if (mime === "audio/mpeg" && info.size >= 10) {
      const tag = await readBytes(handle, 0, 10);
      if (tag.toString("ascii", 0, 3) === "ID3" && [2, 3, 4].includes(tag[3]) &&
          tag.subarray(6).every(n => n < 128)) {
        const payload = tag.subarray(6).reduce((sum, n) => sum * 128 + n, 0);
        const start = 10 + payload + (tag[3] === 4 && (tag[5] & 0x10) ? 10 : 0);
        if (start < info.size) result.audioStart = start;
      }
    } else if (mime === "audio/mp4" || mime === "video/mp4") {
      const boxes = await topLevelBoxes(handle, info.size);
      const mdat = boxes.find(b => b.type === "mdat");
      const moov = boxes.find(b => b.type === "moov");
      if (mdat) result.audioStart = mdat.body;
      if (moov && mdat && moov.start > mdat.start) result.tailStart = moov.start;
      if (mime === "video/mp4") {
        const view = await buildAudioView(handle, info.size, boxes);
        if (view) {
          result.audioViewStart = view.header.length;
          result.audioViewBytes = view.bytes;
        }
      }
    }
    return result;
  } finally {
    await handle.close();
  }
}

interface StoredPlayback {
  audioStart: bigint | null;
  tailStart: bigint | null;
  hintsVersion: number;
  audioViewStart: bigint | null;
  audioViewBytes: bigint | null;
  audioViewVersion: number;
}
export function playbackFields(file: StoredPlayback, streamUrl: string) {
  return {
    ...(file.hintsVersion === hintsVersion && file.audioStart !== null && {
      playbackHints: { audioStart: Number(file.audioStart), ...(file.tailStart !== null && { tailStart: Number(file.tailStart) }) },
    }),
    // The v1 AAC representation is byte-identical while the worker checks older files for Opus and FLAC.
    ...(file.audioViewVersion > 0 && file.audioViewVersion <= audioViewVersion && file.audioViewBytes && {
      audioStreamUrl: streamUrl + "/audio", audioMime: "audio/mp4",
      audioBytes: Number(file.audioViewBytes), audioViewStart: Number(file.audioViewStart),
    }),
  };
}
