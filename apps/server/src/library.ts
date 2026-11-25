import { canRunHeavy, ownerAccess, checkItems, requireHeavy, reserve, release } from "./kaname";
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { playbackFields } from "./media-playback";
import type { Db } from "./db";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { HttpError, invariant } from "./errors";
import { ArtworkService, artworkVersion, removeUnusedArtwork } from "./artwork";
import {
  stageMediaCopy,
  hashFile,
  storagePath,
  inspectAudioTrack,
  inspectFile,
  preparePlayback,
  type MediaInspection,
} from "./media";
import type {
  ItemDto,
  JobDto,
  LibraryDto,
  PlaylistDefinition,
  PlaylistDto,
  PlaylistPlaybackDto,
  TagInput,
  ItemPatch,
  Performance,
  Voice,
} from "@hibiki/contracts";
import { missingClassification, playbackModeSchema, playlistDefinitionSchema } from "@hibiki/contracts";
import { collectReferences, InvalidPlaylistError, resolvePlaylist, usesPrivateHistory } from "@hibiki/core";

import { listTags, tagDto, saveTag } from "./taxonomy";
import { decorateSharedItems } from "./sharing";

export const itemInclude = {
  sources: { include: { file: true } },
  tags: { include: { tag: true } },
} as const;

export function requireHistoryAccess(definition: PlaylistDefinition, browser: boolean) {
  invariant(
    browser || !usesPrivateHistory(definition),
    403, "browser_only", "Создавайте правила по личной истории в браузере",
  );
}
function ownedItemInclude(ownerId: string) {
  return {
    sources: { ...itemInclude.sources, where: { ownerId, OR: [{ fileId: null }, { file: { ownerId } }] } },
    tags: { ...itemInclude.tags, where: { tag: { ownerId } } },
  };
}
type IncludedItem = NonNullable<
  Awaited<ReturnType<Db["item"]["findFirst"]>>
> & { sources: Array<any>; tags: Array<any> };
export function itemDto(row: IncludedItem): ItemDto {
  const coverVersion = artworkVersion(row.sources);
  return {
    id: row.id,
    title: row.title,
    originalTitle: row.originalTitle,
    kind: row.kind as "audio" | "video",
    duration: row.duration,
    favorite: row.favorite,
    preferredSourceId: row.preferredSourceId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tags: row.tags.map(({ tag }) => tagDto(tag)),
    performance: row.performance as Performance,
    voices: JSON.parse(row.voices),
    sources: row.sources.map((source) => ({
      id: source.id,
      provider: source.provider,
      externalId: source.externalId ?? undefined,
      url: source.url ?? undefined,
      status: source.status,
      reason: source.reason ?? undefined,
      thumbnail:
        source.provider === "local" && source.file?.kind === "audio"
          ? `/api/items/${encodeURIComponent(row.id)}/artwork?v=${coverVersion}`
          : (source.thumbnail ?? undefined),
      fileId: source.fileId ?? undefined,
      mime: source.file?.mime,
      bytes: source.file ? Number(source.file.bytes) : undefined,
      hash: source.file?.hash,
      hasAudio:
        source.provider === "local" ? (source.file?.hasAudio ?? undefined) : undefined,
      ...(source.file && playbackFields(source.file, `/files/${source.fileId}`)),
      streamUrl: source.fileId ? `/files/${source.fileId}` : undefined,
    })),
  };
}
// A large playlist repeats the same tag directory on many tracks. Read and
// decode each owned tag once instead of materializing one joined row per use.
async function batchItems(tx: Prisma.TransactionClient, ownerId: string, ids: string[]) {
  const [rows, groups] = await Promise.all([
    tx.item.findMany({where:{ownerId,id:{in:ids}}, include:{sources:ownedItemInclude(ownerId).sources}}),
    tx.$queryRaw<{itemId:string; assigned:string}[]>`
      SELECT itemId, json_group_array(tagId ORDER BY tagId) AS assigned FROM ItemTag
      WHERE itemId IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
      GROUP BY itemId`,
  ]);
  const assignments = new Map(groups.map(row => [row.itemId, JSON.parse(row.assigned) as string[]]));
  const tagIds = new Set<string>();
  for (const row of rows) for (const id of assignments.get(row.id) ?? []) tagIds.add(id);
  const tags = tagIds.size ? await tx.tag.findMany({where:{ownerId,id:{in:[...tagIds]}}}) : [];
  const directory = new Map(tags.map(tag => [tag.id, tagDto(tag)]));
  return rows.map(row => {
    const item = itemDto({...row, tags:[]});
    item.tags = (assignments.get(row.id) ?? []).flatMap(id => directory.get(id) ?? []);
    return item;
  });
}

export async function hydrateLibraryItems(tx: Prisma.TransactionClient, ownerId: string, ids: string[], includeShared: false): Promise<ItemDto[]>;
export async function hydrateLibraryItems(tx: Prisma.TransactionClient, ownerId: string, ids: string[], includeShared: true, library: LibraryService): Promise<ItemDto[]>;
export async function hydrateLibraryItems(tx: Prisma.TransactionClient, ownerId: string, ids: string[], includeShared: boolean, library?: LibraryService) {
  if (!ids.length) return [];
  const owned = ids.length >= 24 ? await batchItems(tx, ownerId, ids) : (await tx.item.findMany({
    where: { ownerId, id: { in: ids } },
    include: ownedItemInclude(ownerId),
  })).map(itemDto);
  const byId = new Map(owned.map(item => [item.id, item]));
  const items = ids.flatMap(id => byId.get(id) ?? []);
  return includeShared && library ? decorateSharedItems(tx, ownerId, items, library) : items;
}

function* playlistCoverCandidates(items: ItemDto[]) {
  for (const item of items) {
    for (const { provider, thumbnail, externalId } of item.sources) {
      if (provider === "youtube" && thumbnail && externalId && /^[\w-]{11}$/.test(externalId))
        yield { url: `https://i.ytimg.com/vi/${externalId}/sddefault.jpg` };
      else if (provider === "local" && thumbnail && thumbnail.split("?")[0] === `/api/items/${encodeURIComponent(item.id)}/artwork`)
        yield { url: `${thumbnail}${thumbnail.includes("?") ? "&" : "?"}size=cover`, itemId: item.id };
    }
  }
}

async function playlistHistory(db: Prisma.TransactionClient, ownerId: string, itemIds?: string[]) {
  const rows = await db.listeningSummary.findMany({
    where: { ownerId, ...(itemIds && { itemId: { in: itemIds } }) },
    select: { itemId: true, launches: true, completed: true, skipped: true, lastStartedAt: true },
  });
  return new Map(rows.map(entry => [entry.itemId, entry]));
}

export function playlistDto(row: {
  id: string;
  title: string;
  description: string;
  definitionJson: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  youtubeLink?: { playlistId: string } | null;
}): PlaylistDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    definition: playlistDefinitionSchema.parse(JSON.parse(row.definitionJson)),
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.youtubeLink ? { youtubeLinked: true } : {}),
  };
}
export function jobDto(row: {
  id: string;
  kind: string;
  state: string;
  progress: number;
  completed: number;
  total: number;
  attempt: number;
  error: string | null;
  resultJson: string | null;
  createdAt: Date;
  updatedAt: Date;
}): JobDto {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state as JobDto["state"],
    progress: row.progress,
    completed: row.completed,
    total: row.total,
    attempt: row.attempt,
    error: row.error ?? undefined,
    result: row.resultJson ? JSON.parse(row.resultJson) : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export class LibraryService {
  private readonly artwork: ArtworkService;
  private readonly liveQueues = new Map<string, {
    version: number; changeToken: string; calculatedAt: number; validUntil: number; ids: string[];
  }>();

  constructor(
    public db: Db,
    public storageRoot: string,
  ) {
    this.artwork = new ArtworkService(db, storageRoot);
  }

  private async playlistCoverUrls(
    ownerId: string, items: ItemDto[], localChecks: Map<string, boolean>, size?: "thumb", signal?: AbortSignal,
  ) {
    const covers = new Set<string>();
    let hasLocal = false;
    for (const { url, itemId } of playlistCoverCandidates(items)) {
      signal?.throwIfAborted();
      if (itemId) {
        if (hasLocal) continue;
        if (!localChecks.has(itemId)) {
          const available = await this.artwork.get(ownerId, itemId, size).then(() => true, error => {
            if (error instanceof HttpError && error.status === 404) return false;
            throw error;
          });
          localChecks.set(itemId, available);
        }
        if (!localChecks.get(itemId)) continue;
        hasLocal = true;
      }
      covers.add(url);
      if (covers.size === 3) break;
    }
    return [...covers];
  }
  async backfillAudioTracks(signal?: AbortSignal) {
    const batchSize = 64;
    let after: string | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const files = await this.db.mediaFile.findMany({
        where: { hasAudio: null, id: after === undefined ? undefined : { gt: after } },
        select: { id: true, ownerId: true, path: true, bytes: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
      for (const file of files) {
        signal?.throwIfAborted();
        let hasAudio: boolean;
        try {
          await ownerAccess(this.db, file.ownerId);
          const path = storagePath(this.storageRoot, file.path);
          const info = await stat(path, { bigint: true });
          if (!info.isFile() || info.size !== file.bytes) continue;
          hasAudio = await inspectAudioTrack(path, signal);
        } catch {
          signal?.throwIfAborted();
          continue;
        }
        signal?.throwIfAborted();
        await this.db.mediaFile.updateMany({
          where: { id: file.id, path: file.path, hasAudio: null },
          data: { hasAudio },
        });
      }
      if (files.length < batchSize) return;
      after = files.at(-1)?.id;
    }
  }
  async snapshot(ownerId: string, browserJobs = false, onInvalidPlaylist?: (id: string) => void, includeShared = true): Promise<LibraryDto> {
    if (!includeShared) return this.snapshotWith(ownerId, this.db, browserJobs, onInvalidPlaylist);
    return this.db.$transaction(async tx => {
      const snapshot = await this.snapshotWith(ownerId, tx, browserJobs, onInvalidPlaylist);
      return { ...snapshot, items: await decorateSharedItems(tx, ownerId, snapshot.items, this) };
    });
  }
  private async snapshotWith(
    ownerId: string,
    db: Prisma.TransactionClient,
    browserJobs = false,
    onInvalidPlaylist?: (id: string) => void,
  ): Promise<LibraryDto> {
    const [items, tags, playlistRows, jobs] = await Promise.all([
      db.item.findMany({
        where: { ownerId },
        include: ownedItemInclude(ownerId),
        orderBy: { createdAt: "desc" },
      }),
      listTags(db, ownerId, true),
      db.playlist.findMany({
        where: { ownerId },
        include: { youtubeLink: { select: { playlistId: true } } },
        orderBy: { createdAt: "asc" },
      }),
      db.job.findMany({
        where: { ownerId, ...(browserJobs ? {} : { browserOnly: false }) },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    const playlists: PlaylistDto[] = [];
    for (const row of playlistRows) {
      try {
        playlists.push(playlistDto(row));
      } catch (error) {
        if (!onInvalidPlaylist || !(error instanceof SyntaxError || error instanceof ZodError)) throw error;
        onInvalidPlaylist(row.id);
      }
    }
    return {
      items: items.map(itemDto),
      tags,
      playlists,
      jobs: jobs.map(jobDto),
    };
  }
  async getItem(ownerId: string, id: string) {
    return this.db.$transaction(tx => this.ownedItem(tx, ownerId, id));
  }
  private async ownedItem(tx: Prisma.TransactionClient, ownerId: string, id: string) {
    const [item] = await hydrateLibraryItems(tx, ownerId, [id], true, this);
    invariant(item, 404, "item_not_found", "Медиа не найдено");
    return item;
  }
  async importLocal(
    ownerId: string,
    filePath: string,
    options: {
      title?: string;
      creditId?: string;
      itemId?: string;
      signal?: AbortSignal;
      validateAccess?: (tx: Prisma.TransactionClient) => Promise<void>;
      prepareValidateAccess?: () => Promise<(tx: Prisma.TransactionClient) => Promise<void>>;
      applyReplacement?: (tx: Prisma.TransactionClient, sourceId: string) => Promise<void>;
    } = {},
  ): Promise<{ item: ItemDto; reused: boolean }> {
    let access = await ownerAccess(this.db, ownerId);
    if (options.itemId) invariant(await this.db.item.findFirst({
      where: { id: options.itemId, ownerId }, select: { id: true },
    }), 404, "item_not_found", "Медиа не найдено");
    const media = await inspectFile(filePath, { signal: options.signal });
    const canonicalKey = `local:${media.hash}`;
    const canonical = await this.db.source.findUnique({
      where: { ownerId_key: { ownerId, key: canonicalKey } },
    });
    const prior =
      options.itemId && canonical?.itemId !== options.itemId
        ? await this.db.source.findUnique({
            where: {
              ownerId_key: {
                ownerId,
                key: `${canonicalKey}:${options.itemId}`,
              },
            },
          })
        : canonical;
    const fileIntact = async (
      file: { path: string; hash: string; bytes: bigint } | null,
    ) => {
      if (!file) return false;
      try {
        const path = storagePath(this.storageRoot, file.path);
        const info = await stat(path);
        return (
          info.isFile() &&
          BigInt(info.size) === file.bytes &&
          (await hashFile(path, options.signal)) === file.hash
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        return false;
      }
    };
    if (prior) {
      const original = prior.fileId
        ? await this.db.mediaFile.findFirst({ where: { id: prior.fileId, ownerId } })
        : null;
      if (original && await fileIntact(original)) {
        let reusable = media.browserCompatible && prior.status === "available";
        if (!options.applyReplacement && !media.browserCompatible && prior.reason === "unsupported_codec") {
          const playbackSources = await this.db.source.findMany({
            where: { itemId: prior.itemId, ownerId, provider: "local", status: "available", file: { ownerId } },
            include: { file: true },
          });
          for (const { file } of playbackSources) {
            if (await fileIntact(file)) {
              reusable = true;
              break;
            }
          }
        }
        if (reusable) {
          const validateAccess = await options.prepareValidateAccess?.() ?? options.validateAccess;
          return this.db.$transaction(async tx => {
            options.signal?.throwIfAborted();
            await validateAccess?.(tx);
            options.signal?.throwIfAborted();
            if (original.hasAudio !== media.hasAudio || !original.hintsVersion || !original.audioViewVersion)
              await tx.mediaFile.update({ where: { id: original.id }, data: { hasAudio: media.hasAudio, ...media.playback } });
            if (options.applyReplacement) {
              invariant(await tx.source.findFirst({
                where: { id: prior.id, ownerId, itemId: options.itemId, status: "available" },
              }), 409, "source_changed", "Источник изменился, проверьте файл снова");
              await options.applyReplacement(tx, prior.id);
            }
            return { item: await this.ownedItem(tx, ownerId, prior.itemId), reused: true };
          });
        }
      }
    }
    if (!media.browserCompatible) requireHeavy(access);
    const prepared = await preparePlayback(
      filePath,
      media,
      join(this.storageRoot, "tmp", "playback"),
      { signal: options.signal },
    );
    const staged = new Map<string, Awaited<ReturnType<typeof stageMediaCopy>>>();
    let reservation: string | undefined;
    try {
      const candidates = [{ path: filePath, media }, ...(prepared ? [prepared] : [])];
      let bytes = 0;
      const missing = [];
      for (const candidate of candidates) {
        const hash = candidate.media.hash;
        const known = await this.db.mediaFile.findUnique({ where: { ownerId_hash: { ownerId, hash } } });
        if (!known || known.path.startsWith("missing/")) bytes += candidate.media.bytes;
        if (!(await fileIntact(known))) missing.push(candidate);
      }
      if (access) {
        const credit = options.creditId && await this.db.kanameStorage.findFirst({ where: { id: options.creditId, ownerId } });
        reservation = await reserve(this.db, ownerId, Math.max(0, bytes - Number(credit ? credit.bytes : 0)), access);
      }
      for (const { path, media: info } of missing)
        staged.set(info.hash, await stageMediaCopy(this.storageRoot, ownerId, info.hash, info.ext, path));
      access = await ownerAccess(this.db, ownerId);
      if (prepared) requireHeavy(access);
      invariant(!options.applyReplacement || prepared || media.browserCompatible,
        422, "no_playable_source", "Не удалось подготовить файл к воспроизведению");
      const title = (options.title?.trim() || media.title).slice(0, 500);
      const validateAccess = await options.prepareValidateAccess?.() ?? options.validateAccess;
      const result = await this.db.$transaction(async (tx) => {
        // Re-check under the write transaction: parallel imports may finish probing together.
        const currentCanonical = await tx.source.findUnique({
          where: { ownerId_key: { ownerId, key: canonicalKey } },
        });
        const itemId =
          options.itemId ?? currentCanonical?.itemId ?? randomUUID();
        const key =
          currentCanonical && currentCanonical.itemId !== itemId
            ? `${canonicalKey}:${itemId}`
            : canonicalKey;
        const current = await tx.source.findUnique({
          where: { ownerId_key: { ownerId, key } },
        });
        const reused = Boolean(current);
        await checkItems(tx, ownerId, !options.itemId && !current ? 1 : 0, access);
        const store = async (info: MediaInspection) => {
          let file = await tx.mediaFile.findUnique({
            where: { ownerId_hash: { ownerId, hash: info.hash } },
          });
          const copy = staged.get(info.hash);
          if (copy) {
            await copy.publish();
            const path = copy.path;
            file = await tx.mediaFile.upsert({
              where: { ownerId_hash: { ownerId, hash: info.hash } },
              create: {
                id: randomUUID(),
                ownerId,
                hash: info.hash,
                path,
                mime: info.mime,
                bytes: info.bytes,
                kind: info.kind,
                duration: info.duration,
                hasAudio: info.hasAudio,
                ...info.playback,
              },
              update: {
                path,
                mime: info.mime,
                bytes: info.bytes,
                kind: info.kind,
                duration: info.duration,
                hasAudio: info.hasAudio,
                ...info.playback,
              },
            });
          } else if (file && (file.hasAudio !== info.hasAudio || !file.hintsVersion || !file.audioViewVersion)) {
            file = await tx.mediaFile.update({
              where: { id: file.id },
              data: { hasAudio: info.hasAudio, ...info.playback },
            });
          }
          invariant(file, 409, "file_changed", "Состав хранилища изменился, повторите импорт");
          return file;
        };
        options.signal?.throwIfAborted();
        await validateAccess?.(tx);
        options.signal?.throwIfAborted();
        const file = await store(media);
        const playback = prepared
          ? await store(prepared.media)
          : undefined;
        if (!options.itemId && !current)
          await tx.item.create({
            data: {
              id: itemId,
              ownerId,
              title,
              originalTitle: media.title,
              kind: media.kind,
              duration: media.duration,
            },
          });
        else if (!options.applyReplacement)
          await tx.item.update({
            where: { id: itemId },
            data: { duration: media.duration ?? undefined },
          });
        const originalState = {
          status: media.browserCompatible ? "available" : "unavailable",
          reason: media.browserCompatible ? null : "unsupported_codec",
          fileId: file.id,
          checkedAt: new Date(),
        };
        const originalSource = await tx.source.upsert({
          where: { ownerId_key: { ownerId, key } },
          create: {
            id: randomUUID(),
            ownerId,
            itemId,
            key,
            provider: "local",
            ...originalState,
          },
          update: originalState,
        });
        let preferredSource = originalSource;
        if (playback) {
          const playbackKey = `local:${playback.hash}`;
          const existing = await tx.source.findUnique({
            where: { ownerId_key: { ownerId, key: playbackKey } },
          });
          const key =
            existing && existing.itemId !== itemId
              ? `${playbackKey}:${itemId}`
              : playbackKey;
          preferredSource = await tx.source.upsert({
            where: { ownerId_key: { ownerId, key } },
            create: {
              id: randomUUID(),
              ownerId,
              itemId,
              key,
              provider: "local",
              fileId: playback.id,
              status: "available",
              checkedAt: new Date(),
            },
            update: {
              status: "available",
              reason: null,
              fileId: playback.id,
              checkedAt: new Date(),
            },
          });
        }
        if (options.applyReplacement) await options.applyReplacement(tx, preferredSource.id);
        options.signal?.throwIfAborted();
        await release(tx, reservation);
        return { itemId, reused };
      }, { timeout: 120000 });
      return {
        item: await this.getItem(ownerId, result.itemId),
        reused: result.reused,
      };
    } finally {
      await Promise.all([...staged.values()].map(copy => copy.discard()));
      await release(this.db, reservation);
      if (prepared) await rm(prepared.path, { force: true });
    }
  }
  async upsertYoutube(
    ownerId: string,
    metadata: {
      externalId: string;
      title?: string;
      duration?: number;
      thumbnail?: string;
      available?: boolean;
      reason?: string;
    },
  ): Promise<{ item: ItemDto; reused: boolean }> {
    invariant(
      /^[\w-]{11}$/.test(metadata.externalId),
      400,
      "youtube_id",
      "Некорректный ID YouTube",
    );
    const access = await ownerAccess(this.db, ownerId);
    const key = `youtube:${metadata.externalId}`;
    const row = await this.db.$transaction(async (tx) => {
      const prior = await tx.source.findUnique({
        where: { ownerId_key: { ownerId, key } },
        include: { item: true },
      });
      await checkItems(tx, ownerId, prior ? 0 : 1, access);
      const meaningful =
        metadata.title?.trim() &&
        !/^\[?(private|deleted|unavailable) video\]?$/i.test(
          metadata.title.trim(),
        );
      const title = meaningful
        ? metadata.title!.trim().slice(0, 500)
        : prior?.item.originalTitle || `YouTube · ${metadata.externalId}`;
      const state =
        metadata.available === false
          ? "unavailable"
          : metadata.available === true
            ? "available"
            : (prior?.status ?? "unknown");
      const item = prior
        ? await tx.item.update({
            where: { id: prior.itemId },
            data: {
                ...(meaningful && !prior.item.preferredSourceId
                ? {
                    originalTitle: title,
                    ...(prior.item.title === prior.item.originalTitle
                      ? { title }
                      : {}),
                  }
                : {}),
              duration: prior.item.preferredSourceId ? undefined : metadata.duration ?? undefined,
            },
          })
        : await tx.item.create({
            data: {
              id: randomUUID(),
              ownerId,
              title,
              originalTitle: title,
              kind: "video",
              duration: metadata.duration ?? null,
            },
          });
      await tx.source.upsert({
        where: { ownerId_key: { ownerId, key } },
        create: {
          id: randomUUID(),
          ownerId,
          itemId: item.id,
          key,
          provider: "youtube",
          externalId: metadata.externalId,
          url: `https://www.youtube.com/watch?v=${metadata.externalId}`,
          status: state,
          reason: metadata.reason,
          checkedAt: new Date(),
          thumbnail:
            metadata.thumbnail ??
            `https://i.ytimg.com/vi/${metadata.externalId}/hqdefault.jpg`,
        },
        update: {
          status: state,
          reason: metadata.reason ?? null,
          thumbnail: metadata.thumbnail ?? undefined,
          checkedAt: new Date(),
        },
      });
      return { id: item.id, reused: Boolean(prior) };
    });
    return {
      item: await this.getItem(ownerId, row.id),
      reused: row.reused,
    };
  }
  async updateItem(ownerId: string, id: string, input: ItemPatch) {
    const [item] = await this.updateItems(ownerId, [{ ...input, id }]);
    return item;
  }

  async updateItems(ownerId: string, changes: Array<ItemPatch & { id: string }>, expectedRevision?: string) {
    return this.db.$transaction(async tx => {
      if (expectedRevision !== undefined) {
        const { libraryRevision } = await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { libraryRevision: true } });
        invariant(String(libraryRevision) === expectedRevision, 409, "library_changed", "Медиатека изменилась, обновите предпросмотр");
      }
      const results = [];
      for (const input of changes) {
        const { id } = input;
        const current = await tx.item.findFirst({
          where: { id, ownerId }, include: { tags: ownedItemInclude(ownerId).tags },
        });
        invariant(current, 404, "item_not_found", "Медиа не найдено");
        if (input.title !== undefined)
          invariant(input.title.trim() && input.title.length <= 500, 400, "invalid_title",
            "Название должно содержать от 1 до 500 символов");
        let tags = current.tags.map(({ tag }) => tag);
        if (input.tagIds !== undefined) {
          const ids = new Set([...input.tagIds, ...tags.filter(tag => tag.archived).map(tag => tag.id)]);
          tags = await tx.tag.findMany({ where: { ownerId, id: { in: [...ids] } } });
          invariant(tags.length === ids.size, 404, "tag_not_found", "Один из тегов не найден");
          await tx.itemTag.deleteMany({ where: { itemId: id, tagId: { notIn: [...ids] } } });
          const existing = new Set(current.tags.map(link => link.tagId));
          const additions = [...ids].filter(tagId => !existing.has(tagId)).map(tagId => ({ itemId: id, tagId }));
          if (additions.length) await tx.itemTag.createMany({ data: additions });
        }
        const performance = input.performance ?? current.performance as Performance;
        const voices: Voice[] = performance === "vocal"
          ? [...new Set<Voice>(input.voices ?? JSON.parse(current.voices))] : [];
        if (input.completeClassification) {
          const missing = missingClassification(tags.map(tagDto), performance, voices);
          const names = { source: "источник", artist: "исполнитель", genre: "жанр", mood: "настроение", performance: "исполнение", voice: "голос" };
          invariant(!missing.length, 422, "incomplete_classification",
            "Для завершения разметки укажите: " + missing.map(field => names[field]).join(", "));
        }
        const row = await tx.item.update({
          where: { id }, data: { title: input.title?.trim(), performance, voices: JSON.stringify(voices) },
          include: ownedItemInclude(ownerId),
        });
        results.push(itemDto(row));
      }
      return decorateSharedItems(tx, ownerId, results, this);
    }, { timeout: 120_000 });
  }
  async deleteItem(ownerId: string, id: string) {
    const removedHashes = await this.db.$transaction(async (tx) => {
      const snapshot = await this.snapshotWith(ownerId, tx);
      invariant(
        snapshot.items.some((item) => item.id === id),
        404,
        "item_not_found",
        "Медиа не найдено",
      );
      const uses = snapshot.playlists.filter((p) =>
        collectReferences(p.definition.rule).itemIds.includes(id),
      );
      invariant(
        !uses.length,
        409,
        "item_in_use",
        `Медиа используется в плейлистах: ${uses.map((p) => p.title).join(", ")}`,
      );
      for (const playlist of snapshot.playlists) {
        if (!playlist.definition.manualOrder?.includes(id)) continue;
        const definition = {
          ...playlist.definition,
          manualOrder: playlist.definition.manualOrder.filter(
            (itemId) => itemId !== id,
          ),
        };
        await tx.playlist.update({
          where: { id: playlist.id },
          data: {
            definitionJson: JSON.stringify(definition),
            revision: { increment: 1 },
          },
        });
      }
      await tx.item.delete({ where: { id } });
      const settings = await tx.setting.findUnique({
        where: { userId: ownerId },
      });
      if (settings)
        await this.writeSettings(ownerId, JSON.parse(settings.json), tx);
      return snapshot.items.find(item => item.id === id)!.sources.flatMap(source => source.hash ?? []);
    });
    // Worker maintenance retries after a transient filesystem failure.
    await Promise.all(removedHashes.map(hash => removeUnusedArtwork(this.db, this.storageRoot, ownerId, hash).catch(() => {})));
  }
  listTags(ownerId: string, includeArchived = false) {
    return listTags(this.db, ownerId, includeArchived);
  }
  createTag(ownerId: string, input: TagInput) {
    return this.db.$transaction(tx => saveTag(tx, ownerId, input));
  }
  updateTag(ownerId: string, id: string, input: Partial<TagInput>) {
    return this.db.$transaction(tx => saveTag(tx, ownerId, input, id));
  }
  async deleteTag(ownerId: string, id: string) {
    await this.db.$transaction(async tx => {
      const tags = await listTags(tx, ownerId, true);
      invariant(tags.some(tag => tag.id === id), 404, "tag_not_found", "Тег не найден");
      invariant(!tags.some(tag => tag.parentIds?.includes(id)), 409, "tag_in_use", "Сначала переместите дочерние теги");
      const playlists = await tx.playlist.findMany({ where: { ownerId } });
      const uses = playlists.map(playlistDto).filter(p => collectReferences(p.definition.rule).tagIds.includes(id));
      invariant(!uses.length, 409, "tag_in_use", `Тег используется в плейлистах: ${uses.map(p => p.title).join(", ")}`);
      invariant(!await tx.youtubeLink.findFirst({ where: { ownerId, tagId: id } }),
        409, "tag_in_use", "Тег используется в синхронизации YouTube");
      await tx.tag.delete({ where: { id } });
    });
  }
  async savePlaylist(
    ownerId: string,
    input: {
      title: string;
      description?: string;
      definition: PlaylistDefinition;
    },
    id?: string,
    browser = true,
  ) {
    invariant(
      input.title.trim() && input.title.length <= 200,
      400,
      "invalid_title",
      "Название плейлиста: от 1 до 200 символов",
    );
    const definition = playlistDefinitionSchema.parse(input.definition);
    requireHistoryAccess(definition, browser);
    const row = await this.db.$transaction(async (tx) => {
      if (id) {
        const existing = await tx.playlist.findFirst({ where: { id, ownerId } });
        invariant(
          existing,
          404,
          "playlist_not_found",
          "Плейлист не найден",
        );
        if (await tx.youtubeLink.findUnique({ where: { playlistId: id }, select: { playlistId: true } }))
          invariant(
            existing.definitionJson === JSON.stringify(definition),
            409,
            "linked_playlist",
            "Состав связанного плейлиста меняется на вкладке YouTube",
          );
      }
      await this.evaluateRuleRows(tx, ownerId, definition, id);
      const data = {
        title: input.title.trim(),
        description: input.description?.slice(0, 2000) ?? "",
        definitionJson: JSON.stringify(definition),
      };
      return id
        ? tx.playlist.update({
            where: { id },
            data: { ...data, revision: { increment: 1 } },
            include: { youtubeLink: { select: { playlistId: true } } },
          })
        : tx.playlist.create({ data: { id: randomUUID(), ownerId, ...data } });
    });
    return playlistDto(row);
  }
  async listPlaylists(ownerId: string) {
    const rows = await this.db.playlist.findMany({
      where: { ownerId }, include: { youtubeLink: { select: { playlistId: true } } }, orderBy: { createdAt: "asc" },
    });
    return rows.map(playlistDto);
  }
  async refreshDuePlaylistCounts(now = new Date(), signal?: AbortSignal) {
    const work = await this.db.playlistCountWork.findFirst({
      where: { OR: [
        { dueAt: { lte: BigInt(+now) } },
        { dueAt: null, OR: [
          { publishedVersion: null },
          { NOT: { publishedVersion: { equals: this.db.playlistCountWork.fields.version } } },
        ] },
      ] }, orderBy: [{ dueAt: "asc" }, { ownerId: "asc" }],
    });
    if (!work) return false;
    const { ownerId, version, dueAt } = work;
    const claim = { ownerId, version, dueAt, publishedVersion: work.publishedVersion, validUntil: work.validUntil };
    try {
      const access = await ownerAccess(this.db, ownerId);
      const coverSize = canRunHeavy(access) ? "thumb" : undefined;
      signal?.throwIfAborted();
      type Card = { count: number; covers: string[]; ids: string[] };
      const cards = new Map<string, Card | null>();
      const localCoverChecks = new Map<string, boolean>();
      const [snapshot, history] = await Promise.all([
        this.snapshot(ownerId, false, id => cards.set(id, null), false),
        playlistHistory(this.db, ownerId),
      ]);
      let nextCutoff = Infinity;
      const inputs = {
        ...snapshot, history, now,
        onFutureHistoryCutoff: (at: number) => { nextCutoff = Math.min(nextCutoff, at); },
      };
      for (const playlist of snapshot.playlists) {
        signal?.throwIfAborted();
        try {
          const { items, total } = resolvePlaylist(playlist.definition, inputs, playlist.id);
          cards.set(playlist.id, {
            count: total,
            covers: await this.playlistCoverUrls(ownerId, items, localCoverChecks, coverSize, signal),
            ids: items.map(item => item.id),
          });
        } catch (error) {
          if (!(error instanceof InvalidPlaylistError)) throw error;
          cards.set(playlist.id, null);
        }
      }
      const watchHistory = snapshot.playlists.some(p => usesPrivateHistory(p.definition));
      const validUntil = Number.isFinite(nextCutoff) ? BigInt(nextCutoff) : null;
      await this.db.$transaction(async tx => {
        // Publish counts, covers and queue orders from the same snapshot. A
        // concurrent library edit or worker publication invalidates this claim.
        const current = await tx.playlistCountWork.updateMany({
          where: claim,
          data: { dueAt: validUntil, publishedVersion: version, validUntil, watchHistory },
        });
        if (!current.count) return;
        await tx.$executeRaw`UPDATE Playlist SET trackCount = json_extract(card.value, '$.count'),
          coverUrlsJson = json_extract(card.value, '$.covers'), queueIdsJson = json_extract(card.value, '$.ids')
          FROM json_each(${JSON.stringify(Object.fromEntries(cards))}) AS card
          WHERE Playlist.ownerId = ${ownerId} AND Playlist.id = card.key
            AND (trackCount IS NOT json_extract(card.value, '$.count')
              OR coverUrlsJson IS NOT json_extract(card.value, '$.covers')
              OR queueIdsJson IS NOT json_extract(card.value, '$.ids'))`;
      });
    } catch (error) {
      signal?.throwIfAborted();
      await this.db.playlistCountWork.updateMany({
        where: claim,
        data: { dueAt: BigInt(+now + 60_000) },
      });
      if (!(error instanceof HttpError && error.status === 403)) throw error;
    }
    return true;
  }
  async playlistPlayback(ownerId: string, id: string): Promise<PlaylistPlaybackDto> {
    return this.db.$transaction(async tx => {
      const ids = await this.playlistIds(tx, ownerId, id);
      return { ids, items: await hydrateLibraryItems(tx, ownerId, ids.slice(0, 8), true, this) };
    });
  }
  async playlistIds(tx: Prisma.TransactionClient, ownerId: string, id: string, now = new Date()): Promise<string[]> {
    const row = await tx.playlist.findFirst({ where: { ownerId, id }, select: { queueIdsJson: true } });
    invariant(row, 404, "playlist_not_found", "Плейлист не найден");
    const work = await tx.playlistCountWork.findUnique({ where: { ownerId } });
    const nowMs = now.getTime();
    const fresh = work && work.publishedVersion === work.version &&
      (work.validUntil === null || work.validUntil > BigInt(nowMs));
    if (fresh && row.queueIdsJson !== null) return JSON.parse(row.queueIdsJson) as string[];

    const key = JSON.stringify([ownerId, id]);
    const cached = this.liveQueues.get(key);
    if (cached && work && cached.version === work.version && cached.changeToken === work.changeToken &&
        cached.calculatedAt <= nowMs && nowMs < cached.validUntil) return [...cached.ids];

    const { ids, validUntil } = await this.livePlaylistIds(tx, ownerId, id, now);
    if (work?.changeToken && ids.length <= 100_000) {
      this.liveQueues.delete(key);
      if (this.liveQueues.size >= 8) this.liveQueues.delete(this.liveQueues.keys().next().value!);
      this.liveQueues.set(key, { version: work.version, changeToken: work.changeToken, calculatedAt: nowMs, validUntil, ids: [...ids] });
    }
    return ids;
  }
  private async livePlaylistIds(tx: Prisma.TransactionClient, ownerId: string, id: string, now: Date) {
    const row = await tx.playlist.findFirstOrThrow({ where: { id, ownerId }, select: { definitionJson: true } });
    let definition: PlaylistDefinition;
    try {
      definition = playlistDefinitionSchema.parse(JSON.parse(row.definitionJson));
    } catch (error) {
      throw new HttpError(422, "invalid_playlist", (error as Error).message);
    }
    const { result, validUntil } = await this.evaluateRuleRows(tx, ownerId, definition, id, now);
    return { ids: result.items.map(item => item.id), validUntil };
  }
  private async evaluateRuleRows(
    tx: Prisma.TransactionClient, ownerId: string, definition: PlaylistDefinition, id?: string, now = new Date(),
  ) {
    const { rule, manualOrder } = definition;
    const references = collectReferences(rule);
    const nested = references.playlistIds.length > 0;
    const rows = nested ? await tx.playlist.findMany({
      where: { ownerId }, select: { id: true, title: true, definitionJson: true },
    }) : [];
    const playlists = rows.flatMap(row => {
      try {
        return [{ id: row.id, title: row.title, definition: playlistDefinitionSchema.parse(JSON.parse(row.definitionJson)) }];
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof ZodError)) throw error;
        return [];
      }
    });
    const manualIds = rule.type === "items" ? [...new Set([...rule.ids, ...(manualOrder ?? [])])] : undefined;
    let candidates: Prisma.Sql | undefined;
    if (manualIds) {
      candidates = Prisma.sql`i.id IN (SELECT value FROM json_each(${JSON.stringify(manualIds)}))`;
    } else if (rule.type === "favorite") {
      candidates = Prisma.sql`i.favorite = 1`;
    } else if (rule.type === "tag" && !rule.descendants) {
      candidates = Prisma.sql`i.id IN (SELECT itemId FROM ItemTag WHERE tagId = ${rule.id})`;
    } else if (rule.type === "filter" && rule.kind) {
      candidates = Prisma.sql`i.kind = ${rule.kind}`;
    }
    // manualOrder can name valid items outside a dynamic rule's current result.
    if (candidates && !manualIds && manualOrder?.length) {
      candidates = Prisma.sql`(${candidates} OR i.id IN (SELECT value FROM json_each(${JSON.stringify(manualOrder)})))`;
    }
    const [rowsForRules, tags, history] = await Promise.all([
      tx.$queryRaw<(Pick<ItemDto, "id" | "title" | "kind" | "duration" | "favorite"> & {
        createdAt: Date; tagIds: string; local: bigint;
      })[]>`
        SELECT i.id, i.title, i.kind, i.duration, i.favorite, i.createdAt,
          (SELECT json_group_array(t.id) FROM ItemTag AS it JOIN Tag AS t ON t.id = it.tagId
            WHERE it.itemId = i.id AND t.ownerId = i.ownerId) AS tagIds,
          EXISTS (SELECT 1 FROM Source AS s WHERE s.itemId = i.id AND s.ownerId = i.ownerId
            AND s.provider = 'local' AND s.status = 'available'
            AND (s.fileId IS NULL OR EXISTS (SELECT 1 FROM MediaFile AS f WHERE f.id = s.fileId AND f.ownerId = i.ownerId))) AS local
        FROM Item AS i WHERE i.ownerId = ${ownerId} ${candidates ? Prisma.sql`AND ${candidates}` : Prisma.empty}
        ${manualIds ? Prisma.empty : Prisma.sql`ORDER BY i.createdAt DESC`}`,
      nested || references.tagIds.length ? listTags(tx, ownerId, true) : [],
      nested || usesPrivateHistory(definition) ? playlistHistory(tx, ownerId, manualIds) : undefined,
    ]);
    const items = rowsForRules.map(({ tagIds, local, createdAt, ...item }) => ({
      ...item, createdAt: new Date(createdAt).toISOString(),
      tags: (JSON.parse(tagIds) as string[]).map(id => ({ id })),
      sources: local ? [{ provider: "local", status: "available" } as const] : [],
    }));
    try {
      let validUntil = Infinity;
      const result = resolvePlaylist(definition, {
        items, tags, playlists, history, now,
        onFutureHistoryCutoff: at => { validUntil = Math.min(validUntil, at); },
      }, id);
      const hasHistoryRules = usesPrivateHistory({ ...definition, sort: "source" }, new Map(playlists.map(p => [p.id, p])));
      return { result, hasHistoryRules, usesHistory: definition.sort === "last-started" || hasHistoryRules, validUntil };
    } catch (error) {
      if (!(error instanceof InvalidPlaylistError)) throw error;
      throw new HttpError(422, "invalid_playlist", error.message);
    }
  }
  async previewCards(ownerId: string, definition: PlaylistDefinition, id?: string) {
    return this.db.$transaction(async tx => {
      if (id) await this.getPlaylist(ownerId, id, tx);
      const { result, hasHistoryRules } = await this.evaluateRuleRows(tx, ownerId, definition, id);
      return {...result, hasHistoryRules, items: result.items.map(({id, title, kind}) => ({id, title, kind}))};
    });
  }
  async preview(ownerId: string, definition: PlaylistDefinition, id?: string, browser = true) {
    const checked = playlistDefinitionSchema.parse(definition);
    requireHistoryAccess(checked, browser);
    return this.db.$transaction(async tx => {
      if (id)
        invariant(
          await tx.playlist.findFirst({ where: { id, ownerId } }),
          404,
          "playlist_not_found",
          "Плейлист не найден",
        );
      return (await this.evaluatePlaylist(tx, ownerId, checked, id, browser)).resolved;
    });
  }
  private async coverBeyondWindow(tx: Prisma.TransactionClient, ownerId: string, tail: string[]) {
    const candidates = await tx.$queryRaw<{ id: string }[]>`
      SELECT member.value AS id FROM json_each(${JSON.stringify(tail)}) AS member
      WHERE EXISTS (SELECT 1 FROM Source AS s LEFT JOIN MediaFile AS f ON f.id = s.fileId AND f.ownerId = s.ownerId
        WHERE s.itemId = member.value AND s.ownerId = ${ownerId} AND (s.fileId IS NULL OR f.id IS NOT NULL)
        AND (s.thumbnail <> '' OR (s.provider = 'local' AND f.kind = 'audio')))
      OR EXISTS (SELECT 1 FROM SharedTrack AS t
        JOIN SharedTrackGrant AS g ON g.recipientItemId = t.recipientItemId
        JOIN ShareLink AS l ON l.id = g.shareLinkId AND l.ownerId = t.originOwnerId
        WHERE t.recipientItemId = member.value AND t.recipientId = ${ownerId}
        AND l.revokedAt IS NULL AND (l.expiresAt IS NULL OR l.expiresAt > ${new Date().toISOString()})
        AND EXISTS (SELECT 1 FROM Source AS origin WHERE origin.itemId = t.originItemId AND origin.ownerId = t.originOwnerId
          AND ((origin.provider = 'youtube' AND origin.fileId IS NULL AND origin.externalId IS NOT NULL)
            OR (origin.provider = 'local' AND EXISTS (
              SELECT 1 FROM MediaFile AS f WHERE f.id = origin.fileId AND f.ownerId = origin.ownerId AND f.kind = 'audio')))))
      ORDER BY member.key`;
    let shared = false;
    for (let start = 0; start < candidates.length; start += 8) {
      const batch = candidates.slice(start, start + 8).map(row => row.id);
      for (const item of await hydrateLibraryItems(tx, ownerId, batch, true, this)) {
        shared ||= !!item.shared;
        const source = item.sources.find(s => s.thumbnail);
        if (source) return { url: source.thumbnail, shared };
      }
    }
    return { shared, url: undefined };
  }
  private async evaluatePlaylist(
    tx: Prisma.TransactionClient,
    ownerId: string,
    definition: PlaylistDefinition,
    id: string | undefined,
    browser: boolean,
    limit?: number,
  ) {
    const { result, usesHistory, validUntil } = await this.evaluateRuleRows(tx, ownerId, definition, id);
    const ids = result.items.map(item => item.id);
    const items = await hydrateLibraryItems(tx, ownerId, limit === undefined ? ids : ids.slice(0, limit), true, this);
    const cover = limit !== undefined && ids.length > limit && !items.some(i => i.sources.some(s => s.thumbnail))
      ? await this.coverBeyondWindow(tx, ownerId, ids.slice(limit)) : undefined;
    const resolved = { ...result, items, ...(limit !== undefined && { excluded: [] }),
      ...(!browser && usesHistory && { reasons: {}, excluded: [] }) };
    return { ids, cover, resolved, usesHistory, serverNow: Date.now(), validUntil: Number.isFinite(validUntil) ? validUntil : null,
      excludedCount: result.excluded.length };
  }
  async getPlaylist(ownerId: string, id: string, tx: Prisma.TransactionClient = this.db) {
    const row = await tx.playlist.findFirst({ where: { id, ownerId }, select: {
      id: true, title: true, description: true, definitionJson: true, revision: true,
      createdAt: true, updatedAt: true, youtubeLink: { select: { playlistId: true } },
    } });
    invariant(row, 404, "playlist_not_found", "Плейлист не найден");
    return playlistDto(row);
  }
  async playlistDetail(ownerId: string, id: string, browser = true, limit?: number) {
    return this.db.$transaction(async tx => {
      const playlist = await this.getPlaylist(ownerId, id, tx);
      const work = limit === undefined ? null : await tx.playlistCountWork.findUniqueOrThrow({
        where: { ownerId }, select: { changeToken: true },
      });
      return { playlist, changeToken: work?.changeToken, ...await this.evaluatePlaylist(tx, ownerId, playlist.definition, id, browser, limit) };
    });
  }
  async playlistRows(ownerId: string, id: string, offset: number, changeToken: string, validUntil: number | null) {
    return this.db.$transaction(async tx => {
      const work = await tx.playlistCountWork.findUnique({ where: { ownerId }, select: { changeToken: true } });
      const now = new Date();
      invariant(work?.changeToken === changeToken && (validUntil === null || +now < validUntil),
        409, "playlist_changed", "Состав плейлиста изменился");
      const ids = await this.playlistIds(tx, ownerId, id, now);
      return { items: await hydrateLibraryItems(tx, ownerId, ids.slice(offset, offset + 100), true, this) };
    });
  }
  async playlistExclusions(ownerId: string, id: string, offset: number) {
    return this.db.$transaction(async tx => {
      const playlist = await this.getPlaylist(ownerId, id, tx);
      const { result } = await this.evaluateRuleRows(tx, ownerId, playlist.definition, id);
      return { total: result.excluded.length, entries: result.excluded.slice(offset, offset + 100) };
    });
  }
  async resolve(ownerId: string, id: string, browser = true) {
    return (await this.playlistDetail(ownerId, id, browser)).resolved;
  }
  async deletePlaylist(ownerId: string, id: string) {
    const playlists = await this.listPlaylists(ownerId);
    invariant(
      playlists.some((p) => p.id === id),
      404,
      "playlist_not_found",
      "Плейлист не найден",
    );
    const uses = playlists.filter(
      (p) =>
        p.id !== id &&
        collectReferences(p.definition.rule).playlistIds.includes(id),
    );
    invariant(
      !uses.length,
      409,
      "playlist_in_use",
      `Плейлист используется в: ${uses.map((p) => p.title).join(", ")}`,
    );
    await this.db.playlist.delete({ where: { id } });
  }
  async getSettings(ownerId: string): Promise<Record<string, unknown>> {
    const row = await this.db.setting.findUnique({
      where: { userId: ownerId },
    });
    return row ? JSON.parse(row.json) : {};
  }
  async setSettings(ownerId: string, value: Record<string, unknown>) {
    invariant(
      JSON.stringify(value).length < 1024 * 1024,
      413,
      "settings_too_large",
      "Настройки слишком велики",
    );
    playbackModeSchema.optional().parse(value.mode);
    return this.db.$transaction(async (tx) => {
      const current = await tx.setting.findUnique({
        where: { userId: ownerId },
      });
      const next = { ...(current ? JSON.parse(current.json) : {}), ...value };
      if (["queue", "originalQueue", "queuePlaylistIds"].some(key => Object.hasOwn(value, key))) {
        return this.writeSettings(ownerId, next, tx);
      }
      const queue: string[] = Array.isArray(next.queue) ? next.queue : [];
      const index = Number.isFinite(next.queueIndex) ? Math.floor(next.queueIndex) : 0;
      next.queueIndex = Math.max(0, Math.min(index, queue.length - 1));
      next.queue = queue;
      const id = queue[next.queueIndex];
      const currentItem = id && await tx.item.findFirst({ where: { id, ownerId }, select: { duration: true } });
      next.position = currentItem && Number.isFinite(next.position)
        ? Math.max(0, Math.min(next.position, currentItem.duration ?? Infinity)) : 0;
      return this.persistSettings(ownerId, next, tx);
    });
  }
  private async writeSettings(
    ownerId: string,
    next: Record<string, unknown>,
    tx: Prisma.TransactionClient,
  ) {
    const owned = await tx.item.findMany({
      where: { ownerId },
      select: { id: true, duration: true },
    });
    const allowed = new Map(owned.map((item) => [item.id, item]));
    const oldQueue: unknown[] = Array.isArray(next.queue) ? next.queue : [];
    const oldIndex =
      typeof next.queueIndex === "number" && Number.isFinite(next.queueIndex)
        ? Math.max(
            0,
            Math.min(
              Math.max(0, oldQueue.length - 1),
              Math.floor(next.queueIndex),
            ),
          )
        : 0;
    const currentId = oldQueue[oldIndex];
    const isRetained = (id: unknown): id is string =>
      typeof id === "string" && allowed.has(id);
    const queue = oldQueue.filter(isRetained);
    const retained =
      typeof currentId === "string" ? queue.indexOf(currentId) : -1;
    // Prefer the next retained occurrence, then the preceding end of the queue.
    const nextIndex =
      retained >= 0
        ? retained
        : Math.min(
            oldQueue.slice(0, oldIndex).filter(isRetained).length,
            Math.max(0, queue.length - 1),
          );
    const duration = allowed.get(queue[nextIndex] ?? "")?.duration;
    let position =
      retained >= 0 &&
      typeof next.position === "number" &&
      Number.isFinite(next.position)
        ? Math.max(0, next.position)
        : 0;
    if (duration != null && Number.isFinite(duration))
      position = Math.min(position, duration);
    Object.assign(next, { queue, queueIndex: nextIndex, position });
    if (next.originalQueue !== undefined)
      next.originalQueue = Array.isArray(next.originalQueue)
        ? next.originalQueue.filter(
            (id): id is string => typeof id === "string" && allowed.has(id),
          )
        : [];
    if (next.queuePlaylistIds !== undefined) {
      const ownersPlaylists = new Set((await tx.playlist.findMany({ where: { ownerId }, select: { id: true } }))
        .map((playlist) => playlist.id));
      const queueIds = new Set(queue);
      const contexts = next.queuePlaylistIds;
      next.queuePlaylistIds = Object.fromEntries(
        contexts && typeof contexts === "object" && !Array.isArray(contexts)
          ? Object.entries(contexts).filter(([itemId, playlistId]) =>
              queueIds.has(itemId) && typeof playlistId === "string" && ownersPlaylists.has(playlistId),
            )
          : [],
      );
    }
    return this.persistSettings(ownerId, next, tx);
  }
  private async persistSettings(ownerId: string, next: Record<string, unknown>, tx: Prisma.TransactionClient) {
    const json = JSON.stringify(next);
    invariant(json.length < 1024 * 1024, 413, "settings_too_large", "Настройки слишком велики");
    await tx.setting.upsert({
      where: { userId: ownerId }, create: { userId: ownerId, json }, update: { json },
    });
    return next;
  }
}
