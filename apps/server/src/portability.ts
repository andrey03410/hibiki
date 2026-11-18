import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { ZipFile } from "yazl";
import * as yauzl from "yauzl";
import { z } from "zod";
import {
  playlistDefinitionSchema,
  settingsSchema,
  type Rule,
  type PlaylistDefinition,
  type Settings,
} from "@hibiki/contracts";
import { usesPrivateHistory } from "@hibiki/core";
import type { Db } from "./db.js";
import { inspectFile } from "./media.js";

const id = z.string().min(1).max(200);
const title = z.string().max(2000);
const note = z.string().max(10_000).optional();
const queueContexts = z.record(id, id);
const counter = z.number().int().nonnegative().max(2_147_483_647);
const summarySchema = z.object({
  launches: counter,
  completed: counter,
  partial: counter,
  skipped: counter,
  errors: counter,
  listened: z.number().nonnegative(),
  seeks: counter,
  fromPlaylist: counter,
  direct: counter,
  manual: counter,
  advance: counter,
  repeat: counter,
  lastStartedAt: z.iso.datetime().nullable(),
  lastCompletedAt: z.iso.datetime().nullable(),
}).strict();
const sourceSchema = z
  .object({
    id,
    provider: z.enum(["youtube", "local"]),
    externalId: z
      .string()
      .regex(/^[\w-]{11}$/)
      .optional(),
    status: z.enum(["available", "unavailable", "unknown"]),
    reason: z.string().max(2000).optional(),
    thumbnail: z
      .url()
      .max(4000)
      .refine(
        (value) => value.startsWith("https://"),
        "Только HTTPS thumbnails",
      )
      .optional(),
    fileId: id.optional(),
    note,
  })
  .strict();
const fileSchema = z
  .object({
    id,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    path: z.string().regex(/^files\/[A-Za-z0-9._-]+$/),
    mime: z.enum([
      "audio/mpeg",
      "audio/wav",
      "audio/ogg",
      "audio/flac",
      "audio/mp4",
      "audio/aac",
      "audio/webm",
      "audio/x-matroska",
      "audio/quicktime",
      "audio/x-msvideo",
      "audio/aiff",
      "audio/x-ms-wma",
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska",
      "video/x-msvideo",
    ]),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 ** 3),
    kind: z.enum(["audio", "video"]),
    duration: z.number().nonnegative().nullable(),
    included: z.boolean(),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal("hibiki"),
    version: z.literal(1),
    origin: id,
    createdAt: z.string(),
    items: z
      .array(
        z
          .object({
            id,
            title,
            originalTitle: title,
            kind: z.enum(["audio", "video"]),
            duration: z.number().nonnegative().nullable(),
            createdAt: z.iso.datetime(),
            sources: z.array(sourceSchema).max(100),
            tagIds: z.array(id).max(10000),
            favorite: z.boolean().optional(),
            note,
            preferredSourceId: id.optional(),
            listeningSummary: summarySchema.optional(),
          })
          .strict(),
      )
      .max(100000),
    tags: z
      .array(z.object({ id, name: title, color: z.string().max(100), note }).strict())
      .max(10000),
    playlists: z
      .array(
        z
          .object({
            id,
            title,
            description: z.string().max(10000),
            definition: playlistDefinitionSchema,
            note,
          })
          .strict(),
      )
      .max(10000),
    files: z.array(fileSchema).max(100000),
    settings: settingsSchema,
  })
  .strict();
export type PortableManifest = z.infer<typeof manifestSchema>;
export function archiveRequiresBrowser(manifest: PortableManifest): boolean {
  return manifest.items.some((item) =>
    item.note !== undefined || item.listeningSummary !== undefined ||
    item.sources.some((source) => source.note !== undefined),
  ) || manifest.tags.some((tag) => tag.note !== undefined) ||
    manifest.playlists.some((playlist) => playlist.note !== undefined || usesPrivateHistory(playlist.definition));
}
export interface ImportPreview {
  canApply: boolean;
  counts: { items: number; tags: number; playlists: number; files: number };
  missingFiles: string[];
  issues: string[];
  duplicates?: { items: number; tags: number; playlists: number };
}
export interface CheckedArchive {
  manifest: PortableManifest;
  preview: ImportPreview;
  files: Map<string, { path: string; hash: string; bytes: number }>;
  archiveHash: string;
}
const MAX_TOTAL = 20 * 1024 ** 3;
const MAX_MANIFEST = 16 * 1024 ** 2;
const MAX_ENTRIES = 100_001;
const safeSettings = (value: unknown): Settings => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  if (raw.originalQueue !== undefined)
    z.array(id).max(100000).parse(raw.originalQueue);
  if (raw.queuePlaylistIds !== undefined) queueContexts.parse(raw.queuePlaylistIds);
  return settingsSchema.parse({
    ...{ volume: 0.8, repeat: "off", shuffle: false, queue: [], queueIndex: 0 },
    ...Object.fromEntries(
      [
        "volume",
        "repeat",
        "shuffle",
        "queue",
        "queueIndex",
        "position",
        "originalQueue",
        "queuePlaylistIds",
      ]
        .filter((k) => raw[k] !== undefined)
        .map((k) => [k, raw[k]]),
    ),
  });
};
export async function fileChecksum(
  file: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(file),
    new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk);
        done();
      },
    }),
    { signal },
  );
  return hash.digest("hex");
}
export async function storagePath(
  storageRoot: string,
  relative: string,
): Promise<string> {
  if (
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((p) => p === ".." || p === "." || p === "")
  )
    throw new Error("Небезопасный путь файла");
  const root = await realpath(storageRoot);
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(root + path.sep))
    throw new Error("Файл вне storage");
  const actual = await realpath(candidate);
  if (
    !actual.startsWith(root + path.sep) ||
    (await lstat(candidate)).isSymbolicLink() ||
    !(await lstat(actual)).isFile()
  )
    throw new Error("Небезопасный файл storage");
  return actual;
}

export async function exportLibrary(
  db: Db,
  ownerId: string,
  storageRoot: string,
  destination: string,
  options: {
    includeFiles: boolean;
    includeNotes?: boolean;
    includeHistorySummary?: boolean;
    signal?: AbortSignal;
  },
): Promise<{ counts: ImportPreview["counts"]; missingFiles: string[] }> {
  options.signal?.throwIfAborted();
  const snapshot = await db.$transaction(async (tx) => ({
    items: await tx.item.findMany({
      where: { ownerId },
      include: { sources: true, tags: true },
    }),
    tags: await tx.tag.findMany({ where: { ownerId } }),
    playlists: await tx.playlist.findMany({ where: { ownerId } }),
    files: await tx.mediaFile.findMany({ where: { ownerId } }),
    setting: await tx.setting.findUnique({ where: { userId: ownerId } }),
    history: options.includeHistorySummary
      ? await tx.listeningSummary.findMany({ where: { ownerId } })
      : [],
  }));
  const history = new Map(
    snapshot.history.map(({ itemId, ownerId: _ownerId, lastStartedAt, lastCompletedAt, ...values }) => [
      itemId,
      { ...values, lastStartedAt: lastStartedAt?.toISOString() ?? null, lastCompletedAt: lastCompletedAt?.toISOString() ?? null },
    ]),
  );
  const usedFiles = new Set(
    snapshot.items.flatMap((i) =>
      i.sources.flatMap((s) => (s.fileId ? [s.fileId] : [])),
    ),
  );
  const entries = new Map<string, string>();
  const missingFiles: string[] = [];
  const files: PortableManifest["files"] = [];
  for (const file of snapshot.files.filter((f) => usedFiles.has(f.id))) {
    options.signal?.throwIfAborted();
    let included = false;
    if (options.includeFiles)
      try {
        const actual = await storagePath(storageRoot, file.path);
        if ((await fileChecksum(actual, options.signal)) !== file.hash)
          throw new Error("Файл изменён");
        entries.set(file.id, actual);
        included = true;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        missingFiles.push(file.id);
      }
    files.push({
      id: file.id,
      hash: file.hash,
      path: `files/${file.id.replace(/[^\w-]/g, "_")}${path.extname(file.path).replace(/[^.\w]/g, "")}`,
      bytes: Number(file.bytes),
      mime: fileSchema.shape.mime.parse(file.mime),
      kind: file.kind as "audio" | "video",
      duration: file.duration,
      included,
    });
  }
  const settings = safeSettings(snapshot.setting ? JSON.parse(snapshot.setting.json) : {});
  if (settings.queuePlaylistIds) {
    const playlistIds = new Set(snapshot.playlists.map((playlist) => playlist.id));
    const queueIds = new Set(settings.queue);
    settings.queuePlaylistIds = Object.fromEntries(
      Object.entries(queueContexts.parse(settings.queuePlaylistIds)).filter(([itemId, playlistId]) =>
        queueIds.has(itemId) && playlistIds.has(playlistId)),
    );
  }
  const manifest: PortableManifest = {
    format: "hibiki",
    version: 1,
    origin: createHash("sha256").update(ownerId).digest("hex"),
    createdAt: new Date().toISOString(),
    items: snapshot.items.map((item) => ({
      id: item.id,
      title: item.title,
      originalTitle: item.originalTitle,
      kind: item.kind as "audio" | "video",
      duration: item.duration,
      createdAt: item.createdAt.toISOString(),
      tagIds: item.tags.map((t) => t.tagId),
      ...(item.favorite ? { favorite: true } : {}),
      ...(options.includeNotes && item.note ? { note: item.note } : {}),
      ...(item.preferredSourceId && item.sources.some((source) => source.id === item.preferredSourceId)
        ? { preferredSourceId: item.preferredSourceId }
        : {}),
      ...(history.has(item.id) ? { listeningSummary: history.get(item.id)! } : {}),
      sources: item.sources.map((s) => ({
        id: s.id,
        provider: s.provider as "youtube" | "local",
        ...(s.externalId ? { externalId: s.externalId } : {}),
        status: s.status as "available" | "unavailable" | "unknown",
        ...(s.reason ? { reason: s.reason } : {}),
        ...(s.thumbnail ? { thumbnail: s.thumbnail } : {}),
        ...(s.fileId ? { fileId: s.fileId } : {}),
        ...(options.includeNotes && s.note ? { note: s.note } : {}),
      })),
    })),
    tags: snapshot.tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      ...(options.includeNotes && t.note ? { note: t.note } : {}),
    })),
    playlists: snapshot.playlists.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      definition: playlistDefinitionSchema.parse(JSON.parse(p.definitionJson)),
      ...(options.includeNotes && p.note ? { note: p.note } : {}),
    })),
    files,
    settings,
  };
  validateManifest(manifest);
  const json = Buffer.from(JSON.stringify(manifest));
  if (json.length > MAX_MANIFEST)
    throw new Error("Манифест библиотеки превышает лимит 16 MiB");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  try {
    const archive = new ZipFile();
    archive.addBuffer(json, "manifest.json");
    for (const file of files)
      if (file.included)
        archive.addFile(entries.get(file.id)!, file.path, { compress: false });
    const complete = pipeline(
      archive.outputStream,
      createWriteStream(temporary, { flags: "wx" }),
      { signal: options.signal },
    );
    archive.end();
    await complete;
    const { rename } = await import("node:fs/promises");
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return {
    counts: {
      items: manifest.items.length,
      tags: manifest.tags.length,
      playlists: manifest.playlists.length,
      files: files.filter((f) => f.included).length,
    },
    missingFiles,
  };
}

function validateManifest(input: unknown): PortableManifest {
  const manifest = manifestSchema.parse(input);
  const unique = (values: string[], kind: string) => {
    if (new Set(values).size !== values.length)
      throw new Error(`Повторяющиеся ID: ${kind}`);
    return new Set(values);
  };
  const items = unique(
    manifest.items.map((i) => i.id),
    "items",
  );
  const tags = unique(
    manifest.tags.map((i) => i.id),
    "tags",
  );
  const playlists = unique(
    manifest.playlists.map((i) => i.id),
    "playlists",
  );
  const files = unique(
    manifest.files.map((i) => i.id),
    "files",
  );
  unique(
    manifest.files.map((i) => i.path),
    "file paths",
  );
  unique(
    manifest.items.flatMap((i) => i.sources.map((s) => s.id)),
    "sources",
  );
  unique(
    manifest.items.flatMap((i) =>
      i.sources
        .filter((s) => s.provider === "youtube")
        .map((s) => s.externalId!),
    ),
    "YouTube identities",
  );
  const requireRef = (set: Set<string>, value: string) => {
    if (!set.has(value)) throw new Error(`Неизвестная ссылка: ${value}`);
  };
  for (const item of manifest.items) {
    if (item.preferredSourceId && !item.sources.some((source) => source.id === item.preferredSourceId))
      throw new Error("Предпочтительный источник не принадлежит записи");
    for (const tag of item.tagIds) requireRef(tags, tag);
    for (const source of item.sources) {
      if (source.provider === "youtube" && !source.externalId)
        throw new Error("Источник YouTube без ID");
      if (source.fileId) requireRef(files, source.fileId);
      if (source.provider === "local" && !source.fileId)
        throw new Error("Локальный источник без файла");
    }
  }
  const dependencies = new Map<string, string[]>();
  const visitRule = (rule: Rule, refs: string[]) => {
    switch (rule.type) {
      case "items":
        rule.ids.forEach((v) => requireRef(items, v));
        break;
      case "tag":
        requireRef(tags, rule.id);
        break;
      case "playlist":
        requireRef(playlists, rule.id);
        refs.push(rule.id);
        break;
      case "union":
      case "intersection":
        rule.rules.forEach((r) => visitRule(r, refs));
        break;
      case "difference":
        visitRule(rule.include, refs);
        visitRule(rule.exclude, refs);
    }
  };
  for (const playlist of manifest.playlists) {
    const refs: string[] = [];
    visitRule(playlist.definition.rule, refs);
    for (const item of playlist.definition.manualOrder ?? [])
      requireRef(items, item);
    dependencies.set(playlist.id, refs);
  }
  const done = new Set<string>();
  const active = new Set<string>();
  let steps = 0;
  const visit = (key: string, depth = 0) => {
    if (depth > 40 || ++steps > 100000)
      throw new Error("Граф плейлистов превышает лимит");
    if (active.has(key)) throw new Error("Цикл плейлистов");
    if (done.has(key)) return;
    active.add(key);
    for (const dep of dependencies.get(key) ?? []) visit(dep, depth + 1);
    active.delete(key);
    done.add(key);
  };
  for (const playlist of playlists) visit(playlist);
  const settings = safeSettings(manifest.settings);
  for (const value of [
    ...settings.queue,
    ...(Array.isArray(settings.originalQueue)
      ? (settings.originalQueue as string[])
      : []),
  ])
    requireRef(items, value);
  if (settings.queuePlaylistIds) {
    const queueIds = new Set(settings.queue);
    for (const [itemId, playlistId] of Object.entries(queueContexts.parse(settings.queuePlaylistIds))) {
      requireRef(queueIds, itemId);
      requireRef(playlists, playlistId);
    }
  }
  manifest.settings = settings;
  return manifest;
}

export async function inspectArchive(
  archivePath: string,
  workDir: string,
  signal?: AbortSignal,
): Promise<CheckedArchive> {
  signal?.throwIfAborted();
  await mkdir(workDir, { recursive: true });
  const files = new Map<
    string,
    { path: string; hash: string; bytes: number }
  >();
  const names = new Set<string>();
  let manifestBuffer: Buffer | undefined;
  let total = 0;
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true },
      (error, result) => (error ? reject(error) : resolve(result!)),
    ),
  );
  const abort = () => zip.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          zip.close();
          reject(error);
        }
      };
      zip.on("error", fail);
      zip.on("end", () => {
        settled = true;
        resolve();
      });
      zip.on("close", () => {
        if (!settled)
          fail(
            new Error(
              signal?.aborted
                ? "Задание отменено"
                : "Архив преждевременно закрыт",
            ),
          );
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          signal?.throwIfAborted();
          const name = entry.fileName;
          if (
            (name !== "manifest.json" &&
              !/^files\/[A-Za-z0-9._-]+$/.test(name)) ||
            names.has(name) ||
            names.size >= MAX_ENTRIES ||
            ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
          )
            throw new Error("Небезопасный путь, тип или повтор файла в архиве");
          names.add(name);
          total += entry.uncompressedSize;
          if (
            total > MAX_TOTAL ||
            entry.uncompressedSize > 4 * 1024 ** 3 ||
            (entry.uncompressedSize > 64 * 1024 ** 2 &&
              entry.uncompressedSize / Math.max(entry.compressedSize, 1) > 1000)
          )
            throw new Error(
              "Архив превышает допустимый размер или коэффициент сжатия",
            );
          if (name === "manifest.json" && entry.uncompressedSize > MAX_MANIFEST)
            throw new Error("Манифест слишком большой");
          const stream = await new Promise<Readable>((res, rej) =>
            zip.openReadStream(entry, (error, result) =>
              error ? rej(error) : res(result!),
            ),
          );
          let bytes = 0;
          const hash = createHash("sha256");
          const buffers: Buffer[] = [];
          const destination = path.join(
            workDir,
            randomUUID() + path.extname(name),
          );
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              bytes += chunk.length;
              if (bytes > entry.uncompressedSize || bytes > 4 * 1024 ** 3)
                return done(new Error("Размер файла архива не совпадает"));
              hash.update(chunk);
              if (name === "manifest.json") buffers.push(chunk);
              done(null, name === "manifest.json" ? undefined : chunk);
            },
          });
          if (name === "manifest.json") {
            await pipeline(stream, meter, { signal });
            manifestBuffer = Buffer.concat(buffers);
          } else {
            await pipeline(
              stream,
              meter,
              createWriteStream(destination, { flags: "wx" }),
              { signal },
            );
            files.set(name, {
              path: destination,
              hash: hash.digest("hex"),
              bytes,
            });
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
    signal?.throwIfAborted();
    if (!manifestBuffer) throw new Error("В архиве нет manifest.json");
    const manifest = validateManifest(
      JSON.parse(manifestBuffer.toString("utf8")),
    );
    const known = new Set(
      manifest.files.filter((f) => f.included).map((f) => f.path),
    );
    for (const name of files.keys())
      if (!known.has(name)) throw new Error("В архиве есть файл вне манифеста");
    const missingFiles: string[] = [];
    for (const file of manifest.files) {
      const actual = files.get(file.path);
      if (!file.included) {
        missingFiles.push(file.id);
        continue;
      }
      if (!actual)
        throw new Error(`В архиве отсутствует заявленный файл: ${file.id}`);
      if (actual.hash !== file.hash || actual.bytes !== file.bytes)
        throw new Error(`Не совпадает хэш или размер файла: ${file.id}`);
      const media = await inspectFile(actual.path, { signal });
      signal?.throwIfAborted();
      if (media.kind !== file.kind || media.mime !== file.mime)
        throw new Error(`Тип медиа не совпадает с манифестом: ${file.id}`);
      if (!media.browserCompatible)
        for (const item of manifest.items)
          for (const source of item.sources)
            if (source.fileId === file.id && source.status === "available") {
              source.status = "unavailable";
              source.reason = "unsupported_codec";
            }
    }
    return {
      manifest,
      files,
      archiveHash: await fileChecksum(archivePath, signal),
      preview: {
        canApply: true,
        counts: {
          items: manifest.items.length,
          tags: manifest.tags.length,
          playlists: manifest.playlists.length,
          files: files.size,
        },
        missingFiles,
        issues: missingFiles.length
          ? [
              "Часть локальных файлов не включена; их источники будут отмечены недоступными",
            ]
          : [],
      },
    };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  } finally {
    zip.close();
    signal?.removeEventListener("abort", abort);
  }
}

const mappedId = (
  ownerId: string,
  origin: string,
  kind: string,
  oldId: string,
) =>
  `imp_${createHash("sha256")
    .update(JSON.stringify([ownerId, origin, kind, oldId]))
    .digest("hex")
    .slice(0, 32)}`;
function rewriteRule(
  rule: Rule,
  maps: {
    items: Map<string, string>;
    tags: Map<string, string>;
    playlists: Map<string, string>;
  },
): Rule {
  switch (rule.type) {
    case "items":
      return { ...rule, ids: rule.ids.map((i) => maps.items.get(i)!) };
    case "tag":
      return { ...rule, id: maps.tags.get(rule.id)! };
    case "playlist":
      return { ...rule, id: maps.playlists.get(rule.id)! };
    case "union":
    case "intersection":
      return { ...rule, rules: rule.rules.map((r) => rewriteRule(r, maps)) };
    case "difference":
      return {
        ...rule,
        include: rewriteRule(rule.include, maps),
        exclude: rewriteRule(rule.exclude, maps),
      };
    default:
      return rule;
  }
}
export async function applyArchive(
  db: Db,
  ownerId: string,
  storageRoot: string,
  checked: CheckedArchive,
  signal?: AbortSignal,
): Promise<{ added: number; reused: number; missingFiles: string[] }> {
  const manifest = validateManifest(checked.manifest);
  signal?.throwIfAborted();
  const manifestFiles = new Map(manifest.files.map((file) => [file.id, file]));
  const fileUses = new Map<string, number>();
  for (const item of manifest.items)
    for (const source of item.sources)
      if (source.fileId) {
        const hash = manifestFiles.get(source.fileId)!.hash;
        fileUses.set(hash, (fileUses.get(hash) ?? 0) + 1);
      }
  // Verify extracted data again: preview and apply may occur in different worker lifetimes.
  for (const file of manifest.files.filter((f) => f.included)) {
    const actual = checked.files.get(file.path);
    if (!actual || (await fileChecksum(actual.path, signal)) !== file.hash)
      throw new Error("Файл изменился после предпросмотра");
  }
  const cleanup: string[] = [];
  const prepared = new Map<
    string,
    {
      relative: string;
      id: string;
      usable: boolean;
      previousPath?: string;
      copied?: string;
    }
  >();
  try {
    // Copy and checksum large bytes before opening the SQLite write transaction.
    for (const file of manifest.files) {
      if (prepared.has(file.hash)) continue;
      signal?.throwIfAborted();
      const existing = await db.mediaFile.findUnique({
        where: { ownerId_hash: { ownerId, hash: file.hash } },
      });
      let usable = false;
      if (existing)
        try {
          const actual = await storagePath(storageRoot, existing.path);
          usable = (await fileChecksum(actual, signal)) === file.hash;
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      const plan = {
        relative: existing?.path ?? `missing/${ownerId}/${randomUUID()}`,
        id: existing?.id ?? mappedId(ownerId, manifest.origin, "file", file.id),
        usable,
        previousPath: existing?.path,
        copied: undefined as string | undefined,
      };
      if (!usable && file.included) {
        const relative = `imported/${ownerId}/${randomUUID()}${path.extname(file.path)}`;
        const destination = path.join(storageRoot, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(
          checked.files.get(file.path)!.path,
          destination,
          constants.COPYFILE_EXCL,
        );
        cleanup.push(destination);
        plan.relative = relative;
        plan.usable = true;
        plan.copied = destination;
      }
      prepared.set(file.hash, plan);
    }
    const usedPaths = new Set<string>();
    const result = await db.$transaction(
      async (tx) => {
        const maps = {
          items: new Map<string, string>(),
          tags: new Map<string, string>(),
          playlists: new Map<string, string>(),
        };
        const fileIds = new Map<string, string>();
        const availability = new Map<string, boolean>();
        let added = 0,
          reused = 0;
        for (const file of manifest.files) {
          signal?.throwIfAborted();
          const plan = prepared.get(file.hash)!;
          let stored = await tx.mediaFile.findUnique({
            where: { ownerId_hash: { ownerId, hash: file.hash } },
          });
          if (!stored)
            stored = await tx.mediaFile.create({
              data: {
                id: plan.id,
                ownerId,
                hash: file.hash,
                path: plan.relative,
                mime: file.mime,
                bytes: file.bytes,
                kind: file.kind,
                duration: file.duration,
              },
            });
          else if (plan.copied && stored.path === plan.previousPath)
            stored = await tx.mediaFile.update({
              where: { id: stored.id },
              data: {
                path: plan.relative,
                mime: file.mime,
                bytes: file.bytes,
                kind: file.kind,
                duration: file.duration,
              },
            });
          const usable =
            stored.path === plan.relative
              ? plan.usable
              : stored.path !== plan.previousPath;
          fileIds.set(file.id, stored.id);
          availability.set(file.id, usable);
          usedPaths.add(path.join(storageRoot, stored.path));
        }
        for (const tag of manifest.tags) {
          const existing = await tx.tag.findUnique({
            where: { ownerId_name: { ownerId, name: tag.name } },
          });
          const newId =
            existing?.id ?? mappedId(ownerId, manifest.origin, "tag", tag.id);
          maps.tags.set(tag.id, newId);
          if (!existing)
            await tx.tag.create({
              data: { id: newId, ownerId, name: tag.name, color: tag.color, note: tag.note },
            });
          else if (tag.note && !existing.note)
            await tx.tag.update({ where: { id: newId }, data: { note: tag.note } });
        }
        for (const playlist of manifest.playlists)
          maps.playlists.set(
            playlist.id,
            mappedId(ownerId, manifest.origin, "playlist", playlist.id),
          );
        for (const item of manifest.items) {
          signal?.throwIfAborted();
          const deterministic = mappedId(
            ownerId,
            manifest.origin,
            "item",
            item.id,
          );
          const candidates = new Set<string>();
          const direct = await tx.item.findFirst({
            where: { id: deterministic, ownerId },
          });
          if (direct) candidates.add(direct.id);
          for (const source of item.sources) {
            const hash = source.fileId
              ? manifestFiles.get(source.fileId)!.hash
              : undefined;
            const key =
              source.provider === "youtube"
                ? `youtube:${source.externalId}`
                : hash &&
                    fileUses.get(hash) === 1 &&
                    !item.sources.some((s) => s.provider === "youtube")
                  ? `local:${hash}`
                  : undefined;
            if (key) {
              const existing = await tx.source.findUnique({
                where: { ownerId_key: { ownerId, key } },
              });
              if (existing) candidates.add(existing.itemId);
            }
          }
          if (candidates.size > 1)
            throw new Error(
              "Источники импортируемого item совпали с разными items; объединение требует решения владельца",
            );
          const existingId = [...candidates][0];
          const newId = existingId ?? deterministic;
          maps.items.set(item.id, newId);
          if (!existingId) {
            await tx.item.create({
              data: {
                id: newId,
                ownerId,
                title: item.title,
                originalTitle: item.originalTitle,
                kind: item.kind,
                duration: item.duration,
                favorite: item.favorite,
                note: item.note,
                createdAt: new Date(item.createdAt),
              },
            });
            added++;
          } else {
            reused++;
            if (item.note)
              await tx.item.updateMany({
                where: { id: newId, ownerId, OR: [{ note: null }, { note: "" }] },
                data: { note: item.note },
              });
          }
          if (item.listeningSummary) {
            const { lastStartedAt, lastCompletedAt, ...values } = item.listeningSummary;
            await tx.listeningSummary.upsert({
              where: { itemId: newId },
              create: {
                itemId: newId, ownerId, ...values,
                lastStartedAt: lastStartedAt && new Date(lastStartedAt),
                lastCompletedAt: lastCompletedAt && new Date(lastCompletedAt),
              },
              update: {},
            });
          }
          for (const tagId of item.tagIds)
            await tx.itemTag.upsert({
              where: {
                itemId_tagId: { itemId: newId, tagId: maps.tags.get(tagId)! },
              },
              create: { itemId: newId, tagId: maps.tags.get(tagId)! },
              update: {},
            });
          for (const source of item.sources) {
            const fileId = source.fileId
              ? fileIds.get(source.fileId)
              : undefined;
            const hash = source.fileId
              ? manifestFiles.get(source.fileId)!.hash
              : undefined;
            const sourceId = mappedId(
              ownerId,
              manifest.origin,
              "source",
              source.id,
            );
            let key =
              source.provider === "youtube"
                ? `youtube:${source.externalId}`
                : `local:${hash}`;
            let existing = await tx.source.findUnique({
              where: { ownerId_key: { ownerId, key } },
            });
            if (
              source.provider === "local" &&
              existing &&
              existing.itemId !== newId
            ) {
              key = `local:${hash}:${newId}`;
              existing = await tx.source.findUnique({
                where: { ownerId_key: { ownerId, key } },
              });
            }
            const previousImport = await tx.source.findFirst({
              where: { id: sourceId, ownerId, itemId: newId },
            });
            const sourceData = {
              key,
              provider: source.provider,
              externalId: source.externalId,
              url:
                source.provider === "youtube"
                  ? `https://www.youtube.com/watch?v=${source.externalId}`
                  : undefined,
              status:
                source.provider === "local" && !availability.get(source.fileId!)
                  ? "unavailable"
                  : source.status,
              reason:
                source.provider === "local" && !availability.get(source.fileId!)
                  ? "Локальный файл не включён в архив"
                  : (source.reason ?? null),
              fileId,
              thumbnail: source.thumbnail,
              ...(source.note && !(previousImport ?? existing)?.note ? { note: source.note } : {}),
            };
            if (
              previousImport &&
              source.fileId &&
              availability.get(source.fileId) &&
              (previousImport.reason === "Локальный файл не включён в архив" ||
                !previousImport.fileId)
            )
              await tx.source.update({
                where: { id: sourceId },
                data: sourceData,
              });
            else if (!existing && !previousImport)
              await tx.source.create({
                data: { id: sourceId, ownerId, itemId: newId, ...sourceData },
              });
            else if (source.note && !(previousImport ?? existing)?.note)
              await tx.source.updateMany({
                where: { id: (previousImport ?? existing)!.id, ownerId, itemId: newId },
                data: { note: source.note },
              });
            if (source.id === item.preferredSourceId)
              await tx.item.updateMany({
                where: { id: newId, ownerId, preferredSourceId: null },
                data: { preferredSourceId: (previousImport ?? existing)?.id ?? sourceId },
              });
          }
        }
        for (const playlist of manifest.playlists) {
          const newId = maps.playlists.get(playlist.id)!;
          const definition: PlaylistDefinition = {
            ...playlist.definition,
            rule: rewriteRule(playlist.definition.rule, maps),
            ...(playlist.definition.manualOrder
              ? {
                  manualOrder: playlist.definition.manualOrder.map(
                    (i) => maps.items.get(i)!,
                  ),
                }
              : {}),
          };
          await tx.playlist.upsert({
            where: { id: newId },
            create: {
              id: newId,
              ownerId,
              title: playlist.title,
              description: playlist.description,
              definitionJson: JSON.stringify(definition),
              note: playlist.note,
            },
            update: {},
          });
          if (playlist.note)
            await tx.playlist.updateMany({
              where: { id: newId, ownerId, OR: [{ note: null }, { note: "" }] },
              data: { note: playlist.note },
            });
        }
        const settings = {
          ...manifest.settings,
          queue: manifest.settings.queue.map((i) => maps.items.get(i)!),
          ...(Array.isArray(manifest.settings.originalQueue)
            ? {
                originalQueue: (
                  manifest.settings.originalQueue as string[]
                ).map((i) => maps.items.get(i)!),
              }
            : {}),
          ...(manifest.settings.queuePlaylistIds
            ? { queuePlaylistIds: Object.fromEntries(
                Object.entries(queueContexts.parse(manifest.settings.queuePlaylistIds)).map(([itemId, playlistId]) => [
                  maps.items.get(itemId)!, maps.playlists.get(playlistId)!,
                ]),
              ) }
            : {}),
        };
        await tx.setting.upsert({
          where: { userId: ownerId },
          create: { userId: ownerId, json: JSON.stringify(settings) },
          update: { json: JSON.stringify(settings) },
        });
        signal?.throwIfAborted();
        return { added, reused, missingFiles: checked.preview.missingFiles };
      },
      { timeout: 120000 },
    );
    await Promise.all(
      cleanup
        .filter((file) => !usedPaths.has(file))
        .map((file) => rm(file, { force: true }).catch(() => {})),
    );
    return result;
  } catch (error) {
    await Promise.all(cleanup.map((file) => rm(file, { force: true })));
    throw error;
  }
}
