import { z } from "zod";

export const tagGroupSchema = z.enum(["source", "artist", "genre", "mood", "extra"]);
export const performanceSchema = z.enum(["unknown", "ost", "vocal"]);
export const voiceSchema = z.enum(["male", "female"]);
export const missingGroupSchema = z.enum(["source", "artist", "genre", "mood", "performance", "voice"]);
export type TagGroup = z.infer<typeof tagGroupSchema>;
export type Performance = z.infer<typeof performanceSchema>;
export type Voice = z.infer<typeof voiceSchema>;
export type MissingGroup = z.infer<typeof missingGroupSchema>;

export interface TagDto {
  id: string;
  name: string;
  color: string;
  group?: TagGroup;
  aliases?: string[];
  parentIds?: string[];
  archived?: boolean;
}
export interface SourceDto {
  id: string;
  provider: "youtube" | "local";
  externalId?: string;
  url?: string;
  status: "unknown" | "available" | "unavailable";
  reason?: string;
  fileId?: string;
  mime?: string;
  bytes?: number;
  hash?: string;
  hasAudio?: boolean;
  thumbnail?: string;
  streamUrl?: string;
}
export interface ItemDto {
  id: string;
  title: string;
  originalTitle: string;
  kind: "audio" | "video";
  duration: number | null;
  createdAt: string;
  updatedAt: string;
  tags: TagDto[];
  sources: SourceDto[];
  favorite?: boolean;
  performance?: Performance;
  voices?: Voice[];
  preferredSourceId?: string;
}
export type Rule =
  | { type: "items"; ids: string[] }
  | { type: "playlist"; id: string }
  | { type: "tag"; id: string; descendants?: boolean }
  | { type: "favorite" }
  | {
      type: "history";
      condition: "never-started" | "never-completed" | "skipped-at-least" | "last-started-before";
      count?: number;
      days?: number;
    }
  | {
      type: "filter";
      kind?: "audio" | "video";
      local?: boolean;
      minDuration?: number;
      maxDuration?: number;
    }
  | { type: "union" | "intersection"; rules: Rule[] }
  | { type: "difference"; include: Rule; exclude: Rule };
export interface PlaylistDefinition {
  version: 1;
  rule: Rule;
  sort: "source" | "title" | "newest" | "duration" | "last-started";
  manualOrder?: string[];
}
export interface PlaylistDto {
  id: string;
  title: string;
  description: string;
  definition: PlaylistDefinition;
  revision: number;
  createdAt: string;
  updatedAt: string;
  youtubeLinked?: boolean;
}
export interface JobDto {
  id: string;
  kind: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  /** Fraction complete, from 0 to 1. */
  progress: number;
  completed: number;
  total: number;
  attempt: number;
  error?: string;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}
export interface LibraryDto {
  items: ItemDto[];
  tags: TagDto[];
  playlists: PlaylistDto[];
  jobs: JobDto[];
}
export interface LibraryOverviewDto extends Omit<LibraryDto, "items"> {
  total: number;
  tagCounts: Record<string, number>;
  revision: string;
}
export interface LibraryPageDto {
  items: ItemDto[];
  total: number;
  nextCursor: string | null;
  tagCounts?: Record<string, number>;
}

export const librarySearchSchema = z.object({
  query: z.string().default(""),
  kind: z.enum(["", "audio", "video"]).default(""),
  tagIds: z.array(z.string().min(1).max(256)).default([]),
  tagMode: z.enum(["and", "or"]).optional(),
  performanceFilter: z.enum(["", "ost", "male", "female", "vocal"]).optional(),
  needsClassification: z.boolean().optional(),
  missingGroup: missingGroupSchema.optional(),
  minDuration: z.string().default(""),
  maxDuration: z.string().default(""),
  addedFrom: z.string().default(""),
  addedThrough: z.string().default(""),
  provider: z.enum(["", "youtube", "local", "working-local"]).default(""),
  availability: z.enum(["", "available", "unknown", "unavailable"]).default(""),
  favoriteOnly: z.boolean().default(false),
  sort: z.enum(["title-asc", "title-desc", "duration-asc", "duration-desc", "added-asc", "added-desc"]).default("added-desc"),
  timeZone: z.string().max(128).optional(),
});
export type LibrarySearch = z.infer<typeof librarySearchSchema>;

export interface UserDto {
  id: string;
  login: string;
}
export interface ResolvedPlaylist {
  items: ItemDto[];
  reasons: Record<string, string[]>;
  excluded: Array<{ id: string; title: string; reasons: string[] }>;
  total: number;
  duration: number;
}
export type RepeatMode = "off" | "all" | "one";
export type PlaybackMode = z.infer<typeof playbackModeSchema>;
export interface Settings {
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  queue: string[];
  queueIndex: number;
  position?: number;
  mode?: PlaybackMode;
  [key: string]: unknown;
}

export const RULE_LIMITS = {
  depth: 20,
  nodes: 500,
  ids: 10_000,
  bytes: 262_144,
} as const;
const idSchema = z.string().min(1).max(256);
export const mediaKindSchema = z.enum(["audio", "video"]);
export const repeatModeSchema = z.enum(["off", "all", "one"]);
export const playbackModeSchema = z.enum(["original", "audio"]);
const durationSchema = z.number().finite().nonnegative();

const recursiveRuleSchema: z.ZodType<Rule> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("items"),
        ids: z.array(idSchema).max(RULE_LIMITS.ids),
      })
      .strict(),
    z.object({ type: z.literal("playlist"), id: idSchema }).strict(),
    z.object({ type: z.literal("tag"), id: idSchema, descendants: z.boolean().optional() }).strict(),
    z.object({ type: z.literal("favorite") }).strict(),
    z.object({
      type: z.literal("history"),
      condition: z.enum(["never-started", "never-completed", "skipped-at-least", "last-started-before"]),
      count: z.number().int().min(1).max(1_000_000).optional(),
      days: z.number().int().min(1).max(36_500).optional(),
    }).strict().refine((rule) =>
      (rule.condition === "skipped-at-least") === (rule.count !== undefined) &&
      (rule.condition === "last-started-before") === (rule.days !== undefined),
      { message: "Укажите число пропусков или дней для выбранного условия" },
    ),
    z
      .object({
        type: z.literal("filter"),
        kind: mediaKindSchema.optional(),
        local: z.boolean().optional(),
        minDuration: durationSchema.optional(),
        maxDuration: durationSchema.optional(),
      })
      .strict()
      .refine(
        (rule) =>
          rule.minDuration === undefined ||
          rule.maxDuration === undefined ||
          rule.minDuration <= rule.maxDuration,
        {
          message: "Минимальная длительность не может превышать максимальную",
        },
      ),
    z
      .object({
        type: z.literal("union"),
        rules: z.array(recursiveRuleSchema).max(RULE_LIMITS.nodes),
      })
      .strict(),
    z
      .object({
        type: z.literal("intersection"),
        rules: z.array(recursiveRuleSchema).max(RULE_LIMITS.nodes),
      })
      .strict(),
    z
      .object({
        type: z.literal("difference"),
        include: recursiveRuleSchema,
        exclude: recursiveRuleSchema,
      })
      .strict(),
  ]),
);

// Inspect before recursive Zod parsing so hostile JSON cannot exhaust the stack.
function ruleBudgetIssue(input: unknown): string | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: input, depth: 1 },
  ];
  let nodes = 0;
  let ids = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > RULE_LIMITS.nodes) return "Превышен бюджет количества правил";
    if (current.depth > RULE_LIMITS.depth)
      return "Превышена допустимая вложенность правил";
    if (current.value === null || typeof current.value !== "object") continue;
    const value = current.value as Record<string, unknown>;
    if (Array.isArray(value.ids)) ids += value.ids.length;
    if (ids > RULE_LIMITS.ids) return "Превышен бюджет ссылок на записи";
    if (Array.isArray(value.rules)) {
      if (value.rules.length > RULE_LIMITS.nodes)
        return "Превышен бюджет количества правил";
      for (const child of value.rules)
        pending.push({ value: child, depth: current.depth + 1 });
    }
    if ("include" in value)
      pending.push({ value: value.include, depth: current.depth + 1 });
    if ("exclude" in value)
      pending.push({ value: value.exclude, depth: current.depth + 1 });
  }
  try {
    if ((JSON.stringify(input)?.length ?? 0) > RULE_LIMITS.bytes)
      return "Превышен размер документа правил";
  } catch {
    return "Правила должны быть сериализуемым JSON";
  }
  return undefined;
}

export const ruleSchema: z.ZodType<Rule> = z.preprocess((input, context) => {
  const issue = ruleBudgetIssue(input);
  if (issue) {
    context.addIssue({ code: "custom", message: issue });
    return z.NEVER;
  }
  return input;
}, recursiveRuleSchema);

export const playlistDefinitionSchema = z
  .object({
    version: z.literal(1),
    rule: ruleSchema,
    sort: z.enum(["source", "title", "newest", "duration", "last-started"]),
    manualOrder: z.array(idSchema).max(RULE_LIMITS.ids).optional(),
  })
  .strict() satisfies z.ZodType<PlaylistDefinition>;

const tagCatalogFields = {
  group: tagGroupSchema.optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  parentIds: z.array(idSchema).max(100).optional(),
  archived: z.boolean().optional(),
};
export const tagInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  color: z.string().regex(/^#[a-f0-9]{6}$/i).optional(),
  ...tagCatalogFields,
});
export type TagInput = z.infer<typeof tagInputSchema>;
export const tagSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(200),
    color: z.string().max(64),
    ...tagCatalogFields,
  })
  .strict() satisfies z.ZodType<TagDto>;
export const sourceSchema = z
  .object({
    id: idSchema,
    provider: z.enum(["youtube", "local"]),
    externalId: z.string().optional(),
    url: z.string().optional(),
    status: z.enum(["unknown", "available", "unavailable"]),
    reason: z.string().optional(),
    fileId: idSchema.optional(),
    mime: z.string().optional(),
    bytes: z.number().int().nonnegative().optional(),
    hash: z.string().optional(),
    hasAudio: z.boolean().optional(),
    thumbnail: z.string().optional(),
    streamUrl: z.string().optional(),
  })
  .strict() satisfies z.ZodType<SourceDto>;
export const itemSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(1000),
    originalTitle: z.string().max(1000),
    kind: mediaKindSchema,
    duration: durationSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    tags: z.array(tagSchema),
    sources: z.array(sourceSchema),
    favorite: z.boolean().optional(),
    performance: performanceSchema.optional(),
    voices: z.array(voiceSchema).max(2).optional(),
    preferredSourceId: idSchema.optional(),
  })
  .strict() satisfies z.ZodType<ItemDto>;
export const playlistSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(10_000),
    definition: playlistDefinitionSchema,
    revision: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
    youtubeLinked: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<PlaylistDto>;
export const jobSchema = z
  .object({
    id: idSchema,
    kind: z.string(),
    state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
    progress: z.number().finite().min(0).max(1),
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    error: z.string().optional(),
    result: z.unknown().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict() satisfies z.ZodType<JobDto>;
export const librarySchema = z
  .object({
    items: z.array(itemSchema),
    tags: z.array(tagSchema),
    playlists: z.array(playlistSchema),
    jobs: z.array(jobSchema),
  })
  .strict() satisfies z.ZodType<LibraryDto>;
export const userSchema = z
  .object({ id: idSchema, login: z.string().min(1) })
  .strict() satisfies z.ZodType<UserDto>;
export const itemPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(1000).optional(),
    kind: mediaKindSchema.optional(),
    tagIds: z.array(idSchema).max(1000).optional(),
    performance: performanceSchema.optional(),
    voices: z.array(voiceSchema).max(2).optional(),
    completeClassification: z.boolean().optional(),
  })
  .strict();
export type ItemPatch = z.infer<typeof itemPatchSchema>;
export const jobCreateSchema = z
  .object({
    kind: z.enum([
      "youtube-import",
      "youtube-download",
      "youtube-refresh",
      "export",
      "import",
    ]),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export const settingsSchema = z
  .object({
    volume: z.number().finite().min(0).max(1),
    repeat: repeatModeSchema,
    shuffle: z.boolean(),
    queue: z.array(idSchema).max(100_000),
    queueIndex: z.number().int().min(-1),
    position: durationSchema.optional(),
    mode: playbackModeSchema.optional(),
  })
  .catchall(z.unknown()) satisfies z.ZodType<Settings>;

export function missingClassification(tags: TagDto[], performance: Performance = "unknown", voices: readonly Voice[] = []): MissingGroup[] {
  const groups = new Set(tags.filter(tag => !tag.archived).map(tag => tag.group));
  const missing: MissingGroup[] = (["source", "artist", "genre", "mood"] as const).filter(group => !groups.has(group));
  if (performance === "unknown") missing.push("performance");
  if (performance === "vocal" && !voices.length) missing.push("voice");
  return missing;
}

/** Validate an owner's complete graph, including parent edges retained for archived labels. */
export function validateCatalog(tags: TagDto[]): void {
  const byId = new Map(tags.map(tag => [tag.id, tag]));
  if (byId.size !== tags.length) throw new Error("Повтор идентификатора тега");
  const paths = new Set<string>();
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const tag of tags) {
    const parents = tag.parentIds ?? [];
    if (new Set(parents).size !== parents.length) throw new Error("Повтор родителя");
    for (const id of parents) {
      const parent = byId.get(id);
      if (!parent) throw new Error("Родительский тег не найден");
      if (tag.group !== "source" || parent.group !== "source")
        throw new Error("Иерархия доступна только в разделе «Источник»");
      if (!tag.archived && parent.archived) throw new Error("У активного тега не может быть архивного родителя");
      const siblings = children.get(id) ?? [];
      siblings.push(tag.id);
      children.set(id, siblings);
    }
    indegree.set(tag.id, parents.length);
    if (!tag.archived) {
      for (const parent of parents.length ? parents : [null]) {
        const path = JSON.stringify([tag.group ?? "extra", parent, tag.name.trim().normalize("NFC").toLowerCase()]);
        if (paths.has(path)) throw new Error("Тег с таким названием уже есть в этой ветке");
        paths.add(path);
      }
    }
  }
  const roots = tags.filter(tag => !indegree.get(tag.id)).map(tag => tag.id);
  for (let i = 0; i < roots.length; i++) {
    for (const child of children.get(roots[i]) ?? []) {
      const remaining = indegree.get(child)! - 1;
      indegree.set(child, remaining);
      if (!remaining) roots.push(child);
    }
  }
  if (roots.length !== tags.length) throw new Error("Цикл в дереве источников");
}
