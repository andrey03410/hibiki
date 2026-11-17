import { spawn } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const LIST_ID = /^[a-zA-Z0-9_-]{2,200}$/;
const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);
export interface YoutubeMetadata {
  externalId: string;
  title?: string;
  duration?: number;
  thumbnail?: string;
  available?: boolean;
  reason?: string;
}
export interface YoutubeCollection {
  title?: string;
  entries: YoutubeMetadata[];
  warnings: string[];
}

export function normalizeYoutubeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Нужна ссылка YouTube");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("Поддерживаются только ссылки youtube.com и youtu.be");
  const list = url.searchParams.get("list");
  if (
    list &&
    LIST_ID.test(list) &&
    (url.pathname === "/playlist" || url.pathname === "/watch")
  )
    return `https://www.youtube.com/playlist?list=${list}`;
  const id = url.hostname.endsWith("youtu.be")
    ? url.pathname.slice(1)
    : url.pathname === "/watch"
      ? url.searchParams.get("v")
      : /^\/(shorts|embed|live)\//.test(url.pathname)
        ? url.pathname.split("/")[2]
        : null;
  if (!id || !VIDEO_ID.test(id))
    throw new Error("Ссылка не содержит поддерживаемое видео или плейлист");
  return `https://www.youtube.com/watch?v=${id}`;
}

export function parseYoutubeEntry(value: unknown): YoutubeMetadata | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !VIDEO_ID.test(raw.id)) return null;
  const title =
    typeof raw.title === "string" &&
    !/^\[(?:Private|Deleted|Unavailable) video\]$/i.test(raw.title)
      ? raw.title
      : undefined;
  const unavailable =
    ["private", "premium_only", "subscriber_only", "needs_auth"].includes(
      String(raw.availability),
    ) ||
    (typeof raw.title === "string" &&
      /^\[(?:Private|Deleted|Unavailable) video\]$/i.test(raw.title));
  const result: YoutubeMetadata = { externalId: raw.id };
  if (title) result.title = title;
  if (
    typeof raw.duration === "number" &&
    Number.isFinite(raw.duration) &&
    raw.duration >= 0
  )
    result.duration = raw.duration;
  const thumbs = Array.isArray(raw.thumbnails) ? raw.thumbnails : [];
  const thumbnail =
    typeof raw.thumbnail === "string" ? raw.thumbnail : thumbs.at(-1)?.url;
  if (typeof thumbnail === "string" && thumbnail.startsWith("https://"))
    result.thumbnail = thumbnail;
  if (unavailable) {
    result.available = false;
    result.reason =
      typeof raw.availability === "string" ? raw.availability : "unavailable";
  } else if (title) result.available = true;
  return result;
}

function redactProviderMessage(value: string): string {
  const proxy = process.env.YTDLP_PROXY;
  if (!proxy) return value;
  let result = value.replaceAll(proxy, "[proxy]");
  try {
    const url = new URL(proxy);
    for (const part of [url.hostname, url.username, url.password].filter(
      (value) => value.length > 3,
    ))
      result = result.replaceAll(part, "[redacted]");
  } catch {}
  return result;
}

export class YoutubeProviderError extends Error {
  readonly unavailable: boolean;
  constructor(message: string) {
    message = redactProviderMessage(message);
    const meaningful =
      message
        .split("\n")
        .filter((s) => /ERROR|unavailable|timed out|not found|ENOENT/i.test(s))
        .at(-1) ?? message;
    super(meaningful.slice(0, 1500));
    this.name = "YoutubeProviderError";
    this.unavailable =
      /Video unavailable|Private video|has been removed|has been deleted|account.*terminated|not available in your country|members.only/i.test(
        message,
      );
  }
}

export async function runTool(
  binary: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onLine?: (line: string) => void;
    maxOutput?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let tail = "";
    let failure: Error | undefined;
    const stop = (reason: Error) => {
      failure ??= reason;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* process already exited */
      }
    };
    const abort = () => stop(new Error("Задание отменено"));
    const timer = setTimeout(
      () => stop(new Error("Истёк таймаут провайдера")),
      options.timeoutMs ?? 120_000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutput ?? 32 * 1024 * 1024))
        return stop(new Error("Ответ провайдера превышает лимит"));
      output.push(chunk);
      tail += chunk.toString();
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) options.onLine?.(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.reduce((n, c) => n + c.length, 0) < 128 * 1024)
        errors.push(chunk);
    });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(new YoutubeProviderError(error.message));
    });
    child.on("close", (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new YoutubeProviderError(
            Buffer.concat(errors).toString() ||
              `yt-dlp завершился с кодом ${code}`,
          ),
        );
      else
        resolve({
          stdout: Buffer.concat(output).toString(),
          stderr: Buffer.concat(errors).toString(),
        });
    });
  });
}

function baseArgs(): string[] {
  const args = [
    "--ignore-config",
    "--no-cache-dir",
    "--socket-timeout",
    "20",
    "--retries",
    "2",
    "--fragment-retries",
    "2",
    "--js-runtimes",
    process.env.YTDLP_JS_RUNTIME || `node:${process.execPath}`,
  ];
  if (process.env.YTDLP_REMOTE_EJS === "1")
    args.push("--remote-components", "ejs:github");
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
  return args;
}
const binary = () => process.env.YTDLP_PATH || "yt-dlp";
export async function youtubeOembed(
  url: string,
  signal?: AbortSignal,
): Promise<YoutubeMetadata> {
  const canonical = normalizeYoutubeUrl(url);
  const parsed = new URL(canonical);
  const externalId = parsed.searchParams.get("v");
  if (!externalId)
    throw new Error("oEmbed поддерживает только отдельные видео");
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", canonical);
  endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint, {
    signal: AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(signal ? [signal] : []),
    ]),
    redirect: "error",
  });
  if (!response.ok)
    throw new YoutubeProviderError(`YouTube oEmbed: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 128 * 1024)
    throw new YoutubeProviderError("Ответ oEmbed превышает лимит");
  const raw = JSON.parse(text);
  if (typeof raw.title !== "string" || !raw.title.trim())
    throw new YoutubeProviderError("oEmbed не вернул название");
  const thumbnail =
    typeof raw.thumbnail_url === "string" &&
    raw.thumbnail_url.startsWith("https://i.ytimg.com/")
      ? raw.thumbnail_url
      : undefined;
  return {
    externalId,
    title: raw.title.trim().slice(0, 2000),
    ...(thumbnail ? { thumbnail } : {}),
  };
}
export async function discoverYoutube(
  url: string,
  signal?: AbortSignal,
): Promise<YoutubeCollection> {
  const canonical = normalizeYoutubeUrl(url);
  try {
    const { stdout, stderr } = await runTool(
      binary(),
      [
        ...baseArgs(),
        "--flat-playlist",
        "--ignore-errors",
        "--skip-download",
        "--dump-single-json",
        "--playlist-end",
        "10000",
        "--",
        canonical,
      ],
      { signal },
    );
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new YoutubeProviderError(
        stderr ||
          "yt-dlp не вернул метаданные; проверьте версию, EJS и JS runtime",
      );
    }
    if (!raw || typeof raw !== "object")
      throw new YoutubeProviderError(
        stderr || "Провайдер не вернул метаданные",
      );
    const entries = (Array.isArray(raw.entries) ? raw.entries : [raw])
      .map(parseYoutubeEntry)
      .filter((e): e is YoutubeMetadata => e !== null);
    if (!entries.length)
      throw new YoutubeProviderError(
        stderr || "Провайдер не вернул ни одной позиции",
      );
    return {
      title: typeof raw.title === "string" ? raw.title : undefined,
      entries,
      warnings: stderr ? [redactProviderMessage(stderr).slice(-1500)] : [],
    };
  } catch (error) {
    signal?.throwIfAborted();
    const parsed = new URL(canonical);
    if (parsed.pathname === "/playlist") throw error;
    if (error instanceof YoutubeProviderError && error.unavailable)
      return {
        entries: [
          {
            externalId: parsed.searchParams.get("v")!,
            available: false,
            reason: error.message,
          },
        ],
        warnings: [error.message],
      };
    try {
      const entry = await youtubeOembed(canonical, signal);
      return {
        title: entry.title,
        entries: [entry],
        warnings: [
          `Метаданные получены через официальный YouTube oEmbed; воспроизведение и скачивание не проверены. yt-dlp: ${redactProviderMessage(error instanceof Error ? error.message : String(error)).slice(0, 1000)}`,
        ],
      };
    } catch (fallbackError) {
      signal?.throwIfAborted();
      throw new YoutubeProviderError(
        `yt-dlp: ${error instanceof Error ? error.message : String(error)}; oEmbed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }
}
export async function refreshYoutube(
  externalId: string,
  signal?: AbortSignal,
): Promise<YoutubeMetadata> {
  if (!VIDEO_ID.test(externalId)) throw new Error("Некорректный ID YouTube");
  const { stdout } = await runTool(
    binary(),
    [
      ...baseArgs(),
      "--no-playlist",
      "--skip-download",
      "--dump-single-json",
      "--",
      `https://www.youtube.com/watch?v=${externalId}`,
    ],
    { signal },
  );
  const entry = parseYoutubeEntry(JSON.parse(stdout));
  if (!entry)
    throw new YoutubeProviderError("Провайдер вернул некорректное видео");
  return entry;
}
export async function downloadYoutube(
  externalId: string,
  mode: "audio" | "video",
  directory: string,
  signal?: AbortSignal,
  onProgress?: (value: number) => void,
): Promise<string> {
  if (!VIDEO_ID.test(externalId)) throw new Error("Некорректный ID YouTube");
  await mkdir(directory, { recursive: true });
  const marker = path.join(directory, "finished.txt");
  const args = [
    ...baseArgs(),
    "--no-playlist",
    "--no-mtime",
    "--newline",
    "--max-filesize",
    String(4 * 1024 * 1024 * 1024),
    "--ffmpeg-location",
    String(ffmpegStatic),
    "--paths",
    directory,
    "--output",
    "media.%(ext)s",
    "--print-to-file",
    "after_move:filepath",
    marker,
    ...(mode === "audio"
      ? [
          "--format",
          "bestaudio[ext=m4a]/bestaudio/best",
          "--extract-audio",
          "--audio-format",
          "m4a",
        ]
      : [
          "--format",
          "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best",
          "--merge-output-format",
          "mp4",
          "--recode-video",
          "mp4",
        ]),
    "--",
    `https://www.youtube.com/watch?v=${externalId}`,
  ];
  await runTool(binary(), args, {
    signal,
    timeoutMs: 60 * 60 * 1000,
    onLine: (line) => {
      const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
      if (match) onProgress?.(Math.min(1, Number(match[1]) / 100));
    },
  });
  const output = (await readFile(marker, "utf8")).trim().split("\n").at(-1)!;
  const actual = await realpath(output);
  const root = await realpath(directory);
  if (!actual.startsWith(root + path.sep))
    throw new Error("Провайдер вернул путь за пределами задания");
  return actual;
}
export async function youtubeDiagnostics() {
  const { stdout } = await runTool(binary(), ["--ignore-config", "--version"], {
    timeoutMs: 45_000,
  });
  const ffmpeg = await runTool(String(ffmpegStatic), ["-version"], {
    timeoutMs: 45_000,
  });
  return {
    version: stdout.trim(),
    runtime: process.env.YTDLP_JS_RUNTIME || `node:${process.execPath}`,
    node: process.version,
    ffmpeg: ffmpeg.stdout.split("\n")[0],
    remoteEjs: process.env.YTDLP_REMOTE_EJS === "1",
    ejs: "Официальный standalone yt-dlp включает EJS; для других сборок установите yt-dlp-ejs или включите YTDLP_REMOTE_EJS=1",
  };
}
export async function updateYoutubeTool() {
  if (process.env.YTDLP_ALLOW_UPDATE !== "1")
    throw new Error("Обновление выключено; задайте YTDLP_ALLOW_UPDATE=1");
  return runTool(binary(), ["--ignore-config", "--update"], {
    timeoutMs: 120_000,
  });
}
