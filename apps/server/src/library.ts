import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db";
import { HttpError, invariant } from "./errors";
import {
  copyMedia,
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
  TagDto,
} from "@hibiki/contracts";
import { playlistDefinitionSchema } from "@hibiki/contracts";
import { collectReferences, resolvePlaylist } from "@hibiki/core";

const itemInclude = {
  sources: { include: { file: true } },
  tags: { include: { tag: true } },
} as const;
type IncludedItem = NonNullable<
  Awaited<ReturnType<Db["item"]["findFirst"]>>
> & { sources: Array<any>; tags: Array<any> };
export function itemDto(row: IncludedItem): ItemDto {
  return {
    id: row.id,
    title: row.title,
    originalTitle: row.originalTitle,
    kind: row.kind as "audio" | "video",
    duration: row.duration,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tags: row.tags.map(({ tag }) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
    })),
    sources: row.sources.map((source) => ({
      id: source.id,
      provider: source.provider,
      externalId: source.externalId ?? undefined,
      url: source.url ?? undefined,
      status: source.status,
      reason: source.reason ?? undefined,
      thumbnail: source.thumbnail ?? undefined,
      fileId: source.fileId ?? undefined,
      mime: source.file?.mime,
      bytes: source.file ? Number(source.file.bytes) : undefined,
      hash: source.file?.hash,
      streamUrl: source.fileId ? `/files/${source.fileId}` : undefined,
    })),
  };
}
export function playlistDto(row: {
  id: string;
  title: string;
  description: string;
  definitionJson: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}): PlaylistDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    definition: playlistDefinitionSchema.parse(JSON.parse(row.definitionJson)),
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
  constructor(
    public db: Db,
    public storageRoot: string,
  ) {}
  async snapshot(ownerId: string): Promise<LibraryDto> {
    const [items, tags, playlists, jobs] = await Promise.all([
      this.db.item.findMany({
        where: { ownerId },
        include: itemInclude,
        orderBy: { createdAt: "desc" },
      }),
      this.db.tag.findMany({ where: { ownerId }, orderBy: { name: "asc" } }),
      this.db.playlist.findMany({
        where: { ownerId },
        orderBy: { createdAt: "asc" },
      }),
      this.db.job.findMany({
        where: { ownerId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    return {
      items: items.map(itemDto),
      tags: tags.map(({ id, name, color }) => ({ id, name, color })),
      playlists: playlists.map(playlistDto),
      jobs: jobs.map(jobDto),
    };
  }
  async getItem(ownerId: string, id: string) {
    const row = await this.db.item.findFirst({
      where: { id, ownerId },
      include: itemInclude,
    });
    invariant(row, 404, "item_not_found", "Медиа не найдено");
    return itemDto(row);
  }
  async importLocal(
    ownerId: string,
    filePath: string,
    options: { title?: string; itemId?: string; signal?: AbortSignal } = {},
  ): Promise<{ item: ItemDto; reused: boolean }> {
    if (options.itemId) await this.getItem(ownerId, options.itemId);
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
    if (prior) {
      const item = await this.getItem(ownerId, prior.itemId);
      if (
        (media.browserCompatible && prior.status === "available") ||
        (!media.browserCompatible &&
          prior.status === "unavailable" &&
          prior.reason === "unsupported_codec" &&
          item.sources.some(
            (source) =>
              source.provider === "local" &&
              source.status === "available" &&
              source.fileId,
          ))
      )
        return { item, reused: true };
    }
    const prepared = await preparePlayback(
      filePath,
      media,
      join(this.storageRoot, "tmp", "playback"),
      { signal: options.signal },
    );
    try {
      const store = async (source: string, info: MediaInspection) => {
        let file = await this.db.mediaFile.findUnique({
          where: { ownerId_hash: { ownerId, hash: info.hash } },
        });
        if (!file) {
          const path = await copyMedia(
            this.storageRoot,
            ownerId,
            info.hash,
            info.ext,
            source,
          );
          file = await this.db.mediaFile.upsert({
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
            },
            update: {},
          });
        }
        return file;
      };
      options.signal?.throwIfAborted();
      const file = await store(filePath, media);
      const playback = prepared
        ? await store(prepared.path, prepared.media)
        : undefined;
      const title = (options.title?.trim() || media.title).slice(0, 500);
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
        else
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
        await tx.source.upsert({
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
        if (playback) {
          const playbackKey = `local:${playback.hash}`;
          const existing = await tx.source.findUnique({
            where: { ownerId_key: { ownerId, key: playbackKey } },
          });
          const key =
            existing && existing.itemId !== itemId
              ? `${playbackKey}:${itemId}`
              : playbackKey;
          await tx.source.upsert({
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
        options.signal?.throwIfAborted();
        return { itemId, reused };
      });
      return {
        item: await this.getItem(ownerId, result.itemId),
        reused: result.reused,
      };
    } finally {
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
    const key = `youtube:${metadata.externalId}`;
    const prior = await this.db.source.findUnique({
      where: { ownerId_key: { ownerId, key } },
      include: { item: true },
    });
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
    const row = await this.db.$transaction(async (tx) => {
      const item = prior
        ? await tx.item.update({
            where: { id: prior.itemId },
            data: {
              ...(meaningful
                ? {
                    originalTitle: title,
                    ...(prior.item.title === prior.item.originalTitle
                      ? { title }
                      : {}),
                  }
                : {}),
              duration: metadata.duration ?? undefined,
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
      return item;
    });
    return {
      item: await this.getItem(ownerId, row.id),
      reused: Boolean(prior),
    };
  }
  async updateItem(
    ownerId: string,
    id: string,
    input: { title?: string; tagIds?: string[] },
  ) {
    await this.getItem(ownerId, id);
    if (input.title !== undefined)
      invariant(
        input.title.trim() && input.title.length <= 500,
        400,
        "invalid_title",
        "Название должно содержать от 1 до 500 символов",
      );
    const tagIds = input.tagIds ? [...new Set(input.tagIds)] : undefined;
    if (tagIds)
      invariant(
        (await this.db.tag.count({
          where: { id: { in: tagIds }, ownerId },
        })) === tagIds.length,
        404,
        "tag_not_found",
        "Один из тегов не найден",
      );
    await this.db.$transaction(async (tx) => {
      await tx.item.update({
        where: { id },
        data: { title: input.title?.trim() },
      });
      if (tagIds) {
        await tx.itemTag.deleteMany({ where: { itemId: id } });
        await tx.itemTag.createMany({
          data: tagIds.map((tagId) => ({ itemId: id, tagId })),
        });
      }
    });
    return this.getItem(ownerId, id);
  }
  async deleteItem(ownerId: string, id: string) {
    await this.getItem(ownerId, id);
    const snapshot = await this.snapshot(ownerId);
    const uses = snapshot.playlists.filter((p) =>
      collectReferences(p.definition.rule).itemIds.includes(id),
    );
    invariant(
      !uses.length,
      409,
      "item_in_use",
      `Медиа используется в плейлистах: ${uses.map((p) => p.title).join(", ")}`,
    );
    await this.db.item.delete({ where: { id } });
  }
  async createTag(
    ownerId: string,
    input: { name: string; color?: string },
  ): Promise<TagDto> {
    const name = input.name.trim();
    invariant(
      name.length > 0 && name.length <= 80,
      400,
      "invalid_tag",
      "Название тега: от 1 до 80 символов",
    );
    const color = input.color ?? "#b8a5ff";
    invariant(
      /^#[0-9a-f]{6}$/i.test(color),
      400,
      "invalid_color",
      "Цвет должен быть в формате #RRGGBB",
    );
    const row = await this.db.tag.upsert({
      where: { ownerId_name: { ownerId, name } },
      create: { id: randomUUID(), ownerId, name, color },
      update: {},
    });
    return { id: row.id, name: row.name, color: row.color };
  }
  async updateTag(
    ownerId: string,
    id: string,
    input: { name?: string; color?: string },
  ) {
    invariant(
      await this.db.tag.findFirst({ where: { id, ownerId } }),
      404,
      "tag_not_found",
      "Тег не найден",
    );
    if (input.name !== undefined)
      invariant(
        input.name.trim().length > 0 && input.name.length <= 80,
        400,
        "invalid_tag",
        "Название тега: от 1 до 80 символов",
      );
    if (input.color !== undefined)
      invariant(
        /^#[0-9a-f]{6}$/i.test(input.color),
        400,
        "invalid_color",
        "Некорректный цвет",
      );
    const row = await this.db.tag.update({
      where: { id },
      data: { name: input.name?.trim(), color: input.color },
    });
    return { id: row.id, name: row.name, color: row.color };
  }
  async deleteTag(ownerId: string, id: string) {
    invariant(
      await this.db.tag.findFirst({ where: { id, ownerId } }),
      404,
      "tag_not_found",
      "Тег не найден",
    );
    const uses = (await this.snapshot(ownerId)).playlists.filter((p) =>
      collectReferences(p.definition.rule).tagIds.includes(id),
    );
    invariant(
      !uses.length,
      409,
      "tag_in_use",
      `Тег используется в плейлистах: ${uses.map((p) => p.title).join(", ")}`,
    );
    await this.db.tag.delete({ where: { id } });
  }
  async savePlaylist(
    ownerId: string,
    input: {
      title: string;
      description?: string;
      definition: PlaylistDefinition;
    },
    id?: string,
  ) {
    invariant(
      input.title.trim() && input.title.length <= 200,
      400,
      "invalid_title",
      "Название плейлиста: от 1 до 200 символов",
    );
    if (id)
      invariant(
        await this.db.playlist.findFirst({ where: { id, ownerId } }),
        404,
        "playlist_not_found",
        "Плейлист не найден",
      );
    const definition = playlistDefinitionSchema.parse(input.definition);
    const snapshot = await this.snapshot(ownerId);
    try {
      resolvePlaylist(definition, snapshot, id);
    } catch (error) {
      throw new HttpError(422, "invalid_playlist", (error as Error).message);
    }
    const data = {
      title: input.title.trim(),
      description: input.description?.slice(0, 2000) ?? "",
      definitionJson: JSON.stringify(definition),
    };
    const row = id
      ? await this.db.playlist.update({
          where: { id },
          data: { ...data, revision: { increment: 1 } },
        })
      : await this.db.playlist.create({
          data: { id: randomUUID(), ownerId, ...data },
        });
    return playlistDto(row);
  }
  async preview(ownerId: string, definition: PlaylistDefinition, id?: string) {
    if (id)
      invariant(
        await this.db.playlist.findFirst({ where: { id, ownerId } }),
        404,
        "playlist_not_found",
        "Плейлист не найден",
      );
    try {
      return resolvePlaylist(
        playlistDefinitionSchema.parse(definition),
        await this.snapshot(ownerId),
        id,
      );
    } catch (error) {
      throw new HttpError(422, "invalid_playlist", (error as Error).message);
    }
  }
  async resolve(ownerId: string, id: string) {
    const row = await this.db.playlist.findFirst({ where: { id, ownerId } });
    invariant(row, 404, "playlist_not_found", "Плейлист не найден");
    return this.preview(ownerId, playlistDto(row).definition, id);
  }
  async deletePlaylist(ownerId: string, id: string) {
    const snapshot = await this.snapshot(ownerId);
    invariant(
      snapshot.playlists.some((p) => p.id === id),
      404,
      "playlist_not_found",
      "Плейлист не найден",
    );
    const uses = snapshot.playlists.filter(
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
    const current = await this.getSettings(ownerId);
    const next = { ...current, ...value };
    if (Array.isArray(next.queue)) {
      const ids = (next.queue as unknown[]).filter(
        (id): id is string => typeof id === "string",
      );
      const owned = await this.db.item.findMany({
        where: { id: { in: ids }, ownerId },
        select: { id: true },
      });
      const allowed = new Set(owned.map((i) => i.id));
      next.queue = ids.filter((id) => allowed.has(id));
    }
    await this.db.setting.upsert({
      where: { userId: ownerId },
      create: { userId: ownerId, json: JSON.stringify(next) },
      update: { json: JSON.stringify(next) },
    });
    return next;
  }
}
