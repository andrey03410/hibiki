import { PrismaClient } from "@prisma/client";
import { sqliteAdapter } from "./sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Sqlite from "better-sqlite3";

export type Db = PrismaClient;
export function createDb(
  storageRoot: string,
  options: { databaseUrl?: string } = {},
): Db {
  mkdirSync(storageRoot, { recursive: true });
  const url =
    options.databaseUrl ??
    process.env.DATABASE_URL ??
    `file:${resolve(storageRoot, "hibiki.db")}`;
  const connection = new Sqlite(url.replace(/^file:/, ""));
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  connection.pragma("busy_timeout = 5000");
  connection.close();
  return new PrismaClient({ adapter: sqliteAdapter(url) });
}
