import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { parseFromTokenizer } from "music-metadata";
import { fromFile } from "strtok3";
import type { Db } from "./db";
import { invariant } from "./errors";
import { storagePath } from "./media";

const maxArtworkBytes = 5 * 1024 ** 2;
const maxMetadataBytes = 8 * 1024 ** 2;
const maxMetadataReads = 4096;
const maxThumbBytes = 32 * 1024;
// Two 100-item pages can arrive together over HTTP/2 during a fast scroll.
const maxQueuedFiles = 256;
const runFfmpeg = promisify(execFile);
interface Artwork {
  mime: "image/jpeg" | "image/png" | "image/webp";
  bytes: Buffer;
  etag?: string;
}

// The embedded MIME tag is untrusted; only these raster signatures are served.
function imageMime(bytes: Buffer): Artwork["mime"] | undefined {
  if (
    bytes.length >= 3 &&
    bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
  )
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
}

async function readArtwork(path: string): Promise<Artwork | undefined> {
  let tokenizer: Awaited<ReturnType<typeof fromFile>> | undefined;
  try {
    tokenizer = await fromFile(path, {
      regularFileOnly: true,
      maxBufferSize: maxArtworkBytes + 64 * 1024,
    });
    let metadataBytes = 0;
    let metadataReads = 0;
    let budgetExceeded = false;
    // Parser limits apply per payload/list, not to all native tags it retains.
    // Every token and number is read through these two methods. Counting before
    // I/O also catches unmapped tags and pictures suppressed by tag priority.
    // Random-access ignore/seek skips media bytes without buffering them.
    for (const method of ["readBuffer", "peekBuffer"] as const) {
      const read = tokenizer[method].bind(tokenizer);
      tokenizer[method] = async (buffer, options) => {
        const length = options?.length ?? buffer.length;
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          ++metadataReads > maxMetadataReads ||
          metadataBytes + length > maxMetadataBytes
        ) {
          budgetExceeded = true;
          throw new Error("Artwork metadata extraction budget exceeded");
        }
        metadataBytes += length;
        return read(buffer, options);
      };
    }
    const metadata = await parseFromTokenizer(tokenizer, {
      duration: false,
      maxMemoryAllocation: maxArtworkBytes + 64 * 1024,
      maxMetadataEntries: 128,
    });
    // Some format parsers recover from read errors with partial metadata.
    if (budgetExceeded) return undefined;
    const pictures = [...(metadata.common.picture ?? [])].sort(
      (a, b) =>
        Number(b.type === "Cover (front)") - Number(a.type === "Cover (front)"),
    );
    for (const picture of pictures) {
      if (!picture.data.length || picture.data.length > maxArtworkBytes) continue;
      const bytes = Buffer.from(picture.data);
      const mime = imageMime(bytes);
      if (mime) return { bytes, mime };
    }
  } catch {
    // Missing, malformed and oversized metadata all use the player's fallback.
  } finally {
    await tokenizer?.close();
  }
}

async function makeThumbnail(original: Artwork): Promise<Artwork | undefined> {
  const codec = { "image/jpeg": "mjpeg", "image/png": "png", "image/webp": "webp" }[original.mime];
  const encoding = runFfmpeg(String(ffmpeg), [
    "-hide_banner", "-loglevel", "error", "-max_alloc", String(64 * 1024 ** 2),
    "-filter_threads", "1", "-threads", "1", "-max_pixels", String(16 * 1024 ** 2),
    "-protocol_whitelist", "pipe", "-f", "image2pipe", "-c:v", codec, "-i", "pipe:0",
    "-frames:v", "1", "-vf", "scale='min(96,iw)':'min(96,ih)':force_original_aspect_ratio=decrease",
    "-threads", "1", "-c:v", "libwebp", "-quality", "72", "-f", "image2pipe", "pipe:1",
  ], { encoding: "buffer", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: maxThumbBytes });
  // A malformed image or an early decoder exit can close stdin during the write.
  encoding.child.stdin?.on("error", () => {});
  encoding.child.stdin?.end(original.bytes);
  try {
    const { stdout } = await encoding;
    if (imageMime(stdout) !== "image/webp") return;
    return {
      bytes: stdout, mime: "image/webp",
      etag: `"${createHash("sha256").update(stdout).digest("base64url")}"`,
    };
  } catch {
    return undefined;
  }
}

export class ArtworkCache {
  private results = new Map<string, Artwork | undefined>();
  private pending = new Map<string, Promise<Artwork | undefined>>();
  private waiting: Array<() => void> = [];
  private active = 0;

  constructor(private capacity: number, private concurrency: number) {}

  async get(key: string, load: () => Promise<Artwork | undefined>) {
    if (this.results.has(key)) {
      const result = this.results.get(key);
      this.results.delete(key);
      this.results.set(key, result);
      return result;
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = this.run(key, load);
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }

  private async run(key: string, load: () => Promise<Artwork | undefined>) {
    if (this.active < this.concurrency) this.active++;
    else {
      invariant(this.waiting.length < maxQueuedFiles, 503, "artwork_busy", "Обработка обложек занята");
      await new Promise<void>(resolve => this.waiting.push(resolve));
    }
    try {
      const result = await load();
      this.results.set(key, result);
      if (this.results.size > this.capacity) this.results.delete(this.results.keys().next().value!);
      return result;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class ArtworkService {
  private originals = new ArtworkCache(8, 2);
  private thumbnails = new ArtworkCache(512, 2);
  constructor(
    private db: Db,
    private storageRoot: string,
  ) {}

  async get(ownerId: string, itemId: string, size?: "thumb"): Promise<Artwork> {
    // Never authorize through the cache: ownership is checked on every request.
    const item = await this.db.item.findFirst({
      where: { id: itemId, ownerId },
      include: {
        sources: {
          where: { provider: "local", ownerId },
          include: { file: true },
        },
      },
    });
    invariant(item, 404, "item_not_found", "Медиа не найдено");
    // The original retains its cover even when a prepared audio copy has none.
    // An audio source can belong to a video item, e.g. a YouTube audio download.
    const sources = item.sources.sort(
      (a, b) =>
        Number(b.reason === "unsupported_codec") -
        Number(a.reason === "unsupported_codec"),
    );
    for (const source of sources) {
      const file = source.file;
      if (!file || file.ownerId !== ownerId || file.kind !== "audio") continue;
      const path = storagePath(this.storageRoot, file.path);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) continue;
      const key = `${path}:${file.hash}:${info.size}:${info.mtimeMs}`;
      const original = () => this.originals.get(key, () => readArtwork(path));
      const result = size === "thumb"
        ? await this.thumbnails.get(key, async () => {
          const cover = await original();
          return cover && makeThumbnail(cover);
        })
        : await original();
      if (result) return result;
    }
    invariant(false, 404, "artwork_not_found", "Обложка не найдена");
  }
}
