import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat, realpath, rm, rename } from "node:fs/promises";
import {
  resolve,
  relative,
  extname,
  basename,
  delimiter,
  sep,
} from "node:path";
import { parseFile } from "music-metadata";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { HttpError, invariant } from "./errors";

const run = promisify(execFile);
const mimes: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".aiff": "audio/aiff",
  ".wma": "audio/x-ms-wma",
};
export interface MediaInspection {
  ext: string;
  bytes: number;
  hash: string;
  kind: "audio" | "video";
  mime: string;
  duration: number | null;
  title: string;
  browserCompatible: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  videoStream?: string;
  audioStream?: string;
  compatibleVideoCodec: boolean;
  compatibleAudioCodec: boolean;
}
export async function hashFile(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  return hash.digest("hex");
}
async function probeMediaStreams(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let output = "";
  try {
    await run(String(ffmpeg), ["-hide_banner", "-nostdin", "-i", path], {
      timeout: 30_000,
      maxBuffer: 1_048_576,
      signal,
    });
  } catch (error) {
    signal?.throwIfAborted();
    const result = error as { code?: number | string; stderr?: string };
    // FFmpeg reports stream headers, then exits with code 1 when no output is provided.
    if (result.code === 1) output = result.stderr ?? "";
  }
  const streams = [
    ...output.matchAll(
      /^ *Stream #(\d+:\d+)[^:\r\n]*:\s*(Audio|Video):\s*([\w]+)([^\r\n]*)/gm,
    ),
  ].map((match) => ({
    id: match[1]!,
    type: match[2]!,
    codec: match[3]!,
    details: match[4]!,
  }));
  const video = streams.find(
    (stream) =>
      stream.type === "Video" && !stream.details.includes("(attached pic)"),
  );
  const audio = streams.find((stream) => stream.type === "Audio");
  invariant(
    video || audio,
    415,
    "invalid_media",
    "В файле нет аудио или видео для воспроизведения",
  );
  return { audio, video, output };
}

export async function inspectAudioTrack(path: string, signal?: AbortSignal) {
  const { audio } = await probeMediaStreams(path, signal);
  return Boolean(audio);
}

export async function inspectFile(
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<MediaInspection> {
  options.signal?.throwIfAborted();
  const ext = extname(path).toLowerCase();
  invariant(
    mimes[ext],
    415,
    "unsupported_media",
    "Поддерживаются аудио- и видеофайлы: MP3, WAV, FLAC, OGG, M4A, MP4, WebM, MOV, MKV",
  );
  const info = await stat(path);
  invariant(
    info.isFile() && info.size > 0,
    400,
    "empty_file",
    "Файл пуст или не является обычным файлом",
  );
  let duration: number | null = null;
  let title = basename(path, ext);
  try {
    const metadata = await parseFile(path, {
      duration: true,
      skipCovers: true,
    });
    duration = metadata.format.duration ?? null;
    title = metadata.common.title || title;
  } catch {
    /* FFmpeg probes video and formats without music tags. */
  }
  const { audio, video, output } = await probeMediaStreams(path, options.signal);
  const kind = video ? "video" : "audio";
  const compatibleVideoCodec =
    video?.codec === "h264" &&
    /\byuvj?420p(?:\b|\()/.test(video.details) &&
    !/\byuvj?420p\d/.test(video.details);
  const compatibleAudioCodec =
    audio?.codec === "aac" && !/HE-AAC|LTP|SSR/.test(audio.details);
  const mp4Audio = !audio || compatibleAudioCodec;
  const browserCompatible =
    kind === "video"
      ? ([".mp4", ".m4v"].includes(ext) && compatibleVideoCodec && mp4Audio) ||
        (ext === ".webm" &&
          ["vp8", "vp9", "av1"].includes(video!.codec) &&
          (!audio || ["opus", "vorbis"].includes(audio.codec)))
      : (ext === ".mp3" && audio?.codec === "mp3") ||
        (ext === ".wav" &&
          /^pcm_(u8|s16le|s24le|s32le|f32le)$/.test(audio?.codec ?? "")) ||
        (ext === ".flac" && audio?.codec === "flac") ||
        ([".ogg", ".opus"].includes(ext) &&
          ["opus", "vorbis"].includes(audio?.codec ?? "")) ||
        ([".m4a", ".mp4", ".m4v"].includes(ext) && compatibleAudioCodec) ||
        (ext === ".webm" && ["opus", "vorbis"].includes(audio?.codec ?? ""));
  const found = output.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (duration === null && found)
    duration = +found[1] * 3600 + +found[2] * 60 + +found[3];
  const mime =
    kind === "audio" && mimes[ext].startsWith("video")
      ? ({
          ".webm": "audio/webm",
          ".mkv": "audio/x-matroska",
          ".mov": "audio/quicktime",
          ".avi": "audio/x-msvideo",
        }[ext] ?? "audio/mp4")
      : mimes[ext];
  return {
    ext,
    bytes: info.size,
    hash: await hashFile(path, options.signal),
    kind,
    mime,
    duration,
    title,
    browserCompatible,
    hasAudio: Boolean(audio),
    videoCodec: video?.codec,
    audioCodec: audio?.codec,
    videoStream: video?.id,
    audioStream: audio?.id,
    compatibleVideoCodec,
    compatibleAudioCodec,
  };
}

/** Generate a playback derivative; the caller owns and removes the returned temporary file. */
export async function preparePlayback(
  path: string,
  media: MediaInspection,
  workDir: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ path: string; media: MediaInspection } | undefined> {
  if (media.browserCompatible) return undefined;
  invariant(
    ffmpeg,
    503,
    "ffmpeg_unavailable",
    "FFmpeg недоступен для подготовки файла",
  );
  options.signal?.throwIfAborted();
  await mkdir(workDir, { recursive: true });
  const target = resolve(
    workDir,
    `${randomUUID()}${media.kind === "video" ? ".mp4" : ".m4a"}`,
  );
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    path,
  ];
  if (media.videoStream) {
    args.push("-map", media.videoStream);
    if (media.compatibleVideoCodec) args.push("-c:v", "copy");
    else
      args.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale=ceil(iw/2)*2:ceil(ih/2)*2",
      );
  }
  if (media.audioStream) {
    args.push("-map", media.audioStream);
    if (media.compatibleAudioCodec) args.push("-c:a", "copy");
    else args.push("-c:a", "aac", "-b:a", "192k");
  }
  args.push("-map_metadata", "0", "-movflags", "+faststart", target);
  try {
    await new Promise<void>((resolveProcess, rejectProcess) => {
      const child = spawn(String(ffmpeg), args, {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          stop();
        },
        options.timeoutMs ?? 5 * 60_000,
      );
      const abort = () => {
        aborted = true;
        stop();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const clean = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
      };
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-16_384);
      });
      child.once("error", (error) => {
        clean();
        rejectProcess(error);
      });
      child.once("close", (code) => {
        clean();
        if (timedOut)
          rejectProcess(
            new HttpError(
              422,
              "media_conversion_timeout",
              "Превышено время подготовки файла для браузера",
            ),
          );
        else if (aborted)
          rejectProcess(
            options.signal?.reason ?? new Error("Подготовка файла отменена"),
          );
        else if (code !== 0)
          rejectProcess(
            new HttpError(
              422,
              "media_conversion_failed",
              `Не удалось подготовить файл для браузера: ${stderr.slice(-2000)}`,
            ),
          );
        else resolveProcess();
      });
    });
    const prepared = await inspectFile(target, { signal: options.signal });
    invariant(
      prepared.browserCompatible && prepared.kind === media.kind,
      422,
      "media_conversion_failed",
      "Подготовленный файл не поддерживается браузером",
    );
    return { path: target, media: prepared };
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}
export function storagePath(root: string, path: string) {
  const full = resolve(root, path);
  invariant(
    full.startsWith(resolve(root) + sep),
    400,
    "invalid_path",
    "Путь за пределами хранилища",
  );
  return full;
}
export async function copyMedia(
  root: string,
  ownerId: string,
  hash: string,
  ext: string,
  source: string,
) {
  const dir = resolve(root, "media", ownerId);
  await mkdir(dir, { recursive: true });
  const target = resolve(dir, `${hash}${ext}`);
  const temporary = resolve(dir, `.${hash}-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return relative(root, target);
}
export async function allowedLocalPath(path: string) {
  const full = await realpath(path);
  const roots = (process.env.LOCAL_MEDIA_DIRS ?? "")
    .split(delimiter)
    .filter(Boolean);
  for (const root of roots) {
    const checked = await realpath(root).catch(() => "");
    if (checked && (full === checked || full.startsWith(checked + sep)))
      return full;
  }
  throw new HttpError(
    403,
    "local_path_forbidden",
    "Папка не разрешена для локального импорта. Добавьте её в LOCAL_MEDIA_DIRS",
  );
}
export const temporaryName = () => randomUUID();
