import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { ListeningAttempt, ListeningSummary, Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db";
import { invariant } from "./errors";

const base = "/api/history";
const threshold = 1_000_000_000;
const batchSize = 250;
const day = 86_400_000;
const futureToleranceMs = 2_000;
const newItemClockUncertaintyMs = 3_000;
const key = z.string().min(1).max(200);
const instant = z.iso.datetime().transform((s) => new Date(s));
const outcome = z.enum(["active", "completed", "partial", "skipped", "error"]);
const attemptInput = z.object({
  // The timestamp is part of the immutable identity, including after detail deletion.
  id: z.string().regex(/^\d{13}\.[0-9a-f-]{36}$/),
  ownerId: key,
  itemId: key,
  playlistId: key.optional(),
  endedAt: instant,
  trigger: z.enum(["manual", "advance", "repeat"]),
  reason: z.enum(["playing", "ended", "manual", "error", "interrupted"]),
  listened: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  covered: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  duration: z.number().positive().max(7 * 86_400).optional(),
  maxPlaybackRate: z.number().min(0.0625).max(16).optional(),
  seeks: z.number().int().nonnegative().max(2_147_483_647),
}).strict();

const filterSchema = z.object({
  from: instant.optional(),
  to: instant.optional(),
  itemId: key.optional(),
  playlistId: key.optional(),
  outcome: outcome.optional(),
}).refine(({ from, to }) => !from || !to || from < to, "Начало периода должно предшествовать концу");

const listQuery = z.object({
  ...filterSchema.shape,
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
}).refine(({ from, to }) => !from || !to || from < to, "Начало периода должно предшествовать концу");

const cleanupSelection = z.object({ from: instant.optional(), to: instant }).strict()
  .refine(({ from, to }) => !from || from < to, "Начало периода должно предшествовать концу");

const interval = z.tuple([z.number().int().nonnegative(), z.number().int().positive()]);
type Interval = z.infer<typeof interval>;
const preferenceData = z.union([
  z.array(interval).transform((ranges) => ({ ranges, recordAfter: null })),
  z.object({ ranges: z.array(interval), recordAfter: z.number().int().nonnegative().nullable() }),
]);
const confirmation = z.object({
  ownerId: key,
  range: interval,
  count: z.number().int().positive(),
  retention: z.string().length(64),
  expires: z.number().int(),
});

const metrics = [
  "launches", "completed", "partial", "skipped", "errors", "listened", "seeks",
  "fromPlaylist", "direct", "manual", "advance", "repeat",
] as const;
type Totals = Pick<ListeningSummary, (typeof metrics)[number]>;
const zero: Totals = {
  launches: 0, completed: 0, partial: 0, skipped: 0, errors: 0, listened: 0, seeks: 0,
  fromPlaylist: 0, direct: 0, manual: 0, advance: 0, repeat: 0,
};

function readPreference(preference: { prunedJson: string } | null) {
  return preferenceData.parse(JSON.parse(preference?.prunedJson ?? "[]"));
}

function mergeRanges(ranges: Interval[], added: Interval) {
  const merged: Interval[] = [];
  for (const [from, to] of [...ranges, added].sort(([a], [b]) => a - b)) {
    const previous = merged.at(-1);
    if (previous && previous[1] >= from) previous[1] = Math.max(previous[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function preferenceView(preference: { enabled: boolean; resetAt: Date | null; prunedJson: string } | null) {
  const { ranges, recordAfter } = readPreference(preference);
  const resetAt = preference?.resetAt ?? null;
  return {
    enabled: preference?.enabled ?? true,
    resetAt,
    pruned: ranges.length > 0,
    recordAfter: Math.max(resetAt?.getTime() ?? 0, recordAfter ?? 0),
    serverTime: Date.now(),
  };
}

async function recordAttempt(db: Db, ownerId: string, input: z.infer<typeof attemptInput>) {
  const claimedStart = Number(input.id.slice(0, 13));
  const { id, itemId, trigger, endedAt: claimedEnd, reason } = input;
  const requestedPlaylistId = input.playlistId ?? null;
  const latestEnd = Date.now() + futureToleranceMs;
  const elapsedMs = claimedEnd.getTime() - claimedStart;
  const elapsed = elapsedMs / 1000;
  invariant(elapsedMs >= 0 && claimedEnd.getTime() <= latestEnd, 400,
    "invalid_attempt_time", "Неверное время попытки");

  return db.$transaction(async (tx) => {
    const preference = await tx.historyPreference.findUnique({ where: { ownerId } });
    const { ranges, recordAfter } = readPreference(preference);
    const since = Math.max(preference?.resetAt?.getTime() ?? 0, recordAfter ?? 0);
    if (preference?.enabled === false || claimedStart <= since) return { recorded: false };

    const previous = await tx.listeningAttempt.findUnique({ where: { id } });
    const wasPruned = (start: number) => ranges.some(([from, to]) => start >= from && start < to);
    // An unfinished attempt that survived selective cleanup can still finish.
    if (!previous && wasPruned(claimedStart)) return { recorded: false };
    const ownedPlaylist = (id: string | null) => id ? tx.playlist.findFirst({
      where: { id, ownerId }, select: { id: true, title: true },
    }) : null;

    if (previous) {
      invariant(
        previous.ownerId === ownerId && previous.itemId === itemId && previous.trigger === trigger,
        409, "attempt_conflict", "Контекст попытки изменился",
      );
      if (previous.playlistId !== requestedPlaylistId) {
        invariant(
          !(await ownedPlaylist(requestedPlaylistId)) && !(await ownedPlaylist(previous.playlistId)),
          409, "attempt_conflict", "Контекст попытки изменился",
        );
      }
      const acceptedElapsed = previous.endedAt.getTime() - previous.startedAt.getTime();
      if (previous.outcome !== "active" || elapsedMs < acceptedElapsed ||
        (reason === "playing" && elapsedMs === acceptedElapsed)) return { recorded: true, historyChanged: false };
    }

    const item = await tx.item.findFirst({
      where: { id: itemId, ownerId }, select: { title: true, duration: true, createdAt: true },
    });
    invariant(item || previous, 404, "item_not_found", "Запись не найдена");
    // A delayed preference response can bias the estimated server time.
    // Keep the ID and elapsed interval, and reuse the adjusted start on every later snapshot.
    const startedAt = previous?.startedAt ?? new Date(Math.max(claimedStart, item?.createdAt.getTime() ?? claimedStart));
    const storedStart = startedAt.getTime();
    invariant(storedStart - claimedStart <= newItemClockUncertaintyMs, 400,
      "invalid_attempt_start", "Попытка началась раньше добавления записи");
    if (!previous && storedStart !== claimedStart && wasPruned(storedStart)) return { recorded: false };
    const endedAt = new Date(storedStart + elapsedMs);
    invariant(endedAt.getTime() <= latestEnd, 400, "invalid_attempt_time", "Неверное время попытки");
    const playlist = previous ? null : await ownedPlaylist(requestedPlaylistId);
    const playlistId = previous ? previous.playlistId : (playlist?.id ?? null);

    const nominalDuration = item?.duration;
    const duration = input.duration ?? (nominalDuration && nominalDuration > 0 ? nominalDuration : null);
    const listened = Math.max(previous?.listened ?? 0, Math.min(input.listened, elapsed));
    const seeks = Math.max(previous?.seeks ?? 0, input.seeks);
    const covered = Math.min(input.covered, elapsed * (input.maxPlaybackRate ?? 1), duration ?? Infinity);
    let result: z.infer<typeof outcome> = "partial";
    if (reason === "playing") result = "active";
    else if (reason === "error") result = "error";
    else if (reason === "ended" && (duration ? covered >= 0.8 * duration : seeks === 0))
      result = "completed";
    else if (reason === "manual" && listened < 15 && (!duration || covered < 0.25 * duration))
      result = "skipped";

    const row = {
      id, ownerId, itemId, playlistId,
      itemTitle: previous?.itemTitle ?? item?.title ?? "",
      playlistTitle: previous?.playlistTitle ?? playlist?.title ?? null,
      startedAt, endedAt, trigger, outcome: result, reason, listened, seeks,
    };
    const bytes = Buffer.byteLength(JSON.stringify(row));
    await tx.listeningAttempt.upsert({
      where: { id }, create: { ...row, bytes },
      update: { endedAt, outcome: result, reason, listened, seeks, bytes },
    });

    const counters: Totals = { ...zero, listened: listened - (previous?.listened ?? 0), seeks: seeks - (previous?.seeks ?? 0) };
    if (!previous) {
      counters.launches = 1;
      counters[trigger] = 1;
      counters[playlistId ? "fromPlaylist" : "direct"] = 1;
    }
    if (result !== "active") counters[result === "error" ? "errors" : result] = 1;

    const before = await tx.listeningSummary.findUnique({ where: { itemId } });
    invariant(!before || before.ownerId === ownerId, 409, "summary_conflict", "Сводка принадлежит другому аккаунту");
    const lastStartedAt = before?.lastStartedAt && before.lastStartedAt > startedAt
      ? before.lastStartedAt : startedAt;
    const lastCompletedAt = result === "completed" && (!before?.lastCompletedAt || endedAt > before.lastCompletedAt)
      ? endedAt : (before?.lastCompletedAt ?? null);
    const increment = Object.fromEntries(metrics.map(field => [field, { increment: counters[field] }]));
    await tx.listeningSummary.upsert({
      where: { itemId }, create: { itemId, ownerId, ...counters, lastStartedAt, lastCompletedAt },
      update: { ...increment, lastStartedAt, lastCompletedAt },
    });
    return { recorded: true, historyChanged: !previous || result !== "active" };
  });
}

function attemptWhere(ownerId: string, filter: z.infer<typeof filterSchema>): Prisma.ListeningAttemptWhereInput {
  return {
    ownerId, itemId: filter.itemId, playlistId: filter.playlistId, outcome: filter.outcome,
    startedAt: { gte: filter.from, lt: filter.to },
  };
}

const cursorSchema = z.tuple([instant, key]);
type Cursor = z.infer<typeof cursorSchema>;
const position = ({ startedAt, id }: Pick<ListeningAttempt, "startedAt" | "id">): Cursor => [startedAt, id];
function readCursor(encoded?: string): Cursor | undefined {
  if (!encoded) return;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString()));
  } catch {
    invariant(false, 400, "invalid_cursor", "Страница истории недоступна");
  }
}

function attemptBatch(
  db: Pick<Db, "listeningAttempt">,
  where: Prisma.ListeningAttemptWhereInput,
  take: number,
  cursor?: Cursor,
) {
  const [date, id] = cursor ?? [];
  return db.listeningAttempt.findMany({
    where: {
      ...where,
      OR: cursor ? [{ startedAt: { lt: date } }, { startedAt: date, id: { lt: id } }] : undefined,
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take,
  });
}

function publicAttempt({ ownerId: _ownerId, ...row }: ListeningAttempt) {
  return row;
}

async function totals(db: Db, ownerId: string) {
  const sevenDays = new Date(Date.now() - 7 * day);
  const thirtyDays = new Date(Date.now() - 30 * day);
  const preference = await db.historyPreference.findUnique({ where: { ownerId } });
  const [ever] = await db.$queryRaw<Totals[]>`
    SELECT SUM(launches) AS launches, SUM(completed) AS completed, SUM(partial) AS partial,
      SUM(skipped) AS skipped, SUM(errors) AS errors, SUM(listened) AS listened, SUM(seeks) AS seeks,
      SUM(fromPlaylist) AS fromPlaylist, SUM(direct) AS direct,
      SUM(manual) AS manual, SUM(advance) AS advance, SUM(repeat) AS repeat
    FROM ListeningSummary WHERE ownerId = ${ownerId}
  `;
  const saved = await db.$queryRaw<(Totals & { period: number; bytes: number })[]>`
    SELECT period, count(*) AS launches,
      SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partial,
      SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped,
      SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
      SUM(listened) AS listened, SUM(seeks) AS seeks,
      SUM(CASE WHEN playlistId IS NULL THEN 0 ELSE 1 END) AS fromPlaylist,
      SUM(CASE WHEN playlistId IS NULL THEN 1 ELSE 0 END) AS direct,
      SUM(CASE WHEN trigger = 'manual' THEN 1 ELSE 0 END) AS manual,
      SUM(CASE WHEN trigger = 'advance' THEN 1 ELSE 0 END) AS advance,
      SUM(CASE WHEN trigger = 'repeat' THEN 1 ELSE 0 END) AS repeat,
      SUM(CAST(bytes AS REAL)) AS bytes
    FROM (
      SELECT *, CASE WHEN startedAt >= ${sevenDays} THEN 7
        WHEN startedAt >= ${thirtyDays} THEN 30 ELSE 0 END AS period
      FROM ListeningAttempt WHERE ownerId = ${ownerId}
    )
    GROUP BY period
  `;
  const sum = (rows: Totals[]) => Object.fromEntries(metrics.map(field =>
    [field, rows.reduce((total, row) => total + Number(row[field]), 0)],
  ));
  const bytes = saved.reduce((total, row) => total + Number(row.bytes), 0);
  return {
    ...preferenceView(preference), bytes, thresholdBytes: threshold, overThreshold: bytes > threshold,
    ever: sum(ever ? [ever] : []),
    sevenDays: sum(saved.filter(row => Number(row.period) === 7)),
    thirtyDays: sum(saved.filter(row => Number(row.period) !== 0)),
  };
}

function csvField(value: string | number | Date | null | undefined) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return String(value);
  const safe = /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

const csvLine = (fields: Parameters<typeof csvField>[0][]) => fields.map(csvField).join(",") + "\r\n";

async function* attemptsCsv(db: Db, where: Prisma.ListeningAttemptWhereInput) {
  yield "\uFEFF" + csvLine(["id", "itemId", "itemTitle", "playlistId", "playlistTitle", "startedAt", "endedAt",
    "trigger", "outcome", "reason", "listenedSeconds", "seeks"]);
  let cursor: Cursor | undefined;
  for (;;) {
    const rows = await attemptBatch(db, where, batchSize, cursor);
    for (const a of rows) yield csvLine([a.id, a.itemId, a.itemTitle, a.playlistId,
      a.playlistTitle, a.startedAt, a.endedAt, a.trigger, a.outcome, a.reason, a.listened, a.seeks]);
    if (rows.length < batchSize) break;
    cursor = position(rows[rows.length - 1]!);
  }
}

async function* summaryCsv(db: Db, ownerId: string) {
  yield "\uFEFF" + csvLine(["itemId", "itemTitle", ...metrics, "lastStartedAt", "lastCompletedAt"]);
  let after: string | undefined;
  for (;;) {
    const rows: ListeningSummary[] = await db.listeningSummary.findMany({
      where: { ownerId, itemId: { gt: after } }, orderBy: { itemId: "asc" }, take: batchSize,
    });
    if (!rows.length) break;
    const items = await db.item.findMany({
      where: { ownerId, id: { in: rows.map(row => row.itemId) } }, select: { id: true, title: true },
    });
    const titles = new Map(items.map(item => [item.id, item.title]));
    for (const row of rows) yield csvLine([row.itemId, titles.get(row.itemId),
      ...metrics.map(field => row[field]), row.lastStartedAt, row.lastCompletedAt]);
    if (rows.length < batchSize) break;
    after = rows[rows.length - 1]!.itemId;
  }
}

function selected(ownerId: string, [from, to]: Interval) {
  return {
    ...attemptWhere(ownerId, { from: new Date(from), to: new Date(to) }),
    outcome: { not: "active" },
  };
}

async function cleanupSnapshot(db: Pick<Db, "$queryRaw" | "historyPreference">, ownerId: string, [from, to]: Interval) {
  const preference = await db.historyPreference.findUnique({ where: { ownerId } });
  const retention = createHash("sha256").update(JSON.stringify([
    preference?.resetAt ?? null, readPreference(preference).ranges,
  ])).digest("hex");
  const [row] = await db.$queryRaw<{ count: bigint; unfinished: bigint; bytes: number | null }[]>`
    SELECT count(*) FILTER (WHERE outcome <> 'active') AS count,
      count(*) FILTER (WHERE outcome = 'active') AS unfinished,
      SUM(CAST(bytes AS REAL)) FILTER (WHERE outcome <> 'active') AS bytes
    FROM ListeningAttempt
    WHERE ownerId = ${ownerId} AND startedAt >= ${new Date(from)}
      AND startedAt < ${new Date(to)}
  `;
  // Between retention changes, membership can only grow. Count plus the
  // retention fingerprint identifies the reviewed membership without reading IDs.
  return {
    count: Number(row?.count ?? 0), unfinishedCount: Number(row?.unfinished ?? 0),
    bytes: row?.bytes ?? 0, retention,
  };
}

function confirmationCodec() {
  const secret = randomBytes(32);
  const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest();
  return {
    create(data: z.infer<typeof confirmation>) {
      const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
      return payload + "." + sign(payload).toString("base64url");
    },
    parse(token: string) {
      try {
        const [payload, signature, extra] = token.split(".");
        if (!payload || !signature || extra !== undefined) return null;
        const actual = Buffer.from(signature, "base64url");
        if (actual.length !== 32 || !timingSafeEqual(actual, sign(payload))) return null;
        return confirmation.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
      } catch {
        return null;
      }
    },
  };
}

export function registerHistory(app: FastifyInstance, db: Db) {
  app.register(async (history) => {
    history.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "private, no-store");
      return payload;
    });
    registerHistoryRoutes(history, db);
  }, { prefix: base });
}

function registerHistoryRoutes(app: FastifyInstance, db: Db) {
  const tokens = confirmationCodec();
  async function owner(request: FastifyRequest) {
    invariant(!request.headers.authorization && request.user, 403,
      "browser_required", "История доступна только в браузере");
    const session = await app.auth.userBySession(request.cookies.hibiki_session);
    invariant(session?.id === request.user.id, 403, "browser_required", "Войдите в Hibiki в браузере");
    return request.user.id;
  }

  app.get("/preference", async (request) => {
    const ownerId = await owner(request);
    return preferenceView(await db.historyPreference.findUnique({ where: { ownerId } }));
  });
  app.put("/preference", async (request) => {
    const ownerId = await owner(request);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    return db.$transaction(async (tx) => {
      const before = await tx.historyPreference.findUnique({ where: { ownerId } });
      if (!enabled) {
        await tx.$executeRaw`
          UPDATE ListeningSummary AS summary
          SET partial = summary.partial + unfinished.count
          FROM (
            SELECT itemId, count(*) AS count FROM ListeningAttempt
            WHERE ownerId = ${ownerId} AND outcome = 'active' GROUP BY itemId
          ) AS unfinished
          WHERE summary.ownerId = ${ownerId} AND summary.itemId = unfinished.itemId
        `;
        // Only change the outcome. The last accepted checkpoint is still the
        // end of the measured interval, including for abandoned sessions.
        await tx.$executeRaw`
          UPDATE ListeningAttempt SET outcome = 'partial', reason = 'interrupted',
            bytes = bytes + length('partial') + length('interrupted') - length(outcome) - length(reason)
          WHERE ownerId = ${ownerId} AND outcome = 'active'
        `;
      }
      if (enabled === (before?.enabled ?? true)) return preferenceView(before);
      const prunedJson = JSON.stringify({ ...readPreference(before), recordAfter: Date.now() });
      const after = await tx.historyPreference.upsert({
        where: { ownerId }, create: { ownerId, enabled, prunedJson }, update: { enabled, prunedJson },
      });
      return preferenceView(after);
    });
  });
  app.post("/attempts", async (request) => {
    const ownerId = await owner(request);
    const input = attemptInput.parse(request.body);
    invariant(ownerId === input.ownerId, 403, "account_changed", "Аккаунт изменился");
    return recordAttempt(db, ownerId, input);
  });
  app.get("/attempts", async (request) => {
    const ownerId = await owner(request);
    const query = listQuery.parse(request.query);
    const rows = await attemptBatch(db, attemptWhere(ownerId, query), query.limit + 1, readCursor(query.cursor));
    const hasMore = rows.length > query.limit;
    if (hasMore) rows.pop();
    return {
      attempts: rows.map(publicAttempt),
      nextCursor: hasMore ? Buffer.from(JSON.stringify(position(rows[rows.length - 1]!))).toString("base64url") : null,
    };
  });
  app.get("/items/:id", async (request) => {
    const ownerId = await owner(request);
    const { id: itemId } = z.object({ id: key }).parse(request.params);
    const item = await db.item.findFirst({ where: { id: itemId, ownerId }, select: { id: true } });
    invariant(item, 404, "item_not_found", "Запись не найдена");
    const row = await db.listeningSummary.findFirst({ where: { itemId, ownerId } });
    const summary = { ...zero, lastStartedAt: null, lastCompletedAt: null };
    if (row) Object.assign(summary, Object.fromEntries(metrics.map((field) => [field, row[field]])), {
      lastStartedAt: row.lastStartedAt, lastCompletedAt: row.lastCompletedAt,
    });
    return { summary, journalUrl: "/settings?historyItem=" + encodeURIComponent(itemId) + "#history" };
  });
  app.get("/summary", async (request) => totals(db, await owner(request)));
  app.get("/attempts.csv", async (request, reply) => {
    const ownerId = await owner(request);
    const where = attemptWhere(ownerId, filterSchema.parse(request.query));
    const to = new Date(Date.now() + 1);
    if (!where.startedAt || !(where.startedAt as Prisma.DateTimeFilter).lt)
      where.startedAt = { ...(where.startedAt as Prisma.DateTimeFilter), lt: to };
    return reply.type("text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="hibiki-listening-history.csv"')
      .send(Readable.from(attemptsCsv(db, where)));
  });
  app.get("/summary.csv", async (request, reply) => {
    const ownerId = await owner(request);
    return reply.type("text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="hibiki-listening-summary.csv"')
      .send(Readable.from(summaryCsv(db, ownerId)));
  });
  app.get("/cleanup/context", async (request) => {
    const ownerId = await owner(request);
    const rows = await db.$queryRaw<{ month: string; count: bigint; bytes: number }[]>`
      SELECT substr(startedAt, 1, 7) AS month, count(*) AS count, SUM(CAST(bytes AS REAL)) AS bytes
      FROM ListeningAttempt WHERE ownerId = ${ownerId} AND outcome <> 'active'
      GROUP BY month ORDER BY month
    `;
    return { periods: rows.map(row => ({ ...row, count: Number(row.count) })) };
  });
  app.post("/cleanup/preview", async (request) => {
    const ownerId = await owner(request);
    const { from, to } = cleanupSelection.parse(request.body);
    const range: Interval = [from?.getTime() ?? 0, Math.min(to.getTime(), Date.now() + 1)];
    invariant(range[0] < range[1], 400, "invalid_period", "В выбранном периоде нет прошедших дней");
    return db.$transaction(async (tx) => {
      const { count, unfinishedCount, bytes, retention } = await cleanupSnapshot(tx, ownerId, range);
      const attempts = count ? await attemptBatch(tx, selected(ownerId, range), 10) : [];
      return {
        count, unfinishedCount, bytes, attempts: attempts.map(publicAttempt),
        from: from ?? null, to: new Date(range[1]),
        token: count ? tokens.create({ ownerId, range, count, retention, expires: Date.now() + 15 * 60_000 }) : null,
      };
    }, { timeout: 60_000 });
  });
  app.post("/cleanup/confirm", async (request) => {
    const ownerId = await owner(request);
    const { token } = z.object({ token: z.string().max(1000) }).strict().parse(request.body);
    const reviewed = tokens.parse(token);
    invariant(reviewed && reviewed.ownerId === ownerId && reviewed.expires > Date.now(),
      400, "preview_expired", "Откройте предпросмотр очистки заново");
    return db.$transaction(async (tx) => {
      const { range, count, retention } = reviewed;
      const current = await cleanupSnapshot(tx, ownerId, range);
      invariant(current.count === count && current.retention === retention, 409,
        "selection_changed", "История изменилась. Откройте предпросмотр очистки заново");
      const before = await tx.historyPreference.findUnique({ where: { ownerId } });
      const data = readPreference(before);
      const prunedJson = JSON.stringify({ ...data, ranges: mergeRanges(data.ranges, range) });
      const { count: deleted } = await tx.listeningAttempt.deleteMany({ where: selected(ownerId, range) });
      await tx.historyPreference.upsert({
        where: { ownerId }, create: { ownerId, prunedJson }, update: { prunedJson },
      });
      return { deleted };
    }, { timeout: 60_000 });
  });
  app.post("/reset", async (request) => {
    const ownerId = await owner(request);
    z.object({ confirm: z.literal(true) }).strict().parse(request.body);
    return db.$transaction(async (tx) => {
      const resetAt = new Date();
      await tx.listeningAttempt.deleteMany({ where: { ownerId } });
      await tx.listeningSummary.deleteMany({ where: { ownerId } });
      // Other tabs must discard the personal order even when their entire
      // selection fits on one page and they never request a cursor.
      await tx.user.update({ where: { id: ownerId }, data: { libraryRevision: { increment: 1 } } });
      await tx.historyPreference.upsert({
        where: { ownerId }, create: { ownerId, resetAt }, update: { resetAt, prunedJson: "[]" },
      });
      return { ok: true };
    }, { timeout: 60_000 });
  });
}
