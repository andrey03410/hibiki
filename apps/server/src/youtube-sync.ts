import { checkItems, ownerAccess, type Access } from "./kaname";
import { createHash, randomUUID } from "node:crypto";
import { playlistDefinitionSchema } from "@hibiki/contracts";
import { Prisma, type YoutubeLink } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db";
import { HttpError, invariant } from "./errors";
import { type LibraryService, playlistDto } from "./library";
import {
  discoverYoutubePlaylist,
  normalizeYoutubePlaylistUrl,
  YOUTUBE_PLAYLIST_LIMIT,
  type YoutubeCollection,
  type YoutubeMetadata,
} from "./youtube";

const checkInterval = 6 * 60 * 60_000;
const previewLifetime = 15 * 60_000;
const modeSchema = z.enum(["auto", "review", "manual"]);
const videoId = z.string().regex(/^[a-zA-Z0-9_-]{11}$/);
const id = z.string().min(1).max(200);
const localEdit = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("add"), itemId: id }),
  z.strictObject({ type: z.literal("remove"), itemId: id }),
  z.strictObject({ type: z.literal("hide"), externalId: videoId }),
  z.strictObject({ type: z.literal("show"), externalId: videoId }),
  z.strictObject({ type: z.literal("tag"), tagId: id.nullable() }),
]);

export type YoutubeSyncMode = z.infer<typeof modeSchema>;
export type YoutubeLocalEdit = z.infer<typeof localEdit>;

interface SnapshotEntry {
  externalId: string;
  itemId: string;
  title: string;
}
interface ReportEntry {
  externalId: string;
  title: string;
}
export interface YoutubeSyncReport {
  id: string;
  checkedAt: string;
  added: Array<ReportEntry & { to: number }>;
  removed: Array<ReportEntry & { from: number }>;
  moved: Array<ReportEntry & { from: number; to: number }>;
}
interface PendingPreview {
  entries: YoutubeMetadata[];
  report: YoutubeSyncReport;
}
interface StoredReports {
  preview: PendingPreview | null;
  report: YoutubeSyncReport | null;
}
export interface YoutubeLinkDto {
  url: string;
  mode: YoutubeSyncMode;
  snapshot: SnapshotEntry[];
  additions: string[];
  hidden: string[];
  tagId: string | null;
  preview: YoutubeSyncReport | null;
  report: YoutubeSyncReport | null;
  lastCheckedAt: string | null;
  lastAppliedAt: string | null;
  error: string | null;
}
export interface YoutubeNoticeDto {
  id: string;
  playlistId: string;
  playlistTitle: string;
  kind: "applied" | "preview";
  report: YoutubeSyncReport;
  createdAt: string;
  readAt: string | null;
}
type Discover = (
  url: string,
  signal?: AbortSignal,
) => Promise<YoutubeCollection>;
type Tx = Prisma.TransactionClient;

const digest = (...data: unknown[]) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
const snapshot = (link: YoutubeLink): SnapshotEntry[] =>
  JSON.parse(link.snapshotJson);
const reports = (link: YoutubeLink): StoredReports =>
  link.previewJson
    ? JSON.parse(link.previewJson)
    : { preview: null, report: null };
const titleOf = (entry: YoutubeMetadata) =>
  entry.title?.trim().slice(0, 500) || `YouTube · ${entry.externalId}`;

async function preference(tx: Tx, ownerId: string): Promise<YoutubeSyncMode> {
  const row = await tx.youtubeSyncPreference.findUnique({ where: { ownerId } });
  return modeSchema.safeParse(row?.mode).data ?? "auto";
}

function linkDto(link: YoutubeLink, mode: YoutubeSyncMode): YoutubeLinkDto {
  const { preview, report } = reports(link);
  return {
    url: link.url,
    mode,
    snapshot: snapshot(link),
    additions: JSON.parse(link.additionsJson),
    hidden: JSON.parse(link.hiddenJson),
    tagId: link.tagId,
    preview: preview?.report ?? null,
    report,
    lastCheckedAt: link.lastCheckedAt?.toISOString() ?? null,
    lastAppliedAt: link.lastAppliedAt?.toISOString() ?? null,
    error: link.error,
  };
}

function diff(
  link: YoutubeLink,
  entries: YoutubeMetadata[],
  checkedAt: Date,
): YoutubeSyncReport {
  const before = snapshot(link);
  const beforeIds = before.map((entry) => entry.externalId);
  const afterIds = entries.map((entry) => entry.externalId);
  const from = new Map(
    beforeIds.map((externalId, index) => [externalId, index + 1]),
  );
  const to = new Map(
    afterIds.map((externalId, index) => [externalId, index + 1]),
  );
  const survivingBefore = beforeIds.filter((externalId) => to.has(externalId));
  const survivingAfter = afterIds.filter((externalId) => from.has(externalId));
  const ranks = new Map(
    survivingBefore.map((externalId, rank) => [externalId, rank]),
  );
  const moved = new Set(
    survivingAfter.filter((externalId, rank) => ranks.get(externalId) !== rank),
  );

  return {
    id: digest(
      link.playlistId,
      link.lastAppliedAt,
      reports(link).report?.id,
      beforeIds,
      afterIds,
    ),
    checkedAt: checkedAt.toISOString(),
    added: entries.flatMap((entry) =>
      from.has(entry.externalId)
        ? []
        : [
            {
              externalId: entry.externalId,
              title: titleOf(entry),
              to: to.get(entry.externalId)!,
            },
          ],
    ),
    removed: before.flatMap(({ externalId, title }) =>
      to.has(externalId)
        ? []
        : [
            {
              externalId,
              title,
              from: from.get(externalId)!,
            },
          ],
    ),
    moved: entries.flatMap((entry) =>
      moved.has(entry.externalId)
        ? [
            {
              externalId: entry.externalId,
              title: titleOf(entry),
              from: from.get(entry.externalId)!,
              to: to.get(entry.externalId)!,
            },
          ]
        : [],
    ),
  };
}

/** Resolve original associations and known sources in the same transaction as publication. */
async function linkItems(
  tx: Tx,
  ownerId: string,
  before: SnapshotEntry[],
  entries: YoutubeMetadata[],
  checkedAt: Date,
  access: Access | null,
) {
  const survivingIds = await ownedItemIds(
    tx,
    ownerId,
    before.map((entry) => entry.itemId),
  );
  const prior = new Map(
    before
      .filter((entry) => survivingIds.has(entry.itemId))
      .map((entry) => [entry.externalId, entry.itemId]),
  );
  const keys = entries
    .filter((entry) => !prior.has(entry.externalId))
    .map((entry) => `youtube:${entry.externalId}`);
  const sources = keys.length
    ? await tx.source.findMany({
        where: {
          ownerId,
          key: { in: keys },
          provider: "youtube",
          item: { ownerId },
        },
        select: { key: true, itemId: true },
      })
    : [];
  const known = new Map(sources.map((source) => [source.key, source.itemId]));
  const newItems: Prisma.ItemCreateManyInput[] = [];
  const newSources: Prisma.SourceCreateManyInput[] = [];
  const rows = entries.map((entry): SnapshotEntry => {
    const { externalId } = entry;
    const key = `youtube:${externalId}`;
    const title = titleOf(entry);
    let itemId = prior.get(externalId) ?? known.get(key);
    if (!itemId) {
      itemId = randomUUID();
      newItems.push({
        id: itemId,
        ownerId,
        title,
        originalTitle: title,
        kind: "video",
        duration: entry.duration,
      });
      newSources.push({
        id: randomUUID(),
        ownerId,
        itemId,
        key,
        externalId,
        provider: "youtube",
        url: `https://www.youtube.com/watch?v=${externalId}`,
        status:
          entry.available === false
            ? "unavailable"
            : entry.available === true
              ? "available"
              : "unknown",
        reason: entry.reason,
        checkedAt,
        thumbnail:
          entry.thumbnail ??
          `https://i.ytimg.com/vi/${externalId}/hqdefault.jpg`,
      });
    }
    return { externalId, itemId, title };
  });
  if (newItems.length) {
    await checkItems(tx, ownerId, newItems.length, access);
    await tx.item.createMany({ data: newItems });
    await tx.source.createMany({ data: newSources });
  }
  return rows;
}

async function ownedItemIds(tx: Tx, ownerId: string, ids: string[]) {
  const rows = ids.length
    ? await tx.item.findMany({
        where: { ownerId, id: { in: [...new Set(ids)] } },
        select: { id: true },
      })
    : [];
  return new Set(rows.map(({ id }) => id));
}

function definitionJson(
  entries: SnapshotEntry[],
  additions: string[],
  hidden: string[],
) {
  const hiddenIds = new Set(hidden);
  const ids = [
    ...new Set([
      ...entries
        .filter((entry) => !hiddenIds.has(entry.externalId))
        .map((entry) => entry.itemId),
      ...additions,
    ]),
  ];
  const definition = playlistDefinitionSchema.safeParse({
    version: 1,
    rule: { type: "items", ids },
    sort: "source",
  });
  invariant(
    definition.success,
    422,
    "youtube_playlist_limit",
    "Состав превышает допустимый размер плейлиста Hibiki",
  );
  return JSON.stringify(definition.data);
}

async function storeDefinition(
  tx: Tx,
  link: YoutubeLink,
  rows: SnapshotEntry[],
) {
  const additions: string[] = JSON.parse(link.additionsJson);
  const hidden: string[] = JSON.parse(link.hiddenJson);
  const owned = await ownedItemIds(tx, link.ownerId, [
    ...rows.map((entry) => entry.itemId),
    ...additions,
  ]);
  const definition = definitionJson(
    rows.filter((entry) => owned.has(entry.itemId)),
    additions.filter((itemId) => owned.has(itemId)),
    hidden,
  );
  await tx.playlist.updateMany({
    where: {
      id: link.playlistId,
      ownerId: link.ownerId,
      definitionJson: { not: definition },
    },
    data: { definitionJson: definition, revision: { increment: 1 } },
  });
}

async function publish(
  tx: Tx,
  link: YoutubeLink,
  pending: PendingPreview,
  now: Date,
  access: Access | null,
  signal?: AbortSignal,
) {
  const rows = await linkItems(
    tx,
    link.ownerId,
    snapshot(link),
    pending.entries,
    now, access,
  );
  const added = new Set(pending.report.added.map((entry) => entry.externalId));
  const tag = link.tagId
    ? await tx.tag.findFirst({
        where: { id: link.tagId, ownerId: link.ownerId },
        select: { id: true },
      })
    : null;
  if (tag) {
    const itemIds = [
      ...new Set(
        rows
          .filter((entry) => added.has(entry.externalId))
          .map((entry) => entry.itemId),
      ),
    ];
    const existing = new Set(
      (
        await tx.itemTag.findMany({
          where: { tagId: tag.id, itemId: { in: itemIds } },
          select: { itemId: true },
        })
      ).map(({ itemId }) => itemId),
    );
    await tx.itemTag.createMany({
      data: itemIds
        .filter((itemId) => !existing.has(itemId))
        .map((itemId) => ({ itemId, tagId: tag.id })),
    });
  }
  await storeDefinition(tx, link, rows);
  signal?.throwIfAborted();
  return {
    snapshotJson: JSON.stringify(rows),
    lastAppliedAt: now,
    previewJson: JSON.stringify({
      preview: null,
      report: pending.report,
    } satisfies StoredReports),
    tagId: tag?.id ?? null,
  };
}

async function addNotice(
  tx: Tx,
  link: YoutubeLink,
  kind: YoutubeNoticeDto["kind"],
  report: YoutubeSyncReport,
  now: Date,
) {
  const noticeId = digest(link.playlistId, kind, report.id);
  await tx.youtubeNotice.upsert({
    where: { id: noticeId },
    create: {
      id: noticeId,
      playlistId: link.playlistId,
      ownerId: link.ownerId,
      payloadJson: JSON.stringify({ kind, report }),
      createdAt: now,
    },
    update: {},
  });
}

export class YoutubeSyncService {
  private readonly discover: Discover;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    options: { discover?: Discover; now?: () => Date } = {},
  ) {
    this.discover = options.discover ?? discoverYoutubePlaylist;
    this.now = options.now ?? (() => new Date());
  }

  preference(ownerId: string) {
    return preference(this.db, ownerId);
  }

  async setPreference(ownerId: string, mode: YoutubeSyncMode) {
    await this.db.youtubeSyncPreference.upsert({
      where: { ownerId },
      create: { ownerId, mode },
      update: { mode },
    });
    return mode;
  }

  async create(ownerId: string, input: string, signal?: AbortSignal) {
    const access = await ownerAccess(this.db, ownerId);
    let url: string;
    try {
      url = normalizeYoutubePlaylistUrl(input);
    } catch (error) {
      throw new HttpError(
        400,
        "youtube_playlist_url",
        (error as Error).message,
      );
    }
    signal?.throwIfAborted();
    const existing = await this.findByUrl(ownerId, url);
    if (existing) return existing;
    const { checkedAt, result, error } = await this.fetch(url, signal);
    if (!result) {
      const winner = await this.findByUrl(ownerId, url);
      if (winner) return winner;
      throw new HttpError(502, "youtube_playlist_discover", error);
    }
    try {
      return await this.db.$transaction(
        async (tx) => {
          // Claim the unique (ownerId, url) link before materializing any items.
          const initial = await tx.playlist.create({
            data: {
              id: randomUUID(),
              ownerId,
              title: result.title?.trim().slice(0, 200) || "Плейлист YouTube",
              definitionJson: definitionJson([], [], []),
              youtubeLink: {
                create: {
                  ownerId,
                  url,
                  lastCheckedAt: checkedAt,
                  lastAppliedAt: checkedAt,
                },
              },
            },
          });
          const rows = await linkItems(
            tx,
            ownerId,
            [],
            result.entries,
            checkedAt, access,
          );
          const playlist = await tx.playlist.update({
            where: { id: initial.id },
            data: {
              definitionJson: definitionJson(rows, [], []),
              youtubeLink: { update: { snapshotJson: JSON.stringify(rows) } },
            },
            include: { youtubeLink: { select: { playlistId: true } } },
          });
          signal?.throwIfAborted();
          return playlistDto(playlist);
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await this.findByUrl(ownerId, url);
        if (winner) return winner;
      }
      throw error;
    }
  }

  async get(ownerId: string, playlistId: string) {
    const playlist = await this.db.playlist.findFirst({
      where: { id: playlistId, ownerId },
      select: { youtubeLink: true },
    });
    invariant(playlist, 404, "playlist_not_found", "Плейлист не найден");
    const link = playlist.youtubeLink;
    return link?.ownerId === ownerId
      ? linkDto(link, await this.preference(ownerId))
      : null;
  }

  async check(ownerId: string, playlistId: string) {
    const link = await this.load(ownerId, playlistId);
    return this.refresh(link);
  }

  async apply(ownerId: string, playlistId: string, previewId: string) {
    const link = await this.load(ownerId, playlistId);
    const access = await ownerAccess(this.db, ownerId);
    const preview = reports(link).preview;
    invariant(
      preview?.report.id === previewId,
      409,
      "youtube_preview_changed",
      "Предпросмотр изменился. Проверьте состав ещё раз.",
    );
    const now = this.now();
    if (
      link.error ||
      now.getTime() - new Date(preview.report.checkedAt).getTime() >=
        previewLifetime
    )
      return this.refresh(link, { confirmed: previewId });
    try {
      return await this.withCurrent(link, async (tx, mode) => {
        const data = await publish(tx, link, preview, now, access);
        return this.save(tx, link, mode, data);
      });
    } catch (error) {
      return this.recordLimit(link, link.lastCheckedAt, error);
    }
  }

  async updateLocal(
    ownerId: string,
    playlistId: string,
    edit: YoutubeLocalEdit,
  ) {
    const link = await this.load(ownerId, playlistId);
    return this.withCurrent(
      link,
      async (tx, mode) => {
        const rows = snapshot(link);
        const additions = new Set<string>(JSON.parse(link.additionsJson));
        const hidden = new Set<string>(JSON.parse(link.hiddenJson));
        let tagId = link.tagId;
        switch (edit.type) {
          case "add":
            invariant(
              await tx.item.findFirst({
                where: { id: edit.itemId, ownerId },
                select: { id: true },
              }),
              404,
              "item_not_found",
              "Запись не найдена",
            );
            additions.add(edit.itemId);
            break;
          case "remove":
            additions.delete(edit.itemId);
            break;
          case "hide":
            invariant(
              rows.some((entry) => entry.externalId === edit.externalId),
              404,
              "youtube_position_not_found",
              "Позиция YouTube не найдена",
            );
            hidden.add(edit.externalId);
            break;
          case "show":
            hidden.delete(edit.externalId);
            break;
          case "tag":
            if (edit.tagId)
              invariant(
                await tx.tag.findFirst({
                  where: { id: edit.tagId, ownerId },
                  select: { id: true },
                }),
                404,
                "tag_not_found",
                "Тег не найден",
              );
            tagId = edit.tagId;
            break;
        }
        const data = {
          additionsJson: JSON.stringify([...additions]),
          hiddenJson: JSON.stringify([...hidden]),
          tagId,
        };
        await storeDefinition(tx, { ...link, ...data }, rows);
        return this.save(tx, link, mode, data);
      },
      true,
    );
  }

  async notices(ownerId: string): Promise<YoutubeNoticeDto[]> {
    const rows = await this.db.youtubeNotice.findMany({
      where: { ownerId, playlist: { ownerId } },
      include: { playlist: { select: { title: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 100,
    });
    return rows.map((row) => {
      const { kind, report }: Pick<YoutubeNoticeDto, "kind" | "report"> =
        JSON.parse(row.payloadJson);
      return {
        id: row.id,
        playlistId: row.playlistId,
        playlistTitle: row.playlist.title,
        kind,
        report,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
      };
    });
  }

  async markRead(ownerId: string, noticeId: string) {
    const { count } = await this.db.youtubeNotice.updateMany({
      where: { id: noticeId, ownerId, readAt: null, playlist: { ownerId } },
      data: { readAt: this.now() },
    });
    return count > 0;
  }

  async runDue(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const cutoff = new Date(this.now().getTime() - checkInterval);
    const link = await this.db.youtubeLink.findFirst({
      where: {
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: cutoff } }],
        NOT: { owner: { youtubeSyncPreference: { is: { mode: "manual" } } } },
      },
      orderBy: [{ lastCheckedAt: "asc" }, { playlistId: "asc" }],
    });
    if (!link) return false;
    try { await this.refresh(link, { background: true, signal }); }
    catch (error) {
      if (!(error instanceof HttpError && error.status === 403)) throw error;
      await this.db.youtubeLink.updateMany({ where: { playlistId: link.playlistId, version: link.version },
        data: { lastCheckedAt: this.now(), error: "Доступ к Hibiki закрыт" } });
    }
    return true;
  }

  private async load(ownerId: string, playlistId: string) {
    const link = await this.db.youtubeLink.findFirst({
      where: { playlistId, ownerId, playlist: { ownerId } },
    });
    invariant(
      link,
      404,
      "youtube_link_not_found",
      "Связанный плейлист не найден",
    );
    return link;
  }

  private async findByUrl(ownerId: string, url: string) {
    const link = await this.db.youtubeLink.findFirst({
      where: { ownerId, url, playlist: { ownerId } },
      select: { playlist: true },
    });
    return link
      ? playlistDto({
          ...link.playlist,
          youtubeLink: { playlistId: link.playlist.id },
        })
      : null;
  }

  private async fetch(
    url: string,
    signal?: AbortSignal,
  ): Promise<
    | { checkedAt: Date; result: YoutubeCollection; error?: undefined }
    | { checkedAt: Date; result?: undefined; error: string }
  > {
    try {
      signal?.throwIfAborted();
      const result = await this.discover(url, signal);
      signal?.throwIfAborted();
      if (result.warnings.length) throw new Error(result.warnings.join("\n"));
      if (result.entries.length > YOUTUBE_PLAYLIST_LIMIT)
        throw new Error("Плейлист YouTube превышает 10 000 позиций");
      const entries = new Map<string, YoutubeMetadata>();
      for (const entry of result.entries) {
        if (!videoId.safeParse(entry?.externalId).success)
          throw new Error("YouTube вернул неполный состав плейлиста");
        if (!entries.has(entry.externalId))
          entries.set(entry.externalId, entry);
      }
      return {
        checkedAt: this.now(),
        result: { ...result, entries: [...entries.values()] },
      };
    } catch (failure) {
      signal?.throwIfAborted();
      const error = (
        failure instanceof Error ? failure.message : String(failure)
      ).slice(0, 1000);
      return {
        checkedAt: this.now(),
        error: error || "Не удалось проверить плейлист YouTube",
      };
    }
  }

  private async refresh(
    link: YoutubeLink,
    options: {
      background?: boolean;
      confirmed?: string;
      signal?: AbortSignal;
    } = {},
  ) {
    const { background, confirmed, signal } = options;
    await ownerAccess(this.db, link.ownerId);
    const { result, checkedAt, error } = await this.fetch(link.url, signal);
    const access = await ownerAccess(this.db, link.ownerId);
    try {
      return await this.withCurrent(link, async (tx, mode) => {
        signal?.throwIfAborted();
        if (background && mode === "manual") return linkDto(link, mode);
        if (!result)
          return this.save(tx, link, mode, { lastCheckedAt: checkedAt, error });
        const report = diff(link, result.entries, checkedAt);
        const base = { lastCheckedAt: checkedAt, error: null };
        const stored = reports(link);
        if (
          !report.added.length &&
          !report.removed.length &&
          !report.moved.length
        )
          return this.save(tx, link, mode, {
            ...base,
            previewJson: JSON.stringify({
              ...stored,
              preview: null,
            } satisfies StoredReports),
          });
        const pending = { entries: result.entries, report };
        if (confirmed ? confirmed === report.id : mode === "auto") {
          const data = await publish(tx, link, pending, checkedAt, access, signal);
          if (mode === "auto")
            await addNotice(tx, link, "applied", report, checkedAt);
          signal?.throwIfAborted();
          return this.save(tx, link, mode, { ...base, ...data });
        }
        if (background) await addNotice(tx, link, "preview", report, checkedAt);
        signal?.throwIfAborted();
        return this.save(tx, link, mode, {
          ...base,
          previewJson: JSON.stringify({
            ...stored,
            preview: pending,
          } satisfies StoredReports),
        });
      });
    } catch (failure) {
      signal?.throwIfAborted();
      return this.recordLimit(link, checkedAt, failure);
    }
  }

  private async withCurrent(
    link: YoutubeLink,
    use: (tx: Tx, mode: YoutubeSyncMode) => Promise<YoutubeLinkDto>,
    failOnConflict = false,
  ) {
    return this.db.$transaction(
      async (tx) => {
        const claim = await tx.youtubeLink.updateMany({
          where: {
            playlistId: link.playlistId,
            ownerId: link.ownerId,
            version: link.version,
          },
          data: { version: { increment: 0 } },
        });
        const mode = await preference(tx, link.ownerId);
        if (claim.count) return use(tx, mode);
        invariant(
          !failOnConflict,
          409,
          "youtube_link_changed",
          "Связанный плейлист уже изменился. Повторите действие.",
        );
        const current = await tx.youtubeLink.findFirst({
          where: { playlistId: link.playlistId, ownerId: link.ownerId },
        });
        invariant(
          current,
          404,
          "youtube_link_not_found",
          "Связанный плейлист не найден",
        );
        return linkDto(current, mode);
      },
      { timeout: 30_000 },
    );
  }

  private async save(
    tx: Tx,
    link: YoutubeLink,
    mode: YoutubeSyncMode,
    data: Prisma.YoutubeLinkUpdateInput,
  ) {
    const saved = await tx.youtubeLink.update({
      where: { playlistId: link.playlistId },
      data: { ...data, version: { increment: 1 } },
    });
    return linkDto(saved, mode);
  }

  private async recordLimit(
    link: YoutubeLink,
    checkedAt: Date | null,
    failure: unknown,
  ) {
    if (
      !(
        failure instanceof HttpError &&
        ["youtube_playlist_limit", "kaname_item_quota"].includes(failure.code)
      )
    )
      throw failure;
    return this.withCurrent(link, (tx, mode) =>
      this.save(tx, link, mode, {
        lastCheckedAt: checkedAt,
        error: failure.message,
      }),
    );
  }
}

function browserOwner(request: FastifyRequest) {
  invariant(request.user, 401, "unauthorized", "Войдите в Hibiki");
  invariant(
    !request.headers.authorization?.startsWith("Bearer "),
    403,
    "browser_only",
    "Доступно в интерфейсе Hibiki",
  );
  return request.user.id;
}

export function registerYoutubeSync(
  app: FastifyInstance,
  db: Db,
  _library: LibraryService,
  discover?: Discover,
) {
  const service = new YoutubeSyncService(db, { discover });
  const playlistId = (request: FastifyRequest) =>
    z.object({ id }).parse(request.params).id;
  const path = "/api/playlists/:id/youtube-sync";
  app.post("/api/youtube-sync/playlists", async (request, reply) => {
    const ownerId = browserOwner(request);
    const { url } = z
      .strictObject({ url: z.string().trim().min(1).max(2000) })
      .parse(request.body);
    return reply.code(201).send(await service.create(ownerId, url));
  });
  app.get(path, async (request) => ({
    link: await service.get(browserOwner(request), playlistId(request)),
  }));
  app.patch(path, (request) =>
    service.updateLocal(
      browserOwner(request),
      playlistId(request),
      localEdit.parse(request.body),
    ),
  );
  app.post(`${path}/check`, (request) =>
    service.check(browserOwner(request), playlistId(request)),
  );
  app.post(`${path}/apply`, (request) =>
    service.apply(
      browserOwner(request),
      playlistId(request),
      z
        .strictObject({ previewId: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(request.body).previewId,
    ),
  );
  app.get("/api/youtube-sync/preference", async (request) => ({
    mode: await service.preference(browserOwner(request)),
  }));
  app.patch("/api/youtube-sync/preference", async (request) => ({
    mode: await service.setPreference(
      browserOwner(request),
      z.strictObject({ mode: modeSchema }).parse(request.body).mode,
    ),
  }));
  app.get("/api/youtube-sync/notices", async (request) => ({
    notices: await service.notices(browserOwner(request)),
  }));
  app.patch("/api/youtube-sync/notices/:id/read", async (request) => {
    await service.markRead(browserOwner(request), playlistId(request));
    return { ok: true };
  });
}
