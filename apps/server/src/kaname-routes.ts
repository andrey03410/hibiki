import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as oidc from "openid-client";
import { z } from "zod";
import { type Access, centralAccess, env, kanameEnabled, markActivity, reportAuthorized, usage } from "./kaname";
import { HttpError, invariant } from "./errors";
import type { Db } from "./db";
import type { AuthService } from "./auth";
declare module "fastify" {
  interface FastifyRequest { access: Access | null }
}
export function registerKaname(app: FastifyInstance, db: Db, auth: AuthService,
  setSession: (reply: FastifyReply, id: string, kaname?: boolean) => Promise<void>) {
  if (!kanameEnabled()) return;
  const pending = new Map<string, { state: string; nonce: string; verifier: string; next: string; expires: number }>();
  let discovered: Promise<oidc.Configuration> | undefined;
  const config = () => {
    if (!discovered) {
      const issuer = new URL(env("KANAME_OIDC_ISSUER"));
      const executions = [oidc.enableNonRepudiationChecks];
      if (issuer.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(issuer.hostname)) executions.push(oidc.allowInsecureRequests);
      discovered = oidc.discovery(issuer, env("KANAME_OIDC_CLIENT_ID"), env("KANAME_OIDC_CLIENT_SECRET"), undefined,
        { execute: executions, timeout: 5 }).catch(() => {
          discovered = undefined;
          throw new HttpError(503, "oidc_discovery", "Служба входа недоступна");
        });
    }
    return discovered;
  };
  const callback = () => new URL("/api/auth/kaname/callback", env("KANAME_SITE_URL"));
  const cookie = () => ({ path: "/api/auth/kaname", httpOnly: true, sameSite: "lax" as const, secure: callback().protocol === "https:", maxAge: 300 });
  app.get("/api/auth/kaname/login", async (req, reply) => {
    const client = await config();
    for (const [id, value] of pending) if (value.expires < Date.now()) pending.delete(id);
    invariant(pending.size < 5000, 429, "login_busy", "Слишком много попыток входа");
    const id = randomBytes(32).toString("base64url");
    const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
    const url = oidc.buildAuthorizationUrl(client, { redirect_uri: callback().href, scope: "openid profile",
      state, nonce, code_challenge_method: "S256", code_challenge: await oidc.calculatePKCECodeChallenge(verifier) });
    const { next } = z.object({ next: z.enum(["/", "/admin", "/settings"]).default("/") }).parse(req.query);
    pending.set(id, { state, nonce, verifier, next, expires: Date.now() + 300_000 });
    return reply.header("cache-control", "no-store").setCookie("hibiki_oidc", id, cookie()).redirect(url.href);
  });
  app.get("/api/auth/kaname/callback", async (req, reply) => {
    const id = req.cookies.hibiki_oidc ?? "";
    const attempt = pending.get(id);
    pending.delete(id);
    reply.clearCookie("hibiki_oidc", cookie()).header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    invariant(attempt && attempt.expires >= Date.now(), 400, "oidc_attempt", "Начните вход заново");
    const current = callback();
    current.search = new URL(req.url, current).search;
    const client = await config();
    const tokens = await oidc.authorizationCodeGrant(client, current, {
      expectedState: attempt.state, expectedNonce: attempt.nonce, pkceCodeVerifier: attempt.verifier, idTokenExpected: true,
    }).catch(() => { throw new HttpError(401, "oidc_failed", "Не удалось подтвердить вход"); });
    const subject = tokens.claims()?.sub;
    invariant(subject, 401, "oidc_subject", "Не удалось подтвердить профиль");
    const access = await centralAccess(subject);
    const user = await auth.federatedUser(access);
    invariant(!user.suspended, 403, "kaname_denied", "Доступ к Hibiki закрыт");
    await setSession(reply, user.id, true);
    await markActivity(db, user.id);
    return reply.redirect(attempt.next);
  });
  app.get("/internal/kaname/v1/usage/:subject", async (request, reply) => {
    invariant(reportAuthorized(request.headers.authorization), 401, "report_token", "Требуется ключ отчётов");
    const { subject } = z.object({ subject: z.string().min(1).max(255) }).parse(request.params);
    const account = await db.user.findUnique({ where: { kanameIssuer_kanameSubject: { kanameIssuer: env("KANAME_OIDC_ISSUER"), kanameSubject: subject } } });
    reply.header("cache-control", "no-store");
    return usage(db, account?.id);
  });
  app.get("/api/kaname/account", async (req) => ({
    role: req.access!.role, limits: req.access!.limits, usage: await usage(db, req.user!.id), portal: env("KANAME_PUBLIC_URL"),
  }));
  function admin(req: FastifyRequest) {
    invariant(req.access?.role === "admin" || req.access?.role === "overlord", 403, "forbidden", "Требуются права администратора Hibiki");
    invariant(!req.headers.authorization, 403, "browser_only", "Управление площадкой доступно в браузере");
  }
  async function canModerate(req: FastifyRequest, targetId: string) {
    admin(req);
    invariant(targetId !== req.user!.id, 409, "self_moderation", "Выберите другой аккаунт");
    const target = await db.user.findFirst({ where: { id: targetId, kanameIssuer: env("KANAME_OIDC_ISSUER") } });
    invariant(target?.kanameSubject, 404, "user_not_found", "Профиль не найден");
    invariant(target.kanameSubject !== env("KANAME_OWNER_SUBJECT"), 403, "owner_protected", "Профиль владельца защищён");
    if (req.access!.role !== "overlord")
      invariant((await centralAccess(target.kanameSubject)).role === "user", 403, "role_protected", "Управлять администраторами может владелец");
  }
  app.get("/api/kaname/admin", async req => {
    admin(req);
    const users = await db.user.findMany({ where: { kanameIssuer: env("KANAME_OIDC_ISSUER") },
      orderBy: { login: "asc" }, select: { id: true, login: true, suspended: true, _count: { select: { items: true, jobs: true } } } });
    const jobs = await db.job.findMany({ orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, ownerId: true, owner: { select: { login: true } }, kind: true, state: true } });
    return { users, jobs };
  });
  app.patch("/api/kaname/admin/users/:id", async req => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { suspended } = z.object({ suspended: z.boolean() }).strict().parse(req.body);
    await canModerate(req, id);
    await db.user.update({ where: { id }, data: { suspended } });
    return { ok: true };
  });
  app.post("/api/kaname/admin/jobs/:id/cancel", async req => {
    admin(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const job = await db.job.findUnique({ where: { id }, select: { ownerId: true } });
    invariant(job, 404, "job_not_found", "Задание не найдено");
    if (job.ownerId !== req.user!.id) await canModerate(req, job.ownerId);
    await app.jobs.cancel(job.ownerId, id, true);
    return { ok: true };
  });
}
