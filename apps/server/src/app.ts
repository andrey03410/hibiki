import { discardReservation } from "./storage-writer";
import { accountStorage } from "./account-storage";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve, join, extname, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import type { UserDto } from "@hibiki/contracts";
import { librarySearchSchema, itemPatchSchema, playlistDefinitionSchema, tagInputSchema } from "@hibiki/contracts";
import type { Db } from "./db";
import { canRunHeavy, env, kanameEnabled, markActivity, meterStorage, ownerAccess, requireHeavy } from "./kaname";
import { registerKaname } from "./kaname-routes";
import { AuthService } from "./auth";
import { hydrateLibraryItems, LibraryService } from "./library";
import { JobsService } from "./jobs";
import { HttpError, invariant } from "./errors";
import { allowedLocalPath, storagePath } from "./media";
import { sendMediaFile } from "./media-response";
import { registerMcp } from "./mcp";
import { uploadPolicy } from "./upload-policy";
import { artworkQuery, ArtworkService } from "./artwork";
import { browserOwner, registerNotes } from "./notes";
import { registerClassification } from "./classification";
import { registerLibraryPages, searchLibraryIds } from "./library-pages";
import { registerReplacement } from "./replacement";
import { registerHistory } from "./history";
import { registerYoutubeSync } from "./youtube-sync";
import { ShareService } from "./sharing";
import { registerVisuals } from "./visual-routes";
import { registerSharing } from "./sharing-routes";

declare module "fastify" {
  interface FastifyRequest {
    user: UserDto | null;
  }
  interface FastifyInstance {
    auth: AuthService;
    library: LibraryService;
    jobs: JobsService;
    sharing: ShareService;
  }
}
export interface UploadGrant {
  ownerId: string;
  expires: number;
  archive: boolean;
}
export interface Services {
  db: Db;
  auth: AuthService;
  library: LibraryService;
  jobs: JobsService;
  sharing: ShareService;
  storageRoot: string;
  uploadGrants: Map<string, UploadGrant>;
}
const playlistInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    definition: playlistDefinitionSchema,
  })
  .strict();
const idOf = (request: { params: unknown }) =>
  z.object({ id: z.string() }).parse(request.params).id;
const browserAccess = (request: FastifyRequest) =>
  Boolean(request.user && !request.headers.authorization && request.cookies.hibiki_session);

export async function createApp(options: { db: Db; storageRoot: string; webRoot?: string }) {
  const { db, storageRoot } = options;
  const auth = new AuthService(db);
  const library = new LibraryService(db, storageRoot);
  const artwork = new ArtworkService(db, storageRoot);
  const jobs = new JobsService(db, library, storageRoot);
  const sharing = new ShareService(db, library);
  const s: Services = {
    db,
    auth,
    library,
    jobs,
    sharing,
    storageRoot,
    uploadGrants: new Map(),
  };
  const app = Object.assign(
    Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 0 }),
    { auth, library, jobs, sharing },
  );
  app.decorateRequest("user", null);
  app.decorateRequest("access", null);
  await app.register(cookie);
  await app.register(multipart, uploadPolicy(false));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: "validation",
          message: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
      });
    if (error instanceof HttpError)
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message } });
    const e = error as { code?: string; statusCode?: number; message: string };
    if (e.code === "P2002")
      return reply.code(409).send({
        error: { code: "conflict", message: "Такая запись уже существует" },
      });
    const status =
      e.statusCode && e.statusCode >= 400 && e.statusCode < 500
        ? e.statusCode
        : /not found|не найден/i.test(e.message)
          ? 404
          : 400;
    return reply.code(status).send({
      error: {
        code: e.code ?? "operation_failed",
        message: e.message.slice(0, 1000),
      },
    });
  });
  app.addHook("onRequest", async (request) => {
    const origin = request.headers.origin;
    if (
      origin &&
      (request.url.startsWith("/mcp") ||
        !["GET", "HEAD", "OPTIONS"].includes(request.method))
    ) {
      const allowed = new Set([
        process.env.KANAME_SITE_URL ?? process.env.PUBLIC_URL ?? "http://localhost:8790",
        "http://localhost:5174",
        "http://127.0.0.1:8790",
        "http://127.0.0.1:5174",
      ]);
      invariant(
        allowed.has(origin),
        403,
        "origin_forbidden",
        "Запрос с этого сайта запрещён",
      );
    }
    if (!request.url.startsWith("/api/") && !request.url.startsWith("/files/"))
      return;
    if (["/api/auth/kaname/login", "/api/auth/kaname/callback", "/api/auth/logout"].includes(request.url.split("?")[0])) return;
    const header = request.headers.authorization;
    request.user = header?.startsWith("Bearer ")
      ? await auth.userByToken(header.slice(7))
      : await auth.userBySession(request.cookies.hibiki_session);
    if (request.user && kanameEnabled()) {
      request.access = await ownerAccess(db, request.user.id);
      const path = request.url.split("?")[0];
      const sharedStream = /^\/api\/(?:shared(?:-items|-playlists)?|items)\/.*\/(?:sources|sound|visual)\//.test(path);
      const libraryReading = /^\/api\/(library(?:\/(?:page|ids))?|items(?:\/[^/]+)?|playlists\/(?:preview|[^/]+\/(?:playback|resolve|detail|rows)))$/.test(path);
      if (libraryReading) await sharing.prefetchForViewer(request.user.id);
      if (path.startsWith("/files/") || sharedStream || path === "/api/settings" || !["GET", "HEAD", "OPTIONS"].includes(request.method))
        await markActivity(db, request.user.id);
    }
    const workspace = request.headers["x-hibiki-workspace"];
    if (workspace !== undefined && workspace !== request.user?.id) {
      throw new HttpError(409, "workspace_changed", "Аккаунт изменился. Открываем его медиатеку.");
    }
    const publicRoute =
      request.url.split("?")[0] === "/api/me" ||
      request.url.startsWith("/api/auth/") ||
      request.url.startsWith("/api/uploads/");
    if (!publicRoute)
      invariant(request.user, 401, "unauthorized", "Войдите в Hibiki");
  });
  const setSession = async (reply: any, userId: string, kaname = false) => {
    const secret = await auth.createSession(userId, kaname);
    reply.setCookie("hibiki_session", secret, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: (kaname ? env("KANAME_SITE_URL") : process.env.PUBLIC_URL ?? "").startsWith("https:"),
      maxAge: 30 * 86400,
    });
  };
  registerKaname(app, db, auth, setSession);
  app.get("/api/me", async (request) => ({
    user: request.user,
    setupRequired: !kanameEnabled() && (await db.user.count()) === 0,
    ...(kanameEnabled() ? { kanameEnabled: true } : {}),
  }));
  for (const action of ["register", "login"] as const)
    app.post(`/api/auth/${action}`, async (request, reply) => {
      if (action === "register" && process.env.PROVISIONED_ACCOUNTS_ONLY === "1")
        throw new HttpError(403, "registration_closed", "Аккаунты создаёт администратор");
      const input = z
        .object({ login: z.string().max(100), password: z.string().max(200) })
        .parse(request.body);
      const user = await auth[action](input.login, input.password);
      await setSession(reply, user.id);
      return { user };
    });
  app.post("/api/auth/logout", async (request, reply) => {
    await auth.logout(request.cookies.hibiki_session);
    reply.clearCookie("hibiki_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/library", (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return library.snapshot(request.user!.id, browserAccess(request));
  });
  app.get("/api/items", async (request) => {
    const query = z
      .object({
        query: z.string().optional(),
        tagId: z.string().optional(),
        kind: z.enum(["audio", "video"]).optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);
    const ownerId = request.user!.id;
    const filters = librarySearchSchema.parse({query: query.query, kind: query.kind, tagIds: query.tagId ? [query.tagId] : []});
    return db.$transaction(async tx => {
      let ids = await searchLibraryIds(tx, ownerId, filters, library, undefined, browserAccess(request));
      if (query.cursor) {
        const index = ids.indexOf(query.cursor);
        invariant(index >= 0, 400, "cursor", "Курсор не найден");
        ids = ids.slice(index + 1);
      }
      const page = ids.slice(0, query.limit);
      return {
        items: await hydrateLibraryItems(tx, ownerId, page, true, library),
        nextCursor: ids.length > page.length ? page.at(-1) : null,
      };
    });
  });
  app.get("/api/items/:id", (request) =>
    library.getItem(request.user!.id, idOf(request), true),
  );
  app.post("/api/items/:id/shared-copy", (request) => {
    const options = z.object({ mode: z.enum(["audio", "video"]).optional() }).strict().parse(request.body ?? {});
    return jobs.create(request.user!.id, "shared-copy", { itemId: idOf(request), ...options });
  });
  app.get("/api/items/:id/artwork", async (request, reply) => {
    reply
      .header("cache-control", "private, no-cache")
      .header("vary", "Cookie, Authorization")
      .header("x-content-type-options", "nosniff");
    const { size, v } = artworkQuery.parse(request.query);
    const thumbnail = canRunHeavy(request.access) ? size : undefined;
    const cover = await artwork.get(request.user!.id, idOf(request), thumbnail);
    if (v && v === cover.version) reply.header("cache-control", "private, max-age=31536000, immutable");
    if (cover.etag) {
      reply.header("etag", cover.etag);
      const validators = request.headers["if-none-match"]?.split(",").map(tag => tag.trim().replace(/^W\//, ""));
      if (validators?.includes("*") || validators?.includes(cover.etag)) return reply.code(304).send();
    }
    return reply.type(cover.mime).send(cover.bytes);
  });
  app.patch("/api/items/:id", (request) =>
    library.updateItem(
      request.user!.id,
      idOf(request),
      itemPatchSchema.parse(request.body),
    ),
  );
  app.post("/api/items/batch", { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    const { changes, expectedRevision } = z.object({
      changes: z.array(itemPatchSchema.extend({ id: z.string().min(1).max(256) })).max(10_000),
      expectedRevision: z.string().regex(/^\d+$/).optional(),
    }).parse(request.body);
    return { items: await library.updateItems(request.user!.id, changes, expectedRevision) };
  });
  app.delete("/api/items/:id", async (request) => {
    await library.deleteItem(request.user!.id, idOf(request));
    return { ok: true };
  });
  app.post("/api/items/import-local", async (request) => {
    requireHeavy(request.access);
    const { paths } = z
      .object({ paths: z.array(z.string()).min(1).max(50) })
      .parse(request.body);
    const items = [];
    for (const path of paths)
      items.push(
        (
          await library.importLocal(
            request.user!.id,
            await allowedLocalPath(path),
          )
        ).item,
      );
    return { items };
  });
  const receiveUpload = async (
    request: any,
    ownerId: string,
    archive = false,
  ) => {
    const access = await ownerAccess(db, ownerId);
    const dir = join(storageRoot, "uploads", ownerId);
    await mkdir(dir, { recursive: true });
    const items = [];
    let archiveJob;
    for await (const part of request.parts(uploadPolicy(archive))) {
      if (part.type !== "file") continue;
      const filename =
        basename(part.filename.replaceAll("\\", "/"))
          .replace(/[\x00-\x1f\x7f]/g, "_")
          .slice(-240) || "upload";
      const ext = extname(filename).toLowerCase();
      invariant(
        !archive || ext === ".zip",
        400,
        "archive_required",
        "Выберите архив .zip библиотеки Hibiki",
      );
      const hold = "upload-" + randomUUID();
      const temporaryDir = join(dir, hold);
      await mkdir(temporaryDir);
      const tmp = join(temporaryDir, filename);
      try {
        await pipeline(part.file, meterStorage(db, ownerId, access, hold, temporaryDir), createWriteStream(tmp, { flags: "wx" }));
        invariant(
          !part.file.truncated,
          413,
          "file_too_large",
          archive ? "Архив превышает 20 ГиБ" : "Файл превышает 2 ГиБ",
        );
        if (archive) {
          invariant(!archiveJob, 400, "one_archive", "Загрузите один архив");
          archiveJob = await jobs.create(ownerId, "import", {
            archivePath: tmp,
          }, browserAccess(request), hold);
        } else
          items.push(
            (await library.importLocal(ownerId, tmp, { uploadReservation: hold }))
              .item,
          );
      } finally {
        try {
          await rm(temporaryDir, { recursive: true, force: true });
        } finally {
          // A failed ZIP handoff may have moved the upload into its job directory.
          await discardReservation(db, ownerId, hold);
        }
      }
    }
    invariant(
      archive ? archiveJob : items.length,
      400,
      "file_required",
      "Выберите файл",
    );
    return archive ? archiveJob : { items };
  };
  app.post("/api/items/upload", (request) =>
    receiveUpload(request, request.user!.id),
  );
  app.get("/api/storage", (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return accountStorage(jobs, request.user!.id, request.access?.limits.storageBytes ?? null);
  });
  app.post("/api/storage/cleanup", (request) => {
    z.object({ confirm: z.literal(true) }).strict().parse(request.body);
    return jobs.cleanupArchives(request.user!.id);
  });
  app.post("/api/imports/upload", (request) =>
    receiveUpload(request, request.user!.id, true),
  );
  app.post("/api/imports/:id/apply", (request) =>
    jobs.applyImport(request.user!.id, idOf(request), browserAccess(request)),
  );
  app.post("/api/uploads/:id", async (request) => {
    const id = idOf(request);
    const grant = s.uploadGrants.get(id);
    s.uploadGrants.delete(id);
    invariant(
      grant && grant.expires > Date.now(),
      401,
      "upload_expired",
      "Ссылка загрузки истекла",
    );
    await ownerAccess(db, grant.ownerId);
    return receiveUpload(request, grant.ownerId, grant.archive);
  });
  app.get("/api/tags", async (request) => ({
    tags: await library.listTags(request.user!.id),
  }));
  app.post("/api/tags", (request) =>
    library.createTag(request.user!.id, tagInputSchema.parse(request.body)),
  );
  app.patch("/api/tags/:id", (request) =>
    library.updateTag(
      request.user!.id,
      idOf(request),
      tagInputSchema.partial().parse(request.body),
    ),
  );
  app.delete("/api/tags/:id", async (request) => {
    await library.deleteTag(request.user!.id, idOf(request));
    return { ok: true };
  });
  app.get("/api/playlists", async (request) => ({
    playlists: await library.listPlaylists(request.user!.id),
  }));
  app.post("/api/playlists/preview", (request, reply) => {
    const input = z
      .object({
        definition: playlistDefinitionSchema,
        playlistId: z.string().optional(),
        cards: z.boolean().optional(),
      })
      .parse(request.body);
    if (input.cards) return library.previewCards(browserOwner(request, reply), input.definition, input.playlistId);
    return library.preview(
      request.user!.id,
      input.definition,
      input.playlistId,
      browserAccess(request),
    );
  });
  app.post("/api/playlists", (request) =>
    library.savePlaylist(request.user!.id, playlistInput.parse(request.body), undefined, browserAccess(request)),
  );
  app.patch("/api/playlists/:id", (request) =>
    library.savePlaylist(
      request.user!.id,
      playlistInput.parse(request.body),
      idOf(request),
      browserAccess(request),
    ),
  );
  app.get("/api/playlists/:id/playback", (request, reply) =>
    library.playlistPlayback(browserOwner(request, reply), idOf(request)),
  );
  app.get("/api/playlists/:id", (request, reply) =>
    library.getPlaylist(browserOwner(request, reply), idOf(request)),
  );
  app.get("/api/playlists/:id/detail", (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const { limit } = z.object({ limit: z.coerce.number().int().positive().default(24) }).parse(request.query);
    return library.playlistDetail(ownerId, idOf(request), true, limit);
  });
  app.post("/api/playlists/:id/rows", (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const { offset, changeToken, validUntil } = z.object({
      offset: z.number().int().nonnegative(), changeToken: z.string().min(1), validUntil: z.number().int().nullable(),
    }).parse(request.body);
    return library.playlistRows(ownerId, idOf(request), offset, changeToken, validUntil);
  });
  app.get("/api/playlists/:id/exclusions", (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const { offset } = z.object({ offset: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
    return library.playlistExclusions(ownerId, idOf(request), offset);
  });
  app.get("/api/playlists/:id/resolve", (request) =>
    library.resolve(request.user!.id, idOf(request), browserAccess(request)),
  );
  app.delete("/api/playlists/:id", async (request) => {
    await library.deletePlaylist(request.user!.id, idOf(request));
    return { ok: true };
  });
  app.get<{ Querystring: {active?: string} }>("/api/jobs", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return { jobs: await jobs.list(request.user!.id, browserAccess(request), request.query.active === "1") };
  });
  app.post("/api/jobs", (request) => {
    const input = z
      .object({
        kind: z.enum([
          "youtube-import",
          "youtube-download",
          "youtube-refresh",
          "export",
        ]),
        input: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(request.body);
    return jobs.create(request.user!.id, input.kind, input.input, browserAccess(request));
  });
  app.get("/api/jobs/:id", (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return jobs.get(request.user!.id, idOf(request), browserAccess(request));
  });
  app.post("/api/jobs/:id/cancel", (request) =>
    jobs.cancel(request.user!.id, idOf(request), browserAccess(request)),
  );
  app.post("/api/jobs/:id/retry", (request) =>
    jobs.retry(request.user!.id, idOf(request), browserAccess(request)),
  );
  app.get("/api/jobs/:id/download", async (request, reply) => {
    const path = await jobs.exportPath(request.user!.id, idOf(request), browserAccess(request));
    reply
      .header("Cache-Control", "private, no-store")
      .header(
        "content-disposition",
        'attachment; filename="hibiki-library.zip"',
      )
      .type("application/zip");
    return reply.send(createReadStream(path));
  });
  app.get("/api/settings", (request) => library.getSettings(request.user!.id));
  app.put("/api/settings", async (request) => {
    const patch = z.record(z.string(), z.unknown()).parse(request.body);
    const saved = await library.setSettings(request.user!.id, patch);
    return (request.query as { patch?: string }).patch === "1"
      ? Object.fromEntries(Object.keys(patch).map(key => [key, saved[key]])) : saved;
  });
  app.get("/api/tokens", async (request) => ({
    tokens: await auth.listTokens(request.user!.id),
  }));
  app.post("/api/tokens", (request) =>
    auth.createToken(
      request.user!.id,
      z
        .object({ name: z.string().max(100).default("Агент") })
        .parse(request.body).name,
    ),
  );
  app.delete("/api/tokens/:id", async (request) => {
    await auth.deleteToken(request.user!.id, idOf(request));
    return { ok: true };
  });
  for (const audio of [false, true]) {
    app.route({
      method: ["GET", "HEAD"],
      url: audio ? "/files/:id/audio" : "/files/:id",
      async handler(request, reply) {
        const file = await db.mediaFile.findFirst({
          where: { id: idOf(request), ownerId: request.user!.id },
        });
        invariant(file, 404, "file_not_found", "Файл не найден");
        reply.header("cache-control", kanameEnabled() ? "private, no-store" : "private, max-age=3600")
          .header("x-content-type-options", "nosniff");
        return sendMediaFile(request, reply, storagePath(storageRoot, file.path), file, audio);
      },
    });
  }
  registerNotes(app, db);
  registerLibraryPages(app, db, library);
  registerClassification(app, db);
  registerReplacement(app, db, library, storageRoot);
  registerHistory(app, db);
  registerYoutubeSync(app, db, library);
  registerSharing(app, sharing, storageRoot);
  registerVisuals(app, storageRoot);
  registerMcp(app, s);
  const webRoot = options.webRoot ?? resolve("apps/web/dist");
  if (existsSync(join(webRoot, "index.html"))) {
    await app.register(staticFiles, {
      root: webRoot, prefix: "/", cacheControl: false,
      setHeaders(response, filePath) {
        response.header("Cache-Control", filePath.startsWith(join(webRoot, "assets") + "/")
          ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !/^\/(api|files|mcp)(\/|$)/.test(request.url)
      ) {
        if (request.url.startsWith("/share/")) reply.header("referrer-policy", "strict-origin");
        return reply
          .header("Cache-Control", "no-cache")
          .type("text/html")
          .send(createReadStream(join(webRoot, "index.html")));
      }
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Не найдено" } });
    });
  }
  return app;
}
