import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { storagePath } from "./media";
import { dbStorageRoots, type Db } from "./db";
import { lockStorage, recoverWriters, relativeWorkPath, storageWriter } from "./storage-writer";
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
  return !access || (access.role === "overlord" && access.permissions.heavy && access.limits.storageBytes === null);
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
  await db.$transaction(async tx => {
    const changed = await tx.user.updateMany({
      where: { id: ownerId, OR: [{ kanameIssuer: null, kanameSubject: null }, { kanameIssuer: issuer, kanameSubject: subject }] },
      data: { kanameIssuer: issuer, kanameSubject: subject },
    });
    invariant(changed.count === 1, 409, "identity_bound", "Локальный профиль уже связан с другой учётной записью");
    for (const artifact of storageRoot ? await storedArtifacts(tx, ownerId, storageRoot) : []) await tx.kanameStorage.upsert({
      where: { id: artifact.id }, create: { ...artifact, ownerId, expiresAt: null }, update: {},
    });
  });
}
async function storedArtifacts(tx: Tx, ownerId: string, storageRoot: string, accounted = new Set<string>()) {
  const existingArtifacts: { id: string; bytes: bigint }[] = [];
  const jobs = await tx.job.findMany({ where: { ownerId, kind: { in: ["export", "import"] } }, select: { id: true, kind: true, archiveState: true, resultJson: true, inputJson: true, attempt: true } });
  const stages = await tx.sourceProposal.findMany({ where: { ownerId, stagedPath: { not: null } }, select: { id: true, stagedPath: true } });
  const paths = [
    ...jobs.filter(job => job.archiveState !== "released" && !(job.kind === "import" && JSON.parse(job.inputJson).apply))
      .map(job => {
        const output = job.kind === "export";
        const attempt = output && JSON.parse(job.resultJson ?? "{}")?.exportAttempt;
        return { id: (output ? "export-" : "job-") + job.id,
          path: join("jobs", job.id, attempt ? "export-" + job.attempt : "", output ? "library.hibiki.zip" : "input.zip") };
      }),
    ...stages.map(stage => ({ id: "stage-" + stage.id, path: stage.stagedPath! })),
  ];
  for (const artifact of paths) {
    if (accounted.has(artifact.id)) continue;
    const size = await stat(storagePath(storageRoot, artifact.path), { bigint: true }).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (size?.isFile()) existingArtifacts.push({ id: artifact.id, bytes: size.size });
  }
  return existingArtifacts;
}

async function fileTreeBytes(path: string): Promise<number> {
  try {
    const info = await lstat(path);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    let total = 0;
    for (const child of await readdir(path)) total += await fileTreeBytes(join(path, child));
    return total;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

// External media tools write seekable files themselves and are available only
// without a finite cap. Measure their private directory while the tool runs.
export async function startHeavyStorage(db: Db, ownerId: string, access: Access | null, id: string, directory: string) {
  requireHeavy(access);
  await reserve(db, ownerId, 0, access, id, directory);
  await db.kanameStorage.update({ where: { id, ownerId }, data: { measureOnDisk: true } });
}
export async function finishHeavyStorage(db: Db, ownerId: string, id: string, directory: string) {
  const bytes = await fileTreeBytes(directory);
  await db.kanameStorage.update({ where: { id, ownerId }, data: { bytes: BigInt(bytes), measureOnDisk: false } });
}

export async function storageBreakdown(db: Db, ownerId: string, storageRoot: string) {
  await recoverWriters(db, ownerId);
  return db.$transaction(async tx => {
    const result = { mediaBytes: await mediaBytes(tx, ownerId), importBytes: 0, exportBytes: 0, otherBytes: 0, temporaryBytes: 0 };
    const held = await tx.kanameStorage.findMany({ where: { ownerId } });
    const accounted = new Set(held.map(row => row.id));
    const add = (id: string, bytes: bigint) => {
      if (id.startsWith("job-")) result.importBytes += Number(bytes);
      else if (id.startsWith("export-")) result.exportBytes += Number(bytes);
      else if (id.startsWith("visual-input-")) result.temporaryBytes += Number(bytes);
      else result.otherBytes += Number(bytes);
    };
    for (const row of held) {
      if (row.measureOnDisk) {
        for (const name of JSON.parse(row.workPaths ?? "[]") as string[])
          result.temporaryBytes += await fileTreeBytes(storagePath(storageRoot, name));
      } else if (row.expiresAt) result.temporaryBytes += Number(row.bytes);
      else add(row.id, row.bytes);
    }
    // Legacy local installations created archives and staged proposals without a ledger row.
    for (const artifact of await storedArtifacts(tx, ownerId, storageRoot, accounted)) add(artifact.id, artifact.bytes);
    return result;
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
  const held = await tx.kanameStorage.aggregate({ where: { ownerId, expiresAt: persistentOnly ? null : undefined }, _sum: { bytes: true } });
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
// Commit the reservation before a writer can create bytes. Time alone cannot prove
// that a file was removed or that its writer died.
// Give a seekable stream-copy writer a hard byte ceiling from the remaining quota.
// FFmpeg may seek back to write its container header; the OS enforces this ceiling.
export async function reserveOutput(db: Db, ownerId: string, estimate: number, access: Access | null, id: string) {
  return db.$transaction(async tx => {
    await lockStorage(tx);
    const limit = access?.limits.storageBytes;
    const bytes = limit == null ? estimate : Math.min(estimate,limit - await mediaBytes(tx,ownerId) - await heldBytes(tx,ownerId,false));
    invariant(bytes > 0,413,"kaname_storage_quota","Недостаточно места для дорожки");
    await tx.kanameStorage.update({where:{id,ownerId},data:{bytes:{increment:BigInt(bytes)}}});
    return bytes;
  });
}
export async function recheckStorage(tx: Tx, ownerId: string, access: Access | null) {
  const limit = access?.limits.storageBytes;
  if (limit != null) invariant(await mediaBytes(tx,ownerId) + await heldBytes(tx,ownerId,false) <= limit,
    413,"kaname_storage_quota","Изменился доступный объём хранилища");
}
export async function reserve(db: Db, ownerId: string, bytes: number, access: Access | null,
  id = randomUUID() as string, workPath?: string | string[]) {
  await recoverWriters(db, ownerId);
  const writer = workPath ? storageWriter(db) : undefined;
  return db.$transaction(async tx => {
    await lockStorage(tx);
    const limit = access?.limits.storageBytes;
    const available = limit == null ? undefined : limit - await mediaBytes(tx, ownerId) - await heldBytes(tx, ownerId, false);
    invariant(bytes === 0 || available === undefined || bytes <= available, 413, "kaname_storage_quota", "Недостаточно места в Hibiki");
    const row = await tx.kanameStorage.findUnique({ where: { id } });
    invariant(!row || row.ownerId === ownerId, 409, "storage_owner", "Резерв принадлежит другому аккаунту");
    const paths = new Set<string>(JSON.parse(row?.workPaths ?? "[]"));
    for (const full of Array.isArray(workPath) ? workPath : workPath ? [workPath] : [])
      paths.add(relativeWorkPath(dbStorageRoots.get(db)!, full));
    const working = { expiresAt: new Date(Date.now() + 86400_000), writer, workPaths: paths.size ? JSON.stringify([...paths]) : undefined };
    await tx.kanameStorage.upsert({ where: { id }, create: { id, ownerId, bytes: BigInt(bytes), ...working },
      update: { bytes: { increment: BigInt(bytes) }, ...working } });
    return id;
  });
}
// Reassign the already-paid bytes before rename. A failed cleanup can then
// leave its destination charged even after the upload or inspection closes.
export async function moveReservedFile(db: Db, ownerId: string, bytes: number, from: string, to: string, move: () => Promise<void>) {
  async function transfer(source: string, destination: string) {
    await db.$transaction(async tx => {
      const changed = await tx.kanameStorage.updateMany({ where: { id: source, ownerId, bytes: { gte: BigInt(bytes) } },
        data: { bytes: { decrement: BigInt(bytes) } } });
      invariant(changed.count === 1, 409, "storage_changed", "Изменился резерв хранилища");
      await tx.kanameStorage.update({ where: { id: destination, ownerId }, data: { bytes: { increment: BigInt(bytes) } } });
    });
  }
  await transfer(from, to);
  try { await move(); }
  catch (error) { await transfer(to, from); throw error; }
}

export async function release(tx: Tx, id?: string) {
  if (id) await tx.kanameStorage.deleteMany({ where: { id } });
}

// Batch metering bounds memory while each write is covered by a committed reservation.
export function meterStorage(db: Db, ownerId: string, access: Access | null, id: string, workPath?: string | string[]) {
  return async function* (source: AsyncIterable<Buffer | string>) {
    if (!id) { yield* source; return; }
    let buffers: Buffer[] = [], bytes = 0;
    for await (const value of source) {
      const chunk = typeof value === "string" ? Buffer.from(value) : value;
      buffers.push(chunk); bytes += chunk.length;
      if (bytes < 1024 * 1024) continue;
      await reserve(db, ownerId, bytes, access, id, workPath);
      yield Buffer.concat(buffers, bytes); buffers = []; bytes = 0;
    }
    if (bytes) { await reserve(db, ownerId, bytes, access, id, workPath); yield Buffer.concat(buffers, bytes); }
  };
}
export async function retain(tx: Tx, id?: string) {
  if (id) await tx.kanameStorage.updateMany({ where: { id }, data: { expiresAt: null, writer: null, workPaths: null } });
}
