import { createDb } from "../apps/server/src/db";
import { bindSubject } from "../apps/server/src/kaname";
const [id, subject] = process.argv.slice(2);
if (!id || !subject) throw new Error("Usage: npm run kaname:bind -- existing-User.id verified-Keycloak-sub");
const storageRoot = process.env.STORAGE_DIR ?? "storage";
const db = createDb(storageRoot);
try {
  await bindSubject(db, id, subject, storageRoot);
  console.log("Привязка существующего профиля Hibiki подтверждена.");
} finally { await db.$disconnect(); }
