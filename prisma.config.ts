import { defineConfig } from "prisma/config";
import { resolve } from "node:path";
export default defineConfig({
  schema: "apps/server/prisma/schema.prisma",
  migrations: { path: "apps/server/prisma/migrations" },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      `file:${resolve(process.env.STORAGE_DIR ?? "storage", "hibiki.db")}`,
  },
});
