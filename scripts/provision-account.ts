import { readFileSync } from "node:fs";
import { AuthService } from "../apps/server/src/auth";
import { createDb } from "../apps/server/src/db";

const login = process.argv[2]?.trim().toLowerCase();
if (!login) throw new Error("Expected login");
const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
const db = createDb(process.env.STORAGE_DIR ?? "storage");
try {
  if (!await db.user.findUnique({ where: { login } })) {
    await new AuthService(db).register(login, password, { provisioned: true });
  }
  console.log(`Account ready: ${login}`);
} finally {
  await db.$disconnect();
}
