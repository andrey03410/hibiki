import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
if (existsSync(".env")) process.loadEnvFile(".env");
process.env.DATABASE_URL ??= `file:${resolve(process.env.STORAGE_DIR ?? "storage", "hibiki.db")}`;
const path = process.env.DATABASE_URL.replace(/^file:/, "");
if (path.startsWith("/")) {
  mkdirSync(dirname(path), { recursive: true });
  // Prisma 7 on macOS needs the target SQLite file to exist. Never truncate it.
  try {
    closeSync(openSync(path, "ax"));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
const args = process.argv.slice(2);
let status =
  spawnSync(resolve("node_modules/.bin/prisma"), args, {
    stdio: "inherit",
    env: process.env,
  }).status ?? 1;
if (!status && args[0] === "migrate" && args[1] === "dev")
  status =
    spawnSync(resolve("node_modules/.bin/prisma"), ["generate"], {
      stdio: "inherit",
      env: process.env,
    }).status ?? 1;
process.exit(status);
