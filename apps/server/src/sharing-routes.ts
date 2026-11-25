import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { artworkQuery, ArtworkService } from "./artwork";
import { sendMediaFile } from "./media-response";
import { canRunHeavy } from "./kaname";
import { storagePath } from "./media";
import type { ShareService, SharedMediaRef } from "./sharing";

const id = z.string().min(1).max(256);
const token = z.string().regex(/^[\w-]{43}$/);
const expiresAt = z.iso.datetime({ offset: true }).nullable();
const target = z.strictObject({ kind: z.enum(["item", "playlist"]), targetId: id, expiresAt: expiresAt.optional() });
const expiry = z.strictObject({ expiresAt });
const item = z.strictObject({ itemId: id });
const optionalItem = item.partial();
const idParam = z.object({ id });
const tokenParam = z.object({ token });
const sharedItem = z.object({ token, itemId: id });
const savedPlaylistItem = z.object({ id, itemId: id });
const sourceParam = z.object({ source: token });

function sharedResponse(reply: FastifyReply) {
  return reply.header("cache-control", "private, no-store")
    .header("vary", "Cookie, Authorization")
    .header("x-content-type-options", "nosniff");
}

export function registerSharing(app: FastifyInstance, sharing: ShareService, storageRoot: string) {
  const artwork = new ArtworkService(app.library.db, storageRoot);

  app.post("/api/share-links", (request, reply) => {
    sharedResponse(reply);
    const { kind, targetId, expiresAt: until } = target.parse(request.body);
    return sharing.create(request.user!.id, kind, targetId, until);
  });
  app.get("/api/share-links", async (request, reply) => {
    sharedResponse(reply);
    return { links: await sharing.list(request.user!.id) };
  });
  app.get("/api/share-links/:id", (request, reply) => {
    sharedResponse(reply);
    return sharing.get(request.user!.id, idParam.parse(request.params).id);
  });
  app.patch("/api/share-links/:id", (request, reply) => {
    sharedResponse(reply);
    return sharing.setExpiry(request.user!.id, idParam.parse(request.params).id, expiry.parse(request.body).expiresAt);
  });
  app.delete("/api/share-links/:id", async (request, reply) => {
    sharedResponse(reply);
    await sharing.revoke(request.user!.id, idParam.parse(request.params).id);
    return { ok: true };
  });
  app.get("/api/shared/:token", (request, reply) => {
    sharedResponse(reply);
    return sharing.open(request.user!.id, tokenParam.parse(request.params).token);
  });
  app.post("/api/shared/:token/save", (request, reply) => {
    sharedResponse(reply);
    return sharing.save(
      request.user!.id,
      tokenParam.parse(request.params).token,
      optionalItem.parse(request.body ?? {}).itemId,
    );
  });
  app.get("/api/shared-playlists", async (request, reply) => {
    sharedResponse(reply);
    return { playlists: await sharing.listSaved(request.user!.id) };
  });
  app.get("/api/shared-playlists/:id", (request, reply) => {
    sharedResponse(reply);
    return sharing.openSaved(request.user!.id, idParam.parse(request.params).id);
  });
  app.post("/api/shared-playlists/:id/save", (request, reply) => {
    sharedResponse(reply);
    return sharing.saveFromSaved(request.user!.id, idParam.parse(request.params).id, item.parse(request.body).itemId);
  });
  app.delete("/api/shared-playlists/:id", async (request, reply) => {
    sharedResponse(reply);
    await sharing.removeSaved(request.user!.id, idParam.parse(request.params).id);
    return { ok: true };
  });

  const registerMedia = (prefix: string, ref: (params: unknown) => SharedMediaRef) => {
    for (const audio of [false, true]) {
      app.route({
        method: ["GET", "HEAD"],
        url: prefix + "/sources/:source" + (audio ? "/audio" : ""),
        async handler(request, reply) {
          sharedResponse(reply);
          const key = sourceParam.parse(request.params).source;
          const file = await sharing.file(request.user!.id, ref(request.params), key);
          return sendMediaFile(request, reply, storagePath(storageRoot, file.path), file, audio, key);
        },
      });
    }
    app.get(prefix + "/artwork", async (request, reply) => {
      sharedResponse(reply);
      const { size } = artworkQuery.parse(request.query);
      const origin = await sharing.artworkOrigin(request.user!.id, ref(request.params));
      const cover = await artwork.get(origin.ownerId, origin.itemId, canRunHeavy(request.access) ? size : undefined);
      return reply.type(cover.mime).send(cover.bytes);
    });
  };
  registerMedia("/api/shared/:token/items/:itemId", params => ({ kind: "link", ...sharedItem.parse(params) }));
  registerMedia("/api/shared-playlists/:id/items/:itemId", params => ({ kind: "playlist", ...savedPlaylistItem.parse(params) }));
  registerMedia("/api/shared-items/:id", params => ({ kind: "item", ...idParam.parse(params) }));
}
