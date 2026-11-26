import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { mediaRangeStream } from "./media-pacing";
import { invariant } from "./errors";
import { readOnlyMediaFlags } from "./media-playback";
import { buildAudioView, buildVideoView, readAudioRange, type AudioView } from "./mp4-audio";

type CachedView = { loading: Promise<AudioView | null>; weight: number };
const views = new Map<string, CachedView>();
let cacheBytes = 0;
function evictOldest() {
  const key = views.keys().next().value!;
  cacheBytes -= views.get(key)!.weight;
  views.delete(key);
}
function cachedView(key: string, build: () => Promise<AudioView | null>) {
  const existing = views.get(key);
  if (existing) {
    views.delete(key);
    views.set(key, existing);
    return existing.loading;
  }
  const entry = { loading: build(), weight: 0 };
  views.set(key, entry);
  if (views.size > 64) evictOldest();
  void entry.loading.then(view => {
    if (!view || views.get(key) !== entry) return;
    entry.weight = view.header.length + view.slices.length * 64;
    cacheBytes += entry.weight;
    while (cacheBytes > 64 * 1024 ** 2) evictOldest();
  }, () => { if (views.get(key) === entry) views.delete(key); });
  return entry.loading;
}

function byteRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const [, first, last] = match;
  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = first && last ? Math.min(Number(last), size - 1) : size - 1;
  return Number.isSafeInteger(start) && start <= end && start < size ? { start, end } : null;
}

export async function sendMediaFile(request: FastifyRequest, reply: FastifyReply, path: string,
  file: { id: string; hash: string; mime: string }, audio: boolean | number, etag = file.hash) {
  const handle = await open(path, readOnlyMediaFlags).catch(() => undefined);
  invariant(handle, 404, "file_not_found", "Файл не найден");
  let streaming = false;
  try {
    const info = await handle.stat();
    invariant(info.isFile(), 404, "file_not_found", "Файл не найден");
    let view: AudioView | null = null;
    if (typeof audio === "number") {
      view = await cachedView(JSON.stringify(["video", file.id, file.hash, info.size, info.mtimeMs, audio]),
        () => buildVideoView(handle, info.size, audio));
      invariant(view, 404, "visual_view_missing", "Видеоряд недоступен");
    } else if (audio) {
      invariant(file.mime === "video/mp4", 404, "audio_view_missing", "Звуковая дорожка недоступна");
      view = await cachedView(JSON.stringify([file.id, file.hash, info.size, info.mtimeMs]),
        () => buildAudioView(handle, info.size));
      invariant(view, 404, "audio_view_missing", "Звуковая дорожка недоступна");
      reply.header("etag", `"${etag}-a1"`);
    }
    if (typeof audio === "number" || (!audio && etag !== file.hash)) reply.header("etag", '"' + etag + '"');
    const size = view?.bytes ?? info.size;
    const range = request.headers.range ? byteRange(request.headers.range, size) : undefined;
    const mime = typeof audio === "number" ? "video/mp4" : view ? "audio/mp4" : file.mime;
    reply.type(mime).header("accept-ranges", "bytes");
    if (range === null) return reply.code(416).header("content-range", `bytes */${size}`).send();
    if (range) reply.code(206).header("content-range", `bytes ${range.start}-${range.end}/${size}`);
    reply.header("content-length", range ? range.end - range.start + 1 : size);
    if (request.method === "HEAD") return reply.send();
    const stream = view
      ? Readable.from(readAudioRange(handle, view, range?.start ?? 0, range?.end ?? size - 1), { objectMode: false })
      : handle.createReadStream(range);
    if (view) stream.once("close", () => { void handle.close().catch(() => {}); });
    streaming = true;
    return reply.send(mediaRangeStream(stream, mime, request.headers));
  } finally {
    if (!streaming) await handle.close();
  }
}
