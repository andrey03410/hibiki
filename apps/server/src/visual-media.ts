import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { invariant } from "./errors";
import { probeMediaStreams } from "./media";
import { readOnlyMediaFlags } from "./media-playback";
import { buildVideoView, readAudioRange } from "./mp4-audio";

export async function videoStreams(path: string, signal?: AbortSignal) {
  const { videos } = await probeMediaStreams(path, signal, true);
  return videos.map((s) => ({
    index: Number(s.id.split(":")[1]),
    codec: s.codec,
    compatible: s.codec === "h264" && /\byuvj?420p\b/.test(s.details),
  }));
}

export async function selectVideoStream(path: string, index?: number, signal?: AbortSignal) {
  const streams = await videoStreams(path, signal);
  invariant(streams.length, 415, "visual_video_missing", "В файле нет видеоряда");
  invariant(
    index !== undefined || streams.length === 1,
    409,
    "visual_video_ambiguous",
    "Выберите videoStreamIndex: " + streams.map((s) => s.index + " (" + s.codec + ")").join(", "),
  );
  const stream = index === undefined ? streams[0] : streams.find((s) => s.index === index);
  invariant(stream, 400, "visual_video_index", "Видеопоток с таким индексом не найден");
  return stream;
}

export async function inspectVisualPath(path: string, videoStreamIndex?: number, signal?: AbortSignal) {
  const stream = await selectVideoStream(path, videoStreamIndex, signal);
  const file = await open(path, readOnlyMediaFlags);
  try {
    const view = stream.compatible && (await buildVideoView(file, (await file.stat()).size, stream.index));
    invariant(
      view && Number.isFinite(view.duration) && view.duration > 0,
      415,
      "visual_prepare_required",
      "Видеоряд требует подготовки для воспроизведения",
    );
    const digest = createHash("sha256").update("hibiki-video-1");
    for (const field of view.identity) digest.update(String(field.length) + ":").update(field);
    for await (const buf of readAudioRange(file, view, view.header.length, view.bytes - 1)) {
      signal?.throwIfAborted();
      digest.update(buf);
    }
    return { streamIndex: stream.index, duration: view.duration, signature: digest.digest("hex"), view };
  } finally {
    await file.close();
  }
}
