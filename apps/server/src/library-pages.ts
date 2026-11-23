import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { librarySearchSchema, playlistDefinitionSchema, type LibrarySearch, type LibraryCardOverviewDto, type LibraryPageDto } from "@hibiki/contracts";
import type { Db } from "./db";
import { invariant } from "./errors";
import { itemDto, itemInclude, jobDto } from "./library";
import { listTags } from "./taxonomy";
import { browserOwner } from "./notes";

const pageSize = 100;
const titleOrder = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
const id = z.string().min(1).max(256);
const searchInput = z.object({
  filters: librarySearchSchema, timeZone: librarySearchSchema.shape.timeZone,
});
const pageInput = searchInput.extend({ cursor: z.string().max(100).optional() });
type SearchInput = z.infer<typeof pageInput>;
type Tx = Prisma.TransactionClient;

async function revision(tx: Tx, ownerId: string) {
  const row = await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { libraryRevision: true } });
  return String(row.libraryRevision);
}

async function overview(tx: Tx, ownerId: string, cardsOnly: boolean): Promise<LibraryCardOverviewDto> {
  const where = { ownerId };
  const [total, tags, counts, playlists, jobs, current] = await Promise.all([
    tx.item.count({ where }),
    listTags(tx, ownerId, true),
    facetCounts(tx, ownerId, Prisma.sql`i.ownerId = ${ownerId}`),
    tx.playlist.findMany({ where, select: {
      id: true, title: true, description: true, revision: true, manual: true, trackCount: true, definitionJson: !cardsOnly,
      createdAt: true, updatedAt: true, youtubeLink: { select: { playlistId: true } },
    }, orderBy: { createdAt: "asc" } }),
    tx.job.findMany({ where, orderBy: { createdAt: "desc" }, take: 50 }),
    revision(tx, ownerId),
  ]);
  return {
    tags: tags.filter(tag => !tag.archived),
    archivedTagNames: Object.fromEntries(tags.filter(tag => tag.archived).map(tag => [tag.id, tag.name])),
    playlists: playlists.map(({ createdAt, updatedAt, youtubeLink, definitionJson, ...card }) => ({
      ...card, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
      ...(youtubeLink ? { youtubeLinked: true } : {}),
      ...(cardsOnly ? {} : { definition: playlistDefinitionSchema.parse(JSON.parse(definitionJson)) }),
    })), jobs: jobs.map(jobDto), total,
    tagCounts: counts,
    revision: current,
  };
}

export async function hydrateLibraryItems(tx: Tx, ownerId: string, ids: string[]) {
  const rows = await tx.item.findMany({
    where: { ownerId, id: { in: ids } },
    include: {
      sources: { ...itemInclude.sources, where: { ownerId, OR: [{ fileId: null }, { file: { ownerId } }] } },
      tags: { ...itemInclude.tags, where: { tag: { ownerId } } },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, itemDto(row)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

function durationBound(value: string) {
  const n = Number(value);
  return value.trim() && Number.isFinite(n) && n >= 0 ? n : undefined;
}

// Find the first instant of a calendar date in the listener's zone, including
// days with a DST transition at midnight. Never assume that a day is 24 hours.
function dateBound(value: string, nextDay: boolean, zone?: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const day = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(+day)) return undefined;
  if (nextDay) day.setUTCDate(day.getUTCDate() + 1);
  const target = day.toISOString().slice(0, 10);
  const dates = new Intl.DateTimeFormat("sv-SE", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  let lo = +day - 86400000;
  let hi = +day + 86400000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dates.format(mid) < target) lo = mid + 1;
    else hi = mid;
  }
  return new Date(lo);
}

const ownedSource = Prisma.sql`s.itemId = i.id AND s.ownerId = i.ownerId AND
  (s.fileId IS NULL OR EXISTS (SELECT 1 FROM MediaFile f WHERE f.id = s.fileId AND f.ownerId = i.ownerId))`;

// UNION deduplicates a shared work reached through several studios. Materialize the
// owner's small catalog once per statement, including its transitive parent edges.
function catalogCte(ownerId: string) {
  return Prisma.sql`WITH RECURSIVE catalog AS MATERIALIZED (
    SELECT id, coalesce(label, name) AS label, aliases, parentIds, "group" AS tagGroup
    FROM Tag WHERE ownerId = ${ownerId} AND NOT archived
  ), ancestry(descendant, ancestor) AS (
    SELECT id, id FROM catalog
    UNION
    SELECT a.descendant, p.id FROM ancestry a JOIN catalog c ON c.id = a.ancestor
    JOIN json_each(c.parentIds) edge JOIN catalog p ON p.id = edge.value
  )`;
}

function missingFilter(group?: LibrarySearch["missingGroup"]) {
  const performance = Prisma.sql`i.performance = 'unknown'`;
  const voice = Prisma.sql`(i.performance = 'vocal' AND json_array_length(i.voices) = 0)`;
  if (group === "performance") return performance;
  if (group === "voice") return voice;
  const assigned = Prisma.sql`FROM ItemTag it JOIN catalog c ON c.id = it.tagId WHERE it.itemId = i.id`;
  if (group) return Prisma.sql`NOT EXISTS (SELECT 1 ${assigned} AND c.tagGroup = ${group})`;
  return Prisma.sql`(${performance} OR ${voice} OR (SELECT count(DISTINCT c.tagGroup)
    ${assigned} AND c.tagGroup IN ('source','artist','genre','mood')) < 4)`;
}

function itemFilter(ownerId: string, search: LibrarySearch, zone?: string) {
  const sql = Prisma.sql;
  const clauses = [sql`i.ownerId = ${ownerId}`];
  if (search.kind) clauses.push(sql`i.kind = ${search.kind}`);
  if (search.favoriteOnly) clauses.push(sql`i.favorite = 1`);
  const min = durationBound(search.minDuration);
  const max = durationBound(search.maxDuration);
  if (min !== undefined) clauses.push(sql`i.duration >= ${min}`);
  if (max !== undefined) clauses.push(sql`i.duration <= ${max}`);
  const from = dateBound(search.addedFrom, false, zone);
  const end = dateBound(search.addedThrough, true, zone);
  if (from) clauses.push(sql`julianday(i.createdAt) >= julianday(${from.toISOString()})`);
  if (end) clauses.push(sql`julianday(i.createdAt) < julianday(${end.toISOString()})`);

  const tagIds = [...new Set(search.tagIds)];
  if (tagIds.length) {
    const all = search.tagMode !== "or" ? sql`HAVING count(DISTINCT a.ancestor) = ${tagIds.length}` : Prisma.empty;
    clauses.push(sql`i.id IN (
      SELECT it.itemId FROM (
        SELECT descendant, ancestor FROM ancestry
        UNION ALL
        SELECT id, id FROM Tag WHERE ownerId = ${ownerId} AND archived
      ) a JOIN ItemTag it ON it.tagId = a.descendant
      WHERE a.ancestor IN (SELECT value FROM json_each(${JSON.stringify(tagIds)}))
      GROUP BY it.itemId ${all}
    )`);
  }
  if (search.performanceFilter === "male" || search.performanceFilter === "female") {
    clauses.push(sql`i.performance = 'vocal' AND EXISTS (SELECT 1 FROM json_each(i.voices) WHERE value = ${search.performanceFilter})`);
  } else if (search.performanceFilter) {
    clauses.push(sql`i.performance = ${search.performanceFilter}`);
  }
  if (search.needsClassification || search.missingGroup) clauses.push(missingFilter(search.missingGroup));
  const source = (condition: Prisma.Sql) => sql`EXISTS (
    SELECT 1 FROM Source s WHERE ${ownedSource} AND ${condition}
  )`;
  if (search.provider === "working-local") {
    clauses.push(source(sql`s.provider = 'local' AND s.status = 'available' AND s.fileId IS NOT NULL`));
  } else if (search.provider) {
    clauses.push(source(sql`s.provider = ${search.provider}`));
  }
  if (search.availability) {
    const available = source(sql`s.status = 'available'`);
    clauses.push(search.availability === "available" ? available : sql`NOT ${available}`);
    const unknown = source(sql`s.status = 'unknown'`);
    if (search.availability === "unknown") clauses.push(unknown);
    if (search.availability === "unavailable") clauses.push(sql`NOT ${unknown}`);
  }
  return Prisma.join(clauses, " AND ");
}

function orderBy(sort: LibrarySearch["sort"]) {
  const direction = sort.endsWith("-desc") ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  return sort.startsWith("duration")
    ? Prisma.sql`i.duration ${direction} NULLS LAST, i.id ASC`
    : Prisma.sql`i.createdAt ${direction}, i.id ASC`;
}

type SortKey = { id: string; title: string; duration: number | null; createdAt: Date };
function compare(a: SortKey, b: SortKey, sort: LibrarySearch["sort"]) {
  let order;
  if (sort.startsWith("duration")) {
    if (a.duration === null || b.duration === null)
      return Number(a.duration === null) - Number(b.duration === null) || a.id.localeCompare(b.id);
    order = a.duration - b.duration;
  } else if (sort.startsWith("title")) {
    order = titleOrder.compare(a.title, b.title);
  } else {
    order = +a.createdAt - +b.createdAt;
  }
  return (sort.endsWith("-desc") ? -order : order) || a.id.localeCompare(b.id);
}

// SQLite's built-in case folding is ASCII-only and its collations cannot
// reproduce Russian numeric title order. Read only matching candidate keys and
// search fields in batches, releasing the private notes after each batch.
async function matchingKeys(tx: Tx, ownerId: string, where: Prisma.Sql, search: LibrarySearch, browser: boolean) {
  const words = search.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const notes = browser ? Prisma.sql`coalesce(i.note, '') || ' ' || coalesce((
    SELECT group_concat(s.note, ' ') FROM Source s WHERE ${ownedSource}
  ), '')` : Prisma.sql`''`;
  const searchText = words.length ? Prisma.sql`
    i.originalTitle || ' ' || ${notes} || ' ' || coalesce((
      SELECT group_concat(c.label || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(c.aliases)), ''), ' ')
      FROM ItemTag it JOIN ancestry a ON a.descendant = it.tagId JOIN catalog c ON c.id = a.ancestor
      WHERE it.itemId = i.id
    ), '')` : Prisma.sql`NULL`;
  const keys: SortKey[] = [];
  let after = "";
  const take = 256;
  for (;;) {
    const rows = await tx.$queryRaw<(SortKey & { text: string | null })[]>(Prisma.sql`
      ${catalogCte(ownerId)}
      SELECT i.id, i.title, i.duration, i.createdAt, ${searchText} AS text FROM Item i
      WHERE ${where} AND i.id > ${after} ORDER BY i.id LIMIT ${take}
    `);
    for (const row of rows) {
      if (row.text !== null) {
        const text = (row.title + " " + row.text).toLocaleLowerCase();
        if (!words.every((word) => text.includes(word))) continue;
      }
      keys.push({ id: row.id, title: row.title, duration: row.duration, createdAt: row.createdAt });
    }
    if (rows.length < take) break;
    after = rows.at(-1)!.id;
  }
  return keys.sort((a, b) => compare(a, b, search.sort)).map(({ id }) => id);
}

export async function searchLibraryIds(tx: Tx, ownerId: string, search: LibrarySearch, zone?: string, browser = false) {
  const where = itemFilter(ownerId, search, zone);
  if (search.query.trim() || search.sort.startsWith("title")) return matchingKeys(tx, ownerId, where, search, browser);
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    ${catalogCte(ownerId)} SELECT i.id FROM Item i WHERE ${where} ORDER BY ${orderBy(search.sort)}
  `);
  return rows.map(row => row.id);
}

async function facetCounts(tx: Tx, ownerId: string, where: Prisma.Sql) {
  const rows = await tx.$queryRaw<{ id: string; total: bigint }[]>(Prisma.sql`
    ${catalogCte(ownerId)}, counts AS (
      SELECT a.ancestor, count(DISTINCT i.id) AS total FROM Item i
      JOIN ItemTag it ON it.itemId = i.id JOIN ancestry a ON a.descendant = it.tagId
      WHERE ${where} GROUP BY a.ancestor
    )
    SELECT c.id, coalesce(counts.total, 0) AS total FROM catalog c LEFT JOIN counts ON counts.ancestor = c.id
  `);
  return Object.fromEntries(rows.map(row => [row.id, Number(row.total)]));
}

function cursorOffset(input: string | undefined, key: string, revision: string) {
  if (!input) return 0;
  const parts = /^([a-f\d]{24})\.(\d+)\.(\d{1,9})$/.exec(input);
  invariant(parts && parts[1] === key, 400, "cursor", "Курсор не соответствует выборке");
  invariant(parts[2] === revision, 409, "library_changed", "Медиатека изменилась, обновите результаты");
  return Number(parts[3]);
}

export function registerLibraryPages(app: FastifyInstance, db: Db) {
  // The common added/duration paths use SQL COUNT and LIMIT. Remember a few
  // ID-only selections so scrolling a Unicode search does not repeat its scan.
  const selections = new Map<string, string[]>();
  const countsCache = new Map<string, Record<string, number>>();
  async function select(tx: Tx, ownerId: string, input: SearchInput, idsOnly: boolean) {
    const search = input.filters;
    const zone = input.timeZone ?? search.timeZone;
    const key = createHash("sha256").update(JSON.stringify([ownerId, search, zone])).digest("hex").slice(0, 24);
    const current = await revision(tx, ownerId);
    const offset = cursorOffset(input.cursor, key, current);
    const where = itemFilter(ownerId, search, zone);
    let ids: string[];
    let total: number;
    if (search.query.trim() || search.sort.startsWith("title")) {
      const cacheKey = key + "." + current;
      let all = selections.get(cacheKey);
      if (!all) {
        all = await matchingKeys(tx, ownerId, where, search, true);
        if (all.length <= 100_000) {
          if (selections.size >= 4) selections.delete(selections.keys().next().value!);
          selections.set(cacheKey, all);
        }
      }
      total = all.length;
      ids = idsOnly ? all : all.slice(offset, offset + pageSize);
    } else {
      const limit = idsOnly ? Prisma.empty : Prisma.sql`LIMIT ${pageSize} OFFSET ${offset}`;
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        ${catalogCte(ownerId)} SELECT i.id FROM Item i WHERE ${where} ORDER BY ${orderBy(search.sort)} ${limit}
      `);
      ids = rows.map(({ id }) => id);
      if (idsOnly) total = ids.length;
      else {
        const [count] = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`${catalogCte(ownerId)} SELECT count(*) AS total FROM Item i WHERE ${where}`);
        total = Number(count.total);
      }
    }
    if (idsOnly) return { ids };
    const end = offset + ids.length;
    let tagCounts: Record<string, number> | undefined;
    if (offset === 0) {
      const filters = { ...search, tagIds: [], tagMode: undefined, sort: "added-desc" as const };
      const cacheKey = JSON.stringify([ownerId, current, filters, zone]);
      tagCounts = countsCache.get(cacheKey);
      if (!tagCounts) {
        let eligible = itemFilter(ownerId, filters, zone);
        if (filters.query.trim()) {
          const matching = await searchLibraryIds(tx, ownerId, filters, zone, true);
          eligible = Prisma.sql`i.ownerId = ${ownerId} AND i.id IN (SELECT value FROM json_each(${JSON.stringify(matching)}))`;
        }
        tagCounts = await facetCounts(tx, ownerId, eligible);
        if (countsCache.size >= 8) countsCache.delete(countsCache.keys().next().value!);
        countsCache.set(cacheKey, tagCounts);
      }
    }
    return {
      items: await hydrateLibraryItems(tx, ownerId, ids), total, tagCounts,
      nextCursor: end < total ? `${key}.${current}.${end}` : null,
    } satisfies LibraryPageDto;
  }

  app.get<{ Querystring: { playlists?: string } }>("/api/library/overview", (request, reply) => {
    const ownerId = browserOwner(request, reply);
    return db.$transaction((tx) => overview(tx, ownerId, request.query.playlists === "summary"));
  });
  app.post("/api/library/page", (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const input = pageInput.parse(request.body);
    return db.$transaction((tx) => select(tx, ownerId, input, false));
  });
  app.post("/api/library/ids", (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const input = searchInput.parse(request.body);
    return db.$transaction((tx) => select(tx, ownerId, input, true));
  });
  app.post("/api/library/items", async (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const { ids } = z.object({ ids: z.array(id).max(pageSize) }).parse(request.body);
    return { items: await hydrateLibraryItems(db, ownerId, ids) };
  });
}
