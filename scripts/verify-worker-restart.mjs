import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { createDb } from "../apps/server/src/db.ts";
import { LibraryService } from "../apps/server/src/library.ts";
import { JobsService } from "../apps/server/src/jobs.ts";

const evidence = path.resolve("storage/verification/01-mvp");
const root = path.join(evidence, `worker-restart-${Date.now()}`);
await mkdir(root, { recursive: true });
const sql = new Database(path.join(root, "hibiki.db"));
const migrations = path.resolve("apps/server/prisma/migrations");
for (const folder of (await readdir(migrations))
  .filter((n) => /^\d/.test(n))
  .sort())
  sql.exec(
    await readFile(path.join(migrations, folder, "migration.sql"), "utf8"),
  );
sql.close();
const db = createDb(root, {
  databaseUrl: `file:${path.join(root, "hibiki.db")}`,
});
const userId = randomUUID();
await db.user.create({
  data: {
    id: userId,
    login: "restart_probe",
    passwordHash: "not-an-interactive-account",
  },
});
const jobs = new JobsService(db, new LibraryService(db, root), root);
const job = await jobs.create(userId, "youtube-import", {
  url: "https://www.youtube.com/playlist?list=PLtdSPZNWT1AtEl2WGRD2d0pZT2fRE2AuX",
});
const children = new Set();
function worker() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/worker/src/main.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STORAGE_DIR: root,
        DATABASE_URL: `file:${path.join(root, "hibiki.db")}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  child.stdout.resume();
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-4000);
  });
  child.once("exit", () => children.delete(child));
  return { child, errors: () => errors };
}
async function waitUntil(fn, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Worker verification timed out");
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) => {
      const t = setTimeout(
        () => reject(new Error("Worker did not stop")),
        10000,
      );
      t.unref();
    }),
  ]);
}
try {
  const first = worker();
  await waitUntil(async () => {
    const value = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    if (value.state === "failed") throw new Error(value.error);
    return value.state === "running" ? value : false;
  });
  await stop(first.child);
  const queued = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(queued.state, "queued");
  assert.equal(queued.attempt, 0);
  const second = worker();
  const completed = await waitUntil(async () => {
    const value = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    if (value.state === "failed") throw new Error(value.error);
    return value.state === "done" ? value : false;
  }, 300000);
  assert.equal(completed.completed, 8);
  assert.equal(await db.item.count({ where: { ownerId: userId } }), 8);
  assert.equal(completed.attempt, 1);
  await stop(second.child);
  await writeFile(
    path.join(evidence, "worker-restart-report.json"),
    JSON.stringify(
      {
        status: "passed",
        interrupted: { state: queued.state, attempt: queued.attempt },
        resumed: {
          state: completed.state,
          attempt: completed.attempt,
          items: completed.completed,
        },
        runtime: process.version,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real worker interrupted during YouTube import, restart finished eight items without duplicate attempts.",
  );
} finally {
  for (const child of children)
    await stop(child).catch(() => child.kill("SIGKILL"));
  await db.$disconnect();
}
