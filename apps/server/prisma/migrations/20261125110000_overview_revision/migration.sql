ALTER TABLE "User" ADD COLUMN "overviewRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER overview_Job_insert AFTER INSERT ON "Job"
BEGIN
  UPDATE "User" SET overviewRevision = overviewRevision + 1 WHERE id = NEW.ownerId;
END;

CREATE TRIGGER overview_Job_update AFTER UPDATE ON "Job" WHEN NEW.kind IS NOT OLD.kind OR NEW.state IS NOT OLD.state OR NEW.progress IS NOT OLD.progress OR NEW.completed IS NOT OLD.completed OR NEW.total IS NOT OLD.total OR NEW.attempt IS NOT OLD.attempt OR NEW.error IS NOT OLD.error OR NEW.resultJson IS NOT OLD.resultJson OR NEW.updatedAt IS NOT OLD.updatedAt OR NEW.ownerId IS NOT OLD.ownerId
BEGIN
  UPDATE "User" SET overviewRevision = overviewRevision + 1 WHERE id IN (NEW.ownerId, OLD.ownerId);
END;

CREATE TRIGGER overview_Job_delete AFTER DELETE ON "Job"
BEGIN
  UPDATE "User" SET overviewRevision = overviewRevision + 1 WHERE id = OLD.ownerId;
END;

CREATE TRIGGER overview_Playlist_insert AFTER INSERT ON "Playlist"
BEGIN
  UPDATE "User" SET overviewRevision = overviewRevision + 1 WHERE id = NEW.ownerId;
END;

CREATE TRIGGER overview_Playlist_update AFTER UPDATE ON "Playlist" WHEN NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description OR NEW.definitionJson IS NOT OLD.definitionJson OR NEW.revision IS NOT OLD.revision OR NEW.manual IS NOT OLD.manual OR NEW.trackCount IS NOT OLD.trackCount OR NEW.coverUrlsJson IS NOT OLD.coverUrlsJson OR NEW.updatedAt IS NOT OLD.updatedAt OR NEW.ownerId IS NOT OLD.ownerId
BEGIN
  UPDATE "User" SET overviewRevision = overviewRevision + 1 WHERE id IN (NEW.ownerId, OLD.ownerId);
END;

CREATE TRIGGER overview_Playlist_delete AFTER DELETE ON "Playlist"
BEGIN
  UPDATE "User" SET overviewRevision = overviewRevision + 1 WHERE id = OLD.ownerId;
END;

CREATE TRIGGER overview_YoutubeLink_insert AFTER INSERT ON "YoutubeLink"
BEGIN
  UPDATE "User" SET overviewRevision = overviewRevision + 1 WHERE id = NEW.ownerId;
END;

CREATE TRIGGER overview_YoutubeLink_update AFTER UPDATE ON "YoutubeLink" WHEN NEW.playlistId IS NOT OLD.playlistId OR NEW.ownerId IS NOT OLD.ownerId
BEGIN
  UPDATE "User" SET overviewRevision = overviewRevision + 1 WHERE id IN (NEW.ownerId, OLD.ownerId);
END;

CREATE TRIGGER overview_YoutubeLink_delete AFTER DELETE ON "YoutubeLink"
BEGIN
  UPDATE "User" SET overviewRevision = overviewRevision + 1 WHERE id = OLD.ownerId;
END;
