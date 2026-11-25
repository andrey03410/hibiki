import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { z } from "zod";
import { parseFromTokenizer } from "music-metadata";
import { fromFile } from "strtok3";
import type { Db } from "./db";
import { invariant } from "./errors";
import { storagePath } from "./media";

const maxArtworkBytes = 5 * 1024 ** 2;
const maxMetadataBytes = 8 * 1024 ** 2;
const maxMetadataReads = 4096;
export const artworkQuery = z.object({ size: z.enum(["thumb", "cover"]).optional(), v: z.string().optional() });
type ArtworkSize = NonNullable<z.infer<typeof artworkQuery>["size"]>;
const renditions = {
  thumb: { pixels: 96, quality: 72, maxBytes: 32 * 1024 },
  cover: { pixels: 640, quality: 80, maxBytes: 768 * 1024 },
};
// Two 100-item pages can arrive together over HTTP/2 during a fast scroll.
const maxQueuedFiles = 256;
const runFfmpeg = promisify(execFile);
interface Artwork {
  mime: "image/jpeg" | "image/png" | "image/webp";
  bytes: Buffer;
  etag?: string;
  version?: string;
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

async function makeRendition(original: Artwork, size: ArtworkSize): Promise<Artwork | undefined> {
  const { pixels, quality, maxBytes } = renditions[size];
  const codec = { "image/jpeg": "mjpeg", "image/png": "png", "image/webp": "webp" }[original.mime];
  const encoding = runFfmpeg(String(ffmpeg), [
    "-hide_banner", "-loglevel", "error", "-max_alloc", String(64 * 1024 ** 2),
    "-filter_threads", "1", "-threads", "1", "-max_pixels", String(16 * 1024 ** 2),
    "-protocol_whitelist", "pipe", "-f", "image2pipe", "-c:v", codec, "-i", "pipe:0",
    "-frames:v", "1", "-vf", `scale='min(${pixels},iw)':'min(${pixels},ih)':force_original_aspect_ratio=decrease`,
    "-threads", "1", "-c:v", "libwebp", "-quality", String(quality), "-f", "image2pipe", "pipe:1",
  ], { encoding: "buffer", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: maxBytes });
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

// The item URL can choose a cover from multiple local files. Its HTTP version
// must change if any candidate changes, including the preferred original.
export function artworkVersion(sources: ReadonlyArray<{ file?: { hash: string; kind: string } | null; reason?: string | null }>) {
  const hashes = sources.filter(s => s.file?.kind === "audio")
    .map(s => [s.reason === "unsupported_codec" ? 0 : 1, s.file!.hash] as const)
    .sort(([a, x], [b, y]) => a - b || x.localeCompare(y)).map(([, hash]) => hash);
  if (hashes.length < 2) return hashes[0];
  return createHash("sha256").update(hashes.join(":")).digest("hex");
}

function artworkDirectory(root: string, ownerId: string) {
  return storagePath(root, join("cache", "artwork", encodeURIComponent(ownerId).replaceAll(".", "%2E")));
}

async function diskRendition(root: string, ownerId: string, hash: string, size: ArtworkSize, original: () => Promise<Artwork | undefined>) {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    const cover = await original();
    return cover && makeRendition(cover, size);
  }
  const directory = artworkDirectory(root, ownerId);
  const base = join(directory, hash + "-" + size);
  try {
    const bytes = await readFile(base + ".webp");
    if (imageMime(bytes) === "image/webp") return { mime: "image/webp" as const, bytes,
      etag: `"${createHash("sha256").update(bytes).digest("base64url")}"` };
  } catch { /* A missing or evicted cache entry is generated on demand. */ }
  if (await stat(base + ".none").then(s => s.isFile(), () => false)) return;
  const cover = await original();
  const result = cover && await makeRendition(cover, size);
  if (cover && !result) return; // A transient encoder failure must remain retryable after a restart.
  const target = base + (result ? ".webp" : ".none");
  const temp = target + "." + randomUUID() + ".tmp";
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temp, result?.bytes ?? Buffer.alloc(0), { flag: "wx" });
    await rename(temp, target);
  } catch {
    await rm(temp, { force: true }).catch(() => {});
  }
  return result;
}

export async function removeUnusedArtwork(db: Db, root: string, ownerId: string, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) return;
  if (await db.source.findFirst({ where: { ownerId, file: { ownerId, hash } }, select: {id: true} })) return;
  const directory = artworkDirectory(root, ownerId);
  await Promise.all(["thumb.webp", "thumb.none", "cover.webp", "cover.none"].map(suffix =>
    rm(join(directory, hash + "-" + suffix), { force: true })));
}

export async function pruneArtworkCache(db: Db, root: string) {
  const parent = join(root, "cache", "artwork");
  const owners = await readdir(parent, {withFileTypes: true}).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const folder of owners.filter(d => d.isDirectory())) {
    const ownerId = decodeURIComponent(folder.name);
    const directory = artworkDirectory(root, ownerId);
    const used = new Set((await db.mediaFile.findMany({
      where: {ownerId, sources: { some: { ownerId } }}, select: {hash: true},
    })).map(f => f.hash));
    for (const file of await readdir(directory, {withFileTypes: true})) {
      if (!file.isFile()) continue;
      const match = /^([a-f0-9]{64})-(?:thumb|cover)\.(?:webp|none)$/.exec(file.name);
      if (match && !used.has(match[1]!)) await removeUnusedArtwork(db, root, ownerId, match[1]!);
      if (file.name.endsWith(".tmp")) {
        const path = join(directory, file.name);
        const info = await stat(path).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > 86400_000) await rm(path, { force: true });
      }
    }
  }
}

export class ArtworkService {
  private originals = new ArtworkCache(8, 2);
  private renditions = {
    thumb: new ArtworkCache(512, 2),
    cover: new ArtworkCache(32, 1),
  };
  constructor(
    private db: Db,
    private storageRoot: string,
  ) {}

  async get(ownerId: string, itemId: string, size?: ArtworkSize): Promise<Artwork> {
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
        Number(a.reason === "unsupported_codec") || (a.file?.hash ?? "").localeCompare(b.file?.hash ?? ""),
    );
    for (const source of sources) {
      const file = source.file;
      if (!file || file.ownerId !== ownerId || file.kind !== "audio") continue;
      const path = storagePath(this.storageRoot, file.path);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) continue;
      const key = `${path}:${file.hash}:${info.size}:${info.mtimeMs}`;
      const original = () => this.originals.get(key, () => readArtwork(path));
      const result = size
        ? await this.renditions[size].get(key, () => diskRendition(this.storageRoot, ownerId, file.hash, size, original))
        : await original();
      if (result) return { ...result, version: artworkVersion(sources) };
    }
    invariant(false, 404, "artwork_not_found", "Обложка не найдена");
  }
}
