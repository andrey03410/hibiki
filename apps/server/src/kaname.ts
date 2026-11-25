import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { storagePath } from "./media";
import type { Db } from "./db";
import { HttpError, invariant } from "./errors";

export const kanameEnabled = () => process.env.KANAME_ENABLED === "1";
export function env(name: string) {
  const value = process.env[name];
  invariant(value, 503, "kaname_configuration", "Не настроено подключение Kaname");
  return value;
}
const limit = z.number().int().nonnegative().safe().nullable();
const accessDto = z.object({
  service: z.literal("hibiki"), subject: z.string().min(1), login: z.string().min(1).max(128),
  role: z.enum(["overlord", "admin", "user"]),
  limits: z.object({ storageBytes: limit, items: limit }),
  permissions: z.object({ heavy: z.boolean() }),
});
export type Access = z.infer<typeof accessDto>;
export function reportAuthorized(header?: string) {
  const expected = Buffer.from("Bearer " + env("KANAME_REPORT_TOKEN"));
  const supplied = Buffer.from(header ?? "");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
export async function centralAccess(subject: string): Promise<Access> {
  const url = new URL("/internal/v1/access/" + encodeURIComponent(subject), env("KANAME_URL"));
  const response = await fetch(url, {
    headers: { authorization: "Bearer " + env("KANAME_SERVICE_TOKEN") },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(4000),
  }).catch(() => { throw new HttpError(503, "kaname_unavailable", "Kaname временно недоступен"); });
  invariant(response.status !== 403 && response.status !== 404, 403, "kaname_denied", "Доступ к Hibiki закрыт");
  invariant(response.ok, 503, "kaname_unavailable", "Kaname временно недоступен");
  const dto = accessDto.safeParse(await response.json().catch(() => null));
  invariant(dto.success && dto.data.subject === subject, 503, "kaname_response", "Kaname вернул неверные права");
  invariant(dto.data.role !== "overlord" || subject === env("KANAME_OWNER_SUBJECT"), 403, "owner_mismatch", "Не подтверждён владелец площадки");
  return dto.data;
}
export async function ownerAccess(db: Db, ownerId: string) {
  if (!kanameEnabled()) return null;
  const row = await db.user.findUnique({ where: { id: ownerId } });
  invariant(row?.kanameSubject && row.kanameIssuer === env("KANAME_OIDC_ISSUER") && !row.suspended, 403, "kaname_denied", "Доступ к Hibiki закрыт");
  return centralAccess(row.kanameSubject);
}
export function canRunHeavy(access: Access | null) {
  return !access || (access.role === "overlord" && access.permissions.heavy);
}
export function requireHeavy(access: Access | null) {
  invariant(canRunHeavy(access), 403, "heavy_forbidden", "Скачивание и перекодирование доступны владельцу");
}
export async function bindSubject(db: Db, ownerId: string, subject: string, storageRoot?: string) {
  const access = await centralAccess(subject);
  const issuer = env("KANAME_OIDC_ISSUER");
  const row = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
  invariant(row.login.toLowerCase() === access.login.toLowerCase(), 409, "identity_mismatch", "Логины профиля и назначения различаются");
  if (row.login.toLowerCase() === "andrey" || access.role === "overlord")
    invariant(row.login.toLowerCase() === "andrey" && access.role === "overlord" && subject === env("KANAME_OWNER_SUBJECT"),
      403, "owner_mismatch", "Проверьте идентификатор владельца в Keycloak");
  const existingArtifacts: { id: string; bytes: bigint }[] = [];
  if (storageRoot) {
    const jobs = await db.job.findMany({ where: { ownerId, kind: { in: ["export", "import"] } }, select: { id: true, kind: true } });
    const stages = await db.sourceProposal.findMany({ where: { ownerId, stagedPath: { not: null } }, select: { id: true, stagedPath: true } });
    const paths = [
      ...jobs.map(job => ({ id: (job.kind === "export" ? "export-" : "job-") + job.id,
        path: join("jobs", job.id, job.kind === "export" ? "library.hibiki.zip" : "input.zip") })),
      ...stages.map(stage => ({ id: "stage-" + stage.id, path: stage.stagedPath! })),
    ];
    for (const artifact of paths) {
      const size = await stat(storagePath(storageRoot, artifact.path), { bigint: true }).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
      if (size?.isFile()) existingArtifacts.push({ id: artifact.id, bytes: size.size });
    }
  }
  await db.$transaction(async tx => {
    const changed = await tx.user.updateMany({
      where: { id: ownerId, OR: [{ kanameIssuer: null, kanameSubject: null }, { kanameIssuer: issuer, kanameSubject: subject }] },
      data: { kanameIssuer: issuer, kanameSubject: subject },
    });
    invariant(changed.count === 1, 409, "identity_bound", "Локальный профиль уже связан с другой учётной записью");
    for (const artifact of existingArtifacts) await tx.kanameStorage.upsert({
      where: { id: artifact.id }, create: { ...artifact, ownerId, expiresAt: null }, update: { bytes: artifact.bytes, expiresAt: null },
    });
  });

}
type Tx = Prisma.TransactionClient;
export async function checkItems(tx: Tx, ownerId: string, count: number, access: Access | null) {
  if (!access || access.limits.items === null || count === 0) return;
  invariant((await tx.item.count({ where: { ownerId } })) + count <= access.limits.items,
    409, "kaname_item_quota", "Исчерпан лимит записей медиатеки");
}
export async function mediaBytes(tx: Tx, ownerId: string) {
  const files = await tx.mediaFile.aggregate({ where: { ownerId, NOT: { path: { startsWith: "missing/" } } }, _sum: { bytes: true } });
  return Number(files._sum.bytes ?? 0n);
}
async function heldBytes(tx: Tx, ownerId: string, persistentOnly: boolean) {
  const held = await tx.kanameStorage.aggregate({ where: { ownerId, ...(persistentOnly ? { expiresAt: null } :
    { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }) }, _sum: { bytes: true } });
  return Number(held._sum.bytes ?? 0n);
}
const activityByDb = new WeakMap<Db, Map<string, { day: string; at: number; written: Promise<unknown> }>>();
export async function markActivity(db: Db, ownerId: string, lastActiveAt = new Date()) {
  const day = lastActiveAt.toISOString().slice(0, 10);
  const at = +lastActiveAt;
  const activity = activityByDb.get(db) ?? new Map();
  activityByDb.set(db, activity);
  const previous = activity.get(ownerId);
  if (previous?.day === day && at - previous.at < 60_000) {
    await previous.written;
    return;
  }
  const written = Promise.resolve(db.kanameActivity.upsert({ where: { ownerId_day: { ownerId, day } },
    create: { ownerId, day, lastActiveAt }, update: { lastActiveAt } }));
  activity.set(ownerId, { day, at, written });
  try {
    await written;
  } catch (error) {
    if (activity.get(ownerId)?.written === written) activity.delete(ownerId);
    throw error;
  }
}
export async function usage(db: Db, ownerId?: string) {
  if (!ownerId) return { storageBytes: 0, counts: { items: 0, playlists: 0, jobs: 0 }, lastActiveAt: null, activeDays30: 0 };
  return db.$transaction(async tx => {
    const day = new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);
    const where = { ownerId };
    return { storageBytes: await mediaBytes(tx, ownerId) + await heldBytes(tx, ownerId, true),
      counts: { items: await tx.item.count({ where }), playlists: await tx.playlist.count({ where }), jobs: await tx.job.count({ where }) },
      lastActiveAt: (await tx.kanameActivity.findFirst({ where, orderBy: { day: "desc" } }))?.lastActiveAt.toISOString() ?? null,
      activeDays30: await tx.kanameActivity.count({ where: { ownerId, day: { gte: day } } }) };
  });
}
// Reservations cover concurrent API/worker processes. Working reservations expire after a crashed operation.
export async function reserve(db: Db, ownerId: string, bytes: number, access: Access | null, id = randomUUID() as string) {
  if (!access) return;
  return db.$transaction(async tx => {
    const limit = access.limits.storageBytes;
    if (limit !== null) {
      const total = await mediaBytes(tx, ownerId) + await heldBytes(tx, ownerId, false);
      invariant(total + bytes <= limit, 413, "kaname_storage_quota", "Недостаточно места в Hibiki");
    }
    await tx.kanameStorage.upsert({ where: { id }, create: { id, ownerId, bytes: BigInt(bytes), expiresAt: new Date(Date.now() + 86400_000) },
      update: { bytes: { increment: BigInt(bytes) }, expiresAt: new Date(Date.now() + 86400_000) } });
    return id;
  });
}
export async function release(tx: Tx, id?: string) {
  if (id) await tx.kanameStorage.deleteMany({ where: { id } });
}

// Batch metering bounds memory while each write is covered by a committed reservation.
export function meterStorage(db: Db, ownerId: string, access: Access | null, id: string) {
  return async function* (source: AsyncIterable<Buffer | string>) {
    if (!access) { yield* source; return; }
    let buffers: Buffer[] = [], bytes = 0;
    for await (const value of source) {
      const chunk = typeof value === "string" ? Buffer.from(value) : value;
      buffers.push(chunk); bytes += chunk.length;
      if (bytes < 1024 * 1024) continue;
      await reserve(db, ownerId, bytes, access, id);
      yield Buffer.concat(buffers, bytes); buffers = []; bytes = 0;
    }
    if (bytes) { await reserve(db, ownerId, bytes, access, id); yield Buffer.concat(buffers, bytes); }
  };
}
export async function retain(tx: Tx, id?: string) {
  if (id) await tx.kanameStorage.updateMany({ where: { id }, data: { expiresAt: null } });
}
