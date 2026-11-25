import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { Prisma } from "@prisma/client";
import type { Db } from "./db";
import { HttpError, invariant } from "./errors";
import { storagePath } from "./media";
import { ownerAccess, requireHeavy } from "./kaname";
import { attachYoutube, canonicalVideo, previewYoutube, youtubeCandidate, type StoredPreview } from "./replacement";

const downloadKind = "mcp-youtube";
async function supersedeDownloads(tx: Prisma.TransactionClient, ownerId: string, itemId: string) {
  await tx.sourceProposal.updateMany({
    where: { ownerId, itemId, kind: downloadKind, status: "downloading" },
    data: { status: "superseded" },
  });
}

async function useLocalSource(
  tx: Prisma.TransactionClient,
  ownerId: string,
  itemId: string,
  sourceId: string,
  root?: string,
) {
  const source = await tx.source.findFirst({
    where: { id: sourceId, ownerId, provider: "local", status: "available" },
    include: { file: true },
  });
  const file = source?.file;
  invariant(
    file && file.ownerId === ownerId && !file.path.startsWith("missing/"),
    404,
    "source_not_found",
    "Источник не найден",
  );
  if (root) {
    const disk = await lstat(storagePath(root, file.path), { bigint: true }).catch(() => null);
    invariant(disk?.isFile() && disk.size === file.bytes, 404, "source_not_found", "Файл недоступен");
  }
  let attached: { id: string; status: string } = source;
  if (source.itemId !== itemId) {
    const existing = await tx.source.findFirst({ where: { ownerId, itemId, provider: "local", fileId: file.id } });
    attached =
      existing ??
      (await tx.source.create({
        data: {
          id: randomUUID(),
          ownerId,
          itemId,
          key: `local:${file.hash}:${itemId}`,
          provider: "local",
          fileId: file.id,
          status: "available",
          checkedAt: source.checkedAt,
        },
      }));
    invariant(attached.status === "available", 422, "replacement_unavailable", "Источник недоступен");
  }
  const item = await tx.item.findFirstOrThrow({ where: { id: itemId, ownerId } });
  if (item.preferredSourceId !== attached.id || item.duration !== file.duration || item.kind !== file.kind)
    await tx.item.update({
      where: { id: itemId, ownerId },
      data: { preferredSourceId: attached.id, duration: file.duration, kind: file.kind },
    });
  return { status: "applied" as const, itemId, sourceId: attached.id, duration: file.duration };
}

export async function replaceSource(
  db: Db,
  root: string,
  ownerId: string,
  itemId: string,
  target: { url?: string; sourceId?: string },
) {
  invariant(
    Boolean(target.url) !== Boolean(target.sourceId),
    400,
    "replacement_target",
    "Укажите один источник: url или sourceId",
  );
  const access = await ownerAccess(db, ownerId);
  const directUrl = target.url && canonicalVideo(target.url);
  const apply = (verified?: { url: string; previous: string | null; preview: StoredPreview }) =>
    db.$transaction(async (tx) => {
      const item = await tx.item.findFirst({
        where: { id: itemId, ownerId },
        select: { preferredSourceId: true, kind: true, duration: true },
      });
      invariant(item, 404, "item_not_found", "Медиа не найдено");
      const source = target.sourceId && (await tx.source.findFirst({ where: { id: target.sourceId, ownerId } }));
      invariant(!target.sourceId || source, 404, "source_not_found", "Источник не найден");
      if (source && source.provider === "local") {
        const result = await useLocalSource(tx, ownerId, itemId, source.id, root);
        await supersedeDownloads(tx, ownerId, itemId);
        return result;
      }
      const url = directUrl || (source && source.url && canonicalVideo(source.url));
      invariant(url, 400, "replacement_video_required", "Укажите ссылку на один ролик YouTube");
      const candidate = await youtubeCandidate(tx, ownerId, itemId, url);
      const receipt = await tx.sourceProposal.findFirst({
        where: { ownerId, itemId, url, kind: downloadKind, status: "applied" },
        orderBy: { createdAt: "desc" },
      });
      const saved: string | undefined = receipt?.metadataJson && JSON.parse(receipt.metadataJson).sourceId;
      if (saved) {
        try {
          const result = await useLocalSource(tx, ownerId, itemId, saved, root);
          await supersedeDownloads(tx, ownerId, itemId);
          return result;
        } catch (error) {
          // A missing previously downloaded file can be fetched again.
          if (!(error instanceof HttpError && error.code === "source_not_found")) throw error;
        }
      }
      const local = await tx.source.findFirst({
        where: { ownerId, itemId, provider: "local", fileId: { not: null } },
        select: { id: true },
      });
      if (local) {
        requireHeavy(access);
        const active = await tx.sourceProposal.findFirst({
          where: { ownerId, itemId, url, kind: downloadKind, status: "downloading" },
        });
        if (active) {
          const job = await tx.job.findUnique({ where: { id: active.id } });
          if (job && !(job.attempt >= 3 && ["failed", "cancelled"].includes(job.state)))
            return { status: job.state, itemId, jobId: job.id };
        }
        await supersedeDownloads(tx, ownerId, itemId);
        const id = randomUUID();
        await tx.sourceProposal.create({
          data: {
            id,
            ownerId,
            itemId,
            kind: downloadKind,
            url,
            status: "downloading",
            metadataJson: JSON.stringify({ previous: item.preferredSourceId }),
          },
        });
        await tx.job.create({
          data: {
            id,
            ownerId,
            kind: "youtube-download",
            inputJson: JSON.stringify({
              itemId,
              mode: item.kind === "audio" ? "audio" : "video",
              replaceSource: true,
            }),
          },
        });
        return { status: "queued", itemId, jobId: id };
      }
      if (candidate.source?.id === item.preferredSourceId && candidate.source?.status === "available") {
        await supersedeDownloads(tx, ownerId, itemId);
        return { status: "applied", itemId, sourceId: candidate.source.id, duration: item.duration };
      }
      if (!verified) return { verify: url, previous: item.preferredSourceId };
      invariant(
        url === verified.url && item.preferredSourceId === verified.previous,
        409,
        "source_changed",
        "Источник записи изменился",
      );
      const sourceId = await attachYoutube(tx, ownerId, itemId, url, verified.preview);
      const duration = verified.preview.duration;
      await tx.item.update({ where: { id: itemId, ownerId }, data: { preferredSourceId: sourceId, duration } });
      await supersedeDownloads(tx, ownerId, itemId);
      return { status: "applied", itemId, sourceId, duration };
    });
  const result = await apply();
  if (!result.verify) return result;
  const preview = await previewYoutube(db, ownerId, itemId, result.verify);
  return apply({ url: result.verify, previous: result.previous, preview });
}

export async function downloadReplacement(
  tx: Prisma.TransactionClient,
  ownerId: string,
  itemId: string,
  jobId: string,
) {
  const row = await tx.sourceProposal.findFirst({ where: { id: jobId, ownerId, itemId, kind: downloadKind } });
  invariant(
    row?.url && (row.status === "downloading" || row.status === "applied"),
    409,
    "replacement_superseded",
    "Выбран другой источник",
  );
  const state = JSON.parse(row.metadataJson!);
  return {
    url: row.url,
    previous: state.previous as string | null,
    applied: row.status === "applied" ? (state.sourceId as string) : undefined,
  };
}

export async function validateDownloadReplacement(
  tx: Prisma.TransactionClient,
  ownerId: string,
  itemId: string,
  jobId: string,
  attempt: number,
) {
  const intent = await downloadReplacement(tx, ownerId, itemId, jobId);
  const job = await tx.job.findFirst({
    where: { id: jobId, ownerId, state: "running", attempt, cancelRequested: false, leaseUntil: { gt: new Date() } },
  });
  invariant(job, 409, "job_lease", "Задание отменено или перезапущено");
  const item = await tx.item.findFirst({ where: { id: itemId, ownerId } });
  invariant(item && item.preferredSourceId === intent.previous, 409, "source_changed", "Источник записи изменился");
  await youtubeCandidate(tx, ownerId, itemId, intent.url);
}

export async function finishDownloadReplacement(
  tx: Prisma.TransactionClient,
  ownerId: string,
  itemId: string,
  jobId: string,
  url: string,
  localSourceId: string,
) {
  // importLocal has checked the lease and source choice before publishing any file in this same transaction.
  await attachYoutube(tx, ownerId, itemId, url, { checkedAt: new Date().toISOString() });
  const applied = await useLocalSource(tx, ownerId, itemId, localSourceId);
  await tx.sourceProposal.update({
    where: { id: jobId, ownerId, itemId, status: "downloading" },
    data: { status: "applied", metadataJson: JSON.stringify({ sourceId: applied.sourceId }) },
  });
}

export async function selectedDownloadVideo(
  tx: Prisma.TransactionClient,
  ownerId: string,
  itemId: string,
  sourceId: string,
) {
  const previous = await tx.sourceProposal.findFirst({
    where: { ownerId, itemId, kind: downloadKind, status: "applied", metadataJson: JSON.stringify({ sourceId }) },
    orderBy: { createdAt: "desc" },
    select: { url: true },
  });
  return previous?.url && new URL(previous.url).searchParams.get("v");
}
