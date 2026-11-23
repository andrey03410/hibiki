import { meterStorage, release, requireHeavy, retain } from "./kaname";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Prisma, SourceProposal } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db";
import { HttpError, invariant } from "./errors";
import type { LibraryService } from "./library";
import { inspectFile, storagePath } from "./media";
import { uploadPolicy } from "./upload-policy";
import { normalizeYoutubeUrl, refreshYoutube, YoutubeProviderError } from "./youtube";

const stagingRoot = join("uploads", "replacements");
const stagedLifetime = 24 * 60 * 60 * 1000;
const stagingId = z.uuid();
const urlInput = z.string().trim().min(1).max(4000);
const reasonInput = z.string().trim().min(1).max(1000);

interface Preview {
  title: string;
  duration: number | null;
  warnings: string[];
  checkedAt: string;
}

interface StoredPreview extends Preview {
  thumbnail?: string;
}

function readPreview(row: SourceProposal): StoredPreview | null {
  return row.metadataJson ? JSON.parse(row.metadataJson) : null;
}

function proposalDto(row: SourceProposal) {
  const preview = readPreview(row);
  return {
    id: row.id,
    itemId: row.itemId,
    kind: row.kind === "local" ? "local" as const : "youtube" as const,
    url: row.url,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    preview: preview && {
      title: preview.title,
      duration: preview.duration,
      warnings: preview.warnings,
      checkedAt: preview.checkedAt,
    },
  };
}

function canonicalVideo(value: string) {
  try {
    const input = new URL(urlInput.parse(value));
    // A watch link copied while watching a playlist can still name one video.
    if (input.pathname === "/watch") input.searchParams.delete("list");
    const canonical = normalizeYoutubeUrl(input.href);
    if (new URL(canonical).searchParams.has("v")) return canonical;
  } catch {
    // Give browser and agent callers the same validation error.
  }
  throw new HttpError(400, "replacement_video_required", "Укажите ссылку на один ролик YouTube");
}

async function checkItem(db: Prisma.TransactionClient, ownerId: string, itemId: string) {
  invariant(await db.item.findFirst({ where: { id: itemId, ownerId }, select: { id: true } }),
    404, "item_not_found", "Медиа не найдено");
}

export async function proposeReplacement(
  db: Db, ownerId: string, itemId: string, url: string, reason: string,
) {
  const canonical = canonicalVideo(url);
  const explanation = reasonInput.parse(reason);
  return db.$transaction(async (tx) => {
    await checkItem(tx, ownerId, itemId);
    return proposalDto(await tx.sourceProposal.create({
      data: { id: randomUUID(), ownerId, itemId, kind: "youtube", url: canonical, reason: explanation },
    }));
  });
}

async function youtubeCandidate(db: Prisma.TransactionClient, ownerId: string, itemId: string, url: string) {
  const externalId = new URL(url).searchParams.get("v")!;
  const key = `youtube:${externalId}`;
  const source = await db.source.findUnique({ where: { ownerId_key: { ownerId, key } } });
  invariant(!source || source.itemId === itemId,
    409, "replacement_conflict", "Этот ролик уже привязан к другой записи");
  return { externalId, key, source };
}

async function previewYoutube(db: Db, ownerId: string, itemId: string, url: string): Promise<StoredPreview> {
  const { externalId } = await youtubeCandidate(db, ownerId, itemId, url);
  const unavailable = () => new HttpError(422, "replacement_unavailable", "Ролик недоступен");
  const metadata = await refreshYoutube(externalId, AbortSignal.timeout(30_000)).catch((error) => {
    if (error instanceof YoutubeProviderError && error.unavailable) throw unavailable();
    throw new HttpError(502, "replacement_check_failed", "Проверка YouTube не удалась. Попробуйте ещё раз.");
  });
  if (metadata.available === false) throw unavailable();
  const title = metadata.title?.trim();
  invariant(metadata.externalId === externalId && metadata.available === true && title,
    502, "replacement_check_failed", "YouTube не подтвердил доступность ролика");
  return {
    title: title.slice(0, 500),
    duration: metadata.duration ?? null,
    thumbnail: metadata.thumbnail,
    warnings: ["Воспроизведение во встроенном плеере ещё не проверено."],
    checkedAt: new Date().toISOString(),
  };
}

function stageDirectory(id: string) {
  return join(stagingRoot, stagingId.parse(id));
}

function stagingFilename(original: string) {
  const filename = basename(original.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "_");
  const extension = extname(filename);
  return Array.from(basename(filename, extension)).slice(0, 56).join("") +
    Array.from(extension).slice(0, 7).join("");
}

function pending(row: SourceProposal) {
  invariant(row.status === "pending", 409, "replacement_resolved", "Предложение уже обработано");
}

async function findProposal(db: Prisma.TransactionClient, ownerId: string, itemId: string, id: string) {
  const row = await db.sourceProposal.findFirst({ where: { id, ownerId, itemId } });
  invariant(row, 404, "replacement_not_found", "Предложение не найдено");
  return row;
}

export function registerReplacement(app: FastifyInstance, db: Db, library: LibraryService, storageRoot: string) {
  const base = "/api/items/:id/replacements";
  const active = new Set<string>();
  const directory = (id: string) => storagePath(storageRoot, stageDirectory(id));
  const removeStage = async (id: string) => {
    await rm(directory(id), { recursive: true, force: true });
    await release(db, "stage-" + id);
  };

  async function sweepStaging() {
    const cutoff = new Date(Date.now() - stagedLifetime);
    const entries = await readdir(storagePath(storageRoot, stagingRoot), { withFileTypes: true })
      .catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    for (const entry of entries) {
      const id = entry.name;
      if (!entry.isDirectory() || !stagingId.safeParse(id).success || active.has(id)) continue;
      const info = await lstat(directory(id)).catch(() => null);
      if (!info || info.mtime >= cutoff || active.has(id)) continue;
      const row = await db.sourceProposal.findUnique({ where: { id } });
      if (active.has(id) || (row && row.createdAt >= cutoff)) continue;
      if (row?.stagedPath) {
        await db.sourceProposal.updateMany({
          where: { id, status: { in: ["pending", "applying"] }, createdAt: { lt: cutoff } },
          data: { status: "expired", stagedPath: null },
        });
      }
      if (!active.has(id)) await removeStage(id);
    }
  }

  let timer: NodeJS.Timeout | undefined;
  let cleanup: Promise<void> | undefined;
  const sweep = () => cleanup ??= sweepStaging()
    .catch((error) => app.log.warn({ err: error }, "Could not clean staged replacements"))
    .finally(() => { cleanup = undefined; });
  app.addHook("onReady", async () => {
    await sweep();
    timer = setInterval(() => void sweep(), 60 * 60 * 1000).unref();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await cleanup;
  });

  const proposalIdOf = (request: FastifyRequest) =>
    z.object({ proposalId: z.string() }).parse(request.params).proposalId;

  async function scope(request: FastifyRequest) {
    invariant(request.user && request.cookies.hibiki_session && !request.headers.authorization,
      403, "browser_session_required", "Откройте карточку записи в Hibiki");
    const { id: itemId } = z.object({ id: z.string() }).parse(request.params);
    const ownerId = request.user.id;
    await checkItem(db, ownerId, itemId);
    return { ownerId, itemId };
  }

  async function stageFile(request: FastifyRequest, ownerId: string, itemId: string) {
    const id = randomUUID();
    const policy = uploadPolicy(false);
    active.add(id);
    try {
      let stagedPath: string | undefined;
      for await (const part of request.parts({ ...policy, limits: { ...policy.limits, files: 1, fields: 0 } })) {
        if (part.type !== "file") continue;
        const filename = stagingFilename(part.filename);
        invariant(filename && filename !== "." && filename !== "..", 400, "file_required", "Выберите файл");
        await mkdir(directory(id), { recursive: true, mode: 0o700 });
        stagedPath = join(stageDirectory(id), filename);
        await pipeline(part.file, meterStorage(db, ownerId, request.access, "stage-" + id), createWriteStream(storagePath(storageRoot, stagedPath), {
          flags: "wx", mode: 0o600,
        }));
        invariant(!part.file.truncated, 413, "file_too_large", "Файл превышает 2 ГиБ");
      }
      invariant(stagedPath, 400, "file_required", "Выберите файл");
      const media = await inspectFile(storagePath(storageRoot, stagedPath));
      if (!media.browserCompatible) requireHeavy(request.access);
      const preview: Preview = {
        title: media.title.trim().slice(0, 500) || basename(stagedPath),
        duration: media.duration,
        warnings: media.browserCompatible ? [] : ["При подтверждении Hibiki подготовит копию для воспроизведения."],
        checkedAt: new Date().toISOString(),
      };
      await retain(db, "stage-" + id);
      return await db.sourceProposal.create({
        data: { id, ownerId, itemId, kind: "local", stagedPath, metadataJson: JSON.stringify(preview) },
      });
    } catch (error) {
      await removeStage(id);
      throw error;
    } finally {
      active.delete(id);
    }
  }

  app.get(base, async (request, reply) => {
    const { ownerId, itemId } = await scope(request);
    reply.header("cache-control", "private, no-store");
    const rows = await db.sourceProposal.findMany({
      where: {
        ownerId, itemId, status: "pending",
        OR: [{ kind: "youtube" }, { kind: "local", createdAt: { gte: new Date(Date.now() - stagedLifetime) } }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return { proposals: rows.map(proposalDto) };
  });

  app.post(`${base}/preview`, async (request) => {
    const { ownerId, itemId } = await scope(request);
    if (request.isMultipart()) return { proposal: proposalDto(await stageFile(request, ownerId, itemId)) };
    const { url: input } = z.object({ url: urlInput }).parse(request.body);
    const url = canonicalVideo(input);
    const preview = await previewYoutube(db, ownerId, itemId, url);
    const row = await db.sourceProposal.create({
      data: { id: randomUUID(), ownerId, itemId, kind: "youtube", url, metadataJson: JSON.stringify(preview) },
    });
    return { proposal: proposalDto(row) };
  });

  app.post(`${base}/:proposalId/preview`, async (request) => {
    const { ownerId, itemId } = await scope(request);
    const proposalId = proposalIdOf(request);
    const row = await findProposal(db, ownerId, itemId, proposalId);
    pending(row);
    invariant(row.kind === "youtube" && row.url, 400, "replacement_video_required", "Укажите ссылку на ролик YouTube");
    if (row.metadataJson) return { proposal: proposalDto(row) };
    const preview = await previewYoutube(db, ownerId, itemId, row.url);
    const updated = await db.sourceProposal.updateMany({
      where: { id: row.id, ownerId, itemId, status: "pending" },
      data: { metadataJson: JSON.stringify(preview) },
    });
    invariant(updated.count, 409, "replacement_resolved", "Предложение уже обработано");
    return { proposal: proposalDto({ ...row, metadataJson: JSON.stringify(preview) }) };
  });

  app.post(`${base}/:proposalId/confirm`, async (request) => {
    const { ownerId, itemId } = await scope(request);
    const proposalId = proposalIdOf(request);
    const row = await findProposal(db, ownerId, itemId, proposalId);
    if (row.status === "confirmed") return { ok: true };
    pending(row);
    const preview = readPreview(row);
    invariant(preview, 409, "replacement_preview_required", "Сначала проверьте источник");
    if (row.kind === "youtube") {
      await db.$transaction(async (tx) => {
        const current = await findProposal(tx, ownerId, itemId, proposalId);
        if (current.status === "confirmed") return;
        pending(current);
        const { url } = current;
        invariant(url, 400, "replacement_video_required", "Укажите ссылку на ролик YouTube");
        const { externalId, key, source } = await youtubeCandidate(tx, ownerId, itemId, url);
        const state = { status: "available", reason: null, checkedAt: new Date(preview.checkedAt) };
        const { id: sourceId } = source
          ? await tx.source.update({ where: { id: source.id }, data: state })
          : await tx.source.create({
              data: { id: randomUUID(), ownerId, itemId, key, provider: "youtube", externalId, url,
                thumbnail: preview.thumbnail ?? `https://i.ytimg.com/vi/${externalId}/hqdefault.jpg`, ...state },
            });
        await tx.item.update({ where: { id: itemId, ownerId }, data: { preferredSourceId: sourceId } });
        await tx.sourceProposal.update({ where: { id: proposalId }, data: { status: "confirmed" } });
      });
    } else {
      const claimed = await db.sourceProposal.updateMany({
        where: { id: proposalId, ownerId, itemId, status: "pending" },
        data: { status: "applying" },
      });
      invariant(claimed.count, 409, "replacement_resolved", "Предложение уже обработано");
      active.add(proposalId);
      try {
        const path = row.stagedPath;
        invariant(path && path === join(stageDirectory(proposalId), basename(path)) &&
          Date.now() - row.createdAt.getTime() < stagedLifetime,
          422, "replacement_file_missing", "Загрузка истекла. Выберите файл заново.");
        const staged = storagePath(storageRoot, path);
        invariant((await lstat(staged).catch(() => null))?.isFile(),
          422, "replacement_file_missing", "Загруженный файл недоступен. Выберите его заново.");
        await library.importLocal(ownerId, staged, {
          itemId, creditId: "stage-" + proposalId,
          applyReplacement: async (tx: Prisma.TransactionClient, sourceId: string) => {
            await tx.sourceProposal.update({
              where: { id: proposalId, ownerId, itemId, status: "applying" },
              data: { status: "confirmed", stagedPath: null },
            });
            await tx.item.update({ where: { id: itemId, ownerId }, data: { preferredSourceId: sourceId } });
          },
        });
      } catch (error) {
        await db.sourceProposal.updateMany({
          where: { id: proposalId, ownerId, itemId, status: "applying" },
          data: { status: "failed", stagedPath: null },
        });
        throw error;
      } finally {
        await removeStage(proposalId);
        active.delete(proposalId);
      }
    }
    return { ok: true };
  });

  app.post(`${base}/:proposalId/decline`, async (request) => {
    const { ownerId, itemId } = await scope(request);
    const proposalId = proposalIdOf(request);
    const row = await findProposal(db, ownerId, itemId, proposalId);
    if (row.status !== "declined") {
      pending(row);
      const changed = await db.sourceProposal.updateMany({
        where: { id: proposalId, ownerId, itemId, status: "pending" },
        data: { status: "declined", stagedPath: null },
      });
      invariant(changed.count, 409, "replacement_resolved", "Предложение уже обработано");
    }
    if (row.kind === "local") await removeStage(proposalId);
    return { ok: true };
  });
}
