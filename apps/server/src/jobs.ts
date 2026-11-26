import { copyComposition, setVisual } from "./visuals";
import { existingVisualUpload, type VisualUpload } from "./visual-upload";
import { discardReservation } from "./storage-writer";
import { ownerAccess, requireHeavy, release, retain, reserve, kanameEnabled, startHeavyStorage, finishHeavyStorage } from "./kaname";
import { MAX_ARCHIVE_UPLOAD_BYTES } from "./upload-policy";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, rename, readdir, mkdir, realpath, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Job, Prisma } from "@prisma/client";
import type { JobDto } from "@hibiki/contracts";
import type { Db } from "./db.js";
import { LibraryService, jobDto } from "./library.js";
import { HttpError, invariant } from "./errors.js";
import { hintsVersion, inspectPlaybackMetadata } from "./media-playback";
import { audioViewVersion } from "./mp4-audio";
import { hashFile, storagePath } from "./media.js";
import { downloadReplacement, finishDownloadReplacement, selectedDownloadVideo, validateDownloadReplacement } from "./source-selection";
import { ShareService } from "./sharing.js";
import {
  discoverYoutube,
  downloadYoutube,
  normalizeYoutubeUrl,
  refreshYoutube,
  YoutubeProviderError,
  type YoutubeMetadata,
} from "./youtube.js";
import {
  applyArchive,
  planArchiveTags,
  archiveRequiresBrowser,
  exportLibrary,
  fileChecksum,
  inspectArchive,
} from "./portability.js";

import { ImportArchives, applications, lockPreview, MAX_ATTEMPTS } from "./import-archives";

const LEASE_MS = 30_000;
const schemas = {
  "youtube-import": z.object({ url: z.string().max(2000) }).strict(),
  "youtube-download": z
    .object({ itemId: z.string().min(1), mode: z.enum(["audio", "video"]) })
    .strict(),
  "youtube-refresh": z
    .object({ itemId: z.string().min(1).optional() })
    .strict(),
  "shared-copy": z.object({
    itemId: z.string().min(1).max(256),
    mode: z.enum(["audio", "video"]).optional(),
  }).strict(),
  export: z.object({
    includeFiles: z.boolean().default(false),
    includeNotes: z.boolean().optional(),
    includeHistorySummary: z.boolean().optional(),
  }).strict(),
  import: z
    .object({ archivePath: z.string().min(1), apply: z.boolean().optional() })
    .strict(),
};
type Kind = keyof typeof schemas;
interface Position {
  status: "done" | "error";
  itemId?: string;
  reused?: boolean;
  unavailable?: boolean;
  error?: string;
}
interface YoutubeResult {
  title?: string;
  entries: YoutubeMetadata[];
  positions: Position[];
  warnings: string[];
  added?: number;
  existing?: number;
  unavailable?: number;
  errors?: number;
}
const asObject = (value: string | null): Record<string, any> =>
  value ? JSON.parse(value) : {};

export class JobsService {
  private active = new Map<string, AbortController>();
  private stopping = false;
  private archives: ImportArchives;
  private nextArchiveRecovery = 0;
  private sharing: ShareService;
  constructor(
    public db: Db,
    public library: LibraryService,
    public storageRoot: string,
  ) {
    this.archives = new ImportArchives(db, storageRoot);
    this.sharing = new ShareService(db, library);
  }
  async backfillPlayback(signal?: AbortSignal) {
    let after: string | undefined;
    let updated = 0, skipped = 0;
    for (;;) {
      signal?.throwIfAborted();
      const files = await this.db.mediaFile.findMany({
        where: { id: after ? { gt: after } : undefined,
          OR: [{ hintsVersion: { lt: hintsVersion } }, { audioViewVersion: { lt: audioViewVersion } }] },
        select: { id: true, ownerId: true, path: true, bytes: true, hash: true, mime: true,
          hintsVersion: true, audioViewVersion: true },
        orderBy: { id: "asc" }, take: 64,
      });
      for (const file of files) {
        signal?.throwIfAborted();
        let data;
        try {
          await ownerAccess(this.db, file.ownerId);
          data = await inspectPlaybackMetadata(storagePath(this.storageRoot, file.path), file.mime, file.bytes);
        } catch {
          signal?.throwIfAborted();
          skipped++;
          continue;
        }
        signal?.throwIfAborted();
        const result = await this.db.mediaFile.updateMany({ where: file, data });
        updated += result.count;
      }
      if (files.length < 64) return { updated, skipped };
      after = files.at(-1)!.id;
    }
  }
  private async owned(ownerId: string, id: string, browser = false): Promise<Job> {
    const row = await this.db.job.findFirst({
      where: { id, ownerId, ...(browser ? {} : { browserOnly: false }) },
    });
    invariant(row, 404, "job_not_found", "Задание не найдено");
    return row;
  }
  async createVisualSource(ownerId: string, itemId: string, input: {
    expectedRevision: number; visualSourceId: string; soundSourceId?: string; videoStreamIndex?: number; operationId?: string;
  }) {
    await ownerAccess(this.db, ownerId);
    const { expectedRevision, visualSourceId, soundSourceId, videoStreamIndex, operationId } = input;
    const inputJson = JSON.stringify({ itemId, expectedRevision, visualSourceId, soundSourceId, videoStreamIndex, operationId });
    const id = createHash("sha256").update(JSON.stringify(["visual-set", ownerId, itemId, operationId ?? inputJson])).digest("hex");
    const job = await this.db.$transaction(async tx => {
      // Serialize the revision check and idempotent job creation with concurrent submissions.
      await tx.$executeRaw`UPDATE Job SET progress = progress WHERE 0`;
      const known = await tx.job.findFirst({ where: { id, ownerId } });
      if (known) {
        invariant(known.inputJson === inputJson, 409, "visual_operation_conflict", "Идентификатор уже использован для другой операции");
        return known;
      }
      const target = await tx.item.findFirst({ where: { id: itemId, ownerId }, select: { visualRevision: true } });
      invariant(target, 404, "item_not_found", "Запись не найдена");
      invariant(target.visualRevision === expectedRevision, 409, "visual_revision", "Видеоряд уже изменился. Обновите карточку.");
      const source = await tx.source.count({ where: { id: visualSourceId, ownerId, item: { ownerId },
        provider: "local", OR: [{ status: "available" }, { reason: "unsupported_codec" }], file: { ownerId, NOT: { path: { startsWith: "missing/" } } } } });
      invariant(source, 404, "visual_source_missing", "Источник видеоряда не найден");
      return tx.job.create({ data: { id, ownerId, kind: "visual-set", inputJson } });
    });
    return jobDto(job);
  }

  async createVisualUpload(ownerId: string, input: VisualUpload, file: string, hold: string) {
    const access = await ownerAccess(this.db, ownerId);
    const { jobId, ...params } = input;
    const hash = await hashFile(file);
    const inputKey = randomUUID();
    const staged = this.visualInput(ownerId, inputKey);
    await mkdir(path.dirname(staged), { recursive: true });
    await reserve(this.db, ownerId, 0, access, hold, staged);
    await rename(file, staged);
    let retained = false;
    try {
      const result = await this.db.$transaction(async tx => {
        await tx.$executeRaw`UPDATE Job SET progress = progress WHERE 0`;
        const known = await existingVisualUpload(tx, ownerId, input, hash);
        if (known) return { job: known, retained: false };
        const target = await tx.item.count({ where: { id: params.itemId, ownerId, visualRevision: params.expectedRevision } });
        invariant(target, 409, "visual_changed", "Запись изменилась во время загрузки");
        const inputHold = "visual-input-" + jobId;
        await tx.kanameStorage.update({ where: { id: hold, ownerId }, data: { id: inputHold } });
        await retain(tx, inputHold);
        const job = await tx.job.create({ data: { id: jobId, ownerId, kind: "visual-attach",
          inputJson: JSON.stringify({ ...params, inputKey, hash }) } });
        return { job: jobDto(job), retained: true };
      });
      retained = result.retained;
      return result.job;
    } finally {
      if (!retained) await rm(staged, { force: true });
    }
  }

  private visualInput(ownerId: string, key: string) {
    invariant(/^[a-f0-9-]{36}$/.test(key), 409, "visual_upload_required", "Загрузите видеоряд ещё раз");
    return storagePath(this.storageRoot, path.join("visual-inputs", ownerId, key));
  }

  private async discardVisualInput(jobId: string) {
    const job = await this.db.job.findUnique({ where: { id: jobId } });
    if (job?.kind !== "visual-attach" || !["done", "failed", "cancelled"].includes(job.state)) return;
    await rm(this.visualInput(job.ownerId, asObject(job.inputJson).inputKey), { force: true });
    await release(this.db, "visual-input-" + jobId);
  }

  private async recoverVisualInputs() {
    const completed = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT j.id FROM Job j JOIN KanameStorage hold ON hold.id = 'visual-input-' || j.id
      WHERE j.kind = 'visual-attach' AND j.state IN ('done','failed','cancelled')
    `;
    for (const job of completed) await this.discardVisualInput(job.id);
  }

  async create(ownerId: string, kind: string, input: unknown, browser = false, uploadHold?: string): Promise<JobDto> {
    const access = await ownerAccess(this.db, ownerId);
    if (kind === "youtube-download") requireHeavy(access);
    invariant(Object.hasOwn(schemas, kind), 400, "job_kind", "Неизвестный тип задания");
    const parsed = schemas[kind as Kind].parse(input) as Record<string, any>;
    if (kind === "shared-copy") {
      const source = await this.sharing.copySource(ownerId, parsed.itemId);
      if (source.provider === "youtube") requireHeavy(access);
    }
    const privateExport = kind === "export" && Boolean(parsed.includeNotes || parsed.includeHistorySummary);
    invariant(!privateExport || browser, 403, "browser_only", "Личные данные экспортируются только из браузера");
    const browserOnly = privateExport || (browser && kind === "import");
    if (kind === "youtube-import") parsed.url = normalizeYoutubeUrl(parsed.url);
    if (
      (kind === "youtube-download" || kind === "youtube-refresh") &&
      parsed.itemId
    ) {
      const item = await this.library.getItem(ownerId, parsed.itemId);
      invariant(
        item.sources.some((s) => s.provider === "youtube" && !s.shared),
        400,
        "youtube_source",
        "У медиа нет источника YouTube",
      );
    }
    const id = randomUUID();
    let archiveHold: string | undefined;
    try {
      if (kind === "import") {
        invariant(
          !parsed.apply,
          400,
          "import_preview_required",
          "Сначала создайте предпросмотр и примените его через applyImport",
        );
        const root = await realpath(this.storageRoot);
        const archive = await realpath(parsed.archivePath);
        const stat = await lstat(archive);
        invariant(
          archive.startsWith(root + path.sep) &&
            stat.isFile() &&
            !stat.isSymbolicLink(),
          400,
          "import_path",
          "Архив должен быть загружен в storage",
        );
        invariant(
          stat.size <= MAX_ARCHIVE_UPLOAD_BYTES,
          400,
          "import_size",
          "Архив больше допустимых 20 GiB",
        );
        const directory = this.directory(id);
        const staged = path.join(directory, "input.zip");
        archiveHold = await reserve(this.db, ownerId, uploadHold ? 0 : stat.size, access, uploadHold ?? randomUUID(), staged);
        await mkdir(directory, { recursive: true });
        if (uploadHold) await rename(archive, staged);
        else await copyFile(archive, staged);
        parsed.archivePath = staged;
        delete parsed.apply;
      }
      return jobDto(await this.db.$transaction(async tx => {
        if (archiveHold) {
          await tx.kanameStorage.update({ where: { id: archiveHold, ownerId }, data: { id: "job-" + id } });
          await retain(tx, "job-" + id);
        }
        return tx.job.create({ data: { id, ownerId, kind, browserOnly, inputJson: JSON.stringify(parsed) } });
      }));
    } catch (error) {
      if (kind === "import")
        await rm(this.directory(id), { recursive: true, force: true });
      if (!uploadHold) await release(this.db, archiveHold);
      throw error;
    }
  }
  async list(ownerId: string, browser = false, activeOnly = false): Promise<JobDto[]> {
    return (
      await this.db.job.findMany({
        where: { ownerId, ...(browser ? {} : { browserOnly: false }), ...(activeOnly && { state: { in: ["queued", "running"] } }) },
        orderBy: { createdAt: "desc" },
        take: 100,
      })
    ).map(jobDto);
  }
  async get(ownerId: string, id: string, browser = false): Promise<JobDto> {
    return jobDto(await this.owned(ownerId, id, browser));
  }
  async cancel(ownerId: string, id: string, browser = false): Promise<JobDto> {
    const job = await this.owned(ownerId, id, browser);
    if (!["queued", "running"].includes(job.state)) return jobDto(job);
    await this.db.$transaction([
      this.db.job.updateMany({ where: { id, ownerId, state: "queued" },
        data: { state: "cancelled", cancelRequested: true, leaseUntil: null } }),
      this.db.job.updateMany({ where: { id, ownerId, state: "running" }, data: { cancelRequested: true } }),
    ]);
    this.active.get(id)?.abort();
    if (job.kind === "visual-attach") await this.discardVisualInput(id);
    return this.get(ownerId, id, browser);
  }
  async retry(ownerId: string, id: string, browser = false): Promise<JobDto> {
    const job = await this.owned(ownerId, id, browser);
    const access = await ownerAccess(this.db, ownerId);
    if (job.kind === "youtube-download") requireHeavy(access);
    invariant(job.kind !== "visual-attach", 409, "visual_upload_required", "Для новой попытки загрузите видеоряд ещё раз");
    invariant(
      ["failed", "cancelled"].includes(job.state),
      409,
      "job_state",
      "Повторить можно только завершившееся с ошибкой или отменённое задание",
    );
    invariant(
      job.attempt < MAX_ATTEMPTS,
      409,
      "job_attempts",
      "Лимит повторов исчерпан; создайте новое задание",
    );
    await this.db.job.updateMany({
      where: { id, ownerId, state: job.state, attempt: job.attempt },
      data: {
        state: "queued",
        cancelRequested: false,
        leaseUntil: null,
        error: null,
      },
    });
    return this.get(ownerId, id, browser);
  }
  async applyImport(ownerId: string, previewJobId: string, browser = false): Promise<JobDto> {
    return jobDto(await this.db.$transaction(async tx => {
      await lockPreview(tx, ownerId, previewJobId);
      const preview = await tx.job.findFirst({ where: { ownerId, id: previewJobId, ...(browser ? {} : { browserOnly: false }) } });
      invariant(preview, 404, "job_not_found", "Задание не найдено");
      const input = asObject(preview.inputJson);
      const result = asObject(preview.resultJson);
      invariant(preview.kind === "import" && preview.state === "done" && !input.apply &&
        result.preview?.canApply && result.archiveHash, 409, "import_preview_required", "Нужен завершённый безопасный предпросмотр");
      const jobs = await applications(tx, ownerId, previewJobId);
      const existing = jobs.find(job => ["queued", "running"].includes(job.state))
        ?? (preview.archiveState && jobs.find(job => job.state === "done"));
      if (existing) return tx.job.findUniqueOrThrow({ where: { id: existing.id } });
      return tx.job.create({ data: {
        id: randomUUID(), ownerId, kind: "import", browserOnly: preview.browserOnly,
        inputJson: JSON.stringify({ archivePath: input.archivePath, apply: true, previewJobId, archiveHash: result.archiveHash }),
      } });
    }));
  }
  archiveCleanupPreview(ownerId: string) {
    return this.archives.estimate(ownerId);
  }
  cleanupArchives(ownerId: string) {
    return this.archives.cleanup(ownerId);
  }
  async exportPath(ownerId: string, id: string, browser = false): Promise<string> {
    const job = await this.owned(ownerId, id, browser);
    invariant(
      job.kind === "export" && job.state === "done",
      409,
      "export_not_ready",
      "Экспорт ещё не готов",
    );
    return path.join(this.directory(id), asObject(job.resultJson).exportAttempt ? `export-${job.attempt}` : "", "library.hibiki.zip");
  }
  private directory(id: string) {
    return path.join(this.storageRoot, "jobs", id);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.active.values()) controller.abort();
  }
  async runOnce(): Promise<boolean> {
    if (this.stopping) return false;
    const now = new Date();
    if (now.getTime() >= this.nextArchiveRecovery) {
      this.nextArchiveRecovery = now.getTime() + 60_000;
      await this.archives.cleanup();
      await this.recoverVisualInputs();
    }
    await this.db.job.updateMany({
      where: {
        cancelRequested: false,
        OR: [
          { state: "queued" },
          { state: "running", leaseUntil: { lte: now } },
        ],
        attempt: { gte: MAX_ATTEMPTS },
      },
      data: {
        state: "failed",
        leaseUntil: null,
        error: "Worker прерывался слишком много раз; лимит попыток исчерпан",
      },
    });
    await this.db.job.updateMany({
      where: {
        cancelRequested: true,
        OR: [
          { state: "queued" },
          { state: "running", leaseUntil: { lte: now } },
        ],
      },
      data: { state: "cancelled", leaseUntil: null },
    });
    const candidate = await this.db.job.findFirst({
      where: {
        cancelRequested: false,
        attempt: { lt: MAX_ATTEMPTS },
        OR: [
          { state: "queued" },
          { state: "running", leaseUntil: { lte: now } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) return false;
    const claimed = await this.db.job.updateMany({
      where: {
        id: candidate.id,
        state: candidate.state,
        attempt: candidate.attempt,
        cancelRequested: false,
        ...(candidate.state === "running" ? { leaseUntil: { lte: now } } : {}),
      },
      data: {
        state: "running",
        attempt: { increment: 1 },
        leaseUntil: new Date(Date.now() + LEASE_MS),
        error: null,
      },
    });
    if (!claimed.count) return false;
    const job = {
      ...candidate,
      state: "running",
      attempt: candidate.attempt + 1,
    };
    const controller = new AbortController();
    this.active.set(job.id, controller);
    if (this.stopping) controller.abort();
    let lastAccessCheck = Date.now();
    let heartbeatBusy = false;
    let heartbeatPromise = Promise.resolve();
    const heartbeat = () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      heartbeatPromise = (async () => {
        if (kanameEnabled() && Date.now() - lastAccessCheck >= 5000) {
          const access = await ownerAccess(this.db, job.ownerId);
          if (job.kind === "youtube-download") requireHeavy(access);
          lastAccessCheck = Date.now();
        }
        const row = await this.db.job.findUnique({
          where: { id: job.id },
          select: { state: true, attempt: true, cancelRequested: true },
        });
        if (
          !row ||
          row.state !== "running" ||
          row.attempt !== job.attempt ||
          row.cancelRequested
        ) {
          controller.abort();
          return;
        }
        const extended = await this.db.job.updateMany({
          where: {
            id: job.id,
            state: "running",
            attempt: job.attempt,
            cancelRequested: false,
            leaseUntil: { gt: new Date() },
          },
          data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
        });
        if (!extended.count) controller.abort();
      })()
        .catch(() => controller.abort())
        .finally(() => {
          heartbeatBusy = false;
        });
    };
    const timer = setInterval(heartbeat, 1000);
    const save = async (
      result: unknown,
      completed: number,
      total: number,
      progress = total ? completed / total : 0,
    ) => {
      controller.signal.throwIfAborted();
      const updated = await this.db.job.updateMany({
        where: {
          id: job.id,
          state: "running",
          attempt: job.attempt,
          cancelRequested: false,
          leaseUntil: { gt: new Date() },
        },
        data: {
          resultJson: JSON.stringify(result),
          completed,
          total,
          progress: Math.max(0, Math.min(1, progress)),
        },
      });
      if (!updated.count) {
        controller.abort();
        throw new Error("Lease задания утрачен");
      }
    };
    const discardUnpublishedExport = async () => {
      if (job.kind === "export") {
        const hold = `export-work-${job.id}-${job.attempt}`;
        if (await this.db.kanameStorage.findUnique({ where: { id: hold } })) {
          await rm(path.join(this.directory(job.id), `export-${job.attempt}`), { recursive: true, force: true });
          await release(this.db, hold);
        }
      }
    };
    try {
      if (job.kind !== "visual-set" && job.kind !== "visual-attach") await mkdir(this.directory(job.id), { recursive: true });
      const result = await this.execute(job, controller.signal, save);
      controller.signal.throwIfAborted();
      const previewId: string | undefined = job.kind === "import" ? asObject(job.inputJson).previewJobId : undefined;
      await this.db.$transaction(async tx => {
        const finished = await tx.job.updateMany({
          where: { id: job.id, state: "running", attempt: job.attempt, cancelRequested: false, leaseUntil: { gt: new Date() } },
          data: { state: "done", leaseUntil: null, progress: 1, resultJson: JSON.stringify(result), error: null },
        });
        if (finished.count && job.kind === "export") {
          const id = "export-" + job.id;
          await tx.kanameStorage.update({
            where: { id: `export-work-${job.id}-${job.attempt}`, ownerId: job.ownerId }, data: { id },
          });
          await retain(tx, id);
        }
        if (finished.count && previewId) await tx.job.updateMany({
          where: { id: previewId, ownerId: job.ownerId, archiveState: null },
          data: { archiveState: "pending" },
        });
      });
      await discardUnpublishedExport();
      if (previewId) await this.archives.remove({ ownerId: job.ownerId, id: previewId }, true);
    } catch (error) {
      await discardUnpublishedExport();
      const current = await this.db.job.findUnique({ where: { id: job.id } });
      if (current?.state === "running" && current.attempt === job.attempt) {
        const cancelled = current.cancelRequested;
        await this.db.job.updateMany({
          where: { id: job.id, state: "running", attempt: job.attempt },
          data: {
            state: cancelled
              ? "cancelled"
              : this.stopping
                ? "queued"
                : "failed",
            leaseUntil: null,
            ...(!cancelled && this.stopping
              ? { attempt: { decrement: 1 } }
              : {}),
            error: cancelled
              ? null
              : this.stopping
                ? null
                : (error instanceof Error
                    ? error.message
                    : String(error)
                  ).slice(0, 2000),
          },
        });
      }
    } finally {
      clearInterval(timer);
      await heartbeatPromise;
      this.active.delete(job.id);
      if (job.kind === "visual-attach") await this.discardVisualInput(job.id);
    }
    return true;
  }
  private async execute(
    job: Job,
    signal: AbortSignal,
    save: (
      result: unknown,
      completed: number,
      total: number,
      progress?: number,
    ) => Promise<void>,
  ): Promise<unknown> {
    const access = await ownerAccess(this.db, job.ownerId);
    if (job.kind === "youtube-download") requireHeavy(access);
    const input = asObject(job.inputJson);
    if (job.kind === "visual-attach" || job.kind === "visual-set") {
      const lease = () => ({ id: job.id, ownerId: job.ownerId, state: "running", attempt: job.attempt,
        cancelRequested: false, leaseUntil: { gt: new Date() } });
      return setVisual(this.db, this.storageRoot, job.ownerId, input.itemId, {
        ...(job.kind === "visual-attach" ? { uploadPath: this.visualInput(job.ownerId, input.inputKey) } : { visualSourceId: input.visualSourceId }),
        expectedRevision: input.expectedRevision,
        soundSourceId: input.soundSourceId, videoStreamIndex: input.videoStreamIndex, operationId: input.operationId ?? job.id,
      }, {
        signal,
        validateAccess: async tx => {
          signal.throwIfAborted();
          invariant(await tx.job.count({ where: lease() }), 409, "job_lease", "Задание уже завершено или отменено");
        },
        onPublished: async (tx, result) => {
          const updated = await tx.job.updateMany({ where: lease(),
            data: { state: "done", leaseUntil: null, progress: 1, completed: 1, total: 1, resultJson: JSON.stringify(result) } });
          invariant(updated.count, 409, "job_lease", "Задание уже завершено или отменено");
        },
      });
    }
    if (job.kind === "youtube-import" || job.kind === "youtube-refresh") {
      let result = asObject(job.resultJson) as YoutubeResult;
      if (!Array.isArray(result.entries)) {
        if (job.kind === "youtube-import") {
          const discovered = await discoverYoutube(input.url, signal);
          result = {
            title: discovered.title,
            entries: discovered.entries,
            positions: [],
            warnings: discovered.warnings,
          };
        } else {
          const sources = await this.db.source.findMany({
            where: {
              ownerId: job.ownerId,
              provider: "youtube",
              ...(input.itemId ? { itemId: input.itemId } : {}),
            },
          });
          result = {
            entries: sources
              .filter((s) => s.externalId)
              .map((s) => ({ externalId: s.externalId! })),
            positions: [],
            warnings: [],
          };
        }
        await save(result, 0, result.entries.length);
      }
      result.positions ??= [];
      result.warnings ??= [];
      for (let index = 0; index < result.entries.length; index++) {
        signal.throwIfAborted();
        if (result.positions[index]?.status === "done") continue;
        try {
          let entry = result.entries[index];
          // Flat playlists can return an ID with null title/availability for
          // removed videos. Check these positions without downloading media.
          if (
            job.kind === "youtube-import" &&
            !entry.title &&
            entry.available !== false
          ) {
            try {
              entry = {
                ...entry,
                ...(await refreshYoutube(
                  entry.externalId,
                  AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                )),
              };
            } catch (error) {
              signal.throwIfAborted();
              if (error instanceof YoutubeProviderError && error.unavailable)
                entry = { ...entry, available: false, reason: error.message };
              else
                result.warnings.push(
                  `Не удалось уточнить ${entry.externalId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1500),
                );
            }
            result.entries[index] = entry;
          }
          if (job.kind === "youtube-refresh") {
            try {
              entry = await refreshYoutube(entry.externalId, signal);
            } catch (error) {
              if (error instanceof YoutubeProviderError && error.unavailable)
                entry = {
                  externalId: entry.externalId,
                  available: false,
                  reason: error.message,
                };
              else throw error;
            }
          }
          signal.throwIfAborted();
          const imported = await this.library.upsertYoutube(job.ownerId, entry);
          result.positions[index] = {
            status: "done",
            itemId: imported.item.id,
            reused: imported.reused,
            unavailable: entry.available === false,
          };
        } catch (error) {
          signal.throwIfAborted();
          result.positions[index] = {
            status: "error",
            error: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 1000),
          };
        }
        result.added = result.positions.filter(
          (p) => p?.status === "done" && !p.reused,
        ).length;
        result.existing = result.positions.filter(
          (p) => p?.status === "done" && p.reused,
        ).length;
        result.errors = result.positions.filter(
          (p) => p?.status === "error",
        ).length;
        result.unavailable = result.positions.filter(
          (p) => p?.unavailable,
        ).length;
        await save(
          result,
          result.positions.filter(Boolean).length,
          result.entries.length,
        );
      }
      return result;
    }
    const shared = job.kind === "shared-copy"
      ? await this.sharing.copySource(job.ownerId, input.itemId)
      : undefined;
    const prepareValidateAccess = shared && (async () => {
      const proof = await this.sharing.authorizeCopy(job.ownerId, input.itemId);
      return async (tx: Prisma.TransactionClient) => {
        signal.throwIfAborted();
        const current = await this.sharing.copySource(job.ownerId, input.itemId, tx, proof);
        invariant(current.sourceId === shared.sourceId && current.provider === shared.provider &&
          (current.provider !== "local" || shared.provider !== "local" || current.composition?.revision === shared.composition?.revision),
          409, "source_changed", "Источник изменился. Запустите копирование снова");
        invariant(await tx.job.findFirst({ where: {
          id: job.id, state: "running", attempt: job.attempt, cancelRequested: false, leaseUntil: { gt: new Date() },
        }, select: { id: true } }), 409, "job_state", "Задание отменено или уже выполняется повторно");
      };
    });
    if (shared?.provider === "local" && shared.composition) {
      const result = await copyComposition(this.db,this.storageRoot,job.ownerId,input.itemId,shared.composition,job.id,signal,prepareValidateAccess!);
      await save(result,1,1);
      return result;
    }
    if (shared?.provider === "local") {
      const sourcePath = storagePath(this.storageRoot, shared.path);
      const info = await lstat(sourcePath).catch(() => undefined);
      invariant(info?.isFile(), 404, "file_not_found", "Исходный файл недоступен");
      const imported = await this.library.importLocal(job.ownerId, sourcePath, {
        itemId: input.itemId, signal, prepareValidateAccess,
      }).catch(error => {
        if (error instanceof Error && error.message.includes(sourcePath))
          throw new HttpError(422, "shared_file_unreadable", "Не удалось прочитать исходный файл");
        throw error;
      });
      await save({ itemId: imported.item.id, reused: imported.reused }, 1, 1);
      return { itemId: imported.item.id, reused: imported.reused };
    }
    if (job.kind === "youtube-download" || shared?.provider === "youtube") {
      requireHeavy(access);
      const itemId: string = input.itemId;
      const replacement = input.replaceSource && job.kind === "youtube-download"
        ? await downloadReplacement(this.db, job.ownerId, itemId, job.id) : undefined;
      if (replacement?.applied) return {itemId, sourceId:replacement.applied, reused:true};
      const item = !shared && !replacement ? await this.library.getItem(job.ownerId, itemId) : undefined;
      const external = item?.sources.filter(s => s.provider === "youtube" && !s.shared && s.externalId);
      const preferred = external?.find(source => source.id === item?.preferredSourceId)?.externalId;
      const downloadedFrom = !preferred && item?.preferredSourceId && external && external.length > 1
        ? await selectedDownloadVideo(this.db, job.ownerId, itemId, item.preferredSourceId) : undefined;
      const externalId = shared?.externalId ?? (replacement ? new URL(replacement.url).searchParams.get("v")
        : preferred || downloadedFrom || external?.[0]?.externalId);
      invariant(externalId, 400, "youtube_source", "У медиа нет источника YouTube");
      const temporary = path.join(
        this.directory(job.id),
        `download-${job.attempt}`,
      );
      const downloadHold = `download-${job.id}-${job.attempt}`;
      let progress = 0;
      let lastWrite = 0;
      let writing = false;
      let progressError: unknown;
      let progressWrite = Promise.resolve();
      try {
        await startHeavyStorage(this.db, job.ownerId, access, downloadHold, temporary);
        const file = await downloadYoutube(
          externalId,
          input.mode ?? "video",
          temporary,
          signal,
          (value) => {
            progress = value;
            if (Date.now() - lastWrite >= 1000 && !writing) {
              lastWrite = Date.now();
              writing = true;
              progressWrite = save(
                { itemId, downloadProgress: value },
                0,
                1,
                value * 0.9,
              )
                .catch((error) => {
                  progressError = error;
                })
                .finally(() => {
                  writing = false;
                });
            }
          },
        );
        await finishHeavyStorage(this.db, job.ownerId, downloadHold, temporary);
        await progressWrite;
        if (progressError) throw progressError;
        signal.throwIfAborted();
        await save({ itemId, downloadProgress: progress }, 0, 1, 0.9);
        requireHeavy(await ownerAccess(this.db, job.ownerId));
        const imported = await this.library.importLocal(job.ownerId, file, {
          itemId,
          signal,
          prepareValidateAccess,
          validateAccess: replacement ? tx => validateDownloadReplacement(tx, job.ownerId, itemId, job.id, job.attempt) : undefined,
          applyReplacement: replacement ? (tx, sourceId) =>
            finishDownloadReplacement(tx, job.ownerId, itemId, job.id, replacement.url, sourceId) : undefined,
        });
        const result = {itemId: imported.item.id, reused: imported.reused,
          ...(replacement && {sourceId: imported.item.preferredSourceId})};
        await save(result, 1, 1);
        return result;
      } finally {
        await progressWrite;
        await discardReservation(this.db, job.ownerId, downloadHold);
      }
    }
    if (job.kind === "export") {
      // Old workers wrote directly in the job directory. New attempts have
      // separate files and charges even if a paused worker outlives its lease.
      for (const name of await readdir(this.directory(job.id))) {
        if (name === "library.hibiki.zip" || (name.startsWith("library.hibiki.zip.") && name.endsWith(".part"))) {
          await rm(path.join(this.directory(job.id), name));
        }
      }
      await this.db.$executeRaw`DELETE FROM KanameStorage WHERE id = ${"export-" + job.id} AND ownerId = ${job.ownerId}
        AND EXISTS (SELECT 1 FROM Job WHERE id = ${job.id} AND state = 'running' AND attempt = ${job.attempt})`;
      const id = `export-work-${job.id}-${job.attempt}`;
      const directory = path.join(this.directory(job.id), `export-${job.attempt}`);
      const output = await exportLibrary(this.db, job.ownerId, this.storageRoot, path.join(directory, "library.hibiki.zip"), {
        includeFiles: input.includeFiles,
        storage: { id, access },
        includeNotes: job.browserOnly && input.includeNotes,
        includeHistorySummary: job.browserOnly && input.includeHistorySummary,
        signal,
      });
      const result = { ...output, exportAttempt: job.attempt };
      await save(result, 1, 1);
      return result;
    }
    if (job.kind === "import") {
      if (input.apply) {
        const preview = await this.owned(job.ownerId, input.previewJobId, job.browserOnly);
        invariant(
          preview.state === "done" &&
            preview.kind === "import" &&
            !asObject(preview.inputJson).apply,
          409,
          "import_preview_required",
          "Предпросмотр больше не доступен",
        );
        invariant(
          (await fileChecksum(input.archivePath, signal)) === input.archiveHash,
          409,
          "archive_changed",
          "Архив изменился после предпросмотра",
        );
      }
      const workDir = path.join(
        this.directory(job.id),
        `inspection-${job.attempt}`,
      );
      const inspectionHold = `inspection-${job.id}-${job.attempt}`;
      try {
        const checked = await inspectArchive(
          input.archivePath,
          workDir,
          signal,
          async bytes => { await reserve(this.db, job.ownerId, bytes, access, inspectionHold, workDir); },
        );
        invariant(job.browserOnly || !archiveRequiresBrowser(checked.manifest),
          403, "browser_only", "Архив с личными данными или правилами истории импортируется только из браузера");
        if (!input.apply) {
          const existing = await this.library.snapshot(job.ownerId, false, undefined, false);
          const identities = new Map<string, (typeof existing.items)[number]>();
          for (const item of existing.items)
            for (const source of item.sources) {
              if (source.provider === "youtube" && source.externalId)
                identities.set(`youtube:${source.externalId}`, item);
              if (source.hash) identities.set(`local:${source.hash}`, item);
            }
          const files = new Map(
            checked.manifest.files.map((file) => [file.id, file]),
          );
          let duplicateItems = 0;
          for (const item of checked.manifest.items) {
            const strong = item.sources.filter(
              (source) => source.provider === "youtube",
            );
            const matched = new Set(
              strong
                .map((source) => identities.get(`youtube:${source.externalId}`))
                .filter(Boolean),
            );
            if (matched.size > 1) {
              checked.preview.canApply = false;
              checked.preview.issues.push(
                `Источники «${item.title}» принадлежат разным items целевой библиотеки`,
              );
            }
            if (!matched.size && !strong.length)
              for (const source of item.sources)
                if (source.fileId) {
                  const match = identities.get(
                    `local:${files.get(source.fileId)!.hash}`,
                  );
                  if (match) matched.add(match);
                }
            if (matched.size) {
              duplicateItems++;
              if ([...matched].some((match) => match?.title !== item.title))
                checked.preview.issues.push(
                  `Существующее название «${[...matched][0]!.title}» сохранится при импорте «${item.title}»`,
                );
            }
          }
          let duplicateTags = 0;
          try {
            duplicateTags = planArchiveTags(job.ownerId, checked.manifest, existing.tags).filter(t => t.existing).length;
          } catch (error) {
            checked.preview.canApply = false;
            checked.preview.issues.push("Конфликт каталога тегов: " + (error as Error).message);
          }
          checked.preview.duplicates = {
            items: duplicateItems,
            tags: duplicateTags,
            playlists: checked.manifest.playlists.filter((playlist) =>
              existing.playlists.some(
                (value) => value.title === playlist.title,
              ),
            ).length,
          };
          const result = {
            preview: checked.preview,
            archiveHash: checked.archiveHash,
          };
          await save(result, 1, 1);
          return result;
        }
        const applied = await applyArchive(
          this.db,
          job.ownerId,
          this.storageRoot,
          checked,
          signal,
          inspectionHold,
        );
        await save(applied, 1, 1);
        return applied;
      } finally {
        await rm(workDir, { recursive: true, force: true });
        await release(this.db, inspectionHold);
      }
    }
    throw new HttpError(400, "job_kind", "Неизвестный тип задания");
  }
}
