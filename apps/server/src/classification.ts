import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Db } from "./db";
import { invariant } from "./errors";
import { browserOwner } from "./notes";
import { collectReferences } from "@hibiki/core";
import {
  playlistDefinitionSchema,
  tagInputSchema,
  validateCatalog,
  missingClassification,
  type TagDto,
} from "@hibiki/contracts";

const key = z.string().trim().min(1).max(256);
const unique = (a: string[]) => new Set(a).size === a.length;
const refs = z.array(key).max(200).refine(unique, "Повторяющееся значение");
const packSchema = z
  .object({
    archiveTagIds: z.array(key).max(10000).refine(unique).default([]),
    tags: z
      .array(
        z
          .object({
            key,
            name: tagInputSchema.shape.name,
            group: z.enum(["source", "artist", "genre", "mood", "extra"]),
            aliases: tagInputSchema.shape.aliases.default([]),
            parents: z.array(key).max(100).refine(unique).default([]),
          })
          .strict(),
      )
      .max(10000),
    items: z
      .array(
        z
          .object({
            id: key,
            tags: refs,
            performance: z.enum(["ost", "vocal", "unknown"]),
            voices: z
              .array(z.enum(["male", "female"]))
              .max(2)
              .refine(unique),
          })
          .strict(),
      )
      .nonempty()
      .max(100000),
  })
  .strict();
type Pack = z.infer<typeof packSchema>;
type Tx = Prisma.TransactionClient;
type ItemState = {
  id: string;
  title?: string;
  performance: string;
  voices: string;
  favorite: boolean;
  tags: string[];
};
type ItemChange = { before: ItemState; after: ItemState };
type SavedTag = {
  id: string;
  name: string;
  label: string | null;
  group: string;
  aliases: string;
  parentIds: string;
  archived: boolean;
  legacyFlat: boolean;
  color: string;
  note: string | null;
};
type Journal = {
  changes: ItemChange[];
  created: SavedTag[];
  archived: SavedTag[];
};
type StoredBatch = {
  id: string;
  state: string;
  revision: number;
  packageJson: string;
  journalJson: string | null;
  reportJson: string;
};

const invalid = (value: unknown, message: string) =>
  invariant(value, 400, "invalid_package", message);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const managedId = (owner: string, k: string) =>
  "tag9_" + hash(JSON.stringify([owner, k])).slice(0, 32);
const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const fields = {
  id: true,
  name: true,
  label: true,
  group: true,
  aliases: true,
  parentIds: true,
  archived: true,
  legacyFlat: true,
  color: true,
  note: true,
} as const;
function dto(tag: SavedTag): TagDto {
  return {
    id: tag.id,
    name: tag.label ?? tag.name,
    color: tag.color,
    group: tag.group as TagDto["group"],
    aliases: JSON.parse(tag.aliases),
    parentIds: JSON.parse(tag.parentIds),
    archived: tag.archived,
    ...(tag.legacyFlat ? { legacyFlat: true } : {}),
  };
}
function tagRow(owner: string, t: Pack["tags"][number]): SavedTag {
  const id = managedId(owner, t.key);
  return {
    id,
    name: id,
    label: t.name,
    group: t.group,
    aliases: JSON.stringify(t.aliases),
    parentIds: JSON.stringify(t.parents.map((p) => managedId(owner, p))),
    legacyFlat: false,
    archived: false,
    color: "#b8a5ff",
    note: null,
  };
}
function performanceLabel(performance: string, voices: readonly string[]) {
  if (performance === "ost") return "Без вокала (OST)";
  if (performance !== "vocal") return "Не указано";
  if (voices.length === 2) return "С вокалом · оба голоса";
  if (voices.includes("male")) return "С вокалом · мужской";
  if (voices.includes("female")) return "С вокалом · женский";
  return "С вокалом · голос не указан";
}

async function itemsFor(tx: Tx, ownerId: string, ids: string[]) {
  const rows = await tx.item.findMany({
    where: { ownerId, id: { in: ids } },
    select: {
      id: true,
      title: true,
      performance: true,
      voices: true,
      favorite: true,
      tags: { select: { tagId: true } },
    },
  });
  return new Map(
    rows.map((r) => [r.id, { ...r, tags: r.tags.map((t) => t.tagId).sort() }]),
  );
}
async function prepare(tx: Tx, ownerId: string, p: Pack) {
  const revision = (
    await tx.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { libraryRevision: true },
    })
  ).libraryRevision;
  invalid(
    unique(p.tags.map((t) => t.key)) && unique(p.items.map((i) => i.id)),
    "Повторяющиеся записи или ключи каталога",
  );
  const keys = new Set(p.tags.map((t) => t.key)),
    ids = p.items.map((i) => i.id);
  const catalog = await tx.tag.findMany({ where: { ownerId }, select: fields });
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const archiveSet = new Set(p.archiveTagIds);
  const archived = p.archiveTagIds
    .map((id) => byId.get(id))
    .filter((t): t is SavedTag => Boolean(t));
  invalid(
    archived.length === archiveSet.size,
    "В пакете неизвестный старый тег",
  );
  if (archived.length) {
    const outside = await tx.$queryRaw<{ id: string }[]>`
      SELECT i.id FROM Item i JOIN ItemTag it ON it.itemId=i.id
      WHERE i.ownerId=${ownerId} AND it.tagId IN (SELECT value FROM json_each(${JSON.stringify(p.archiveTagIds)}))
        AND i.id NOT IN (SELECT value FROM json_each(${JSON.stringify(ids)})) LIMIT 1
    `;
    invalid(
      !outside.length,
      "Пакет не охватывает все записи архивируемых тегов",
    );
  }
  const managed = new Map<string, SavedTag>(),
    created: SavedTag[] = [];
  for (const t of p.tags) {
    invalid(
      t.parents.every((k) => keys.has(k)),
      "Неизвестный родитель в пакете",
    );
    const tag = tagRow(ownerId, t),
      existing = byId.get(tag.id);
    invalid(
      !archiveSet.has(tag.id),
      "Тег нельзя одновременно создать и убрать в архив",
    );
    if (existing) {
      invalid(
        existing.label === tag.label &&
          existing.group === tag.group &&
          existing.aliases === tag.aliases &&
          existing.parentIds === tag.parentIds &&
          !existing.archived,
        "Существующее значение каталога отличается от пакета",
      );
    } else {
      created.push(tag);
      byId.set(tag.id, tag);
    }
    managed.set(t.key, tag);
  }
  try {
    validateCatalog(
      [...byId.values()].map((t) => ({
        ...dto(t),
        archived: t.archived || archiveSet.has(t.id),
      })),
    );
  } catch (error) {
    invalid(
      false,
      error instanceof Error ? error.message : "Некорректная иерархия тегов",
    );
  }
  const beforeItems = await itemsFor(tx, ownerId, ids);
  invalid(
    beforeItems.size === ids.length,
    "Одна из композиций отсутствует в медиатеке",
  );
  const managedIds = new Set([...managed.values()].map((t) => t.id));
  const changes: ItemChange[] = [];
  const missing: Record<string, number> = {};
  let incomplete = 0,
    favoritesAdded = 0;
  const performanceChanges = new Map<
    string,
    { before: string; after: string; count: number }
  >();
  const examples = new Map<
    string,
    { before: string; after: string; count: number }
  >();
  for (const i of p.items) {
    invalid(
      i.tags.every((k) => keys.has(k)),
      "Композиция ссылается на неизвестное значение каталога",
    );
    invalid(
      i.performance === "vocal" || !i.voices.length,
      "Голоса допустимы только у вокальной композиции",
    );
    const before = beforeItems.get(i.id)!;
    const legacy = new Set(
      before.tags
        .filter((id) => archiveSet.has(id))
        .map((id) => dto(byId.get(id)!).name.toLowerCase()),
    );
    const oldLabels = [
      legacy.has("ost") && "OST",
      legacy.has("vocals") && "vocals",
    ].filter(Boolean);
    const prior =
      before.performance === "unknown" && oldLabels.length
        ? oldLabels.join(" + ")
        : performanceLabel(before.performance, JSON.parse(before.voices));
    const next = performanceLabel(i.performance, i.voices);
    const pair = JSON.stringify([prior, next]);
    const previous = performanceChanges.get(pair);
    performanceChanges.set(pair, {
      before: prior,
      after: next,
      count: (previous?.count ?? 0) + 1,
    });
    const assigned = i.tags.map((k) => managed.get(k)!.id);
    const tags = [
      ...new Set([
        ...before.tags.filter((id) => !managedIds.has(id)),
        ...assigned,
      ]),
    ].sort();
    const favorite =
      before.favorite ||
      before.tags.some(
        (id) =>
          archiveSet.has(id) &&
          dto(byId.get(id)!).name.toLocaleLowerCase() === "любимое",
      );
    const gaps = missingClassification(
      tags
        .filter((id) => !archiveSet.has(id))
        .map((id) => dto(byId.get(id)!))
        .filter((t) => !t.archived),
      i.performance,
      i.voices,
    );
    if (gaps.length) incomplete++;
    for (const g of gaps) missing[g] = (missing[g] ?? 0) + 1;
    if (favorite && !before.favorite) favoritesAdded++;
    const after = {
      id: i.id,
      tags,
      performance: i.performance,
      voices: JSON.stringify([...i.voices].sort()),
      favorite,
    };
    if (
      !sameIds(before.tags, tags) ||
      before.performance !== after.performance ||
      before.voices !== after.voices ||
      before.favorite !== favorite
    )
      changes.push({ before, after });
    if (examples.size < 1000) {
      const old = before.tags
        .filter((id) => archiveSet.has(id))
        .map((id) => dto(byId.get(id)!).name)
        .join(", ");
      const fresh = i.tags.map((k) => managed.get(k)!.label).join(", ");
      const k = JSON.stringify([old, fresh]);
      const row = examples.get(k) ?? { before: old, after: fresh, count: 0 };
      row.count++;
      examples.set(k, row);
    }
  }
  const journal: Journal = {
    changes,
    created,
    archived: archived.filter((t) => !t.archived),
  };
  return {
    journal,
    summary: {
      revision,
      items: p.items.length,
      tags: p.tags.length,
      archivedTags: journal.archived.length,
      incomplete,
      missing,
      favoritesAdded,
      performanceChanges: [...performanceChanges.values()].sort(
        (a, b) => b.count - a.count,
      ),
      examples: [...examples.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 30),
    },
  };
}
const options = { timeout: 120000, maxWait: 15000 };
export async function previewClassification(
  db: Db,
  owner: string,
  input: unknown,
) {
  const p = packSchema.parse(input),
    serialized = JSON.stringify(p),
    digest = hash(serialized);
  return db.$transaction(async (tx) => {
    const last = await tx.$queryRaw<StoredBatch[]>`
      SELECT id,state,reportJson FROM ClassificationBatch
      WHERE ownerId=${owner} AND digest=${digest}
        AND (state='applied' OR (state='preview' AND revision=(SELECT libraryRevision FROM User WHERE id=${owner})))
      ORDER BY rowid DESC LIMIT 1
    `;
    if (last.length)
      return {
        ...JSON.parse(last[0].reportJson),
        id: last[0].id,
        state: last[0].state,
      };
    const { summary } = await prepare(tx, owner, p);
    const id = randomUUID();
    await tx.$executeRaw`INSERT INTO ClassificationBatch (id,ownerId,digest,revision,state,packageJson,reportJson) VALUES (${id},${owner},${digest},${summary.revision},'preview',${serialized},${JSON.stringify(summary)})`;
    return { ...summary, id, state: "preview" };
  }, options);
}
async function findBatch(tx: Tx, owner: string, id: string) {
  const [row] = await tx.$queryRaw<
    StoredBatch[]
  >`SELECT * FROM ClassificationBatch WHERE id=${id} AND ownerId=${owner}`;
  invariant(row, 404, "not_found", "Пакет не найден");
  return row;
}
async function writeChanges(tx: Tx, owner: string, changes: ItemChange[]) {
  const add: { itemId: string; tagId: string }[] = [],
    remove: { itemId: string; tagId: string }[] = [];
  for (const { before, after } of changes) {
    for (const tagId of after.tags)
      if (!before.tags.includes(tagId)) add.push({ itemId: after.id, tagId });
    for (const tagId of before.tags)
      if (!after.tags.includes(tagId)) remove.push({ itemId: after.id, tagId });
  }
  if (remove.length)
    await tx.$executeRaw`DELETE FROM ItemTag WHERE (itemId,tagId) IN (SELECT json_extract(value,'$.itemId'),json_extract(value,'$.tagId') FROM json_each(${JSON.stringify(remove)}))`;
  if (add.length) await tx.itemTag.createMany({ data: add });
  const changed = changes
    .filter(
      ({ before, after }) =>
        before.favorite !== after.favorite ||
        before.voices !== after.voices ||
        before.performance !== after.performance,
    )
    .map(({ after: { id, performance, voices, favorite } }) => ({
      id,
      performance,
      voices,
      favorite,
    }));
  if (changed.length)
    await tx.$executeRaw`UPDATE Item SET performance=json_extract(j.value,'$.performance'),voices=json_extract(j.value,'$.voices'),favorite=json_extract(j.value,'$.favorite'),updatedAt=${new Date().toISOString()} FROM json_each(${JSON.stringify(changed)}) j WHERE Item.id=json_extract(j.value,'$.id') AND Item.ownerId=${owner}`;
}
export async function applyClassification(db: Db, owner: string, id: string) {
  return db.$transaction(async (tx) => {
    const batch = await findBatch(tx, owner, id);
    if (batch.state === "applied")
      return { ...JSON.parse(batch.reportJson), id, state: "applied" };
    invariant(
      batch.state === "preview",
      409,
      "batch_closed",
      "Этот пакет уже отменён",
    );
    const current = await tx.user.findUniqueOrThrow({
      where: { id: owner },
      select: { libraryRevision: true },
    });
    invariant(
      current.libraryRevision === batch.revision,
      409,
      "stale_preview",
      "Медиатека изменилась. Повторите предпросмотр.",
    );
    const { journal, summary } = await prepare(
      tx,
      owner,
      packSchema.parse(JSON.parse(batch.packageJson)),
    );
    if (journal.created.length)
      await tx.tag.createMany({
        data: journal.created.map((t) => ({ ...t, ownerId: owner })),
      });
    if (journal.archived.length)
      await tx.tag.updateMany({
        where: {
          ownerId: owner,
          id: { in: journal.archived.map((t) => t.id) },
        },
        data: { archived: true },
      });
    await writeChanges(tx, owner, journal.changes);
    await tx.$executeRaw`UPDATE ClassificationBatch SET state='applied',journalJson=${JSON.stringify(journal)} WHERE id=${id} AND ownerId=${owner}`;
    return { id, state: "applied", ...summary };
  }, options);
}
export async function undoClassification(db: Db, owner: string, id: string) {
  return db.$transaction(async (tx) => {
    const batch = await findBatch(tx, owner, id);
    if (batch.state === "undone")
      return { ...JSON.parse(batch.reportJson), id, state: "undone" };
    invariant(
      batch.state === "applied" && batch.journalJson,
      409,
      "not_applied",
      "Пакет ещё не применён",
    );
    const [latest] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM ClassificationBatch WHERE ownerId=${owner} AND state='applied' ORDER BY rowid DESC LIMIT 1`;
    invariant(
      latest?.id === id,
      409,
      "newer_batch",
      "Сначала отмените более поздний пакет разметки",
    );
    const journal = JSON.parse(batch.journalJson) as Journal;
    const current = await itemsFor(
      tx,
      owner,
      journal.changes.map((c) => c.before.id),
    );
    const skippedChanges: {
      itemId?: string;
      tagId?: string;
      label: string;
      field: string;
    }[] = [];
    const restore: ItemChange[] = [];
    for (const c of journal.changes) {
      const item = current.get(c.before.id);
      if (!item) {
        skippedChanges.push({
          itemId: c.before.id,
          label: c.before.title ?? c.before.id,
          field: "Запись удалена",
        });
        continue;
      }
      const target = { ...item };
      const skip = (field: string) =>
        skippedChanges.push({ itemId: item.id, label: item.title, field });
      if (
        item.performance === c.after.performance &&
        item.voices === c.after.voices
      ) {
        target.performance = c.before.performance;
        target.voices = c.before.voices;
      } else if (
        c.before.performance !== c.after.performance ||
        c.before.voices !== c.after.voices
      )
        skip("Исполнение и голоса");
      if (item.favorite === c.after.favorite)
        target.favorite = c.before.favorite;
      else if (c.before.favorite !== c.after.favorite) skip("Избранное");
      if (sameIds(item.tags, c.after.tags)) target.tags = c.before.tags;
      else if (!sameIds(c.before.tags, c.after.tags)) skip("Теги");
      restore.push({ before: item, after: target });
    }
    await writeChanges(tx, owner, restore);
    await tx.tag.updateMany({
      where: {
        ownerId: owner,
        id: { in: journal.archived.map((t) => t.id) },
        archived: true,
      },
      data: { archived: false },
    });
    const all = await tx.tag.findMany({
      where: { ownerId: owner },
      select: { ...fields, _count: { select: { items: true } } },
    });
    const present = new Map(all.map((t) => [t.id, t])),
      created = new Map(journal.created.map((t) => [t.id, t]));
    const keep = new Set<string>();
    for (const playlist of await tx.playlist.findMany({
      where: { ownerId: owner },
      select: { definitionJson: true },
    }))
      for (const tagId of collectReferences(
        playlistDefinitionSchema.parse(JSON.parse(playlist.definitionJson))
          .rule,
      ).tagIds)
        keep.add(tagId);
    for (const link of await tx.youtubeLink.findMany({
      where: { ownerId: owner },
      select: { tagId: true },
    }))
      if (link.tagId) keep.add(link.tagId);
    for (const { _count, ...t } of all) {
      const original = created.get(t.id);
      if (
        !original ||
        _count.items ||
        Object.keys(original).some(
          (k) => t[k as keyof SavedTag] !== original[k as keyof SavedTag],
        )
      )
        keep.add(t.id);
    }
    // Retain ancestors needed by a surviving child, including manually created descendants.
    for (const id of keep)
      for (const parent of JSON.parse(
        present.get(id)?.parentIds ?? "[]",
      ) as string[])
        keep.add(parent);
    const removable = journal.created
      .filter((t) => !keep.has(t.id))
      .map((t) => t.id);
    for (const t of journal.created) {
      if (keep.has(t.id))
        skippedChanges.push({
          tagId: t.id,
          label: present.get(t.id)?.label ?? t.label ?? t.name,
          field: "Значение каталога",
        });
    }
    if (removable.length)
      await tx.tag.deleteMany({
        where: { ownerId: owner, id: { in: removable } },
      });
    try {
      const restored = await tx.tag.findMany({
        where: { ownerId: owner },
        select: fields,
      });
      validateCatalog(restored.map(dto));
    } catch (error) {
      invariant(
        false,
        409,
        "undo_catalog_conflict",
        "Отмена создаст конфликт в каталоге: " + (error as Error).message,
      );
    }
    const report = {
      ...JSON.parse(batch.reportJson),
      skipped: skippedChanges.length,
      skippedChanges,
    };
    await tx.$executeRaw`UPDATE ClassificationBatch SET state='undone',reportJson=${JSON.stringify(report)} WHERE id=${id} AND ownerId=${owner}`;
    return { ...report, id, state: "undone" };
  }, options);
}
export function registerClassification(app: FastifyInstance, db: Db) {
  app.post(
    "/api/classification/preview",
    { bodyLimit: 16 * 1024 * 1024 },
    (req, rep) => previewClassification(db, browserOwner(req, rep), req.body),
  );
  for (const [action, fn] of [
    ["apply", applyClassification],
    ["undo", undoClassification],
  ] as const) {
    app.post("/api/classification/:id/" + action, (req, rep) =>
      fn(
        db,
        browserOwner(req, rep),
        z.object({ id: key }).parse(req.params).id,
      ),
    );
  }
  app.get("/api/classification/latest", async (req, rep) => {
    const owner = browserOwner(req, rep);
    const [batch] = await db.$queryRaw<
      { id: string; state: string; reportJson: string }[]
    >`SELECT id,state,reportJson FROM ClassificationBatch WHERE ownerId=${owner} ORDER BY rowid DESC LIMIT 1`;
    return {
      batch: batch
        ? { ...JSON.parse(batch.reportJson), id: batch.id, state: batch.state }
        : null,
    };
  });
}
