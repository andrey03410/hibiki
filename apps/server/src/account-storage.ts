import type { JobsService } from "./jobs";
import { storageBreakdown } from "./kaname";

export async function accountStorage(jobs: JobsService, ownerId: string, limitBytes: number | null) {
  const [breakdown, cleanable] = await Promise.all([
    storageBreakdown(jobs.db, ownerId, jobs.storageRoot),
    jobs.archiveCleanupPreview(ownerId),
  ]);
  return { ...breakdown, limitBytes, cleanable };
}
