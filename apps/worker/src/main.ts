import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { createDb } from "../../server/src/db.js";
import { LibraryService } from "../../server/src/library.js";
import { JobsService } from "../../server/src/jobs.js";
import {
  youtubeDiagnostics,
  updateYoutubeTool,
} from "../../server/src/youtube.js";

const storageRoot = path.resolve(process.env.STORAGE_DIR ?? "storage");
if (process.argv.includes("--diagnostics")) {
  console.log(JSON.stringify(await youtubeDiagnostics(), null, 2));
} else if (process.argv.includes("--update-ytdlp")) {
  const updated = await updateYoutubeTool();
  console.log(updated.stdout);
} else {
  const db = createDb(storageRoot);
  const jobs = new JobsService(
    db,
    new LibraryService(db, storageRoot),
    storageRoot,
  );
  const abort = new AbortController();
  let stopping = false;
  const stop = () => {
    stopping = true;
    abort.abort();
    void jobs.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("Hibiki worker готов");
  try {
    while (!stopping) {
      try {
        const worked = await jobs.runOnce();
        if (!worked) await setTimeout(750, undefined, { signal: abort.signal });
      } catch (error) {
        if (stopping) break;
        console.error(
          "Ошибка worker:",
          error instanceof Error ? error.message : String(error),
        );
        await setTimeout(1500, undefined, { signal: abort.signal }).catch(
          () => {},
        );
      }
    }
  } finally {
    await jobs.stop();
    await db.$disconnect();
  }
}
