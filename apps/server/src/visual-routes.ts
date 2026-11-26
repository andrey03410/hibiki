import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { setVisual, clearVisual, roleFile } from "./visuals";
import { sendMediaFile } from "./media-response";
import { storagePath } from "./media";

const id = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
const operation = z.strictObject({ expectedRevision: revision, operationId: id.optional() });
const assignment = operation.extend({
  visualSourceId: id,
  soundSourceId: id.optional(),
  videoStreamIndex: revision.optional(),
});
const params = z.object({ id });
export function registerVisuals(app: FastifyInstance, root: string) {
  const db = app.library.db;
  const base = "/api/items/:id";
  app.post(base + "/visual/prepare", request =>
    app.jobs.createVisualSource(request.user!.id, params.parse(request.params).id, assignment.parse(request.body)),
  );
  app.put(base + "/visual", (request) =>
    setVisual(db, root, request.user!.id, params.parse(request.params).id, assignment.parse(request.body)),
  );
  app.delete(base + "/visual", (request) =>
    clearVisual(db, root, request.user!.id, params.parse(request.params).id, operation.parse(request.body)),
  );
  for (const role of ["sound", "visual"] as const)
    app.route({
      method: ["GET", "HEAD"],
      url: base + "/" + role + "/:revision",
      async handler(request, reply) {
        const { id, revision } = params
          .extend({ revision: z.coerce.number().int().nonnegative() })
          .parse(request.params);
        const { file, view } = await roleFile(db, request.user!.id, id, revision, role);
        reply.header("cache-control", "private, no-store").header("vary", "Cookie, Authorization");
        return sendMediaFile(
          request,
          reply,
          storagePath(root, file.path),
          file,
          view,
          role + "-" + id + "-" + revision,
        );
      },
    });
}
