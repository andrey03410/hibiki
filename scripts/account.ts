import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createDb } from "../apps/server/src/db";
import { AuthService } from "../apps/server/src/auth";
const root = resolve(process.env.STORAGE_DIR ?? "storage");
const db = createDb(root);
const auth = new AuthService(db);
const login = process.argv[2] ?? "andrey";
try {
  const exists = await db.user.findUnique({ where: { login } });
  if (exists) {
    console.log(`Account ${login} already exists; no credentials changed.`);
  } else {
    const password = randomBytes(18).toString("base64url");
    const user = await auth.register(login, password);
    await mkdir(join(root, "accounts"), { recursive: true });
    const path = join(root, "accounts", `${login}.json`);
    await writeFile(
      path,
      JSON.stringify(
        {
          login,
          password,
          userId: user.id,
          url: process.env.PUBLIC_URL ?? "http://localhost:8790",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(`Account created. Credentials saved in ${path}`);
  }
} finally {
  await db.$disconnect();
}
