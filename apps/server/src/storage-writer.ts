import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { realpath, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import Sqlite from "better-sqlite3";
import type { Prisma } from "@prisma/client";
import { dbStorageRoots, type Db } from "./db";

// The web server and worker may run in different PID namespaces. A SQLite
// exclusive lock on their shared volume survives pauses and is dropped on exit.
const markers = new WeakMap<Db, string>();
export function storageWriter(db: Db) {
  const previous = markers.get(db);
  if (previous) return previous;
  const id = randomUUID();
  const directory = join(dbStorageRoots.get(db)!, ".writers");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, id);
  const marker = new Sqlite(file);
  marker.exec("BEGIN EXCLUSIVE");
  markers.set(db, id);
  const close = () => {
    if (!marker.open) return;
    marker.close();
    rmSync(file, { force: true });
    markers.delete(db);
  };
  const disconnect = db.$disconnect.bind(db);
  db.$disconnect = async () => { await disconnect(); close(); };
  return id;
}

function liveWriter(root: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Некорректный идентификатор записи");
  const file = join(root, ".writers", id);
  if (!existsSync(file)) return false;
  let marker: Sqlite.Database | undefined;
  try {
    marker = new Sqlite(file, { timeout: 0, fileMustExist: true });
    marker.exec("BEGIN EXCLUSIVE");
    return false;
  } catch (error) {
    if (!existsSync(file)) return false;
    // Inaccessible locks cannot establish that their writer stopped.
    if (error instanceof Sqlite.SqliteError) return true;
    throw error;
  } finally { marker?.close(); }
}

export function relativeWorkPath(root: string, full: string) {
  const name = relative(resolve(root), resolve(full));
  if (!name || name.startsWith(".." + sep) || name === "..")
    throw new Error("Временный файл вне хранилища");
  return name;
}

// Obtain the SQLite writer lock before combining a database decision with unlink/rename.
export async function lockStorage(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`UPDATE KanameStorage SET bytes = bytes WHERE 0`;
}

// Pre-migration reservations have no trustworthy file list. At upgrade, leave
// those bytes charged while an unaccounted legacy file could still exist.
async function legacyFilesRemain(tx: Prisma.TransactionClient, root: string, ownerId: string) {
  const jobs = await tx.job.findMany({ select: { id: true, ownerId: true, kind: true, attempt: true, resultJson: true } });
  const jobById = new Map(jobs.map(job => [job.id, job]));
  const media = await tx.mediaFile.findMany({ where: { ownerId }, select: { path: true } });
  const accounted = new Set(media.map(file => file.path));
  const rows = await tx.kanameStorage.findMany({ where: { ownerId, writer: { not: "legacy" } }, select: { workPaths: true } });
  for (const row of rows)
    for (const name of JSON.parse(row.workPaths ?? "[]") as string[]) accounted.add(name);
  const stages = await tx.sourceProposal.findMany({ where: { stagedPath: { not: null } }, select: { stagedPath: true } });
  for (const stage of stages) accounted.add(stage.stagedPath!);
  async function remaining(name: string): Promise<boolean> {
    if (accounted.has(name)) return false;
    const entries = await readdir(join(root, name), { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      return null;
    });
    if (!entries) return true;
    for (const entry of entries) {
      const child = join(name, entry.name);
      if (accounted.has(child)) continue;
      if (entry.isDirectory()) {
        if (name === "jobs" && jobById.has(entry.name)) {
          const job = jobById.get(entry.name)!;
          if (job.ownerId !== ownerId) continue;
          // Published archives have independent persistent accounting.
          if (job.kind === "import") accounted.add(join(child, "input.zip"));
          if (job.kind === "export") {
            const attempt = JSON.parse(job.resultJson ?? "{}")?.exportAttempt;
            accounted.add(join(child, attempt ? "export-" + job.attempt : "", "library.hibiki.zip"));
          }
        }
        if (await remaining(child)) return true;
      } else if (entry.isFile()) return true;
    }
    return false;
  }
  for (const category of [join("uploads", ownerId), join("media", ownerId), join("imported", ownerId),
    "jobs", join("tmp", "playback"), join("uploads", "replacements")])
    if (await remaining(category)) return true;
  return false;
}

export async function recoverWriters(db: Db, ownerId: string) {
  const root = dbStorageRoots.get(db)!;
  const writers = await db.kanameStorage.findMany({ where: { ownerId, expiresAt: { not: null }, writer: { not: null } },
    distinct: ["writer"], select: { writer: true } });
  for (const { writer } of writers) {
    if (writer === "legacy") {
      const expired = { ownerId, writer, expiresAt: { lte: new Date() } };
      if (await db.kanameStorage.count({ where: expired })) await db.$transaction(async tx => {
        await lockStorage(tx);
        // Old multipart requests used the reservation UUID as their private
        // directory name. No other reservation or job shares these uploads.
        const stale = await tx.kanameStorage.findMany({ where: expired, select: { id: true } });
        const uploads = join(root, "uploads", ownerId);
        for (const row of stale) {
          if (!/^[a-f0-9-]{36}$/i.test(row.id)) continue;
          try {
            const realRoot = await realpath(root);
            if (await realpath(uploads) !== join(realRoot, "uploads", ownerId)) continue;
            const path = join(uploads, row.id);
            if (await realpath(path) !== join(realRoot, "uploads", ownerId, row.id)) continue;
            await rm(path, { recursive: true });
          } catch { continue; }
          await tx.kanameStorage.delete({ where: { id: row.id } });
        }
        if (!await legacyFilesRemain(tx, root, ownerId)) await tx.kanameStorage.deleteMany({ where: expired });
      }, { timeout: 120000 });
      continue;
    }
    if (writer === markers.get(db) || (writer !== "abandoned" && liveWriter(root, writer!))) continue;
    await db.$transaction(async tx => {
      await lockStorage(tx);
      const rows = await tx.kanameStorage.findMany({ where: { ownerId, writer, expiresAt: { not: null } } });
      for (const row of rows) {
        if (!row.workPaths) continue;
        let cleaned = true;
        for (const name of JSON.parse(row.workPaths) as string[]) {
          const full = resolve(root, name);
          if (relativeWorkPath(root, full) !== name) { cleaned = false; continue; }
          // A published content-addressed file can be shared by concurrent writers.
          if (await tx.mediaFile.count({ where: { ownerId, path: name } })) continue;
          try {
            if (await realpath(dirname(full)) !== join(await realpath(root), dirname(name))) { cleaned = false; continue; }
            await rm(full, { recursive: true, force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleaned = false;
          }
        }
        if (!cleaned) continue;
        await tx.kanameStorage.delete({ where: { id: row.id } });
      }
    });
  }
}

export async function discardReservation(db: Db, ownerId: string, id: string) {
  const failed = await db.kanameStorage.updateMany({ where: { ownerId, id, expiresAt: { not: null } }, data: { writer: "abandoned" } });
  if (failed.count) await recoverWriters(db, ownerId);
}
