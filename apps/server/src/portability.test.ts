import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { ZipFile } from "yazl";
import { exportLibrary, inspectArchive, applyArchive, planArchiveTags } from "./portability.js";
import { testContext, wav } from "./test-utils.js";

async function zip(
  destination: string,
  files: Record<string, string | Buffer>,
) {
  const archive = new ZipFile();
  for (const [name, value] of Object.entries(files))
    archive.addBuffer(Buffer.from(value), name);
  const done = pipeline(archive.outputStream, createWriteStream(destination));
  archive.end();
  await done;
}
describe("portable library", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  beforeEach(async () => {
    ctx = await testContext();
  });
  afterEach(async () => {
    await ctx.close();
  });
  it("exports private notes and summary only on opt-in and preserves populated targets", async () => {
    const { item } = await ctx.library.upsertYoutube(ctx.userId, {
      externalId: "abcdefghijk", title: "Song",
    });
    await ctx.db.item.update({ where: { id: item.id }, data: {
      note: "my private note", favorite: true, preferredSourceId: item.sources[0].id,
    } });
    await ctx.db.source.update({ where: { id: item.sources[0].id }, data: { note: "source note" } });
    await ctx.db.listeningSummary.create({ data: { ownerId: ctx.userId, itemId: item.id, launches: 3 } });
    for (const includePrivate of [false, true]) {
      const archive = join(ctx.root, `summary-${includePrivate}.zip`);
      await exportLibrary(ctx.db, ctx.userId, ctx.root, archive, {
        includeFiles: false, includeNotes: includePrivate, includeHistorySummary: includePrivate,
      });
      const checked = await inspectArchive(archive, join(ctx.root, `check-${includePrivate}`));
      expect(checked.manifest.items[0].note).toBe(includePrivate ? "my private note" : undefined);
      expect(checked.manifest.items[0].listeningSummary?.launches).toBe(includePrivate ? 3 : undefined);
      if (!includePrivate) continue;
      await applyArchive(ctx.db, ctx.otherUserId, ctx.root, checked);
      const target = await ctx.db.item.findFirstOrThrow({ where: { ownerId: ctx.otherUserId }, include: { sources: true } });
      expect(target).toMatchObject({ note: "my private note", favorite: true, preferredSourceId: target.sources[0].id });
      expect(target.sources[0].note).toBe("source note");
      expect((await ctx.db.listeningSummary.findUniqueOrThrow({ where: { itemId: target.id } })).launches).toBe(3);
      await ctx.db.item.update({ where: { id: target.id }, data: { note: "my newer note" } });
      await applyArchive(ctx.db, ctx.otherUserId, ctx.root, checked);
      expect((await ctx.db.item.findUniqueOrThrow({ where: { id: target.id } })).note).toBe("my newer note");
      expect((await ctx.db.listeningSummary.findUniqueOrThrow({ where: { itemId: target.id } })).launches).toBe(3);
    }
  });
  it("keeps two archived memberships with the same former label distinct on a new account", () => {
    const first = { id: "a", name: "first", label: "Theme", color: "#eeeeee", archived: true };
    const second = { ...first, id: "b", name: "second" };
    const plan = planArchiveTags("owner", { origin: "old-account", tags: [first, second] }, []);
    expect(new Set(plan.map(entry => entry.id)).size).toBe(2);
    expect(plan.filter(entry => entry.existing)).toHaveLength(0);
  });
  it("round-trips typed homonyms, mapped parent IDs, aliases, old playlist memberships and vocal credits", async () => {
    const { db, userId, otherUserId, root } = ctx;
    await db.tag.createMany({
      data: [
        {
          id: "studio",
          ownerId: userId,
          name: "opaque-studio",
          label: "Kyoto Animation",
          group: "source",
          aliases: '["KyoAni"]',
        },
        {
          id: "work",
          ownerId: userId,
          name: "opaque-work",
          label: "CLANNAD",
          group: "source",
          parentIds: '["studio"]',
        },
        {
          id: "vn",
          ownerId: userId,
          name: "opaque-vn",
          label: "CLANNAD",
          group: "source",
        },
        { id: "legacy", ownerId: userId, name: "OST", archived: true },
      ],
    });
    const { item } = await ctx.library.upsertYoutube(userId, {
      externalId: "abcdefghijk",
      title: "Original",
    });
    await db.item.update({
      where: { id: item.id },
      data: { performance: "vocal", voices: '["female"]' },
    });
    await db.itemTag.createMany({
      data: ["work", "legacy"].map((tagId) => ({ itemId: item.id, tagId })),
    });
    const archive = join(root, "classification.zip");
    await exportLibrary(db, userId, root, archive, { includeFiles: false });
    const checked = await inspectArchive(archive, join(root, "check-taxonomy"));
    await applyArchive(db, otherUserId, root, checked);
    const rows = await db.tag.findMany({ where: { ownerId: otherUserId } });
    const studio = rows.find((t) => t.label === "Kyoto Animation")!;
    expect(JSON.parse(studio.aliases)).toEqual(["KyoAni"]);
    expect(rows.filter((t) => t.label === "CLANNAD")).toHaveLength(2);
    expect(rows.find((t) => t.name === "opaque-work")?.parentIds).toBe(
      JSON.stringify([studio.id]),
    );
    expect(studio.id).not.toBe("studio");
    expect(rows.find((t) => t.name === "OST")?.archived).toBe(true);
    const imported = await db.item.findFirstOrThrow({
      where: { ownerId: otherUserId },
    });
    expect(imported).toMatchObject({
      performance: "vocal",
      voices: '["female"]',
    });
    await db.item.update({
      where: { id: imported.id },
      data: { voices: '["male"]' },
    });
    await applyArchive(db, otherUserId, root, checked);
    expect(
      await db.item.findUniqueOrThrow({ where: { id: imported.id } }),
    ).toMatchObject({ voices: '["male"]' });
  });
  it("copies files and rewrites every item/tag/playlist/queue reference for the new owner", async () => {
    const input = join(ctx.root, "tone.wav");
    await writeFile(input, wav());
    const item = (
      await ctx.library.importLocal(ctx.userId, input, { title: "My tone" })
    ).item;
    const tag = await ctx.library.createTag(ctx.userId, { name: "Soundtrack" });
    await ctx.library.updateItem(ctx.userId, item.id, { tagIds: [tag.id] });
    const child = await ctx.library.savePlaylist(ctx.userId, {
      title: "Child",
      definition: {
        version: 1,
        sort: "source",
        rule: { type: "tag", id: tag.id },
        manualOrder: [item.id],
      },
    });
    await ctx.library.savePlaylist(ctx.userId, {
      title: "Parent",
      definition: {
        version: 1,
        sort: "source",
        rule: { type: "playlist", id: child.id },
      },
    });
    await ctx.db.setting.upsert({
      where: { userId: ctx.userId },
      create: {
        userId: ctx.userId,
        json: JSON.stringify({
          volume: 0.3,
          repeat: "all",
          shuffle: true,
          queue: [item.id],
          originalQueue: [item.id],
          queueIndex: 0,
          position: 2,
          mode: "audio",
        }),
      },
      update: {},
    });
    const destination = join(ctx.root, "out.zip");
    await exportLibrary(ctx.db, ctx.userId, ctx.root, destination, {
      includeFiles: true,
    });
    const checked = await inspectArchive(
      destination,
      join(ctx.root, "inspection"),
    );
    expect(checked.preview.canApply).toBe(true);
    expect(checked.preview.counts.items).toBe(1);
    await applyArchive(ctx.db, ctx.otherUserId, ctx.root, checked);
    const imported = await ctx.library.snapshot(ctx.otherUserId);
    expect(imported.items).toHaveLength(1);
    expect(imported.items[0].title).toBe("My tone");
    expect(imported.items[0].createdAt).toBe(item.createdAt);
    expect(imported.items[0].id).not.toBe(item.id);
    expect(imported.items[0].tags[0].id).not.toBe(tag.id);
    const importedFile = await ctx.db.mediaFile.findFirstOrThrow({
      where: { ownerId: ctx.otherUserId },
    });
    expect(await readFile(join(ctx.root, importedFile.path))).toEqual(wav());
    expect(imported.items[0].sources[0].hasAudio).toBe(true);
    const settings = JSON.parse(
      (
        await ctx.db.setting.findUniqueOrThrow({
          where: { userId: ctx.otherUserId },
        })
      ).json,
    );
    expect(settings.queue).toEqual([imported.items[0].id]);
    expect(settings.originalQueue).toEqual([imported.items[0].id]);
    expect(settings.shuffle).toBe(true);
    expect(settings.mode).toBe("audio");
    for (const playlist of imported.playlists)
      expect(JSON.stringify(playlist.definition)).not.toContain(item.id);
    await applyArchive(ctx.db, ctx.otherUserId, ctx.root, checked);
    expect((await ctx.library.snapshot(ctx.otherUserId)).items).toHaveLength(1);
    expect(
      (await ctx.library.snapshot(ctx.otherUserId)).playlists,
    ).toHaveLength(2);
    expect((await ctx.library.snapshot(ctx.userId)).items[0].id).toBe(item.id);
  });
  it("preserves shared file item identities and unavailable codec states through metadata then full import", async () => {
    const input = join(ctx.root, "shared.wav");
    await writeFile(input, wav());
    const first = (
      await ctx.library.importLocal(ctx.userId, input, { title: "First" })
    ).item;
    const second = (
      await ctx.library.upsertYoutube(ctx.userId, {
        externalId: "abcdefghijk",
        title: "Second",
      })
    ).item;
    await ctx.library.importLocal(ctx.userId, input, { itemId: second.id });
    await ctx.db.source.updateMany({
      where: { itemId: first.id, provider: "local" },
      data: { status: "unavailable", reason: "unsupported_codec" },
    });
    const destination = join(ctx.root, "shared.zip");
    await exportLibrary(ctx.db, ctx.userId, ctx.root, destination, {
      includeFiles: false,
    });
    const metadata = await inspectArchive(
      destination,
      join(ctx.root, "shared-meta"),
    );
    await applyArchive(ctx.db, ctx.otherUserId, ctx.root, metadata);
    await exportLibrary(
      ctx.db,
      ctx.otherUserId,
      ctx.root,
      join(ctx.root, "re-export.zip"),
      { includeFiles: false },
    );
    await exportLibrary(ctx.db, ctx.userId, ctx.root, destination, {
      includeFiles: true,
    });
    const complete = await inspectArchive(
      destination,
      join(ctx.root, "shared-full"),
    );
    await applyArchive(ctx.db, ctx.otherUserId, ctx.root, complete);
    const imported = (await ctx.library.snapshot(ctx.otherUserId)).items;
    expect(imported).toHaveLength(2);
    expect(imported.find((i) => i.title === "First")?.sources[0]).toMatchObject(
      { status: "unavailable", reason: "unsupported_codec" },
    );
    expect(
      imported
        .find((i) => i.title === "Second")
        ?.sources.filter((s) => s.provider === "local"),
    ).toHaveLength(1);
    expect(
      imported
        .find((i) => i.title === "Second")
        ?.sources.find((s) => s.provider === "local")?.fileId,
    ).toBeTruthy();
  });
  it("reports omitted files and refuses archives with corrupt checksums before any DB change", async () => {
    const input = join(ctx.root, "tone.wav");
    await writeFile(input, wav());
    await ctx.library.importLocal(ctx.userId, input);
    const destination = join(ctx.root, "meta.zip");
    await exportLibrary(ctx.db, ctx.userId, ctx.root, destination, {
      includeFiles: false,
    });
    const checked = await inspectArchive(
      destination,
      join(ctx.root, "metadata"),
    );
    expect(checked.preview.missingFiles).toHaveLength(1);
    expect(checked.preview.canApply).toBe(true);
    expect(checked.manifest.settings).not.toHaveProperty("mode");
    await applyArchive(ctx.db, ctx.otherUserId, ctx.root, checked);
    expect((await ctx.library.snapshot(ctx.otherUserId)).items[0].sources[0].hasAudio).toBeUndefined();
    expect(
      (await ctx.library.snapshot(ctx.otherUserId)).items[0].sources.every(
        (s) => s.status !== "available",
      ),
    ).toBe(true);
    const manifest = structuredClone(checked.manifest);
    manifest.files[0].included = true;
    await zip(join(ctx.root, "corrupt.zip"), {
      "manifest.json": JSON.stringify(manifest),
      [manifest.files[0].path]: "corrupt",
    });
    await expect(
      inspectArchive(
        join(ctx.root, "corrupt.zip"),
        join(ctx.root, "corrupt-check"),
      ),
    ).rejects.toThrow(/хэш|hash|размер/i);
  });
  it("preserves file metadata above 2 GiB without numeric truncation or materializing the file", async () => {
    const item = (
      await ctx.library.upsertYoutube(ctx.userId, {
        externalId: "abcdefghijk",
        title: "Large original",
      })
    ).item;
    const file = await ctx.db.mediaFile.create({
      data: {
        id: "large-file",
        ownerId: ctx.userId,
        hash: "a".repeat(64),
        path: "missing/large.mp4",
        mime: "video/mp4",
        bytes: 3 * 1024 ** 3,
        kind: "video",
      },
    });
    await ctx.db.source.create({
      data: {
        id: "large-source",
        ownerId: ctx.userId,
        itemId: item.id,
        key: "local:" + file.hash,
        provider: "local",
        fileId: file.id,
        status: "unavailable",
        reason: "missing",
      },
    });
    const destination = join(ctx.root, "large-metadata.zip");
    await exportLibrary(ctx.db, ctx.userId, ctx.root, destination, {
      includeFiles: false,
    });
    const checked = await inspectArchive(
      destination,
      join(ctx.root, "large-metadata"),
    );
    expect(checked.manifest.files[0].bytes).toBe(3221225472);
    await applyArchive(ctx.db, ctx.otherUserId, ctx.root, checked);
    expect(
      Number(
        (
          await ctx.db.mediaFile.findFirstOrThrow({
            where: { ownerId: ctx.otherUserId },
          })
        ).bytes,
      ),
    ).toBe(3221225472);
  });
  it("rejects executable MIME and non-media bytes even when the archive checksum is valid", async () => {
    const input = join(ctx.root, "real.wav");
    await writeFile(input, wav());
    await ctx.library.importLocal(ctx.userId, input);
    const destination = join(ctx.root, "executable.zip");
    await exportLibrary(ctx.db, ctx.userId, ctx.root, destination, {
      includeFiles: false,
    });
    const checked = await inspectArchive(
      destination,
      join(ctx.root, "executable-meta"),
    );
    const manifest = structuredClone(checked.manifest);
    const data = Buffer.from("<html><script>alert(1)</script></html>");
    manifest.files[0].included = true;
    manifest.files[0].bytes = data.length;
    manifest.files[0].hash = createHash("sha256").update(data).digest("hex");
    await zip(destination, {
      "manifest.json": JSON.stringify(manifest),
      [manifest.files[0].path]: data,
    });
    await expect(
      inspectArchive(destination, join(ctx.root, "disguised-media")),
    ).rejects.toThrow(/медиа|аудио|видео|media/i);
    (manifest.files[0] as { mime: string }).mime = "text/html";
    await zip(destination, {
      "manifest.json": JSON.stringify(manifest),
      [manifest.files[0].path]: data,
    });
    await expect(
      inspectArchive(destination, join(ctx.root, "mime-check")),
    ).rejects.toThrow();
  });
  it("rejects unsupported versions, foreign references and unsafe archive names", async () => {
    const destination = join(ctx.root, "invalid.zip");
    await zip(destination, {
      "manifest.json": JSON.stringify({ format: "hibiki", version: 999 }),
    });
    await expect(
      inspectArchive(destination, join(ctx.root, "invalid")),
    ).rejects.toThrow();
    const empty = join(ctx.root, "empty.zip");
    await exportLibrary(ctx.db, ctx.userId, ctx.root, empty, {
      includeFiles: false,
    });
    const checked = await inspectArchive(empty, join(ctx.root, "empty"));
    checked.manifest.settings.queue = ["foreign-id"];
    await zip(destination, {
      "manifest.json": JSON.stringify(checked.manifest),
    });
    await expect(
      inspectArchive(destination, join(ctx.root, "foreign")),
    ).rejects.toThrow(/ссыл|reference|очеред/i);
    // yazl correctly rejects traversal at authoring time; construct a valid ZIP and mutate the name bytes.
    await zip(destination, { "safe.txt": "escape" });
    let bytes = await readFile(destination);
    bytes = Buffer.from(
      bytes.toString("latin1").replaceAll("safe.txt", "../x.txt"),
      "latin1",
    );
    await writeFile(destination, bytes);
    await expect(
      inspectArchive(destination, join(ctx.root, "unsafe")),
    ).rejects.toThrow();
  });
});
