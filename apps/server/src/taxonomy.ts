import { randomUUID } from "node:crypto";
import type { Prisma, Tag } from "@prisma/client";
import { tagInputSchema, validateCatalog, type TagDto, type TagGroup, type TagInput } from "@hibiki/contracts";
import { HttpError, invariant } from "./errors";

export function tagDto(row: Tag): TagDto {
  return {
    id: row.id, name: row.label ?? row.name, color: row.color, group: row.group as TagGroup,
    ...(row.legacyFlat ? { legacyFlat: true } : {}),
    aliases: JSON.parse(row.aliases), parentIds: JSON.parse(row.parentIds), archived: row.archived,
  };
}

export async function listTags(tx: Prisma.TransactionClient, ownerId: string, includeArchived = false) {
  const rows = await tx.tag.findMany({ where: { ownerId, ...(includeArchived ? {} : { archived: false }) } });
  return rows.map(tagDto).sort((a, b) => a.name.localeCompare(b.name, "ru") || a.id.localeCompare(b.id));
}

export async function saveTag(tx: Prisma.TransactionClient, ownerId: string, patch: Partial<TagInput>, id?: string) {
  const rows = await tx.tag.findMany({ where: { ownerId } });
  const current = id === undefined ? undefined : rows.find(row => row.id === id);
  invariant(id === undefined || current, 404, "tag_not_found", "Тег не найден");
  const input = tagInputSchema.parse({ ...(current && tagDto(current)), ...patch });
  const tagId = id ?? randomUUID();
  const parentIds = [...new Set(input.parentIds ?? [])];
  const owned = new Set(rows.map(row => row.id));
  for (const parentId of parentIds)
    invariant(parentId === tagId || owned.has(parentId), 404, "tag_not_found", "Родительский тег не найден");
  const next: TagDto = {
    id: tagId, name: input.name, color: input.color ?? "#b8a5ff", group: input.group ?? "extra",
    parentIds, aliases: [...new Set(input.aliases ?? [])], archived: input.archived ?? false,
  };
  // Editing a color or alias keeps an existing exact identity. Moving or renaming
  // it uses the uniqueness rules that apply to every new catalog path.
  if (current?.legacyFlat && next.group === current.group && next.name === (current.label ?? current.name))
    next.legacyFlat = true;
  // Original clients create-or-get a flat tag by its exact name.
  if (!id && patch.group === undefined && !patch.parentIds && !patch.aliases && patch.archived === undefined) {
    const prior = rows.find(row => !row.archived && row.group === "extra" && (row.label ?? row.name) === next.name);
    if (prior) return tagDto(prior);
  }
  try {
    validateCatalog([...rows.filter(row => row.id !== id).map(tagDto), next]);
  } catch (error) {
    throw new HttpError(409, "invalid_catalog", (error as Error).message);
  }
  const data = {
    label: next.name, color: next.color, group: next.group, archived: next.archived, legacyFlat: !!next.legacyFlat,
    aliases: JSON.stringify(next.aliases), parentIds: JSON.stringify(next.parentIds),
  };
  const row = current
    ? await tx.tag.update({ where: { id: current.id }, data })
    : await tx.tag.create({
        data: { id: tagId, ownerId, name: rows.some(row => row.name === next.name) ? tagId : next.name, ...data },
      });
  return tagDto(row);
}
