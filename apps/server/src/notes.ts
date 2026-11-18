import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db";
import { invariant } from "./errors";

const id = z.string().min(1).max(256);
const noteTarget = z.object({ type: z.enum(["item", "source", "playlist", "tag"]), id });
const noteInput = z.object({ text: z.string().max(4000).nullable() }).strict();
const favoriteInput = z.object({ favorite: z.boolean() }).strict();

export function registerNotes(app: FastifyInstance, db: Db) {
  function browserOwner(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "private, no-store");
    invariant(!request.headers.authorization, 403, "browser_session_required", "Войдите в Hibiki через браузер");
    invariant(request.user && request.cookies.hibiki_session, 401, "unauthorized", "Войдите в Hibiki");
    return request.user.id;
  }

  app.get("/api/notes", async (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const where = { ownerId, note: { not: null } };
    const select = { id: true, note: true } as const;
    const [item, source, playlist, tag] = await Promise.all([
      db.item.findMany({ where, select }),
      db.source.findMany({ where: { ...where, item: { ownerId } }, select }),
      db.playlist.findMany({ where, select }),
      db.tag.findMany({ where, select }),
    ]);
    const index = (rows: { id: string; note: string | null }[]) =>
      Object.fromEntries(rows.flatMap(({ id, note }) => note?.trim() ? [[id, note]] : []));
    return { item: index(item), source: index(source), playlist: index(playlist), tag: index(tag) };
  });

  app.put("/api/notes/:type/:id", async (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const target = noteTarget.parse(request.params);
    const { text } = noteInput.parse(request.body);
    const note = text?.trim() ? text : null;
    const update = { where: { id: target.id, ownerId }, data: { note } };
    const write = {
      item: () => db.item.updateMany(update),
      source: () => db.source.updateMany({ ...update, where: { ...update.where, item: { ownerId } } }),
      playlist: () => db.playlist.updateMany(update),
      tag: () => db.tag.updateMany(update),
    }[target.type];
    const result = await write();
    invariant(result.count === 1, 404, "not_found", "Объект заметки не найден");
    return { text: note };
  });

  app.patch("/api/items/:id/favorite", async (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const target = z.object({ id }).parse(request.params);
    const { favorite } = favoriteInput.parse(request.body);
    const result = await db.item.updateMany({ where: { id: target.id, ownerId }, data: { favorite } });
    invariant(result.count === 1, 404, "not_found", "Запись не найдена");
    return { favorite };
  });
}
