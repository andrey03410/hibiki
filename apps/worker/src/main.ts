import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { pruneArtworkCache } from "../../server/src/artwork.js";
import { createDb } from "../../server/src/db.js";
import { LibraryService } from "../../server/src/library.js";
import { JobsService } from "../../server/src/jobs.js";
import { YoutubeSyncService } from "../../server/src/youtube-sync.js";
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
} else if (process.argv.includes("--backfill-playback")) {
  const db = createDb(storageRoot);
  try {
    const jobs = new JobsService(db, new LibraryService(db, storageRoot), storageRoot);
    console.log(JSON.stringify(await jobs.backfillPlayback()));
  } finally { await db.$disconnect(); }
} else {
  const db = createDb(storageRoot);
  const library = new LibraryService(db, storageRoot);
  const jobs = new JobsService(db, library, storageRoot);
  const abort = new AbortController();
  const youtubeSync = new YoutubeSyncService(db);
  let stopping = false;
  const stop = () => {
    stopping = true;
    abort.abort();
    void jobs.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("Hibiki worker готов");
  const playback = jobs.backfillPlayback(abort.signal).then(result => {
    if (result.updated || result.skipped) console.log("Подсказки воспроизведения:", result);
  }).catch((error: unknown) => {
    if (!abort.signal.aborted) console.error("Ошибка заполнения подсказок воспроизведения:", error);
  });
  const artworkCleanup = (async () => {
    while (!abort.signal.aborted) {
      try { await pruneArtworkCache(db, storageRoot); }
      catch (error) { if (!abort.signal.aborted) console.error("Ошибка очистки обложек:", error); }
      await setTimeout(24 * 60 * 60_000, undefined, { signal: abort.signal }).catch(() => {});
    }
  })();
  const audioTracks = library.backfillAudioTracks(abort.signal).catch((error: unknown) => {
    if (abort.signal.aborted) return;
    console.error(
      "Ошибка проверки звуковых дорожек:",
      error instanceof Error ? error.message : String(error),
    );
  });
  const playlistCounts = (async () => {
    while (!abort.signal.aborted) {
      try {
        if (await library.refreshDuePlaylistCounts(new Date(), abort.signal)) continue;
      } catch (error) {
        if (abort.signal.aborted) break;
        console.error("Ошибка обновления числа записей:", error instanceof Error ? error.message : String(error));
      }
      await setTimeout(3000, undefined, { signal: abort.signal }).catch(() => {});
    }
  })();
  const syncChecks = (async () => {
    while (!abort.signal.aborted) {
      try {
        if (await youtubeSync.runDue(abort.signal)) continue;
      } catch (error) {
        if (abort.signal.aborted) break;
        console.error(
          "Ошибка синхронизации YouTube:",
          error instanceof Error ? error.message : String(error),
        );
      }
      await setTimeout(60_000, undefined, { signal: abort.signal }).catch(
        () => {},
      );
    }
  })();
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
    abort.abort();
    await Promise.all([jobs.stop(), syncChecks, audioTracks, playback, artworkCleanup, playlistCounts]);
    await db.$disconnect();
  }
}
