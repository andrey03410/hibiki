import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "./auth";
import { HttpError } from "./errors";
import { registerHistory } from "./history";
import { testContext } from "./test-utils";

const hour = 3_600_000;
let context: Awaited<ReturnType<typeof testContext>>;
let app: FastifyInstance;
let ownerHeaders: { cookie: string };
let otherHeaders: { cookie: string };
let auth: AuthService;
let start: number;

beforeEach(async () => {
  context = await testContext();
  const { db, userId, otherUserId } = context;
  auth = new AuthService(db);
  app = Fastify();
  app.decorate("auth", auth);
  app.decorateRequest("user", null);
  await app.register(cookie);
  app.addHook("onRequest", async (request) => {
    request.user = request.headers.authorization?.startsWith("Bearer ")
      ? await auth.userByToken(request.headers.authorization.slice(7))
      : await auth.userBySession(request.cookies.hibiki_session);
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof HttpError ? error.status : 400).send({
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  });
  registerHistory(app, db);
  app.get("/api/history-other", () => ({ ok: true }));
  ownerHeaders = { cookie: `hibiki_session=${await auth.createSession(userId)}` };
  otherHeaders = { cookie: `hibiki_session=${await auth.createSession(otherUserId)}` };
  start = Date.now() - hour;
  await db.item.createMany({
    data: [
      { id: "track", ownerId: userId, title: '=Old, "track"', originalTitle: "Track", kind: "audio", duration: 100, createdAt: new Date(start - hour) },
      { id: "unknown", ownerId: userId, title: "Unknown", originalTitle: "Unknown", kind: "video", createdAt: new Date(start - hour) },
      { id: "other-track", ownerId: otherUserId, title: "Private", originalTitle: "Private", kind: "audio", createdAt: new Date(start - hour) },
    ],
  });
  await db.playlist.create({
    data: { id: "other-playlist", ownerId: otherUserId, title: "Private list", definitionJson: "{}" },
  });
});

afterEach(async () => {
  await app.close();
  await context.close();
});

type Reason = "playing" | "ended" | "manual" | "error" | "interrupted";
function attempt({
  at = start, itemId = "track", reason = "ended" as Reason, elapsed = 100,
  listened = 90, covered = 90, seeks = 0,
} = {}) {
  return {
    id: `${at}.${randomUUID()}`, ownerId: context.userId, itemId, trigger: "manual",
    endedAt: new Date(at + elapsed * 1000).toISOString(), reason, listened, covered, seeks,
  };
}

function post(path: string, payload: object, headers = ownerHeaders) {
  return app.inject({ method: "POST", url: `/api/history${path}`, headers, payload });
}

function get(path: string, headers = ownerHeaders) {
  return app.inject({ method: "GET", url: `/api/history${path}`, headers });
}

describe("attempts", () => {
  it("counts actual start immediately and folds reordered and duplicate snapshots into one final row", async () => {
    const initial = attempt({ reason: "playing", elapsed: 0, listened: 0, covered: 0 });
    expect((await post("/attempts", initial)).json()).toEqual({ recorded: true, historyChanged: true });
    expect((await get("/items/track")).json()).toMatchObject({
      summary: { launches: 1, manual: 1, direct: 1, completed: 0 },
      journalUrl: "/settings?historyItem=track#history",
    });
    const checkpoint = { ...initial, endedAt: new Date(start + 20_000).toISOString(), listened: 12, covered: 12, seeks: 1 };
    expect((await post("/attempts", checkpoint)).json()).toEqual({ recorded: true, historyChanged: false });
    expect((await post("/attempts", initial)).json()).toEqual({ recorded: true, historyChanged: false });
    const final = { ...initial, reason: "ended", endedAt: new Date(start + 100_000).toISOString(), listened: 90, covered: 90, seeks: 2 };
    expect((await post("/attempts", final)).json()).toEqual({ recorded: true, historyChanged: true });
    expect((await post("/attempts", final)).json()).toEqual({ recorded: true, historyChanged: false });
    expect((await post("/attempts", { ...checkpoint, endedAt: new Date(start + 105_000).toISOString() })).json())
      .toEqual({ recorded: true, historyChanged: false });
    expect((await get("/items/track")).json().summary).toMatchObject({
      launches: 1, completed: 1, partial: 0, listened: 90, seeks: 2,
      lastStartedAt: new Date(start).toISOString(), lastCompletedAt: final.endedAt,
    });
    expect((await get("/attempts")).json().attempts).toHaveLength(1);
  });

  it("marks the first successful checkpoint as a history change if the start packet was lost", async () => {
    const checkpoint = attempt({ reason: "playing", elapsed: 16, listened: 16, covered: 16 });
    expect((await post("/attempts", checkpoint)).json()).toEqual({ recorded: true, historyChanged: true });
    expect((await get("/items/track")).json().summary.launches).toBe(1);
  });

  it.each([
    [{ reason: "ended", listened: 85, covered: 79 }, "partial"],
    [{ reason: "ended", elapsed: 2, listened: 90, covered: 90 }, "partial"],
    [{ reason: "manual", listened: 14, covered: 14 }, "skipped"],
    [{ reason: "manual", listened: 15, covered: 15 }, "partial"],
    [{ reason: "error", listened: 0, covered: 0 }, "error"],
    [{ reason: "interrupted", listened: 5, covered: 5 }, "partial"],
    [{ reason: "ended", itemId: "unknown", listened: 3, covered: 3 }, "completed"],
    [{ reason: "ended", itemId: "unknown", seeks: 1 }, "partial"],
  ] as const)("classifies %j as %s", async (input, outcome) => {
    const row = attempt(input);
    expect((await post("/attempts", row)).statusCode).toBe(200);
    const journal = (await get("/attempts")).json();
    expect(journal.attempts[0].outcome).toBe(outcome);
  });

  it("uses bounded duration from the playing source when it differs from original item metadata", async () => {
    const shorter = { ...attempt({ elapsed: 20, listened: 16, covered: 16 }), duration: 20 };
    const longer = { ...attempt(), duration: 200 };
    const manual = { ...attempt({ reason: "manual", listened: 10, covered: 10 }), duration: 20 };
    for (const row of [shorter, longer, manual]) {
      expect((await post("/attempts", row)).statusCode).toBe(200);
    }
    const outcomes = new Map((await get("/attempts")).json().attempts.map((row: { id: string; outcome: string }) =>
      [row.id, row.outcome]));
    expect(outcomes.get(shorter.id)).toBe("completed");
    expect(outcomes.get(longer.id)).toBe("partial");
    expect(outcomes.get(manual.id)).toBe("partial");
    expect((await post("/attempts", { ...attempt(), duration: 1e9 })).statusCode).toBe(400);
  });

  it("clamps a new item's start after a delayed clock response while preserving elapsed time and replay fences", async () => {
    const createdAt = Date.now() - 1000;
    await context.db.item.update({
      where: { id: "track" }, data: { createdAt: new Date(createdAt), duration: 1 },
    });
    const estimatedStart = createdAt - 2000;
    const first = attempt({ at: estimatedStart, reason: "playing", elapsed: 0, listened: 0, covered: 0 });
    const checkpoint = { ...first, endedAt: new Date(estimatedStart + 500).toISOString(), listened: 0.5, covered: 0.5 };
    const final = { ...first, reason: "ended", endedAt: new Date(estimatedStart + 900).toISOString(), listened: 0.9, covered: 0.9 };
    for (const snapshot of [first, checkpoint, final]) {
      expect((await post("/attempts", snapshot)).json()).toMatchObject({ recorded: true });
    }
    expect((await get("/attempts")).json().attempts).toEqual([expect.objectContaining({
      id: first.id, startedAt: new Date(createdAt).toISOString(), endedAt: new Date(createdAt + 900).toISOString(),
      outcome: "completed", listened: 0.9,
    })]);
    const selection = { from: new Date(createdAt).toISOString(), to: new Date(createdAt + 1).toISOString() };
    const preview = (await post("/cleanup/preview", selection)).json();
    expect(preview).toMatchObject({ count: 1 });
    expect((await post("/cleanup/confirm", { token: preview.token })).json()).toEqual({ deleted: 1 });
    expect((await post("/attempts", final)).json()).toEqual({ recorded: false });
    expect((await get("/items/track")).json().summary).toMatchObject({ launches: 1, completed: 1, listened: 0.9 });
  });

  it("rejects estimates far before item creation or ahead of server time", async () => {
    const createdAt = Date.now() - 500;
    await context.db.item.update({ where: { id: "track" }, data: { createdAt: new Date(createdAt) } });
    for (const at of [createdAt - 365 * 24 * hour, createdAt + 365 * 24 * hour]) {
      const response = await post("/attempts", attempt({ at, reason: "playing", elapsed: 0, listened: 0, covered: 0 }));
      expect(response.statusCode).toBe(400);
    }
    expect((await get("/attempts")).json().attempts).toEqual([]);
  });

  it("keeps playlist origin independent from trigger and refuses a foreign item or transport account", async () => {
    const { db, userId } = context;
    await db.playlist.create({
      data: { id: "playlist", ownerId: userId, title: "My list", definitionJson: "{}" },
    });
    expect((await post("/attempts", { ...attempt(), itemId: "other-track" })).statusCode).toBe(404);
    expect((await post("/attempts", attempt(), otherHeaders)).statusCode).toBe(403);
    await post("/attempts", { ...attempt(), playlistId: "playlist" });
    await post("/attempts", { ...attempt(), playlistId: "playlist", trigger: "advance" });
    await post("/attempts", { ...attempt(), trigger: "repeat" });
    expect((await get("/items/track")).json().summary).toMatchObject({
      launches: 3, fromPlaylist: 2, direct: 1, manual: 1, advance: 1, repeat: 1,
    });
    expect((await get("/attempts?playlistId=playlist")).json().attempts).toHaveLength(2);
    expect((await get("/items/track", otherHeaders)).statusCode).toBe(404);
    expect((await get("/attempts", otherHeaders)).json().attempts).toEqual([]);
  });

  it("normalizes deleted and foreign playlist IDs to direct playback on every retry", async () => {
    for (const playlistId of ["removed-playlist", "other-playlist"]) {
      const playing = { ...attempt({ reason: "playing", elapsed: 0, listened: 0, covered: 0 }), playlistId };
      const ended = { ...playing, reason: "ended", endedAt: new Date(start + 100_000).toISOString(), listened: 90, covered: 90 };
      for (const snapshot of [playing, ended, playing, ended]) {
        expect((await post("/attempts", snapshot)).json()).toMatchObject({ recorded: true });
      }
    }
    const { attempts } = (await get("/attempts")).json();
    expect(attempts).toHaveLength(2);
    for (const row of attempts) expect(row).toMatchObject({ playlistId: null, playlistTitle: null, outcome: "completed" });
    expect((await get("/items/track")).json().summary).toMatchObject({
      launches: 2, direct: 2, fromPlaylist: 0, completed: 2,
    });
  });

  it("keeps the owned playlist context already saved before deletion", async () => {
    const { db, userId } = context;
    await db.playlist.create({
      data: { id: "playlist", ownerId: userId, title: "Saved list", definitionJson: "{}" },
    });
    const started = { ...attempt({ reason: "playing", elapsed: 0, listened: 0, covered: 0 }), playlistId: "playlist" };
    await post("/attempts", started);
    const ended = { ...started, reason: "ended", endedAt: new Date(start + 100_000).toISOString(), listened: 90, covered: 90 };
    const { playlistId: _id, ...withoutPlaylist } = ended;
    expect((await post("/attempts", withoutPlaylist)).statusCode).toBe(409);
    await db.playlist.delete({ where: { id: "playlist" } });
    expect((await post("/attempts", withoutPlaylist)).json()).toMatchObject({ recorded: true });
    expect((await post("/attempts", ended)).json()).toMatchObject({ recorded: true });
    const next = { ...attempt(), playlistId: "playlist", trigger: "advance" };
    expect((await post("/attempts", next)).json()).toMatchObject({ recorded: true });
    const { attempts } = (await get("/attempts")).json();
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: started.id, playlistId: "playlist", playlistTitle: "Saved list", outcome: "completed" }),
      expect.objectContaining({ id: next.id, playlistId: null, playlistTitle: null, outcome: "completed" }),
    ]));
    expect((await get("/items/track")).json().summary).toMatchObject({
      launches: 2, completed: 2, direct: 1, fromPlaylist: 1, advance: 1,
    });
  });

  it("accepts fast coverage independently of elapsed listening and bounds it by the observed peak rate", async () => {
    const fast = { ...attempt({ elapsed: 45, listened: 45, covered: 90 }), maxPlaybackRate: 2 };
    const impossible = { ...attempt({ elapsed: 20, listened: 20, covered: 90 }), maxPlaybackRate: 2 };
    const manual = { ...attempt({ reason: "manual", elapsed: 13, listened: 13, covered: 26 }), maxPlaybackRate: 2 };
    for (const row of [fast, impossible, manual]) {
      expect((await post("/attempts", row)).statusCode).toBe(200);
    }
    const { attempts } = (await get("/attempts")).json();
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fast.id, listened: 45, outcome: "completed" }),
      expect.objectContaining({ id: impossible.id, listened: 20, outcome: "partial" }),
      expect.objectContaining({ id: manual.id, listened: 13, outcome: "partial" }),
    ]));
    expect((await post("/attempts", { ...attempt(), maxPlaybackRate: 17 })).statusCode).toBe(400);
  });

  it("prevents caching across private JSON, mutation, CSV and error responses", async () => {
    for (const path of ["/preference", "/summary", "/attempts", "/items/track",
      "/attempts.csv", "/summary.csv", "/cleanup/context"]) {
      const response = await get(path);
      expect(response.statusCode, path).toBe(200);
      expect(response.headers["cache-control"], path).toBe("private, no-store");
    }
    const preview = await post("/cleanup/preview", { to: new Date().toISOString() });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["cache-control"]).toBe("private, no-store");
    const denied = await app.inject("/api/history/attempts");
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["cache-control"]).toBe("private, no-store");
    const separate = await app.inject("/api/history-other");
    expect(separate.statusCode).toBe(200);
    expect(separate.headers["cache-control"]).toBeUndefined();
  });

  it("requires a live owner cookie even when a bearer and matching cookie are supplied", async () => {
    const token = await auth.createToken(context.userId, "agent");
    const authorization = `Bearer ${token.token}`;
    for (const path of ["/preference", "/attempts", "/items/track", "/attempts.csv", "/summary.csv", "/cleanup/context"]) {
      expect((await get(path, { authorization, ...ownerHeaders } as typeof ownerHeaders)).statusCode).toBe(403);
    }
    expect((await app.inject({ url: "/api/history/preference" })).statusCode).toBe(403);
    await auth.logout(ownerHeaders.cookie.split("=")[1]!);
    expect((await get("/preference")).statusCode).toBe(403);
  });
});

describe("retention and data controls", () => {
  it("previews an explicit period, refuses stale selections, and keeps summary and duplicate fences after cleanup", async () => {
    const older = attempt({ at: start - 60_000 });
    const newer = attempt();
    await post("/attempts", older);
    await post("/attempts", newer);
    const selection = { from: new Date(start - 90_000).toISOString(), to: new Date(start).toISOString() };
    expect((await post("/cleanup/preview", {})).statusCode).toBe(400);
    let preview = (await post("/cleanup/preview", selection)).json();
    expect(preview).toMatchObject({ count: 1, attempts: [{ id: older.id }] });
    expect(preview.bytes).toBeGreaterThan(0);
    const late = attempt({ at: start - 30_000 });
    await post("/attempts", late);
    expect((await post("/cleanup/confirm", { token: preview.token })).statusCode).toBe(409);
    expect((await get("/attempts")).json().attempts).toHaveLength(3);
    preview = (await post("/cleanup/preview", selection)).json();
    expect((await post("/cleanup/confirm", { token: preview.token }, otherHeaders)).statusCode).toBe(400);
    expect((await post("/cleanup/confirm", { token: preview.token })).json()).toEqual({ deleted: 2 });
    expect((await get("/attempts")).json().attempts.map((row: { id: string }) => row.id)).toEqual([newer.id]);
    expect((await post("/attempts", older)).json()).toEqual({ recorded: false });
    expect((await post("/attempts", { ...older, endedAt: newer.endedAt })).json()).toEqual({ recorded: false });
    expect((await get("/summary")).json()).toMatchObject({
      ever: { launches: 3, completed: 3 }, sevenDays: { launches: 1 }, pruned: true,
    });
  });

  it("keeps unfinished attempts visible and accepts their final snapshots across selective cleanup", async () => {
    const older = attempt({ at: start - 80_000, reason: "playing", elapsed: 0, listened: 0, covered: 0 });
    const active = attempt({ at: start - 30_000, reason: "playing", elapsed: 0, listened: 0, covered: 0 });
    const done = attempt({ at: start - 60_000 });
    for (const row of [older, active, done]) await post("/attempts", row);
    const selection = { from: new Date(start - 90_000).toISOString(), to: new Date(start).toISOString() };
    const preview = (await post("/cleanup/preview", selection)).json();
    expect(preview).toMatchObject({ count: 1, unfinishedCount: 2, attempts: [{ id: done.id }] });
    expect((await post("/cleanup/confirm", { token: preview.token })).json()).toEqual({ deleted: 1 });
    const finalize = { ...active, reason: "ended", endedAt: new Date(start + 70_000).toISOString(), listened: 90, covered: 90 };
    expect((await post("/attempts", finalize)).json()).toMatchObject({ recorded: true });
    expect((await post("/attempts", done)).json()).toEqual({ recorded: false });
    const journal = (await get("/attempts?outcome=active")).json();
    expect(journal.attempts.map((row: { id: string }) => row.id)).toEqual([older.id]);
    expect((await get("/attempts.csv?outcome=active")).body).toContain(older.id);
    expect((await get("/items/track")).json().summary).toMatchObject({ launches: 3, completed: 2, listened: 180 });
  });

  it("requires a new cleanup preview if an unfinished attempt finishes before confirmation", async () => {
    const started = attempt({ reason: "playing", elapsed: 0, listened: 0, covered: 0 });
    await post("/attempts", started);
    await post("/attempts", attempt({ at: start - 30_000 }));
    const selection = { from: new Date(start - 90_000).toISOString(), to: new Date(start + 1000).toISOString() };
    const preview = (await post("/cleanup/preview", selection)).json();
    expect(preview).toMatchObject({ count: 1, unfinishedCount: 1 });
    await post("/attempts", { ...started, reason: "ended", endedAt: new Date(start + 100_000).toISOString(), listened: 90, covered: 90 });
    expect((await post("/cleanup/confirm", { token: preview.token })).statusCode).toBe(409);
    expect((await get("/attempts")).json().attempts).toHaveLength(2);
  });

  it("defaults to enabled, preserves old records on opt-out, fences old requests after opt-in and full reset", async () => {
    expect((await get("/preference")).json().enabled).toBe(true);
    const before = attempt();
    await post("/attempts", before);
    await app.inject({ method: "PUT", url: "/api/history/preference", headers: ownerHeaders, payload: { enabled: false } });
    expect((await post("/attempts", attempt())).json()).toEqual({ recorded: false });
    expect((await get("/attempts")).json().attempts).toHaveLength(1);
    await app.inject({ method: "PUT", url: "/api/history/preference", headers: ownerHeaders, payload: { enabled: true } });
    expect((await post("/attempts", attempt())).json()).toEqual({ recorded: false });
    expect((await post("/reset", { confirm: false })).statusCode).toBe(400);
    expect((await post("/reset", { confirm: true })).json()).toEqual({ ok: true });
    expect((await post("/attempts", before)).json()).toEqual({ recorded: false });
    expect((await get("/attempts")).json().attempts).toEqual([]);
    expect((await get("/items/track")).json().summary.launches).toBe(0);
    expect((await get("/summary")).json()).toMatchObject({ ever: { launches: 0 }, resetAt: expect.any(String) });
  });

  it("finalizes accepted active rows on opt-out exactly once and makes them eligible for selective cleanup", async () => {
    const recorded = attempt({ at: start - 10_000, reason: "playing", elapsed: 8, listened: 5, covered: 5, seeks: 2 });
    const second = attempt({ at: start - 5000, reason: "playing", elapsed: 0, listened: 0, covered: 0 });
    const complete = attempt({ at: start - 20_000 });
    for (const row of [recorded, second, complete]) expect((await post("/attempts", row)).statusCode).toBe(200);
    const other = { ...attempt({ itemId: "other-track", reason: "playing", elapsed: 0, listened: 0, covered: 0 }), ownerId: context.otherUserId };
    expect((await post("/attempts", other, otherHeaders)).statusCode).toBe(200);

    const setEnabled = (enabled: boolean) => app.inject({
      method: "PUT", url: "/api/history/preference", headers: ownerHeaders, payload: { enabled },
    });
    for (const response of await Promise.all([setEnabled(false), setEnabled(false)])) {
      expect(response.statusCode).toBe(200);
    }
    const { attempts } = (await get("/attempts")).json();
    expect(attempts).toEqual([
      expect.objectContaining({ id: second.id, outcome: "partial", reason: "interrupted", listened: 0, endedAt: second.endedAt }),
      expect.objectContaining({ id: recorded.id, outcome: "partial", reason: "interrupted", listened: 5, seeks: 2, endedAt: recorded.endedAt }),
      expect.objectContaining({ id: complete.id, outcome: "completed", reason: "ended" }),
    ]);
    expect((await get("/items/track")).json().summary).toMatchObject({
      launches: 3, partial: 2, completed: 1, listened: 95, seeks: 2, lastCompletedAt: complete.endedAt,
    });
    expect((await get("/attempts", otherHeaders)).json().attempts).toEqual([
      expect.objectContaining({ id: other.id, outcome: "active" }),
    ]);
    await setEnabled(true);
    const lateFinal = { ...recorded, reason: "ended", endedAt: new Date(start + 100_000).toISOString(), listened: 100, covered: 100 };
    expect((await post("/attempts", lateFinal)).json()).toEqual({ recorded: false });
    const selection = { from: new Date(start - 15_000).toISOString(), to: new Date(start).toISOString() };
    const preview = (await post("/cleanup/preview", selection)).json();
    expect(preview).toMatchObject({ count: 2, unfinishedCount: 0 });
    expect((await post("/cleanup/confirm", { token: preview.token })).json()).toEqual({ deleted: 2 });
    expect((await get("/items/track")).json().summary).toMatchObject({ launches: 3, partial: 2, completed: 1, listened: 95 });
  });

  it("paginates tied timestamps and exports filtered details in batches, including deleted titles", async () => {
    const rows = Array.from({ length: 305 }, () => ({
      id: `${start}.${randomUUID()}`, ownerId: context.userId, itemId: "track",
      itemTitle: '=Old, "track"', startedAt: new Date(start), endedAt: new Date(start + 5000),
      trigger: "manual", outcome: "skipped", reason: "manual", listened: 5, seeks: 0, bytes: 400,
    }));
    await context.db.listeningAttempt.createMany({ data: rows });
    await post("/attempts", attempt({ itemId: "unknown" }));
    const extended = { ...attempt(), ownerId: context.otherUserId, itemId: "other-track" };
    await post("/attempts", extended, otherHeaders);
    await context.db.item.delete({ where: { id: "track" } });
    const page = (await get("/attempts?itemId=track&outcome=skipped&limit=2")).json();
    const next = (await get(`/attempts?itemId=track&outcome=skipped&limit=2&cursor=${page.nextCursor}`)).json();
    expect(new Set([...page.attempts, ...next.attempts].map((row) => row.id)).size).toBe(4);
    const csv = await get("/attempts.csv?itemId=track&outcome=skipped");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body.trim().split("\r\n")).toHaveLength(306);
    expect(csv.body).toContain(`"'=Old, ""track"""`);
    expect(csv.body).not.toContain("other-track");
    expect(csv.body).not.toContain("unknown");
    expect((await get("/summary.csv")).body).toContain("Unknown");
  });

  it("warns above 1 GB without pruning data and provides month aggregates only", async () => {
    const { db, userId } = context;
    const now = new Date(start);
    await db.listeningAttempt.create({
      data: {
        id: "oversized-fixture", ownerId: userId, itemId: "track", itemTitle: "Do not disclose",
        startedAt: now, endedAt: now, trigger: "manual", outcome: "partial", reason: "ended",
        listened: 0, seeks: 0, bytes: 1_200_000_000,
      },
    });
    expect((await get("/summary")).json()).toMatchObject({ bytes: 1_200_000_000, overThreshold: true });
    expect((await get("/cleanup/context")).json()).toEqual({
      periods: [{ month: now.toISOString().slice(0, 7), count: 1, bytes: 1_200_000_000 }],
    });
    expect((await post("/attempts", attempt())).json()).toMatchObject({ recorded: true });
    expect((await get("/attempts")).json().attempts).toHaveLength(2);
  });
});
