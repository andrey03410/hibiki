import { expect, it, vi } from "vitest";
import { testContext } from "./test-utils";
import { createApp } from "./app";

it("closes password login when the installation uses Kaname", async () => {
  const ctx = await testContext();
  vi.stubEnv("KANAME_ENABLED", "1");
  const app = await createApp({ db: ctx.db, storageRoot: ctx.root });
  try {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "alice", password: "ignored" } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject("/api/me")).json().kanameEnabled).toBe(true);
  } finally { await app.close(); await ctx.close(); vi.unstubAllEnvs(); }
});

import { AuthService } from "./auth";
import { bindSubject, ownerAccess, reserve, usage } from "./kaname";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { wav } from "./test-utils";

async function fixture() {
  const ctx = await testContext();
  vi.stubEnv("KANAME_ENABLED", "1");
  vi.stubEnv("KANAME_OIDC_ISSUER", "https://issuer.example.test");
  vi.stubEnv("KANAME_URL", "https://kaname.example.test");
  vi.stubEnv("KANAME_PUBLIC_URL", "https://kaname.example.test");
  vi.stubEnv("KANAME_OWNER_SUBJECT", "owner");
  vi.stubEnv("KANAME_SERVICE_TOKEN", randomUUID());
  vi.stubEnv("KANAME_REPORT_TOKEN", randomUUID());
  const grants = new Map([
    ["alice", { role: "user", login: "alice", items: 50 as number | null, storageBytes: 1_000_000_000 }],
    ["bob", { role: "admin", login: "bob", items: null as number | null, storageBytes: 1_000_000_000 }],
    ["owner", { role: "overlord", login: "andrey", items: null as number | null, storageBytes: 1_000_000_000 }],
  ]);
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer " + process.env.KANAME_SERVICE_TOKEN);
    const subject = url.pathname.split("/").at(-1)!;
    const grant = grants.get(subject);
    if (!grant) return new Response(null, { status: 403 });
    return Response.json({ service: "hibiki", subject, login: grant.login, role: grant.role, limits: grant,
      permissions: { heavy: grant.role === "overlord" } });
  }));
  const app = await createApp({ db: ctx.db, storageRoot: ctx.root });
  const auth = new AuthService(ctx.db);
  await bindSubject(ctx.db, ctx.userId, "alice");
  await bindSubject(ctx.db, ctx.otherUserId, "bob");
  const alice = { cookie: "hibiki_session=" + await auth.createSession(ctx.userId, true) };
  const bob = { cookie: "hibiki_session=" + await auth.createSession(ctx.otherUserId, true) };
  return { ...ctx, grants, app, auth, alice, bob,
    async close() { await app.close(); await ctx.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); } };
}

it("pins the owner subject and retains the original item owner across binding", async () => {
  const f = await fixture();
  try {
    await f.db.user.create({ data: { id: "existing-owner-id", login: "andrey", passwordHash: "legacy" } });
    const item = await f.db.item.create({ data: { id: randomUUID(), ownerId: "existing-owner-id", title: "Сохранено", originalTitle: "Сохранено", kind: "audio" } });
    await expect(f.auth.federatedUser({ subject: "unknown", role: "user", login: "andrey", service: "hibiki", permissions: { heavy: false }, limits: { items: 50, storageBytes: 1e9 } })).rejects.toThrow();
    await bindSubject(f.db, "existing-owner-id", "owner");
    await bindSubject(f.db, "existing-owner-id", "owner");
    expect(await f.auth.federatedUser((await ownerAccess(f.db, "existing-owner-id"))!)).toMatchObject({ id: item.ownerId });
    expect(await f.db.item.count({ where: { ownerId: item.ownerId } })).toBe(1);
    vi.stubEnv("KANAME_ENABLED", "0");
    const legacy = await f.auth.createSession(f.userId);
    const token = await f.auth.createToken(f.userId, "старый");
    vi.stubEnv("KANAME_ENABLED", "1");
    expect(await f.auth.userBySession(legacy)).toBeNull();
    expect(await f.auth.userByToken(token.token)).toBeNull();
  } finally { await f.close(); }
});

it("checks owner, limits and revocation on uploads, media, MCP and workers", async () => {
  const f = await fixture();
  try {
    const allowed = await f.app.inject({ method: "POST", url: "/api/jobs", headers: f.alice,
      payload: { kind: "youtube-import", input: { url: "https://www.youtube.com/watch?v=abcdefghijk" } } });
    expect(allowed.statusCode).toBe(200);
    expect((await f.app.inject({ method: "POST", url: "/api/jobs", headers: f.bob,
      payload: { kind: "youtube-download", input: { itemId: "unneeded", mode: "audio" } } })).statusCode).toBe(403);
    const token = await f.auth.createToken(f.userId, "MCP");
    const filePath = path.join(f.root, "one.wav");
    await writeFile(filePath, wav());
    const result = await f.library.importLocal(f.userId, filePath);
    const fileUrl = result.item.sources[0].streamUrl!;
    expect((await f.app.inject({ url: fileUrl, headers: { ...f.alice, range: "bytes=0-3" } })).statusCode).toBe(206);
    expect((await f.app.inject({ url: fileUrl, headers: f.bob })).statusCode).toBe(404);
    expect((await usage(f.db, f.userId)).storageBytes).toBe(wav().length);
    const report = { authorization: "Bearer " + process.env.KANAME_REPORT_TOKEN };
    expect((await f.app.inject({ url: "/internal/kaname/v1/usage/alice", headers: report })).json()).toMatchObject({ activeDays30: 1, counts: { items: 1 } });
    expect((await f.app.inject({ url: "/internal/kaname/v1/usage/missing", headers: report })).json()).toMatchObject({ activeDays30: 0, lastActiveAt: null });
    expect((await f.app.inject({ url: "/internal/kaname/v1/usage/alice", headers: { authorization: "Bearer " + process.env.KANAME_SERVICE_TOKEN } })).statusCode).toBe(401);
    expect((await f.app.inject({ url: "/api/kaname/admin", headers: f.alice })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "PATCH", url: "/api/kaname/admin/users/" + f.userId, headers: f.bob, payload: { suspended: true } })).statusCode).toBe(200);
    expect((await f.app.inject({ url: fileUrl, headers: f.alice })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "PATCH", url: "/api/kaname/admin/users/" + f.userId, headers: f.bob, payload: { suspended: false } })).statusCode).toBe(200);
    f.grants.delete("alice");
    expect((await f.app.inject({ url: fileUrl, headers: f.alice })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer " + token.token }, payload: {} })).statusCode).toBe(403);
    await f.app.jobs.runOnce();
    expect(await f.db.job.findUnique({ where: { id: allowed.json().id } })).toMatchObject({ state: "failed" });
  } finally { await f.close(); }
});

it("serializes the last slot and byte reservations including cross-process writers", async () => {
  const f = await fixture();
  const { createDb } = await import("./db");
  const second = createDb(f.root, { databaseUrl: "file:" + path.join(f.root, "hibiki.db") });
  try {
    await f.db.item.createMany({ data: Array.from({ length: 49 }, (_, i) => ({
      id: "seed-" + i, ownerId: f.userId, title: "seed", originalTitle: "seed", kind: "video",
    })) });
    const results = await Promise.allSettled(["firstaaaaaa", "secondaaaaa"].map(externalId => f.library.upsertYoutube(f.userId, { externalId })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await f.db.item.count({ where: { ownerId: f.userId } })).toBe(50);
    const grant = await ownerAccess(f.db, f.userId);
    const claims = await Promise.allSettled([reserve(f.db, f.userId, 600_000_000, grant), reserve(second, f.userId, 600_000_000, grant)]);
    expect(claims.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await f.db.kanameStorage.aggregate({ _sum: { bytes: true } }))._sum.bytes).toBe(600_000_000n);
    f.grants.get("alice")!.role = "admin";
    f.grants.get("alice")!.items = null;
    await f.library.upsertYoutube(f.userId, { externalId: "thirdaaaaaa" });
    expect(await f.db.item.count({ where: { ownerId: f.userId } })).toBe(51);
  } finally { await second.$disconnect(); await f.close(); }
});
