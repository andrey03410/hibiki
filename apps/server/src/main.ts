import { resolve } from "node:path";
import { createDb } from "./db";
import { createApp } from "./app";
const storageRoot = resolve(process.env.STORAGE_DIR ?? "storage");
const db = createDb(storageRoot);
const app = await createApp({ db, storageRoot });
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8790),
});
console.log(
  `Hibiki: ${process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8790}`}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    await db.$disconnect();
    process.exit(0);
  });
