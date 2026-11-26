import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "./app";
import type { Db } from "./db";
import type { Prisma } from "@prisma/client";
import { jobDto } from "./library";
import { invariant } from "./errors";
import { meterStorage, ownerAccess } from "./kaname";
import { discardReservation } from "./storage-writer";
import { uploadPolicy } from "./upload-policy";

const sourceId = z.string().min(1).max(256);
export const visualUploadOptions = z.object({
  expectedRevision: z.coerce.number().int().nonnegative(),
  soundSourceId: sourceId.optional(),
  videoStreamIndex: z.coerce.number().int().nonnegative().optional(),
  operationId: sourceId.optional(),
}).strict();

export type VisualUpload = z.infer<typeof visualUploadOptions> & { itemId: string; jobId: string };

export function visualGrant(ownerId: string, itemId: string, params: z.infer<typeof visualUploadOptions>): VisualUpload {
  const operationId = params.operationId ?? randomUUID();
  const jobId = createHash("sha256").update(JSON.stringify(["visual-attach", ownerId, itemId, operationId])).digest("hex");
  return { ...params, itemId, operationId, jobId };
}

export async function existingVisualUpload(db: Prisma.TransactionClient, ownerId: string, input: VisualUpload, hash?: string) {
  const job = await db.job.findFirst({ where: { id: input.jobId, ownerId, kind: "visual-attach" } });
  if (!job) return;
  const saved = JSON.parse(job.inputJson);
  invariant(saved.itemId === input.itemId && saved.expectedRevision === input.expectedRevision &&
    saved.videoStreamIndex === input.videoStreamIndex && saved.soundSourceId === input.soundSourceId &&
    saved.operationId === input.operationId && (!hash || saved.hash === hash),
    409, "visual_operation_conflict", "Идентификатор уже использован для другой операции");
  return jobDto(job);
}

export async function checkVisualTarget(db: Db, ownerId: string, itemId: string, expectedRevision: number) {
  const item = await db.item.findFirst({ where: { id: itemId, ownerId }, select: { visualRevision: true } });
  invariant(item, 404, "item_not_found", "Запись не найдена");
  invariant(item.visualRevision === expectedRevision, 409, "visual_revision", "Видеоряд уже изменился. Обновите карточку.");
}

export async function receiveVisualUpload(request: FastifyRequest, s: Services, ownerId: string, input: VisualUpload) {
  const access = await ownerAccess(s.db, ownerId);
  if (!await existingVisualUpload(s.db, ownerId, input)) await checkVisualTarget(s.db, ownerId, input.itemId, input.expectedRevision);
  const hold = "upload-" + randomUUID();
  const dir = join(s.storageRoot, "uploads", ownerId, hold);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "input");
  const policy = uploadPolicy(false);
  try {
    let uploaded = false;
    for await (const part of request.parts({ ...policy, limits: { ...policy.limits, files: 1 } })) {
      if (part.type !== "file") continue;
      invariant(part.fieldname === "file", 400, "file_required", "Поместите видеоряд в поле file");
      await pipeline(part.file, meterStorage(s.db, ownerId, access, hold, dir), createWriteStream(file, { flags: "wx" }));
      invariant(!part.file.truncated, 413, "file_too_large", "Файл превышает 2 ГиБ");
      uploaded = true;
    }
    invariant(uploaded, 400, "file_required", "Выберите файл с видеорядом");
    return await s.jobs.createVisualUpload(ownerId, input, file, hold);
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } finally {
      await discardReservation(s.db, ownerId, hold);
    }
  }
}
