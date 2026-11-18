import { MAX_ARCHIVE_UPLOAD_BYTES } from "./upload-policy";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, realpath, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Job } from "@prisma/client";
import type { JobDto } from "@hibiki/contracts";
import type { Db } from "./db.js";
import { LibraryService, jobDto } from "./library.js";
import { HttpError, invariant } from "./errors.js";
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
  archiveRequiresBrowser,
  exportLibrary,
  fileChecksum,
  inspectArchive,
} from "./portability.js";

const MAX_ATTEMPTS = 3;
const LEASE_MS = 30_000;
const schemas = {
  "youtube-import": z.object({ url: z.string().max(2000) }).strict(),
  "youtube-download": z
    .object({ itemId: z.string().min(1), mode: z.enum(["audio", "video"]) })
    .strict(),
  "youtube-refresh": z
    .object({ itemId: z.string().min(1).optional() })
    .strict(),
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
  constructor(
    public db: Db,
    public library: LibraryService,
    public storageRoot: string,
  ) {}
  private async owned(ownerId: string, id: string, browser = false): Promise<Job> {
    const row = await this.db.job.findFirst({
      where: { id, ownerId, ...(browser ? {} : { browserOnly: false }) },
    });
    invariant(row, 404, "job_not_found", "Задание не найдено");
    return row;
  }
  async create(ownerId: string, kind: string, input: unknown, browser = false): Promise<JobDto> {
    invariant(Object.hasOwn(schemas, kind), 400, "job_kind", "Неизвестный тип задания");
    const parsed = schemas[kind as Kind].parse(input) as Record<string, any>;
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
        item.sources.some((s) => s.provider === "youtube"),
        400,
        "youtube_source",
        "У медиа нет источника YouTube",
      );
    }
    const id = randomUUID();
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
      await mkdir(directory, { recursive: true });
      const staged = path.join(directory, "input.zip");
      await copyFile(archive, staged);
      parsed.archivePath = staged;
      delete parsed.apply;
    }
    try {
      return jobDto(
        await this.db.job.create({
          data: { id, ownerId, kind, browserOnly, inputJson: JSON.stringify(parsed) },
        }),
      );
    } catch (error) {
      if (kind === "import")
        await rm(this.directory(id), { recursive: true, force: true });
      throw error;
    }
  }
  async list(ownerId: string, browser = false): Promise<JobDto[]> {
    return (
      await this.db.job.findMany({
        where: { ownerId, ...(browser ? {} : { browserOnly: false }) },
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
    await this.db.job.updateMany({
      where: { id, ownerId, state: { in: ["queued", "running"] } },
      data: {
        cancelRequested: true,
        ...(job.state === "queued"
          ? { state: "cancelled", leaseUntil: null }
          : {}),
      },
    });
    this.active.get(id)?.abort();
    return this.get(ownerId, id, browser);
  }
  async retry(ownerId: string, id: string, browser = false): Promise<JobDto> {
    const job = await this.owned(ownerId, id, browser);
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
    const preview = await this.owned(ownerId, previewJobId, browser);
    const input = asObject(preview.inputJson);
    const result = asObject(preview.resultJson);
    invariant(
      preview.kind === "import" &&
        preview.state === "done" &&
        !input.apply &&
        result.preview?.canApply &&
        result.archiveHash,
      409,
      "import_preview_required",
      "Нужен завершённый безопасный предпросмотр",
    );
    const id = randomUUID();
    return jobDto(
      await this.db.job.create({
        data: {
          id,
          ownerId,
          kind: "import",
          browserOnly: preview.browserOnly,
          inputJson: JSON.stringify({
            archivePath: input.archivePath,
            apply: true,
            previewJobId,
            archiveHash: result.archiveHash,
          }),
        },
      }),
    );
  }
  async exportPath(ownerId: string, id: string, browser = false): Promise<string> {
    const job = await this.owned(ownerId, id, browser);
    invariant(
      job.kind === "export" && job.state === "done",
      409,
      "export_not_ready",
      "Экспорт ещё не готов",
    );
    return path.join(this.directory(id), "library.hibiki.zip");
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
    let heartbeatBusy = false;
    let heartbeatPromise = Promise.resolve();
    const heartbeat = () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      heartbeatPromise = (async () => {
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
    try {
      await mkdir(this.directory(job.id), { recursive: true });
      const result = await this.execute(job, controller.signal, save);
      controller.signal.throwIfAborted();
      await this.db.job.updateMany({
        where: {
          id: job.id,
          state: "running",
          attempt: job.attempt,
          cancelRequested: false,
          leaseUntil: { gt: new Date() },
        },
        data: {
          state: "done",
          leaseUntil: null,
          progress: 1,
          resultJson: JSON.stringify(result),
          error: null,
        },
      });
    } catch (error) {
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
    const input = asObject(job.inputJson);
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
    if (job.kind === "youtube-download") {
      const item = await this.library.getItem(job.ownerId, input.itemId);
      const source = item.sources.find(
        (s) => s.provider === "youtube" && s.externalId,
      );
      invariant(source, 400, "youtube_source", "У медиа нет источника YouTube");
      const temporary = path.join(
        this.directory(job.id),
        `download-${job.attempt}`,
      );
      let progress = 0;
      let lastWrite = 0;
      let writing = false;
      let progressError: unknown;
      let progressWrite = Promise.resolve();
      try {
        const file = await downloadYoutube(
          source.externalId!,
          input.mode,
          temporary,
          signal,
          (value) => {
            progress = value;
            if (Date.now() - lastWrite >= 1000 && !writing) {
              lastWrite = Date.now();
              writing = true;
              progressWrite = save(
                { itemId: item.id, downloadProgress: value },
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
        await progressWrite;
        if (progressError) throw progressError;
        signal.throwIfAborted();
        await save({ itemId: item.id, downloadProgress: progress }, 0, 1, 0.9);
        const imported = await this.library.importLocal(job.ownerId, file, {
          itemId: item.id,
          signal,
        });
        await save({ itemId: imported.item.id, reused: imported.reused }, 1, 1);
        return { itemId: imported.item.id, reused: imported.reused };
      } finally {
        await progressWrite;
        await rm(temporary, { recursive: true, force: true });
      }
    }
    if (job.kind === "export") {
      const output = await exportLibrary(
        this.db,
        job.ownerId,
        this.storageRoot,
        path.join(this.directory(job.id), "library.hibiki.zip"),
        {
          includeFiles: input.includeFiles,
          includeNotes: job.browserOnly && input.includeNotes,
          includeHistorySummary: job.browserOnly && input.includeHistorySummary,
          signal,
        },
      );
      await save(output, 1, 1);
      return output;
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
      try {
        const checked = await inspectArchive(
          input.archivePath,
          workDir,
          signal,
        );
        invariant(job.browserOnly || !archiveRequiresBrowser(checked.manifest),
          403, "browser_only", "Архив с личными данными или правилами истории импортируется только из браузера");
        if (!input.apply) {
          const existing = await this.library.snapshot(job.ownerId);
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
          checked.preview.duplicates = {
            items: duplicateItems,
            tags: checked.manifest.tags.filter((tag) =>
              existing.tags.some((value) => value.name === tag.name),
            ).length,
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
        );
        await save(applied, 1, 1);
        return applied;
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
    throw new HttpError(400, "job_kind", "Неизвестный тип задания");
  }
}
