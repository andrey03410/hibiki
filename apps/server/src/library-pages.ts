import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { shuffle } from "@hibiki/core";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { browserLibrarySearchSchema, playlistDefinitionSchema, type BrowserLibrarySearch, type LibrarySearch, type CompactLibraryOverviewDto, type LibraryDirectoryRow, type LibraryCardOverviewDto, type ItemDto, type LibraryCardDto } from "@hibiki/contracts";
import type { Db } from "./db";
import { invariant } from "./errors";
import { jobDto, type LibraryService } from "./library";
import { listTags } from "./taxonomy";
import { browserOwner } from "./notes";
import { LibrarySelections } from "./library-selections";
import { audioClasses } from "@hibiki/contracts";
import { parseStoredQuality } from "./media-quality";

const pageSize = 100;
const titleOrder = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
const id = z.string().min(1).max(256);
const searchInput = z.object({
  filters: browserLibrarySearchSchema, timeZone: browserLibrarySearchSchema.shape.timeZone,
  selectionId: z.string().min(1).max(100).optional(),
});
const pageInput = searchInput.extend({ cursor: z.string().max(100).optional(), countsKey: z.string().max(100).optional(),
  cards: z.boolean().optional(), indexedCounts: z.boolean().optional(), picker: z.boolean().optional(), tagRevision: z.string().max(100).optional() });
type SearchInput = z.infer<typeof pageInput>;
type FacetCounts = { tags: Record<string, number>; audio: Record<string, number> };
type Tx = Prisma.TransactionClient;

async function revision(tx: Tx, ownerId: string) {
  const row = await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { libraryRevision: true } });
  return String(row.libraryRevision);
}

// Existing published cards can remain fresh indefinitely without a library edit.
function publishedCoverUrls(json: string): string[] {
  return (JSON.parse(json) as string[]).map(url => url
    .replace(/^(\/api\/items\/[^/]+\/artwork)\?size=thumb$/, "$1?size=cover")
    .replace(/^(https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/)(?:mqdefault|default)\.jpg$/, "$1sddefault.jpg"));
}

function facetToken(ownerId: string, revision: string, search: BrowserLibrarySearch, zone?: string) {
  const scope = [ownerId, revision, search.query.trim(), search.kind, search.provider, search.availability, search.favoriteOnly,
    search.minDuration, search.maxDuration, search.addedFrom, search.addedThrough,
    search.addedFrom || search.addedThrough ? zone : "", search.performanceFilter || "", !!search.needsClassification,
    search.missingGroup || "", search.sort === "recent", [...(search.audioQuality ?? [])].sort(),
    ...(search.tagSets?.length ? [search.tagSets.map(set => [set.group, [...set.ids].sort(), !!set.all])] : [])];
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 24);
}

async function overview(tx: Tx, ownerId: string, cardsOnly: boolean, current: string, overviewToken: string): Promise<LibraryCardOverviewDto> {
  const where = { ownerId };
  const [total, tags, counts, quality, playlists, jobs] = await Promise.all([
    tx.item.count({ where }),
    listTags(tx, ownerId, true),
    facetCounts(tx, ownerId, Prisma.sql`i.ownerId = ${ownerId}`),
    audioCounts(tx, ownerId, Prisma.sql`i.ownerId = ${ownerId}`),
    tx.playlist.findMany({ where, select: {
      id: true, title: true, description: true, revision: true, manual: true, trackCount: true,
      coverUrlsJson: cardsOnly, definitionJson: !cardsOnly,
      createdAt: true, updatedAt: true, youtubeLink: { select: { playlistId: true } },
    }, orderBy: { createdAt: "asc" } }),
    tx.job.findMany({ where, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return {
    tags: tags.filter(tag => !tag.archived),
    archivedTagNames: Object.fromEntries(tags.filter(tag => tag.archived).map(tag => [tag.id, tag.name])),
    playlists: playlists.map(({ createdAt, updatedAt, youtubeLink, definitionJson, coverUrlsJson, ...card }) => ({
      ...card, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
      ...(youtubeLink ? { youtubeLinked: true } : {}),
      ...(coverUrlsJson ? { coverUrls: publishedCoverUrls(coverUrlsJson) } : {}),
      ...(cardsOnly ? {} : { definition: playlistDefinitionSchema.parse(JSON.parse(definitionJson)) }),
    })), jobs: jobs.map(jobDto), total,
    tagCounts: counts, audioCounts: quality,
    revision: current, overviewToken, countsKey: facetToken(ownerId, current, browserLibrarySearchSchema.parse({})),
  };
}

function compactOverview(value: LibraryCardOverviewDto, indexes: Map<string, number>): CompactLibraryOverviewDto {
  const {tags, tagCounts, ...summary} = value;
  const directory = tags.map(tag => {
    const row: LibraryDirectoryRow = [tag.id, tag.name, tag.color, tag.group!, tagCounts[tag.id]!];
    if (tag.aliases?.length) row[5] = tag.aliases;
    if (tag.parentIds?.length) row[6] = tag.parentIds.map(id => indexes.get(id) ?? id);
    if (tag.legacyFlat) row[7] = true;
    return row;
  });
  return {...summary, directory};
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

// The file that represents a recording, chosen like `itemAudioQuality`: the sound of an
// assigned visual, the preferred source, then the first available local file.
const qualityFile = Prisma.sql`(SELECT f.id FROM Source s JOIN MediaFile f ON f.id = s.fileId AND f.ownerId = s.ownerId
  WHERE s.itemId = i.id AND s.ownerId = i.ownerId AND s.provider = 'local' AND s.status = 'available'
  ORDER BY s.id = (SELECT v.soundSourceId FROM ItemVisual v WHERE v.itemId = i.id) DESC,
    s.id = i.preferredSourceId DESC, s.rowid LIMIT 1)`;
const qualityScore = Prisma.sql`(SELECT q.audioScore FROM MediaFile q WHERE q.id = ${qualityFile})`;
const qualitySort = (sort: string) => sort.startsWith("quality");

/** Values are a class, a format or `class.format`, combined with OR. */
function audioQualityFilter(values: readonly string[] | undefined) {
  if (!values?.length) return;
  const sql = Prisma.sql;
  const parts = [...new Set(values)].map(value => {
    if ((audioClasses as readonly string[]).includes(value)) return sql`q.audioClass = ${value}`;
    const [quality, format] = value.split(".");
    return format ? sql`(q.audioClass = ${quality} AND q.audioFormat = ${format})` : sql`q.audioFormat = ${value}`;
  });
  return sql`EXISTS (SELECT 1 FROM MediaFile q WHERE q.id = ${qualityFile} AND (${Prisma.join(parts, " OR ")}))`;
}

async function audioCounts(tx: Tx, ownerId: string, where: Prisma.Sql) {
  const rows = await tx.$queryRaw<{ audioClass: string; audioFormat: string | null; total: bigint }[]>(Prisma.sql`
    ${catalogCte(ownerId)} SELECT q.audioClass, q.audioFormat, count(*) AS total
    FROM Item i JOIN MediaFile q ON q.id = ${qualityFile}
    WHERE ${where} AND q.audioClass IS NOT NULL GROUP BY q.audioClass, q.audioFormat`);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.audioClass] = (counts[row.audioClass] ?? 0) + Number(row.total);
    if (row.audioFormat) counts[row.audioClass + "." + row.audioFormat] = Number(row.total);
  }
  return counts;
}

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

type BorrowedStatus = { available: string[]; unknown: string[] };

async function borrowedStatus(tx: Tx, ownerId: string, search: BrowserLibrarySearch, library: LibraryService): Promise<BorrowedStatus | undefined> {
  if (!search.availability) return;
  const tracks = await tx.sharedTrack.findMany({
    where: { recipientId: ownerId }, select: { recipientItemId: true }, orderBy: { recipientItemId: "asc" },
  });
  if (!tracks.length) return;
  const status: BorrowedStatus = { available: [], unknown: [] };
  const batchSize = 500;
  for (let start = 0; start < tracks.length; start += batchSize) {
    const ids = tracks.slice(start, start + batchSize).map(track => track.recipientItemId);
    const items = await library.itemWindow(tx, ownerId, ids);
    for (const item of items) {
      if (item.sources.some(source => source.shared && source.status === "available")) status.available.push(item.id);
      if (item.sources.some(source => source.shared && source.status === "unknown")) status.unknown.push(item.id);
    }
  }
  return status;
}

type TagSet = { ids: string[]; all?: boolean };

function tagSetFilter(ownerId: string, set: TagSet) {
  const tagIds = [...new Set(set.ids)];
  const selected = tagIds.length === 1
    ? Prisma.sql`= ${tagIds[0]}`
    : Prisma.sql`IN (SELECT value FROM json_each(${JSON.stringify(tagIds)}))`;
  if (tagIds.length === 1 || !set.all) {
    return Prisma.sql`i.id IN (
      SELECT it.itemId FROM ItemTag it WHERE it.tagId IN (
        SELECT descendant FROM ancestry WHERE ancestor ${selected}
        UNION ALL SELECT id FROM Tag WHERE ownerId = ${ownerId} AND archived AND id ${selected}
      )
    )`;
  }
  return Prisma.sql`i.id IN (
    SELECT it.itemId FROM (
      SELECT descendant, ancestor FROM ancestry
      UNION ALL SELECT id, id FROM Tag WHERE ownerId = ${ownerId} AND archived
    ) a JOIN ItemTag it ON it.tagId = a.descendant
    WHERE a.ancestor ${selected} GROUP BY it.itemId HAVING count(DISTINCT a.ancestor) = ${tagIds.length}
  )`;
}

/** The tag sets a search applies: explicit site sets, or the legacy flat selection. */
function searchTagSets(search: BrowserLibrarySearch): (TagSet & { group?: string })[] {
  if (search.tagSets?.length) return search.tagSets;
  const tagIds = [...new Set(search.tagIds)];
  return tagIds.length ? [{ ids: tagIds, all: search.tagMode !== "or" }] : [];
}

function tagFilter(ownerId: string, sets: TagSet[]) {
  if (!sets.length) return;
  return Prisma.join(sets.map(set => tagSetFilter(ownerId, set)), " AND ");
}

function itemFilter(ownerId: string, search: BrowserLibrarySearch, zone?: string, borrowed?: BorrowedStatus) {
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

  const tags = tagFilter(ownerId, searchTagSets(search));
  if (tags) clauses.push(tags);
  if (search.sort === "recent") clauses.push(sql`i.id IN (
    SELECT itemId FROM ListeningSummary WHERE ownerId = ${ownerId} AND lastStartedAt IS NOT NULL
  )`);
  if (search.performanceFilter === "male" || search.performanceFilter === "female") {
    clauses.push(sql`i.performance = 'vocal' AND EXISTS (SELECT 1 FROM json_each(i.voices) WHERE value = ${search.performanceFilter})`);
  } else if (search.performanceFilter) {
    clauses.push(sql`i.performance = ${search.performanceFilter}`);
  }
  if (search.needsClassification || search.missingGroup) clauses.push(missingFilter(search.missingGroup));
  const quality = audioQualityFilter(search.audioQuality);
  if (quality) clauses.push(quality);
  const source = (condition: Prisma.Sql) => sql`EXISTS (
    SELECT 1 FROM Source s WHERE ${ownedSource} AND ${condition}
  )`;
  if (search.provider === "working-local") {
    clauses.push(source(sql`s.provider = 'local' AND s.status = 'available' AND s.fileId IS NOT NULL`));
  } else if (search.provider) {
    clauses.push(source(sql`s.provider = ${search.provider}`));
  }
  if (search.availability) {
    const withBorrowed = (status: keyof BorrowedStatus) => {
      const own = source(sql`s.status = ${status}`);
      const ids = borrowed?.[status];
      return ids?.length ? sql`(${own} OR i.id IN (SELECT value FROM json_each(${JSON.stringify(ids)})))` : own;
    };
    const available = withBorrowed("available");
    clauses.push(search.availability === "available" ? available : sql`NOT ${available}`);
    const unknown = withBorrowed("unknown");
    if (search.availability === "unknown") clauses.push(unknown);
    if (search.availability === "unavailable") clauses.push(sql`NOT ${unknown}`);
  }
  return Prisma.join(clauses, " AND ");
}

function historySort(sort: BrowserLibrarySearch["sort"]) {
  return sort === "popular" || sort === "recent";
}

function snapshotSort(sort: BrowserLibrarySearch["sort"]) {
  return historySort(sort) || sort === "random";
}

function orderBy(sort: BrowserLibrarySearch["sort"]) {
  if (sort === "popular") return Prisma.sql`coalesce(h.completed, 0) DESC, h.lastStartedAt DESC NULLS LAST, i.id ASC`;
  if (sort === "recent") return Prisma.sql`h.lastStartedAt DESC, i.id ASC`;
  if (sort === "random") return Prisma.sql`i.id ASC`;
  const direction = sort.endsWith("-desc") ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  if (qualitySort(sort)) return Prisma.sql`${qualityScore} ${direction} NULLS LAST, i.id ASC`;
  return sort.startsWith("duration")
    ? Prisma.sql`i.duration ${direction} NULLS LAST, i.id ASC`
    : Prisma.sql`i.createdAt ${direction}, i.id ASC`;
}

type SortKey = { id: string; title: string; duration: number | null; createdAt: Date; quality?: number | null };
function compare(a: SortKey, b: SortKey, sort: BrowserLibrarySearch["sort"]) {
  let order;
  if (qualitySort(sort)) {
    const left = a.quality ?? null, right = b.quality ?? null;
    if (left === null || right === null)
      return Number(left === null) - Number(right === null) || a.id.localeCompare(b.id);
    order = left - right;
  } else if (sort.startsWith("duration")) {
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
async function matchingKeys(tx: Tx, ownerId: string, where: Prisma.Sql, search: BrowserLibrarySearch, browser: boolean, signal?: AbortSignal) {
  const words = search.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const notes = browser ? Prisma.sql`coalesce(i.note, '') || ' ' || coalesce((
    SELECT group_concat(s.note, ' ') FROM Source s WHERE ${ownedSource}
  ), '')` : Prisma.sql`''`;
  // Resolve each assigned tag's name, aliases and inherited labels once. A
  // correlated ancestry join per item repeats this work for the whole catalog.
  const tagLabels = words.length ? await tx.$queryRaw<{id: string; labels: string}[]>(Prisma.sql`
    ${catalogCte(ownerId)}
    SELECT a.descendant AS id, group_concat(c.label || ' ' || coalesce((
      SELECT group_concat(value, ' ') FROM json_each(c.aliases)), ''), ' ') AS labels
    FROM ancestry a JOIN catalog c ON c.id = a.ancestor GROUP BY a.descendant
  `) : [];
  const labels = new Map(tagLabels.map(row => [row.id, row.labels.toLocaleLowerCase()]));
  const fields = words.length ? Prisma.sql`i.originalTitle || ' ' || ${notes} AS text,
    (SELECT json_group_array(it.tagId) FROM ItemTag it WHERE it.itemId = i.id) AS assigned`
    : Prisma.sql`NULL AS text, NULL AS assigned`;
  const keys: SortKey[] = [];
  let after = "";
  const take = 256;
  for (;;) {
    signal?.throwIfAborted();
    const quality = qualitySort(search.sort) ? qualityScore : Prisma.sql`NULL`;
    const rows = await tx.$queryRaw<(SortKey & { text: string | null; assigned: string | null })[]>(Prisma.sql`
      ${catalogCte(ownerId)}
      SELECT i.id, i.title, i.duration, i.createdAt, ${quality} AS quality, ${fields} FROM Item i
      WHERE ${where} AND i.id > ${after} ORDER BY i.id LIMIT ${take}
    `);
    for (const row of rows) {
      if (row.text !== null) {
        const text = (row.title + " " + row.text).toLocaleLowerCase();
        const remaining = words.filter(word => !text.includes(word));
        if (remaining.length) {
          const assigned: string[] = JSON.parse(row.assigned!);
          if (!remaining.every(word => assigned.some(id => labels.get(id)?.includes(word)))) continue;
        }
      }
      keys.push({ id: row.id, title: row.title, duration: row.duration, createdAt: row.createdAt,
        quality: row.quality === null || row.quality === undefined ? null : Number(row.quality) });
    }
    if (rows.length < take) break;
    after = rows.at(-1)!.id;
    // The synchronous SQLite adapter can chain all batches in microtasks.
    // Let a disconnected browser release the transaction before the next scan.
    if (signal) await setImmediate();
  }
  if (!snapshotSort(search.sort)) keys.sort((a, b) => compare(a, b, search.sort));
  return keys.map(({ id }) => id);
}

export async function searchLibraryIds(tx: Tx, ownerId: string, search: LibrarySearch, library: LibraryService, zone?: string, browser = false) {
  const borrowed = await borrowedStatus(tx, ownerId, search, library);
  const where = itemFilter(ownerId, search, zone, borrowed);
  if (search.query.trim() || search.sort.startsWith("title")) return matchingKeys(tx, ownerId, where, search, browser);
  return orderedIds(tx, ownerId, where, search.sort);
}

// MCP cursors identify the last visible item. Cheap date/duration orders can
// seek straight to it. Locale-aware text matches and natural title ordering
// are calculated in JS and reused only within the same owner and library revision.
export class McpMediaPages {
  private readonly orders = new Map<string, string[]>();

  async read(tx: Tx, ownerId: string, search: LibrarySearch, library: LibraryService, limit: number, cursor?: string) {
    const borrowed = await borrowedStatus(tx, ownerId, search, library);
    const where = itemFilter(ownerId, search, search.timeZone, borrowed);
    if (search.query.trim() || search.sort.startsWith("title")) {
      // Borrowed source availability can change without a recipient library edit.
      const key = search.availability ? undefined : createHash("sha256")
        .update(JSON.stringify([ownerId, await revision(tx, ownerId), search])).digest("hex");
      let ids = key ? this.orders.get(key) : undefined;
      if (!ids) {
        ids = await matchingKeys(tx, ownerId, where, search, false);
        if (key && ids.length <= 50_000) {
          if (this.orders.size >= 8) this.orders.delete(this.orders.keys().next().value!);
          this.orders.set(key, ids);
        }
      }
      const index = cursor ? ids.indexOf(cursor) : -1;
      invariant(!cursor || index >= 0, 400, "cursor", "Курсор не найден");
      return ids.slice(index + 1, index + limit + 2);
    }

    let after = Prisma.empty;
    if (cursor) {
      // Duration and quality may be missing; such records come last in both directions.
      const duration = search.sort.startsWith("duration") || qualitySort(search.sort);
      const column = qualitySort(search.sort) ? qualityScore : duration ? Prisma.sql`i.duration` : Prisma.sql`i.createdAt`;
      // Preserve the exact stored SQLite timestamp (including its precision).
      const anchor = duration ? column : Prisma.sql`CAST(i.createdAt AS TEXT)`;
      const [row] = await tx.$queryRaw<{value: string | number | null}[]>(Prisma.sql`
        ${catalogCte(ownerId)} SELECT ${anchor} AS value FROM Item i WHERE ${where} AND i.id = ${cursor}
      `);
      invariant(row, 400, "cursor", "Курсор не найден");
      const direction = search.sort.endsWith("desc") ? Prisma.sql`<` : Prisma.sql`>`;
      if (row.value === null) after = Prisma.sql` AND ${column} IS NULL AND i.id > ${cursor}`;
      else after = Prisma.sql` AND (${column} ${direction} ${row.value}
        OR (${column} = ${row.value} AND i.id > ${cursor}) ${duration ? Prisma.sql`OR ${column} IS NULL` : Prisma.empty})`;
    }
    return orderedIds(tx, ownerId, Prisma.sql`${where}${after}`, search.sort, Prisma.sql`LIMIT ${limit + 1}`);
  }
}

export async function itemSummaries(tx: Tx, ownerId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx.$queryRaw<{ id: string; title: string; kind: string; duration: number | null; quality: string | null }[]>(Prisma.sql`
    SELECT i.id, i.title, i.kind, i.duration, (SELECT q.quality FROM MediaFile q WHERE q.id = ${qualityFile}) AS quality
    FROM json_each(${JSON.stringify(ids)}) member CROSS JOIN Item i ON i.id = member.value AND i.ownerId = ${ownerId}
    ORDER BY member.key`);
  return rows.map(({ quality, ...row }) => {
    const stored = parseStoredQuality(quality);
    const audio = (stored?.origin ?? stored)?.audio;
    return { ...row, ...(audio && { audioQuality: { label: audio.label, class: audio.class, format: audio.format } }) };
  });
}

async function facetRows(tx: Tx, ownerId: string, where: Prisma.Sql) {
  return tx.$queryRaw<{ id: string; tagGroup: string | null; total: bigint }[]>(Prisma.sql`
    ${catalogCte(ownerId)}, counts AS (
      SELECT a.ancestor, count(DISTINCT i.id) AS total FROM Item i
      JOIN ItemTag it ON it.itemId = i.id JOIN ancestry a ON a.descendant = it.tagId
      WHERE ${where} GROUP BY a.ancestor
    )
    SELECT c.id, c.tagGroup, coalesce(counts.total, 0) AS total FROM catalog c LEFT JOIN counts ON counts.ancestor = c.id
  `);
}

async function facetCounts(tx: Tx, ownerId: string, where: Prisma.Sql) {
  return Object.fromEntries((await facetRows(tx, ownerId, where)).map(row => [row.id, Number(row.total)]));
}

/**
 * Faceted counts for grouped tag sets: tags of a group with a chosen set are
 * counted without that set (so siblings stay comparable), every other tag with
 * all sets applied. Costs one query per chosen group plus one.
 * Only the first set of a group is skipped for that group's counts.
 */
async function groupedFacetCounts(tx: Tx, ownerId: string, eligible: Prisma.Sql, sets: NonNullable<BrowserLibrarySearch["tagSets"]>) {
  const narrowed = (skip?: number) => {
    const filter = tagFilter(ownerId, sets.filter((_, index) => index !== skip));
    return filter ? Prisma.sql`${eligible} AND ${filter}` : eligible;
  };
  const counts = await facetCounts(tx, ownerId, narrowed());
  // The first set of a group is its facet choice; later sets of that group always apply.
  for (const [index, set] of sets.entries()) {
    if (sets.findIndex(other => other.group === set.group) !== index) continue;
    for (const row of await facetRows(tx, ownerId, narrowed(index))) {
      if ((row.tagGroup ?? "extra") === set.group) counts[row.id] = Number(row.total);
    }
  }
  return counts;
}

function cursorOffset(input: string | undefined, key: string, revision: string) {
  if (!input) return 0;
  const parts = /^([a-f\d]{24})\.(\d+(?:-[a-f\d]{16})?)\.(\d{1,9})$/.exec(input);
  invariant(parts && parts[1] === key, 400, "cursor", "Курсор не соответствует выборке");
  invariant(parts[2] === revision, 409, "library_changed", "Медиатека изменилась, обновите результаты");
  return Number(parts[3]);
}

function idFilter(ids: string[]) {
  return Prisma.sql`i.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}

async function orderedIds(tx: Tx, ownerId: string, where: Prisma.Sql, sort: BrowserLibrarySearch["sort"], limit = Prisma.empty) {
  const summary = historySort(sort)
    ? Prisma.sql`LEFT JOIN ListeningSummary h ON h.itemId = i.id AND h.ownerId = i.ownerId`
    : Prisma.empty;
  const rows = await tx.$queryRaw<{id: string}[]>(Prisma.sql`
    ${catalogCte(ownerId)} SELECT i.id FROM Item i ${summary} WHERE ${where} ORDER BY ${orderBy(sort)} ${limit}
  `);
  return rows.map(row => row.id);
}

async function selectionIds(
  tx: Tx, ownerId: string, where: Prisma.Sql, search: BrowserLibrarySearch, signal: AbortSignal, textMatches?: string[],
) {
  let all = textMatches;
  if (all) {
    // Text matches cover the facet scope; tags and quality narrow them here.
    const narrowing = [tagFilter(ownerId, searchTagSets(search)), audioQualityFilter(search.audioQuality)].filter(part => part !== undefined);
    if (narrowing.length) {
      const tags = Prisma.join(narrowing, " AND ");
      const tagged = await tx.$queryRaw<{id: string}[]>(Prisma.sql`
        ${catalogCte(ownerId)} SELECT i.id FROM Item i WHERE i.ownerId = ${ownerId} AND ${tags} AND ${idFilter(all)}
      `);
      const keep = new Set(tagged.map(row => row.id));
      all = all.filter(id => keep.has(id));
    }
  } else if (search.query.trim() || search.sort.startsWith("title")) {
    all = await matchingKeys(tx, ownerId, where, search, true, signal);
  }
  if (!all || historySort(search.sort)) {
    const eligible = all ? Prisma.sql`i.ownerId = ${ownerId} AND ${idFilter(all)}` : where;
    all = await orderedIds(tx, ownerId, eligible, search.sort);
  }
  return search.sort === "random" ? shuffle(all, search.randomSeed) : all;
}

async function whileConnected<T>(reply: FastifyReply, run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  reply.raw.once("close", abort);
  try {
    if (reply.raw.destroyed) abort();
    return await run(controller.signal);
  } finally {
    reply.raw.off("close", abort);
  }
}

export function registerLibraryPages(app: FastifyInstance, db: Db, library: LibraryService) {
  const selections = new Map<string, string[]>();
  let retainedSelectionIds = 0;
  const tagDirectories = new Map<string, { revision: string; indexes: Map<string, number> }>();
  const countsCache = new Map<string, FacetCounts>();
  let compactSummary: {token: string; json: string} | undefined;
  let previousText: {scope: string; query: string; ids: string[]} | undefined;
  const snapshots = new LibrarySelections();
  app.addHook("onClose", async () => snapshots.close());
  async function select(tx: Tx, ownerId: string, input: SearchInput, idsOnly: boolean, signal: AbortSignal) {
    const search = input.filters;
    const zone = input.timeZone ?? search.timeZone;
    const key = createHash("sha256").update(JSON.stringify([ownerId, search, zone])).digest("hex").slice(0, 24);
    const borrowed = await borrowedStatus(tx, ownerId, search, library);
    const sharedRevision = borrowed ? "-" + createHash("sha256").update(JSON.stringify(borrowed)).digest("hex").slice(0, 16) : "";
    const current = (await revision(tx, ownerId)) + sharedRevision;
    signal.throwIfAborted();
    const frozen = snapshotSort(search.sort);
    let offset = 0;
    let selectionId = input.selectionId;
    if (frozen && input.cursor) {
      const parts = /^s\.([a-f0-9-]{36})\.(\d{1,9})$/.exec(input.cursor);
      invariant(parts && (!selectionId || selectionId === parts[1]), 400, "cursor", "Курсор не соответствует выборке");
      selectionId = parts[1];
      offset = Number(parts[2]);
    } else {
      offset = cursorOffset(input.cursor, key, current);
    }

    const countsKey = facetToken(ownerId, current, search, zone);
    async function page(ids: string[], total: number, facetCounts?: FacetCounts) {
      const tagCounts = facetCounts?.tags;
      const end = offset + ids.length;
      const prefix = selectionId ? "s." + selectionId : key + "." + current;
      const nextCursor = end < total ? prefix + "." + end : null;
      if (input.picker) {
        return {items: await itemSummaries(tx, ownerId, ids), total, nextCursor};
      }
      // Recent selections freeze history separately from library mutations.
      const token = search.sort === "recent" ? countsKey + "." + selectionId : countsKey;
      const directory = tagDirectories.get(ownerId);
      const indexes = directory?.revision === current && input.tagRevision === current ? directory.indexes : undefined;
      const indexed = input.cards && input.indexedCounts && indexes && tagCounts;
      const counts = offset > 0 ? {} : token === input.countsKey
        ? { countsKey: token, countsUnchanged: true }
        : indexed ? { countsKey: token, countsByIndex: Array.from(indexes.keys(), id => tagCounts[id] ?? 0), audioCounts: facetCounts?.audio }
        : { countsKey: token, tagCounts, audioCounts: facetCounts?.audio };
      const items = await library.itemWindow(tx, ownerId, ids);
      const pageInfo = { total, ...counts, selectionId, nextCursor };
      if (!input.cards) return { ...pageInfo, items };
      const tags = new Map<string, ItemDto["tags"][number]>();
      const cards: LibraryCardDto[] = items.map(({tags: assigned, originalTitle, updatedAt, ...item}) => {
        for (const tag of assigned) {
          if (tag.archived || input.tagRevision !== current) tags.set(tag.id, tag);
        }
        return { ...item, tagRefs: assigned.map(tag => indexes?.get(tag.id) ?? tag.id),
          // The browser plays the authorized stream URL and requests artwork
          // by its versioned URL. Storage identity is only needed by exports.
          sources: item.sources.map(({hash, fileId, ...source}) => source),
          ...(originalTitle !== item.title && { originalTitle }), ...(updatedAt !== item.createdAt && { updatedAt }) };
      });
      return { ...pageInfo, items: cards, tags: [...tags.values()] };
    }
    if (selectionId || (frozen && idsOnly)) {
      const selection = snapshots.get(selectionId, key, current);
      if (idsOnly) return { ids: Array.isArray(selection.ids) ? selection.ids : selection.ids.slice() };
      return page(selection.ids.slice(offset, offset + pageSize), selection.ids.length,
        offset === 0 ? { tags: selection.tagCounts, audio: selection.audioCounts ?? {} } : undefined);
    }

    const where = itemFilter(ownerId, search, zone, borrowed);
    const cacheKey = key + "." + current;
    const text = Boolean(search.query.trim());
    // Facets leave out the chosen tags and quality: each facet is counted without its own choice.
    const facets = { ...search, tagIds: [], tagMode: undefined, tagSets: undefined, randomSeed: undefined, audioQuality: [],
      sort: search.sort === "recent" ? "recent" as const : "added-desc" as const };
    const facetKey = countsKey;
    // New recent snapshots must include starts since the previous first page.
    let counts = !idsOnly && offset === 0 && search.sort !== "recent" ? countsCache.get(facetKey) : undefined;
    let all = frozen ? undefined : selections.get(cacheKey);
    let textMatches: string[] | undefined;
    if (!idsOnly && (!input.picker || frozen) && offset === 0 && !counts && (frozen || countsKey !== input.countsKey)) {
      let eligible = itemFilter(ownerId, facets, zone, borrowed);
      if (text) {
        // Facets ignore the selected tags. One pass over these broader matches
        // supplies both the counts and the (possibly narrower) ordered list.
        const query = search.query.trim().toLocaleLowerCase();
        const scope = facetToken(ownerId, current, {...facets, query: ""}, zone);
        // Appending to the last word (or adding another word) can only narrow the
        // matches. Use the complete untagged result, never one page of visible rows.
        const prior = !frozen && previousText?.scope === scope && query.startsWith(previousText.query)
          ? previousText.ids : undefined;
        if (all && !search.tagIds.length && !search.tagSets?.length && !search.audioQuality.length) textMatches = all;
        else if (prior?.length === 0) textMatches = [];
        else {
          const candidates = prior ? Prisma.sql`${eligible} AND ${idFilter(prior)}` : eligible;
          textMatches = await matchingKeys(tx, ownerId, candidates, search, true, signal);
        }
        if (!frozen && textMatches.length <= 4096) previousText = {scope, query, ids: textMatches};
        eligible = Prisma.sql`i.ownerId = ${ownerId} AND ${idFilter(textMatches)}`;
      }
      const quality = audioQualityFilter(search.audioQuality);
      const tagScope = quality ? Prisma.sql`${eligible} AND ${quality}` : eligible;
      const tags = tagFilter(ownerId, searchTagSets(search));
      counts = {
        tags: search.tagSets?.length
          ? await groupedFacetCounts(tx, ownerId, tagScope, search.tagSets)
          : await facetCounts(tx, ownerId, tagScope),
        audio: await audioCounts(tx, ownerId, tags ? Prisma.sql`${eligible} AND ${tags}` : eligible),
      };
      if (search.sort !== "recent") {
        if (countsCache.size >= 8) countsCache.delete(countsCache.keys().next().value!);
        countsCache.set(facetKey, counts);
      }
    }

    if (!all && (frozen || text || search.sort.startsWith("title"))) {
      all = await selectionIds(tx, ownerId, where, search, signal, textMatches);
      signal.throwIfAborted();
      if (frozen) {
        selectionId = snapshots.add({ key, revision: current, ids: all, tagCounts: counts!.tags, audioCounts: counts!.audio });
      } else if (all.length <= 100_000) {
        // Short text matches consume very few IDs. Keep recent queries across
        // successive track searches while preserving the original total ID budget.
        while (selections.size >= 32 || retainedSelectionIds + all.length > 400_000) {
          const oldest = selections.keys().next().value!;
          retainedSelectionIds -= selections.get(oldest)!.length;
          selections.delete(oldest);
        }
        selections.set(cacheKey, all);
        retainedSelectionIds += all.length;
      }
    }

    if (all) {
      if (idsOnly) return { ids: all };
      return page(all.slice(offset, offset + pageSize), all.length, counts);
    }
    const limit = idsOnly ? Prisma.empty : Prisma.sql`LIMIT ${pageSize} OFFSET ${offset}`;
    const ids = await orderedIds(tx, ownerId, where, search.sort, limit);
    if (idsOnly) return { ids };
    const [count] = await tx.$queryRaw<{total: bigint}[]>(Prisma.sql`${catalogCte(ownerId)} SELECT count(*) AS total FROM Item i WHERE ${where}`);
    return page(ids, Number(count.total), counts);
  }

  app.get<{ Querystring: { playlists?: string; since?: string; format?: string } }>("/api/library/overview", async (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const cardsOnly = request.query.playlists === "summary";
    const compact = cardsOnly && request.query.format === "compact";
    const result = await db.$transaction(async tx => {
      const state = await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { libraryRevision: true, overviewRevision: true } });
      const token = createHash("sha256").update(JSON.stringify([ownerId, cardsOnly, state.libraryRevision, state.overviewRevision])).digest("hex").slice(0, 32);
      if (request.query.since === token) return null;
      if (compact && compactSummary?.token === token) return compactSummary.json;
      return overview(tx, ownerId, cardsOnly, String(state.libraryRevision), token);
    });
    if (!result) return reply.code(204).send();
    if (typeof result === "string") return reply.type("application/json").send(result);
    if (tagDirectories.get(ownerId)?.revision !== result.revision) {
      if (tagDirectories.size >= 8) tagDirectories.delete(tagDirectories.keys().next().value!);
      tagDirectories.set(ownerId, {revision: result.revision, indexes: new Map(result.tags.map((tag, index) => [tag.id, index]))});
    }
    if (!compact) return result;
    const json = JSON.stringify(compactOverview(result, tagDirectories.get(ownerId)!.indexes));
    // The token covers the authenticated owner, library, playlists and job revisions.
    if (Buffer.byteLength(json) <= 2 * 1024 * 1024) compactSummary = {token: result.overviewToken!, json};
    return reply.type("application/json").send(json);
  });
  app.post("/api/library/page", (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const input = pageInput.parse(request.body);
    return whileConnected(reply, signal => db.$transaction(tx => select(tx, ownerId, input, false, signal)));
  });
  app.post("/api/library/ids", (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const input = searchInput.parse(request.body);
    return whileConnected(reply, signal => db.$transaction(tx => select(tx, ownerId, input, true, signal)));
  });
  // Browse tiles: the newest YouTube artwork under each source section.
  app.post("/api/library/section-covers", async (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const { ids } = z.object({ ids: z.array(id).max(100) }).parse(request.body);
    if (!ids.length) return { covers: {} };
    const rows = await db.$transaction(tx => tx.$queryRaw<{ tagId: string; externalId: string }[]>`${catalogCte(ownerId)}, picked AS (
        SELECT a.ancestor AS tagId, s.externalId AS externalId,
          row_number() OVER (PARTITION BY a.ancestor ORDER BY i.createdAt DESC, i.id) AS rank
        FROM ancestry a
        JOIN ItemTag it ON it.tagId = a.descendant
        JOIN Item i ON i.id = it.itemId AND i.ownerId = ${ownerId}
        JOIN Source s ON s.itemId = i.id AND s.ownerId = i.ownerId
        WHERE a.ancestor IN (${Prisma.join(ids)}) AND s.provider = 'youtube' AND s.externalId IS NOT NULL AND s.thumbnail IS NOT NULL
      )
      SELECT tagId, externalId FROM picked WHERE rank = 1`);
    const covers: Record<string, string> = {};
    for (const row of rows) if (/^[\w-]{11}$/.test(row.externalId)) covers[row.tagId] = `https://i.ytimg.com/vi/${row.externalId}/mqdefault.jpg`;
    return { covers };
  });
  app.post("/api/library/items", async (request, reply) => {
    const ownerId = browserOwner(request, reply);
    const { ids, verifyShared, picker } = z.object({ ids: z.array(id).max(pageSize), verifyShared: z.boolean().optional(), picker: z.boolean().optional() }).parse(request.body);
    if (picker) {
      const rows = await db.item.findMany({where: {ownerId, id: {in: ids}}, select: {id: true, title: true}});
      const byId = new Map(rows.map(row => [row.id, row]));
      return {items: ids.flatMap(id => byId.get(id) ?? [])};
    }
    await app.sharing.prefetchForViewer(ownerId, ids, verifyShared);
    return db.$transaction(async tx => ({ items: await library.itemWindow(tx, ownerId, ids) }));
  });
}
