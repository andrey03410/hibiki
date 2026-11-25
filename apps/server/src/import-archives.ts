import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import type { Db } from "./db";
import { invariant } from "./errors";

export const MAX_ATTEMPTS = 3;
type Tx = Prisma.TransactionClient;
type Candidate = { id: string; ownerId: string };

// The first statement takes the SQLite writer lock before we inspect dependencies.
// Server and worker can then make the same decision in separate processes.
export async function lockPreview(tx: Tx, ownerId: string, id: string) {
  await tx.$executeRaw`UPDATE Job SET archiveState = archiveState
    WHERE ownerId = ${ownerId} AND id = ${id} AND kind = 'import'`;
}

export async function applications(tx: Tx, ownerId: string, previewId: string) {
  return tx.$queryRaw<{ id: string; state: string; attempt: number }[]>`
    SELECT id, state, attempt FROM Job WHERE ownerId = ${ownerId} AND kind = 'import'
      AND json_extract(inputJson, '$.previewJobId') = ${previewId}
      AND json_extract(inputJson, '$.apply') = 1
    ORDER BY createdAt DESC, id DESC`;
}

function eligibleJobs(db: Db, ownerId?: string) {
  const scope = ownerId === undefined ? Prisma.sql`p.archiveState IN ('pending','deleting')`
    : Prisma.sql`p.ownerId = ${ownerId} AND (p.archiveState IS NULL OR p.archiveState IN ('pending','deleting'))`;
  return db.$queryRaw<Candidate[]>`
    SELECT p.id, p.ownerId FROM Job p WHERE ${scope} AND p.kind = 'import' AND p.state = 'done'
      AND json_extract(p.inputJson, '$.apply') IS NOT 1
      AND EXISTS (SELECT 1 FROM Job a WHERE a.ownerId = p.ownerId AND a.kind = 'import'
        AND json_extract(a.inputJson, '$.previewJobId') = p.id AND json_extract(a.inputJson, '$.apply') = 1 AND a.state = 'done')
      AND NOT EXISTS (SELECT 1 FROM Job a WHERE a.ownerId = p.ownerId AND a.kind = 'import'
        AND json_extract(a.inputJson, '$.previewJobId') = p.id AND json_extract(a.inputJson, '$.apply') = 1
        AND (a.state IN ('queued','running') OR (a.state IN ('failed','cancelled') AND a.attempt < ${MAX_ATTEMPTS})))`;
}

async function archiveFile(storageRoot: string, id: string) {
  invariant(id === path.basename(id) && id !== "." && id !== "..", 409, "archive_path", "Неверный каталог архива");
  const root = await realpath(storageRoot);
  const directory = path.join(root, "jobs", id);
  try {
    invariant(await realpath(directory) === directory, 409, "archive_path", "Неверный каталог архива");
    const file = path.join(directory, "input.zip");
    const info = await lstat(file);
    invariant(info.isFile(), 409, "archive_path", "Неверный файл архива");
    return { file, bytes: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export class ImportArchives {
  constructor(private db: Db, private storageRoot: string) {}

  async estimate(ownerId: string) {
    const total = { count: 0, bytes: 0 };
    for (const row of await eligibleJobs(this.db, ownerId)) {
      try {
        const archive = await archiveFile(this.storageRoot, row.id);
        if (!archive) continue;
        total.count++;
        total.bytes += archive.bytes;
      } catch {
        // An unreadable archive stays visible for a cleanup attempt. Its
        // persistent charge is the last known size.
        const hold = await this.db.kanameStorage.findFirst({ where: { ownerId, id: "job-" + row.id } });
        total.count++;
        total.bytes += Number(hold?.bytes ?? 0);
      }
    }
    return total;
  }

  async cleanup(ownerId?: string) {
    const total = { count: 0, bytes: 0, failedCount: 0 };
    for (const row of await eligibleJobs(this.db, ownerId)) {
      try {
        const result = await this.remove(row, ownerId === undefined);
        if (result) { total.count++; total.bytes += result.bytes; }
      } catch {
        total.failedCount++;
      }
    }
    return total;
  }

  async remove({ ownerId, id }: Candidate, automatic: boolean) {
    const appliedId = await this.db.$transaction(async tx => {
      await lockPreview(tx, ownerId, id);
      const preview = await tx.job.findFirst({ where: { ownerId, id, kind: "import", state: "done" } });
      if (!preview || preview.archiveState === "released" || (automatic && !preview.archiveState) ||
          JSON.parse(preview.inputJson).apply) return;
      const jobs = await applications(tx, ownerId, id);
      if (jobs.some(job => ["queued", "running"].includes(job.state) ||
        (["failed", "cancelled"].includes(job.state) && job.attempt < MAX_ATTEMPTS))) return;
      const applied = jobs.find(job => job.state === "done");
      if (!applied) return;
      await tx.job.update({ where: { id }, data: { archiveState: "deleting" } });
      return applied.id;
    });
    if (!appliedId) return;
    // The committed intent prevents reopening the preview even after a crash
    // between unlink and COMMIT. Recovery can finish when the file is absent.
    return this.db.$transaction(async tx => {
      await lockPreview(tx, ownerId, id);
      const preview = await tx.job.findFirst({ where: { ownerId, id, archiveState: "deleting" } });
      if (!preview) return;
      const archive = await archiveFile(this.storageRoot, id);
      if (archive) await unlink(archive.file);
      await tx.kanameStorage.deleteMany({ where: { ownerId, id: "job-" + id } });
      const result = { ...JSON.parse(preview.resultJson ?? "{}"), archiveReleased: true, appliedJobId: appliedId };
      await tx.job.update({ where: { id }, data: { archiveState: "released", resultJson: JSON.stringify(result) } });
      return archive ? { bytes: archive.bytes } : undefined;
    });
  }
}
