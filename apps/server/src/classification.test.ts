import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testContext } from "./test-utils";
import {
  applyClassification,
  previewClassification,
  undoClassification,
} from "./classification";

describe("library classification packages", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  beforeEach(async () => {
    ctx = await testContext();
  });
  afterEach(async () => {
    await ctx.close();
  });
  async function fixture() {
    const { item } = await ctx.library.upsertYoutube(ctx.userId, {
      externalId: "abcdefghijk",
      title: "Original",
    });
    const old = await ctx.library.createTag(ctx.userId, { name: "Любимое" });
    await ctx.library.updateItem(ctx.userId, item.id, {
      title: "Curated",
      tagIds: [old.id],
    });
    return {
      old,
      item,
      input: {
        archiveTagIds: [old.id],
        tags: [
          { key: "source", name: "Песня", group: "source" },
          { key: "artist", name: "Test", group: "artist" },
          { key: "genre", name: "Rock", group: "genre" },
          { key: "mood", name: "Быстрая", group: "mood" },
        ],
        items: [
          {
            id: item.id,
            tags: ["source", "artist", "genre", "mood"],
            performance: "vocal",
            voices: ["female"],
          },
        ],
      },
    };
  }
  it("previews without edits, applies once, preserves both titles and exact legacy membership, and respects later manual changes on undo", async () => {
    const { input, item, old } = await fixture();
    const batch = await previewClassification(ctx.db, ctx.userId, input);
    expect(batch).toMatchObject({
      items: 1,
      incomplete: 0,
      archivedTags: 1,
      favoritesAdded: 1,
    });
    expect(
      await ctx.db.item.findUniqueOrThrow({ where: { id: item.id } }),
    ).toMatchObject({ favorite: false });
    await expect(
      applyClassification(ctx.db, ctx.otherUserId, batch.id),
    ).rejects.toThrow();
    await applyClassification(ctx.db, ctx.userId, batch.id);
    await applyClassification(ctx.db, ctx.userId, batch.id);
    expect(await ctx.db.itemTag.count({ where: { itemId: item.id } })).toBe(5);
    expect(
      await ctx.db.tag.findUniqueOrThrow({ where: { id: old.id } }),
    ).toMatchObject({ archived: true });
    expect(
      await ctx.db.item.findUniqueOrThrow({ where: { id: item.id } }),
    ).toMatchObject({
      title: "Curated",
      originalTitle: "Original",
      performance: "vocal",
      favorite: true,
    });
    await ctx.db.item.update({
      where: { id: item.id },
      data: { voices: '["male"]' },
    });
    const undo = await undoClassification(ctx.db, ctx.userId, batch.id);
    expect(undo.skippedChanges).toContainEqual({
      itemId: item.id,
      label: "Curated",
      field: "Исполнение и голоса",
    });
    expect(
      (await undoClassification(ctx.db, ctx.userId, batch.id)).skippedChanges,
    ).toEqual(undo.skippedChanges);
    expect(
      await ctx.db.item.findUniqueOrThrow({ where: { id: item.id } }),
    ).toMatchObject({
      voices: '["male"]',
      performance: "vocal",
      favorite: false,
    });
    expect(
      await ctx.db.tag.findUniqueOrThrow({ where: { id: old.id } }),
    ).toMatchObject({ archived: false });
  });
  it("rejects undo atomically if a later manual tag occupies the restored path", async () => {
    const { input, old, item } = await fixture();
    const batch = await previewClassification(ctx.db, ctx.userId, input);
    await applyClassification(ctx.db, ctx.userId, batch.id);
    const manual = await ctx.library.createTag(ctx.userId, {
      name: "Любимое",
      group: "extra",
    });
    await expect(
      undoClassification(ctx.db, ctx.userId, batch.id),
    ).rejects.toThrow();
    expect(
      await ctx.db.tag.findUniqueOrThrow({ where: { id: old.id } }),
    ).toHaveProperty("archived", true);
    expect(
      await ctx.db.tag.findUniqueOrThrow({ where: { id: manual.id } }),
    ).toHaveProperty("archived", false);
    expect(
      await ctx.db.item.findUniqueOrThrow({ where: { id: item.id } }),
    ).toHaveProperty("performance", "vocal");
  });
  it("counts every performance transition, including old conflicting OST and vocals tags", async () => {
    const { input, item } = await fixture();
    const other = await ctx.library.upsertYoutube(ctx.userId, {
      externalId: "bcdefghijkl",
      title: "Other",
    });
    const tags = await Promise.all(
      ["OST", "vocals"].map((name) =>
        ctx.library.createTag(ctx.userId, { name }),
      ),
    );
    for (const id of [item.id, other.item.id])
      await ctx.library.updateItem(ctx.userId, id, {
        tagIds: tags.map((t) => t.id),
      });
    const result = await previewClassification(ctx.db, ctx.userId, {
      ...input,
      archiveTagIds: tags.map((t) => t.id),
      items: [
        { ...input.items[0], voices: [] },
        {
          ...input.items[0],
          id: other.item.id,
          performance: "ost",
          voices: [],
        },
      ],
    });
    expect(result.performanceChanges).toEqual(
      expect.arrayContaining([
        {
          before: "OST + vocals",
          after: "С вокалом · голос не указан",
          count: 1,
        },
        { before: "OST + vocals", after: "Без вокала (OST)", count: 1 },
      ]),
    );
  });
  it("requires a fresh revision and rejects foreign IDs, invalid graphs and repeated assignments", async () => {
    const { input, item } = await fixture();
    await expect(
      previewClassification(ctx.db, ctx.otherUserId, input),
    ).rejects.toThrow();
    await expect(
      previewClassification(ctx.db, ctx.userId, {
        ...input,
        items: [...input.items, ...input.items],
      }),
    ).rejects.toThrow();
    await expect(
      previewClassification(ctx.db, ctx.userId, {
        ...input,
        tags: input.tags.map((t) => ({ ...t, parents: [t.key] })),
      }),
    ).rejects.toThrow();
    const batch = await previewClassification(ctx.db, ctx.userId, input);
    await ctx.library.updateItem(ctx.userId, item.id, {
      title: "New manual title",
    });
    await expect(
      applyClassification(ctx.db, ctx.userId, batch.id),
    ).rejects.toThrow(/изменил/);
    expect(await ctx.db.tag.count({ where: { ownerId: ctx.userId } })).toBe(1);
  });
});
