import { lockStorage, discardReservation } from "./storage-writer";
import { ownerAccess, checkItems, moveReservedFile, reserve, release, meterStorage, type Access } from "./kaname";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import { copyFile, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";
import { ZipFile } from "yazl";
import * as yauzl from "yauzl";
import { z } from "zod";
import {
  validateCatalog,
  tagInputSchema,
  playlistDefinitionSchema,
  settingsSchema,
  type Rule,
  type TagDto,
  type PlaylistDefinition,
  type Settings,
} from "@hibiki/contracts";
import { usesPrivateHistory } from "@hibiki/core";
import type { Db } from "./db.js";
import { tagDto } from "./taxonomy";
import { inspectFile, probeMediaStreams } from "./media.js";
import { readOnlyMediaFlags } from "./media-playback";
import { readAudioRange, type AudioView } from "./mp4-audio";
import { inspectVisualPath } from "./visual-media";
import { cleanupPreviousVisual } from "./visuals";

const id = z.string().min(1).max(200);
const title = z.string().max(2000);
const note = z.string().max(10_000).optional();
const queueContexts = z.record(id, id);
const counter = z.number().int().nonnegative().max(2_147_483_647);
const summarySchema = z
  .object({
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
  })
  .strict();
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
const manifestV1 = z
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
            performance: z.enum(["unknown", "ost", "vocal"]).optional(),
            voices: z
              .array(z.enum(["male", "female"]))
              .max(2)
              .optional(),
            note,
            preferredSourceId: id.optional(),
            listeningSummary: summarySchema.optional(),
          })
          .strict(),
      )
      .max(100000),
    tags: z
      .array(
        z
          .object({
            id,
            name: title,
            label: tagInputSchema.shape.name.optional(),
            color: z.string().max(100),
            note,
            group: z
              .enum(["source", "artist", "genre", "mood", "extra"])
              .optional(),
            aliases: tagInputSchema.shape.aliases,
            parentIds: tagInputSchema.shape.parentIds,
            archived: z.boolean().optional(),
            legacyFlat: z.boolean().optional(),
          })
          .strict(),
      )
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
const rolesSchema = z.object({
  sound: z.object({ sourceId: id, fileId: id.optional() }).strict(),
  visual: z.object({ trackId: id }).strict(),
}).strict();
const trackSchema = z.object({
  id, signature: z.string().regex(/^[a-f0-9]{64}$/), fileId: id,
  streamIndex: z.number().int().nonnegative().nullable(), duration: z.number().positive(),
}).strict();
const manifestV2 = manifestV1.extend({
  version: z.literal(2),
  items: z.array(manifestV1.shape.items.element.extend({ roles: rolesSchema.optional() })).max(100000),
  visualTracks: z.array(trackSchema).max(100000),
});
const manifestSchema = z.discriminatedUnion("version", [manifestV1, manifestV2]);
type PortableTrack = z.infer<typeof trackSchema>;
type PortableRoles = z.infer<typeof rolesSchema>;
export type PortableManifest = z.infer<typeof manifestSchema>;
export function archiveRequiresBrowser(manifest: PortableManifest): boolean {
  return (
    manifest.items.some(
      (item) =>
        item.note !== undefined ||
        item.listeningSummary !== undefined ||
        item.sources.some((source) => source.note !== undefined),
    ) ||
    manifest.tags.some((tag) => tag.note !== undefined) ||
    manifest.playlists.some(
      (playlist) =>
        playlist.note !== undefined || usesPrivateHistory(playlist.definition),
    )
  );
}
export interface ImportPreview {
  canApply: boolean;
  counts: { items: number; tags: number; playlists: number; files: number };
  missingFiles: string[];
  issues: string[];
  missingRoles?: { itemId: string; role: "sound" | "visual" }[];
  duplicates?: { items: number; tags: number; playlists: number };
}
export interface CheckedArchive {
  manifest: PortableManifest;
  preview: ImportPreview;
  files: Map<string, ExtractedFile>;
  archiveHash: string;
}
type ExtractedFile = {
  playback?: import("./media-playback").PlaybackMetadata;
  path: string;
  hash: string;
  bytes: number;
  hasAudio?: boolean;
};
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
  if (raw.queuePlaylistIds !== undefined)
    queueContexts.parse(raw.queuePlaylistIds);
  return settingsSchema.parse({
    ...{ volume: 0.8, repeat: "off", shuffle: false, queue: [], queueIndex: 0 },
    ...Object.fromEntries(
      [
        "volume",
        "lastNonzeroVolume",
        "repeat",
        "shuffle",
        "queue",
        "queueIndex",
        "position",
        "mode",
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

async function* visualBytes(path: string, view: AudioView, signal?: AbortSignal, expectedHash?: string) {
  const handle = await open(path, readOnlyMediaFlags);
  const digest = expectedHash ? createHash("sha256") : undefined;
  try {
    for await (const chunk of readAudioRange(handle, view, 0, view.bytes - 1)) {
      signal?.throwIfAborted();
      digest?.update(chunk);
      yield chunk;
    }
    if (digest && digest.digest("hex") !== expectedHash) throw new Error("Видеоряд изменился во время экспорта");
  } finally { await handle.close(); }
}

async function verifyVisual(path: string, track: PortableTrack, signal?: AbortSignal) {
  const checked = await inspectVisualPath(path, track.streamIndex ?? undefined, signal);
  if (checked.signature !== track.signature || Math.abs(checked.duration - track.duration) > 0.01)
    throw new Error("Подпись или длительность видеоряда не совпадает с манифестом");
  return checked;
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
    storage?: { id: string; access: Access | null };
    signal?: AbortSignal;
  },
): Promise<{ counts: ImportPreview["counts"]; missingFiles: string[] }> {
  options.signal?.throwIfAborted();
  const snapshot = await db.$transaction(async (tx) => ({
    items: await tx.item.findMany({
      where: { ownerId },
      include: { sources: true, tags: true, visual: { include: { visualTrack: true } } },
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
    snapshot.history.map(
      ({
        itemId,
        ownerId: _ownerId,
        lastStartedAt,
        lastCompletedAt,
        ...values
      }) => [
        itemId,
        {
          ...values,
          lastStartedAt: lastStartedAt?.toISOString() ?? null,
          lastCompletedAt: lastCompletedAt?.toISOString() ?? null,
        },
      ],
    ),
  );
  const usedFiles = new Set(
    snapshot.items.flatMap((i) =>
      i.sources.flatMap((s) => (s.fileId ? [s.fileId] : [])),
    ),
  );
  const originals = new Set(usedFiles);
  const tracks = new Map(snapshot.items.flatMap(item => {
    const pair = item.visual;
    if (!pair) return [];
    if (pair.visualTrack.ownerId !== ownerId || !item.sources.some(source => source.id === pair.soundSourceId && source.ownerId === ownerId))
      throw new Error("Дорожки принадлежат другой записи или владельцу");
    if (pair.soundFileId) usedFiles.add(pair.soundFileId);
    if (pair.visualTrack.streamIndex === null || originals.has(pair.visualTrack.fileId)) usedFiles.add(pair.visualTrack.fileId);
    return [[pair.visualTrack.id, pair.visualTrack] as const];
  }));
  const entries = new Map<string, string>();
  const videoEntries = new Map<string, { actual: string; view: AudioView }>();
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
  const portableTracks: PortableTrack[] = [];
  const byHash = new Map(files.map(file => [file.hash, file]));
  const ownedFiles = new Map(snapshot.files.map(file => [file.id, file]));
  for (const track of tracks.values()) {
    const signature = track.signature.split(":").at(-1)!;
    const file = ownedFiles.get(track.fileId);
    if (!file) throw new Error("Файл видеоряда недоступен владельцу");
    if (track.streamIndex === null || originals.has(file.id)) {
      portableTracks.push({ id: track.id, signature, fileId: file.id, streamIndex: track.streamIndex, duration: track.duration });
      continue;
    }
    // A virtual track whose donor is absent must never add that donor's original bytes to the archive.
    const fileId = "video-" + createHash("sha256").update(track.id).digest("hex");
    let hash = createHash("sha256").update("missing-video:" + signature).digest("hex");
    let bytes = 0, included = false;
    const actual = await storagePath(storageRoot, file.path).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (actual) {
      const verified = await verifyVisual(actual, { id: track.id, signature, fileId, duration: track.duration, streamIndex: track.streamIndex }, options.signal);
      const digest = createHash("sha256");
      for await (const chunk of visualBytes(actual, verified.view, options.signal)) digest.update(chunk);
      hash = digest.digest("hex");
      bytes = verified.view.bytes;
      included = options.includeFiles;
      if (included) videoEntries.set(fileId, { actual, view: verified.view });
    } else if (options.includeFiles) missingFiles.push(fileId);
    const existing = byHash.get(hash);
    if (!existing) {
      const selected = fileSchema.parse({ id: fileId, hash, bytes, included, path: "files/" + fileId + ".mp4",
        mime: "video/mp4", kind: "video", duration: track.duration });
      files.push(selected);
      byHash.set(hash, selected);
    }
    portableTracks.push({ id: track.id, signature, fileId: existing?.id ?? fileId, streamIndex: null, duration: track.duration });
  }
  const settings = safeSettings(
    snapshot.setting ? JSON.parse(snapshot.setting.json) : {},
  );
  if (settings.queuePlaylistIds) {
    const playlistIds = new Set(
      snapshot.playlists.map((playlist) => playlist.id),
    );
    const queueIds = new Set(settings.queue);
    settings.queuePlaylistIds = Object.fromEntries(
      Object.entries(queueContexts.parse(settings.queuePlaylistIds)).filter(
        ([itemId, playlistId]) =>
          queueIds.has(itemId) && playlistIds.has(playlistId),
      ),
    );
  }
  const manifest = validateManifest({
    format: "hibiki",
    ...(tracks.size ? { version: 2, visualTracks: portableTracks } : { version: 1 }),
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
      ...(item.performance !== "unknown"
        ? {
            performance: item.performance as "vocal" | "ost",
            voices: JSON.parse(item.voices),
          }
        : {}),
      ...(item.favorite ? { favorite: true } : {}),
      ...(options.includeNotes && item.note ? { note: item.note } : {}),
      ...(item.preferredSourceId &&
      item.sources.some((source) => source.id === item.preferredSourceId)
        ? { preferredSourceId: item.preferredSourceId }
        : {}),
      ...(history.has(item.id)
        ? { listeningSummary: history.get(item.id)! }
        : {}),
      ...(item.visual && { roles: {
        sound: { sourceId: item.visual.soundSourceId, ...(item.visual.soundFileId && { fileId: item.visual.soundFileId }) },
        visual: { trackId: item.visual.visualTrackId },
      } }),
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
      ...(t.label !== null ? { label: t.label } : {}),
      group: t.group as NonNullable<PortableManifest["tags"][number]["group"]>,
      aliases: JSON.parse(t.aliases),
      parentIds: JSON.parse(t.parentIds),
      archived: t.archived,
      legacyFlat: t.legacyFlat,
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
  });
  const json = Buffer.from(JSON.stringify(manifest));
  if (json.length > MAX_MANIFEST)
    throw new Error("Манифест библиотеки превышает лимит 16 MiB");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  try {
    const archive = new ZipFile();
    archive.addBuffer(json, "manifest.json");
    const output = archive.outputStream as Readable;
    archive.on("error", error => output.destroy(error));
    const openStreams = new Set<Readable>();
    output.once("close", () => { for (const stream of openStreams) stream.destroy(); });
    for (const file of files) {
      if (!file.included) continue;
      const entry = videoEntries.get(file.id);
      if (entry) {
        const stream = Readable.from(visualBytes(entry.actual, entry.view, options.signal, file.hash), { objectMode: false });
        stream.on("error", error => output.destroy(error));
        openStreams.add(stream);
        stream.once("close", () => openStreams.delete(stream));
        archive.addReadStream(stream, file.path, { compress: false, size: file.bytes });
      } else archive.addFile(entries.get(file.id)!, file.path, { compress: false });
    }
    const complete = pipeline(
      archive.outputStream,
      meterStorage(db, ownerId, options.storage?.access ?? null, options.storage?.id ?? "", [temporary, destination]),
      createWriteStream(temporary, { flags: "wx" }),
      { signal: options.signal },
    );
    archive.end();
    await complete;
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
  unique(
    manifest.tags.map((t) => t.name),
    "ключи тегов",
  );
  validateCatalog(
    manifest.tags.map((t) => ({
      ...t,
      name: t.label ?? t.name,
      legacyFlat: isLegacyFlat(t),
    })),
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
    if (
      (item.voices?.length && item.performance !== "vocal") ||
      new Set(item.voices).size !== (item.voices?.length ?? 0)
    )
      throw new Error("Некорректное исполнение композиции в архиве");
    if (
      item.preferredSourceId &&
      !item.sources.some((source) => source.id === item.preferredSourceId)
    )
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
  if (manifest.version === 2) {
    const trackIds = unique(manifest.visualTracks.map(track => track.id), "visual tracks");
    const media = new Map(manifest.files.map(file => [file.id, file]));
    const used = new Set<string>();
    const originals = new Set(manifest.items.flatMap(item => item.sources.flatMap(source => source.fileId ? [source.fileId] : [])));
    const usedFiles = new Set(originals);
    for (const track of manifest.visualTracks) {
      if (track.streamIndex !== null && !originals.has(track.fileId)) throw new Error("Виртуальный видеоряд ссылается на отсутствующую запись донора");
      usedFiles.add(track.fileId);
      if (media.get(track.fileId)?.kind !== "video") throw new Error("Видеоряд ссылается на неизвестный видеофайл");
    }
    for (const { roles, sources } of manifest.items) {
      if (!roles) continue;
      requireRef(trackIds, roles.visual.trackId);
      used.add(roles.visual.trackId);
      if (!sources.find(source => source.id === roles.sound.sourceId && source.provider === "local")?.fileId)
        throw new Error("Звуковой источник не принадлежит записи или не имеет файла");
      if (roles.sound.fileId) usedFiles.add(roles.sound.fileId);
      if (roles.sound.fileId && media.get(roles.sound.fileId)?.kind !== "audio")
        throw new Error("Звуковая дорожка ссылается на неизвестный аудиофайл");
    }
    if (used.size !== trackIds.size) throw new Error("В архиве есть видеоряд без записи");
    if (usedFiles.size !== media.size) throw new Error("В архиве есть файл без источника или роли");
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
    for (const [itemId, playlistId] of Object.entries(
      queueContexts.parse(settings.queuePlaylistIds),
    )) {
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
  onEntry?: (bytes: number) => Promise<void>,
): Promise<CheckedArchive> {
  signal?.throwIfAborted();
  await mkdir(workDir, { recursive: true });
  const files = new Map<string, ExtractedFile>();
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
          if (name !== "manifest.json") await onEntry?.(entry.uncompressedSize);
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
      const media = await inspectFile(actual.path, { signal, standalone: true });
      signal?.throwIfAborted();
      if (media.kind !== file.kind || media.mime !== file.mime)
        throw new Error(`Тип медиа не совпадает с манифестом: ${file.id}`);
      actual.hasAudio = media.hasAudio;
      actual.playback = media.playback;
      if (!media.browserCompatible)
        for (const item of manifest.items)
          for (const source of item.sources)
            if (source.fileId === file.id && source.status === "available") {
              source.status = "unavailable";
              source.reason = "unsupported_codec";
            }
    }
    const missingRoles: NonNullable<ImportPreview["missingRoles"]> = [];
    if (manifest.version === 2) {
      const resources = new Map(manifest.files.map(f => [f.id, files.get(f.path)]));
      const tracks = new Map(manifest.visualTracks.map(t => [t.id, t]));
      for (const track of tracks.values()) {
        const actual = resources.get(track.fileId);
        if (actual) {
          if (track.streamIndex === null && actual.hasAudio) throw new Error("Файл отдельного видеоряда содержит чужой звук");
          await verifyVisual(actual.path, track, signal);
        }
      }
      for (const { id, roles, sources } of manifest.items) {
        if (!roles) continue;
        const original = resources.get(sources.find(s => s.id === roles.sound.sourceId)!.fileId!);
        const sound = roles.sound.fileId ? resources.get(roles.sound.fileId) : original;
        if (!original || !sound) missingRoles.push({ itemId: id, role: "sound" });
        if (original?.hasAudio === false || sound?.hasAudio === false) throw new Error("В звуковом источнике нет аудио");
        if (!resources.get(tracks.get(roles.visual.trackId)!.fileId)) missingRoles.push({ itemId: id, role: "visual" });
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
        ...(missingRoles.length && { missingRoles }),
        issues: missingFiles.length
          ? [
              "Часть локальных файлов не включена; их источники будут отмечены недоступными",
              ...(missingRoles.length ? ["Недоступно звуковых дорожек: " + missingRoles.filter(r => r.role === "sound").length + ", видеорядов: " + missingRoles.filter(r => r.role === "visual").length] : []),
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
type ArchiveTag = PortableManifest["tags"][number];
// A v1 archive from before grouped catalogs has no label or group fields.
function isLegacyFlat(tag: ArchiveTag) {
  return (
    (tag.legacyFlat ?? (tag.label === undefined && tag.group === undefined)) &&
    (tag.group ?? "extra") === "extra" &&
    !tag.parentIds?.length
  );
}

type TagMapping = {
  tag: ArchiveTag;
  id: string;
  parentIds: string[];
  existing: boolean;
  markLegacy: boolean;
  mergedAliases?: string[];
};

/** Map parents before children. Compare display paths because unrelated tags may share a label. */
export function planArchiveTags(
  ownerId: string,
  manifest: Pick<PortableManifest, "origin" | "tags">,
  destination: TagDto[],
): TagMapping[] {
  const key = (
    name: string,
    group: string,
    archived: boolean,
    parents: string[],
  ) =>
    JSON.stringify([
      name.trim().normalize("NFC").toLowerCase(),
      group,
      archived,
      [...parents].sort(),
    ]);
  const sameOwner =
    manifest.origin === createHash("sha256").update(ownerId).digest("hex");
  const byId = new Map(destination.map((tag) => [tag.id, tag]));
  const aliasesById = new Map(
    destination.map((tag) => [tag.id, tag.aliases ?? []]),
  );
  const byPath = new Map<string, Map<string, string>>();
  const indexPath = (path: string, name: string, id: string) => {
    const variants = byPath.get(path) ?? new Map<string, string>();
    variants.set(name, id);
    byPath.set(path, variants);
  };
  for (const tag of destination)
    indexPath(
      key(tag.name, tag.group ?? "extra", !!tag.archived, tag.parentIds ?? []),
      tag.name,
      tag.id,
    );
  const remaining = new Map(
    manifest.tags.map((t) => [t.id, t.parentIds?.length ?? 0]),
  );
  const children = new Map<string, ArchiveTag[]>();
  for (const tag of manifest.tags) {
    for (const id of tag.parentIds ?? []) {
      const list = children.get(id) ?? [];
      list.push(tag);
      children.set(id, list);
    }
  }
  const queue = manifest.tags.filter((t) => !remaining.get(t.id));
  const mapped = new Map<string, string>();
  const plan: TagMapping[] = [];
  for (const tag of queue) {
    const parentIds = (tag.parentIds ?? []).map((id) => mapped.get(id)!);
    const stable = mappedId(ownerId, manifest.origin, "tag", tag.id);
    const identity = key(
      tag.label ?? tag.name,
      tag.group ?? "extra",
      !!tag.archived,
      parentIds,
    );
    // An archived label may have been reused for several unrelated exact playlist rules.
    const variants = byPath.get(identity);
    const name = tag.label ?? tag.name;
    let existing = tag.archived ? undefined : variants?.get(name);
    if (
      !existing &&
      !tag.archived &&
      !isLegacyFlat(tag) &&
      variants?.size === 1
    )
      existing = variants.values().next().value;
    if (byId.has(stable)) existing = stable;
    if (sameOwner && byId.has(tag.id)) existing = tag.id;
    const id = existing ?? stable;
    mapped.set(tag.id, id);
    indexPath(identity, name, id);
    const prior = existing === undefined ? undefined : byId.get(existing);
    const markLegacy =
      !!prior &&
      !prior.legacyFlat &&
      isLegacyFlat(tag) &&
      (prior.group ?? "extra") === "extra" &&
      prior.name === name;
    const currentAliases = aliasesById.get(id) ?? [];
    const aliases = [...new Set([...currentAliases, ...(tag.aliases ?? [])])];
    if (aliases.length > 100)
      throw new Error("После слияния у тега больше 100 псевдонимов");
    aliasesById.set(id, aliases);
    plan.push({
      tag,
      id,
      parentIds,
      existing: existing !== undefined,
      markLegacy,
      mergedAliases:
        aliases.length > currentAliases.length ? aliases : undefined,
    });

    for (const child of children.get(tag.id) ?? []) {
      const count = remaining.get(child.id)! - 1;
      remaining.set(child.id, count);
      if (!count) queue.push(child);
    }
  }
  if (plan.length !== manifest.tags.length)
    throw new Error("Некорректная иерархия тегов в архиве");
  const added = plan
    .filter((t) => !t.existing)
    .map(({ tag, id, parentIds }) => ({
      ...tag,
      id,
      parentIds,
      name: tag.label ?? tag.name,
      legacyFlat: isLegacyFlat(tag),
    }));
  const exactMatches = new Set(
    plan.filter((p) => p.markLegacy).map((p) => p.id),
  );
  validateCatalog([
    ...destination.map((tag) =>
      exactMatches.has(tag.id) ? { ...tag, legacyFlat: true } : tag,
    ),
    ...added,
  ]);
  return plan;
}
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
  inspectionHold?: string,
): Promise<{ added: number; reused: number; missingFiles: string[] }> {
  const access = await ownerAccess(db, ownerId);
  const manifest = validateManifest(checked.manifest);
  signal?.throwIfAborted();
  const manifestFiles = new Map(manifest.files.map((file) => [file.id, file]));
  const fileUses = new Map<string, number>();
  const sourceFiles = new Set<string>();
  for (const item of manifest.items)
    for (const source of item.sources)
      if (source.fileId) {
        sourceFiles.add(source.fileId);
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
  const reservation = randomUUID();
  const directory = path.join("imported", ownerId, reservation);
  const inspection = inspectionHold && await db.kanameStorage.findFirst({ where: { ownerId, id: inspectionHold, expiresAt: { not: null } } });
  const inspectionDirs: string[] = JSON.parse(inspection && inspection.workPaths || "[]");
  let movedBytes = 0;
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
        const relative = path.join(directory, randomUUID() + path.extname(file.path));
        const destination = path.join(storageRoot, relative);
        const source = checked.files.get(file.path)!.path;
        const move = !!inspection && movedBytes + file.bytes <= Number(inspection.bytes)
          && inspectionDirs.includes(path.relative(storageRoot, path.dirname(source)));
        await reserve(db, ownerId, move ? 0 : file.bytes, access, reservation, path.join(storageRoot, directory));
        cleanup.push(destination);
        await mkdir(path.dirname(destination), { recursive: true });
        if (move) {
          try {
            await moveReservedFile(db, ownerId, file.bytes, inspectionHold!, reservation, () => rename(source, destination));
            movedBytes += file.bytes;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
            await reserve(db, ownerId, file.bytes, access, reservation);
            await copyFile(source, destination, constants.COPYFILE_EXCL);
          }
        } else await copyFile(source, destination, constants.COPYFILE_EXCL);
        plan.relative = relative;
        plan.usable = true;
        plan.copied = destination;
      }
      prepared.set(file.hash, plan);
    }
    const rolesByItem = new Map<string, PortableRoles>();
    const verifiedTracks = new Map<string, { track: PortableTrack; identity: string; streamIndex: number | null }>();
    if (manifest.version === 2) {
      const actualResource = (fileId: string) => {
        const plan = prepared.get(manifestFiles.get(fileId)!.hash)!;
        return plan.usable ? storagePath(storageRoot, plan.relative) : null;
      };
      for (const track of manifest.visualTracks) {
        const actual = await actualResource(track.fileId);
        // A manifest with no bytes may preserve identity but cannot populate the trusted signature index.
        if (actual && track.streamIndex === null && (await probeMediaStreams(actual, signal, true)).audio)
          throw new Error("Файл отдельного видеоряда содержит чужой звук");
        const verified = actual ? await verifyVisual(actual, track, signal) : null;
        const pendingId = mappedId(ownerId, manifest.origin, "visual", track.id);
        verifiedTracks.set(track.id, { track, identity: verified ? track.signature : "pending:" + pendingId + ":" + track.signature,
          streamIndex: verified?.streamIndex ?? track.streamIndex });
      }
      const sounds = new Map<string, Awaited<ReturnType<typeof inspectFile>>>();
      for (const item of manifest.items) {
        const roles = item.roles;
        if (!roles) continue;
        rolesByItem.set(item.id, roles);
        const original = item.sources.find(s => s.id === roles.sound.sourceId)!.fileId!;
        for (const fileId of new Set([original, roles.sound.fileId ?? original])) {
          const actual = await actualResource(fileId);
          if (!actual) continue;
          let info = sounds.get(fileId);
          if (!info) {
            info = await inspectFile(actual, { signal, standalone: true });
            sounds.set(fileId, info);
          }
          if (!info.hasAudio || (fileId === roles.sound.fileId && info.kind !== "audio"))
            throw new Error("Файл звуковой роли не содержит подходящую аудиодорожку");
        }
      }
    }
    const usedPaths = new Set<string>();
    const result = await db.$transaction(
      async (tx) => {
        await lockStorage(tx);
        const maps = {
          items: new Map<string, string>(),
          tags: new Map<string, string>(),
          playlists: new Map<string, string>(),
        };
        const fileIds = new Map<string, string>();
        const availability = new Map<string, boolean>();
        const newRoleFiles: string[] = [];
        let added = 0,
          reused = 0;
        for (const file of manifest.files) {
          signal?.throwIfAborted();
          const plan = prepared.get(file.hash)!;
          const { hasAudio, playback } = checked.files.get(file.path) ?? {};
          let stored = await tx.mediaFile.findUnique({
            where: { ownerId_hash: { ownerId, hash: file.hash } },
          });
          if (!stored) {
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
                hasAudio,
                ...playback,
              },
            });
            if (manifest.version === 2 && !sourceFiles.has(file.id)) newRoleFiles.push(stored.id);
          } else if (plan.copied && stored.path === plan.previousPath)
            stored = await tx.mediaFile.update({
              where: { id: stored.id },
              data: {
                path: plan.relative,
                mime: file.mime,
                bytes: file.bytes,
                kind: file.kind,
                duration: file.duration,
                hasAudio,
                ...playback,
              },
            });
          else if (hasAudio !== undefined && (stored.hasAudio !== hasAudio || !stored.hintsVersion || !stored.audioViewVersion))
            stored = await tx.mediaFile.update({
              where: { id: stored.id },
              data: { hasAudio, ...playback },
            });
          const usable =
            stored.path === plan.relative
              ? plan.usable
              : stored.path !== plan.previousPath;
          fileIds.set(file.id, stored.id);
          availability.set(file.id, usable);
          usedPaths.add(path.join(storageRoot, stored.path));
        }
        const destinationTags = await tx.tag.findMany({ where: { ownerId } });
        const internalNames = new Set(destinationTags.map((t) => t.name));
        for (const {
          tag,
          id,
          parentIds,
          existing,
          markLegacy,
          mergedAliases,
        } of planArchiveTags(ownerId, manifest, destinationTags.map(tagDto))) {
          if (!existing) {
            let name = tag.name;
            if (internalNames.has(name)) {
              name = id;
              while (internalNames.has(name)) name = randomUUID();
            }
            await tx.tag.create({
              data: {
                id,
                ownerId,
                name,
                label: tag.label ?? (name !== tag.name ? tag.name : null),
                group: tag.group ?? "extra",
                archived: tag.archived ?? false,
                legacyFlat: isLegacyFlat(tag),
                aliases: JSON.stringify(tag.aliases ?? []),
                parentIds: JSON.stringify(parentIds),
                color: tag.color,
                note: tag.note,
              },
            });
            internalNames.add(name);
          } else {
            if (markLegacy || mergedAliases)
              await tx.tag.update({
                where: { id },
                data: {
                  ...(markLegacy && { legacyFlat: true }),
                  ...(mergedAliases && {
                    aliases: JSON.stringify(mergedAliases),
                  }),
                },
              });
            if (tag.note)
              await tx.tag.updateMany({
                where: { id, ownerId, note: null },
                data: { note: tag.note },
              });
          }
          maps.tags.set(tag.id, id);
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
            await checkItems(tx, ownerId, 1, access);
            await tx.item.create({
              data: {
                id: newId,
                ownerId,
                title: item.title,
                originalTitle: item.originalTitle,
                kind: item.kind,
                duration: item.duration,
                favorite: item.favorite,
                performance: item.performance,
                voices: JSON.stringify(item.voices ?? []),
                note: item.note,
                createdAt: new Date(item.createdAt),
              },
            });
            added++;
          } else {
            reused++;
            if (item.performance && item.performance !== "unknown")
              await tx.item.updateMany({
                where: { id: newId, ownerId, performance: "unknown" },
                data: {
                  performance: item.performance,
                  voices: JSON.stringify(item.voices ?? []),
                },
              });
            if (item.note)
              await tx.item.updateMany({
                where: {
                  id: newId,
                  ownerId,
                  OR: [{ note: null }, { note: "" }],
                },
                data: { note: item.note },
              });
          }
          if (item.listeningSummary) {
            const { lastStartedAt, lastCompletedAt, ...values } =
              item.listeningSummary;
            await tx.listeningSummary.upsert({
              where: { itemId: newId },
              create: {
                itemId: newId,
                ownerId,
                ...values,
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
          const sourceIds = new Map<string, string>();
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
              ...(source.note && !(previousImport ?? existing)?.note
                ? { note: source.note }
                : {}),
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
                where: {
                  id: (previousImport ?? existing)!.id,
                  ownerId,
                  itemId: newId,
                },
                data: { note: source.note },
              });
            sourceIds.set(source.id, (previousImport ?? existing)?.id ?? sourceId);
            if (source.id === item.preferredSourceId)
              await tx.item.updateMany({
                where: { id: newId, ownerId, preferredSourceId: null },
                data: {
                  preferredSourceId:
                    (previousImport ?? existing)?.id ?? sourceId,
                },
              });
          }
          const roles = rolesByItem.get(item.id);
          if (roles) {
            const { track, identity, streamIndex } = verifiedTracks.get(roles.visual.trackId)!;
            const current = await tx.item.findUniqueOrThrow({ where: { id: newId },
              select: { visualRevision: true, visual: { include: { visualTrack: true } } } });
            const old = current.visual;
            const pendingIdentity = "pending:" + mappedId(ownerId, manifest.origin, "visual", track.id) + ":" + track.signature;
            // A repeat import can hydrate its own missing role. It cannot undo a subsequent edit or clear.
            if ((!old && !current.visualRevision) || (old?.visualTrack.signature === pendingIdentity && identity === track.signature)) {
              const visual = await tx.visualTrack.upsert({
                where: { ownerId_signature: { ownerId, signature: identity } },
                create: { id: randomUUID(), ownerId, signature: identity, fileId: fileIds.get(track.fileId)!, duration: track.duration, streamIndex },
                update: {},
              });
              const data = { soundSourceId: sourceIds.get(roles.sound.sourceId)!, visualTrackId: visual.id,
                soundFileId: roles.sound.fileId ? fileIds.get(roles.sound.fileId)! : null };
              await tx.itemVisual.upsert({ where: { itemId: newId }, create: { itemId: newId, ...data }, update: data });
              await tx.item.update({ where: { id: newId }, data: { visualRevision: { increment: 1 } } });
              await cleanupPreviousVisual(tx, ownerId, old);
            }
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
            ? {
                queuePlaylistIds: Object.fromEntries(
                  Object.entries(
                    queueContexts.parse(manifest.settings.queuePlaylistIds),
                  ).map(([itemId, playlistId]) => [
                    maps.items.get(itemId)!,
                    maps.playlists.get(playlistId)!,
                  ]),
                ),
              }
            : {}),
        };
        await tx.setting.upsert({
          where: { userId: ownerId },
          create: { userId: ownerId, json: JSON.stringify(settings) },
          update: { json: JSON.stringify(settings) },
        });
        signal?.throwIfAborted();
        // A verified visual can already use a different local donor container.
        // Retire only new role files from this import which got no reference.
        for (let i = 0; i < newRoleFiles.length; i += 250) {
          const unused = await tx.mediaFile.findMany({ where: { ownerId, id: { in: newRoleFiles.slice(i, i + 250) },
            sources: { none: {} }, visualTracks: { none: {} }, visualSounds: { none: {} } }, select: { id: true, path: true } });
          for (const file of unused) {
            await tx.mediaFile.delete({ where: { id: file.id } });
            usedPaths.delete(path.join(storageRoot, file.path));
          }
        }
        // Parallel imports may publish the same hash. Delete losing copies while
        // their reservation is still held, before committing the winning files.
        for (const file of cleanup)
          if (!usedPaths.has(file)) await rm(file, { force: true });
        for (const plan of prepared.values()) {
          if (!plan.copied || !usedPaths.has(plan.copied) || !plan.previousPath || plan.previousPath.startsWith("missing/")) continue;
          if (!await tx.mediaFile.count({ where: { ownerId, path: plan.previousPath } }))
            await storagePath(storageRoot, plan.previousPath).then(file => rm(file, { force: true })).catch(error => { if (error.code !== "ENOENT") throw error; });
        }
        await release(tx, reservation);
        return { added, reused, missingFiles: checked.preview.missingFiles };
      },
      { timeout: 120000 },
    );
    return result;
  } catch (error) {
    await discardReservation(db, ownerId, reservation);
    throw error;
  }
}
