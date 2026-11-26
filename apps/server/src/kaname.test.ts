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
import { ArtworkService } from "./artwork";
import { bindSubject, ownerAccess, reserve, usage, markActivity, storageBreakdown } from "./kaname";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
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

it("requires fresh author access when the player refreshes borrowed sources", async () => {
  const f = await fixture();
  try {
    const { item } = await f.library.upsertYoutube(f.userId, { externalId: "abcdefghijk" });
    const issued = await f.app.sharing.create(f.userId, "item", item.id);
    const token = new URL(issued.url!).pathname.split("/").at(-1)!;
    const saved = await f.app.sharing.save(f.otherUserId, token);
    const read = (verifyShared: boolean) => f.app.inject({
      method: "POST", url: "/api/library/items", headers: f.bob, payload: { ids: [saved.id], verifyShared },
    });
    expect((await read(false)).json().items).toMatchObject([{
      shared: { available: true }, sources: [{ shared: true, provider: "youtube" }],
    }]);
    f.grants.delete("alice");
    const after = await read(true);
    expect(after.statusCode).toBe(200);
    expect(after.json().items).toMatchObject([{ shared: { available: false }, sources: [] }]);
  } finally { await f.close(); }
});

it("checks playlist cover metadata without converting thumbnails for regular Kaname members", async () => {
  const f = await fixture();
  const artwork = vi.spyOn(ArtworkService.prototype, "get");
  try {
    const file = path.join(f.root, "plain.wav");
    await writeFile(file, wav());
    const { item } = await f.library.importLocal(f.userId, file);
    const list = await f.library.savePlaylist(f.userId, { title: "Обложка", definition: {
      version: 1, sort: "source", rule: { type: "items", ids: [item.id] },
    } });
    await f.library.refreshDuePlaylistCounts();
    expect(artwork).toHaveBeenCalledExactlyOnceWith(f.userId, item.id, undefined);
    const cards = await f.app.inject({ url: "/api/library/overview?playlists=summary", headers: f.alice });
    expect(cards.json().playlists).toMatchObject([{ id: list.id, trackCount: 1, coverUrls: [] }]);
  } finally {
    artwork.mockRestore();
    await f.close();
  }
});

it("coalesces concurrent file activity per owner for a minute and writes immediately on a new UTC day", async () => {
  const ctx = await testContext();
  try {
    const recorded = async () => (await ctx.db.kanameActivity.findMany({where: {ownerId: ctx.userId}, orderBy: {day: "asc"}})).map(r => r.lastActiveAt.toISOString());
    const start = Date.parse("2026-11-24T23:58:58Z");
    const mark = (seconds: number) => markActivity(ctx.db, ctx.userId, new Date(start + seconds * 1000));
    await Promise.all([mark(0), mark(1), mark(2)]);
    expect(await recorded()).toEqual([new Date(start).toISOString()]);
    await mark(59);
    await mark(60);
    await mark(62);
    expect(await recorded()).toEqual([new Date(start + 60000).toISOString(), new Date(start + 62000).toISOString()]);
  } finally { await ctx.close(); }
});

it("keeps a staged upload charged while publishing its media copy", async () => {
  const f = await fixture();
  try {
    const data = wav();
    const file = path.join(f.root, "upload.wav");
    await writeFile(file, data);
    const grant = await ownerAccess(f.db, f.userId);
    await reserve(f.db, f.userId, data.length, grant, "upload-regression");
    f.grants.get("alice")!.storageBytes = data.length * 2 - 1;
    const options = { title: "Upload" };
    await expect(f.library.importLocal(f.userId, file, options)).rejects.toMatchObject({ code: "kaname_storage_quota" });
    f.grants.get("alice")!.storageBytes++;
    await f.library.importLocal(f.userId, file, options);
    await f.library.importLocal(f.userId, file, options);
    expect((await usage(f.db, f.userId)).storageBytes).toBe(data.length);
  } finally { await f.close(); }
});

it("reports pre-ledger local archives and recovers only a stopped storage writer", async () => {
  const f = await testContext();
  const { createDb } = await import("./db");
  const second = createDb(f.root);
  try {
    const id = randomUUID();
    const dir = path.join(f.root, "jobs", id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "input.zip"), Buffer.alloc(101));
    await f.db.job.create({ data: { id, ownerId: f.userId, kind: "import", inputJson: "{}" } });
    const tmp = path.join(f.root, "uploads", f.userId, randomUUID());
    await reserve(second, f.userId, 60, null, "orphan", tmp);
    await mkdir(tmp, { recursive: true });
    await writeFile(path.join(tmp, "part"), Buffer.alloc(37));
    await second.kanameStorage.update({ where: { id: "orphan" }, data: { expiresAt: new Date(0) } });
    expect(await storageBreakdown(f.db, f.userId, f.root)).toEqual({
      mediaBytes: 0, importBytes: 101, exportBytes: 0, otherBytes: 0, temporaryBytes: 60,
    });
    expect((await storageBreakdown(f.db, f.otherUserId, f.root)).importBytes).toBe(0);
    await second.$disconnect();
    expect((await storageBreakdown(f.db, f.userId, f.root)).temporaryBytes).toBe(0);
    await expect(lstat(tmp)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(path.join(dir, "input.zip"))).size).toBe(101);
  } finally { await second.$disconnect(); await f.close(); }
});

it("uploads an exact-limit WAV without consuming space for a second copy", async () => {
  const f = await fixture();
  try {
    const data = wav();
    const payload = Buffer.concat([
      Buffer.from('--quota\r\nContent-Disposition: form-data; name="file"; filename="exact.wav"\r\n\r\n'),
      data, Buffer.from("\r\n--quota--\r\n"),
    ]);
    const upload = () => f.app.inject({ method: "POST", url: "/api/items/upload",
      headers: { ...f.alice, "content-type": "multipart/form-data; boundary=quota" }, payload });
    f.grants.get("alice")!.storageBytes = data.length - 1;
    expect((await upload()).statusCode).toBe(413);
    f.grants.get("alice")!.storageBytes++;
    expect((await upload()).statusCode).toBe(200);
    expect(await storageBreakdown(f.db, f.userId, f.root)).toEqual({
      mediaBytes: data.length, importBytes: 0, exportBytes: 0, otherBytes: 0, temporaryBytes: 0,
    });
    expect((await usage(f.db, f.userId)).storageBytes).toBe(data.length);
  } finally { await f.close(); }
});

it("moves reserved extraction data at the exact ZIP plus media limit", async () => {
  const f = await fixture();
  try {
    const { exportLibrary, inspectArchive, applyArchive } = await import("./portability");
    const data = wav();
    const original = path.join(f.root, "original.wav");
    await writeFile(original, data);
    await f.library.importLocal(f.otherUserId, original);
    const zip = path.join(f.root, "source.zip");
    await exportLibrary(f.db, f.otherUserId, f.root, zip, { includeFiles: true });
    const zipBytes = (await lstat(zip)).size;
    f.grants.get("alice")!.storageBytes = zipBytes + data.length;
    const grant = await ownerAccess(f.db, f.userId);
    await reserve(f.db, f.userId, zipBytes, grant, "job-preview");
    const work = path.join(f.root, "inspection");
    const checked = await inspectArchive(zip, work, undefined, async bytes => {
      await reserve(f.db, f.userId, bytes, grant, "inspection", work);
    });
    const before = await lstat([...checked.files.values()][0].path);
    await applyArchive(f.db, f.userId, f.root, checked, undefined, "inspection");
    const file = await f.db.mediaFile.findFirstOrThrow({ where: { ownerId: f.userId } });
    expect((await lstat(path.join(f.root, file.path))).ino).toBe(before.ino);
    expect((await f.db.kanameStorage.findUniqueOrThrow({ where: { id: "inspection" } })).bytes).toBe(0n);
  } finally { await f.close(); }
});

it("recovers expired legacy upload holds and empty reservations per owner", async () => {
  const f = await testContext();
  try {
    const make = async (ownerId: string, file: boolean) => {
      const id = randomUUID();
      await f.db.kanameStorage.create({ data: { id, ownerId, writer: "legacy", bytes: 42n, expiresAt: new Date(0) } });
      const dir = path.join(f.root, "uploads", ownerId, id);
      if (file) {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "partial"), Buffer.alloc(42));
      }
      return dir;
    };
    const partial = await make(f.userId, true);
    await make(f.userId, false);
    const other = await make(f.otherUserId, true);
    expect((await storageBreakdown(f.db, f.userId, f.root)).temporaryBytes).toBe(0);
    await expect(lstat(partial)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(path.join(other, "partial"))).size).toBe(42);
    expect(await f.db.kanameStorage.count({ where: { ownerId: f.otherUserId } })).toBe(1);
  } finally { await f.close(); }
});

it("measures growing external-tool output before completion and closes it once", async () => {
  const f = await testContext();
  try {
    const { startHeavyStorage, finishHeavyStorage } = await import("./kaname");
    const { discardReservation } = await import("./storage-writer");
    const directory = path.join(f.root, "jobs", "sample", "download-1");
    await startHeavyStorage(f.db, f.userId, null, "download", directory);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "video.part"), Buffer.alloc(1000));
    await writeFile(path.join(directory, "audio.part"), Buffer.alloc(333));
    expect((await storageBreakdown(f.db, f.userId, f.root)).temporaryBytes).toBe(1333);
    expect((await storageBreakdown(f.db, f.otherUserId, f.root)).temporaryBytes).toBe(0);
    await finishHeavyStorage(f.db, f.userId, "download", directory);
    expect((await storageBreakdown(f.db, f.userId, f.root)).temporaryBytes).toBe(1333);
    await discardReservation(f.db, f.userId, "download");
    expect((await storageBreakdown(f.db, f.userId, f.root)).temporaryBytes).toBe(0);
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
});

it("allows a quota-limited listener to remux a clip, bounds the output and gates actual transcoding", async () => {
  const f = await fixture();
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const ffmpeg = (await import("ffmpeg-static")).default;
    const { setVisual } = await import("./visuals");
    const songPath = path.join(f.root,"song.wav"), clip = path.join(f.root,"clip.mkv"), vp8 = path.join(f.root,"vp8.webm");
    await writeFile(songPath,wav());
    const song = (await f.library.importLocal(f.userId,songPath)).item;
    const make = (codec:string,out:string) => promisify(execFile)(String(ffmpeg),["-hide_banner","-loglevel","error","-f","lavfi","-i",
      "testsrc2=s=64x64:r=25:d=1","-c:v",codec,out]);
    await make("libx264",clip);
    await make("libvpx",vp8);
    const attach = (uploadPath:string) => setVisual(f.db,f.root,f.userId,song.id,{expectedRevision:0,uploadPath});
    await expect(attach(vp8)).rejects.toMatchObject({code:"heavy_forbidden"});
    f.grants.get("alice")!.storageBytes = wav().length + 500;
    await expect(attach(clip)).rejects.toMatchObject({code:"kaname_storage_quota"});
    expect(await f.db.kanameStorage.count()).toBe(0);
    expect(await f.db.visualTrack.count()).toBe(0);
    f.grants.get("alice")!.storageBytes = wav().length + 50_000;
    expect((await attach(clip)).visual?.duration).toBeCloseTo(1);
    expect(await f.db.mediaFile.count()).toBe(2);
    expect(await f.db.kanameStorage.count()).toBe(0);
  } finally { await f.close(); }
});
