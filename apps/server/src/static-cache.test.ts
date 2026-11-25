import { expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testContext } from "./test-utils";
import { createApp } from "./app";

it("keeps hashed assets across visits and revalidates the shell and worker", async () => {
  const ctx = await testContext();
  const webRoot = join(ctx.root, "web");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  for (const name of ["assets/test-abc123.js", "index.html", "audio-worker.js"]) await writeFile(join(webRoot, name), "fixture");
  const app = await createApp({ db: ctx.db, storageRoot: ctx.root, webRoot });
  try {
    for (const path of ["/", "/settings", "/audio-worker.js", "/assets/test-abc123.js"]) {
      const result = await app.inject(path);
      expect(result.statusCode, path + " " + result.body).toBe(200);
      expect(result.headers["cache-control"]).toBe(path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    }
  } finally { await app.close(); await ctx.close(); }
});
