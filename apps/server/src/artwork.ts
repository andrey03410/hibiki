import { stat } from "node:fs/promises";
import { parseFromTokenizer } from "music-metadata";
import { fromFile } from "strtok3";
import type { Db } from "./db";
import { invariant } from "./errors";
import { storagePath } from "./media";

const maxArtworkBytes = 5 * 1024 ** 2;
const maxMetadataBytes = 8 * 1024 ** 2;
const maxMetadataReads = 4096;
const maxCachedFiles = 8;
interface Artwork {
  mime: "image/jpeg" | "image/png" | "image/webp";
  bytes: Buffer;
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

export class ArtworkService {
  // At most 40 MiB of image bytes; pending requests for the same file share work.
  private cache = new Map<string, Promise<Artwork | undefined>>();
  constructor(
    private db: Db,
    private storageRoot: string,
  ) {}

  async get(ownerId: string, itemId: string): Promise<Artwork> {
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
      let artwork = this.cache.get(key);
      if (artwork) this.cache.delete(key);
      else artwork = readArtwork(path);
      this.cache.set(key, artwork);
      if (this.cache.size > maxCachedFiles)
        this.cache.delete(this.cache.keys().next().value!);
      const result = await artwork;
      if (result) return result;
    }
    invariant(false, 404, "artwork_not_found", "Обложка не найдена");
  }
}
