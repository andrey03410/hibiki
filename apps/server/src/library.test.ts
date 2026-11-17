import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { testContext, wav } from "./test-utils";
import { hashFile, inspectFile } from "./media";
import { exportLibrary, inspectArchive } from "./portability";

describe("personal library", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  beforeEach(async () => {
    ctx = await testContext();
  });
  afterEach(async () => {
    await ctx.close();
  });
  it("imports a real audio file without duplicates and isolates other owners", async () => {
    const input = join(ctx.root, "tone.wav");
    await writeFile(input, wav());
    const a = await ctx.library.importLocal(ctx.userId, input, {
      title: "Key OST",
    });
    const b = await ctx.library.importLocal(ctx.userId, input);
    expect(a.item.kind).toBe("audio");
    expect(a.item.duration).toBeGreaterThan(0);
    expect(b.item.id).toBe(a.item.id);
    expect(b.reused).toBe(true);
    expect((await ctx.library.snapshot(ctx.otherUserId)).items).toEqual([]);
    const other = await ctx.library.importLocal(ctx.otherUserId, input);
    expect(other.item.id).not.toBe(a.item.id);
  });
  it("keeps a renamed item and its tags when YouTube becomes unavailable", async () => {
    const { item } = await ctx.library.upsertYoutube(ctx.userId, {
      externalId: "abcdefghijk",
      title: "Opening",
    });
    const tag = await ctx.library.createTag(ctx.userId, { name: "Аниме" });
    await ctx.library.updateItem(ctx.userId, item.id, {
      title: "Моё название",
      tagIds: [tag.id],
    });
    await ctx.library.upsertYoutube(ctx.userId, {
      externalId: "abcdefghijk",
      available: false,
      title: "[Private video]",
    });
    const stored = (await ctx.library.snapshot(ctx.userId)).items[0];
    expect(stored.id).toBe(item.id);
    expect(stored.title).toBe("Моё название");
    expect(stored.originalTitle).toBe("Opening");
    expect(stored.tags[0].id).toBe(tag.id);
    expect(stored.sources[0].status).toBe("unavailable");
  });
  it("rejects foreign item/tag/playlist references before making changes", async () => {
    const { item } = await ctx.library.upsertYoutube(ctx.userId, {
      externalId: "abcdefghijk",
      title: "Opening",
    });
    const tag = await ctx.library.createTag(ctx.otherUserId, {
      name: "Чужой тег",
    });
    await expect(
      ctx.library.updateItem(ctx.otherUserId, item.id, { title: "Stolen" }),
    ).rejects.toThrow();
    await expect(
      ctx.library.updateItem(ctx.userId, item.id, { tagIds: [tag.id] }),
    ).rejects.toThrow();
    await expect(
      ctx.library.savePlaylist(ctx.otherUserId, {
        title: "Invalid",
        definition: {
          version: 1,
          sort: "source",
          rule: { type: "items", ids: [item.id] },
        },
      }),
    ).rejects.toThrow();
    expect((await ctx.library.snapshot(ctx.userId)).items[0].title).toBe(
      "Opening",
    );
  });
  it("resolves mixed items dynamically and refuses dependency cycles", async () => {
    const input = join(ctx.root, "tone.wav");
    await writeFile(input, wav());
    const audio = (await ctx.library.importLocal(ctx.userId, input)).item;
    const video = (
      await ctx.library.upsertYoutube(ctx.userId, {
        externalId: "abcdefghijk",
        title: "Opening",
      })
    ).item;
    const child = await ctx.library.savePlaylist(ctx.userId, {
      title: "Child",
      definition: {
        version: 1,
        sort: "source",
        rule: { type: "items", ids: [audio.id] },
      },
    });
    const parent = await ctx.library.savePlaylist(ctx.userId, {
      title: "Mixed",
      definition: {
        version: 1,
        sort: "source",
        rule: {
          type: "union",
          rules: [
            { type: "playlist", id: child.id },
            { type: "items", ids: [video.id] },
          ],
        },
      },
    });
    expect(
      (await ctx.library.resolve(ctx.userId, parent.id)).items.map(
        (i) => i.kind,
      ),
    ).toEqual(["audio", "video"]);
    await expect(
      ctx.library.savePlaylist(
        ctx.userId,
        {
          title: child.title,
          definition: {
            version: 1,
            sort: "source",
            rule: { type: "playlist", id: parent.id },
          },
        },
        child.id,
      ),
    ).rejects.toThrow();
    await expect(
      ctx.library.deletePlaylist(ctx.userId, child.id),
    ).rejects.toThrow();
  });

  it("preserves an incompatible video original and attaches a playable copy to the same mixed-library item", async () => {
    const input = join(ctx.root, "original.mkv");
    await promisify(execFile)(
      String(ffmpeg),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=64x64:r=10:d=0.3",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=0.3",
        "-c:v",
        "ffv1",
        "-c:a",
        "pcm_s16le",
        "-shortest",
        input,
      ],
      { timeout: 10_000 },
    );
    const originalHash = await hashFile(input);
    const video = await ctx.library.importLocal(ctx.userId, input, {
      title: "My video",
    });
    expect(video.item.sources).toHaveLength(2);
    const original = video.item.sources.find(
      (source) => source.hash === originalHash,
    )!;
    const playable = video.item.sources.find(
      (source) => source.status === "available",
    )!;
    expect(original).toMatchObject({
      status: "unavailable",
      reason: "unsupported_codec",
    });
    expect(playable).toMatchObject({ provider: "local", mime: "video/mp4" });
    expect(playable.hash).not.toBe(originalHash);
    for (const source of video.item.sources) {
      const file = await ctx.db.mediaFile.findUniqueOrThrow({
        where: { id: source.fileId! },
      });
      const stored = join(ctx.root, file.path);
      expect(await hashFile(stored)).toBe(source.hash);
      if (source.id === original.id)
        expect(await readFile(stored)).toEqual(await readFile(input));
      else
        expect(await inspectFile(stored)).toMatchObject({
          videoCodec: "h264",
          audioCodec: "aac",
          browserCompatible: true,
        });
    }
    const again = await ctx.library.importLocal(ctx.userId, input);
    expect(again).toMatchObject({ reused: true, item: { id: video.item.id } });
    expect(again.item.sources).toHaveLength(2);
    const audioInput = join(ctx.root, "audio.wav");
    await writeFile(audioInput, wav());
    const audio = await ctx.library.importLocal(ctx.userId, audioInput);
    const playlist = await ctx.library.savePlaylist(ctx.userId, {
      title: "Mixed local",
      definition: {
        version: 1,
        sort: "source",
        rule: { type: "items", ids: [audio.item.id, video.item.id] },
      },
    });
    expect(
      (await ctx.library.resolve(ctx.userId, playlist.id)).items.map(
        (item) => item.kind,
      ),
    ).toEqual(["audio", "video"]);
  });

  it("keeps the existing identity and title when an incompatible local copy is attached to YouTube", async () => {
    const item = (
      await ctx.library.upsertYoutube(ctx.userId, {
        externalId: "abcdefghijk",
        title: "Saved title",
      })
    ).item;
    const input = join(ctx.root, "original.aac");
    await promisify(execFile)(
      String(ffmpeg),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=0.3",
        "-c:a",
        "aac",
        input,
      ],
      { timeout: 10_000 },
    );
    const imported = await ctx.library.importLocal(ctx.userId, input, {
      itemId: item.id,
    });
    expect(imported.item.id).toBe(item.id);
    expect(imported.item.title).toBe("Saved title");
    expect(
      imported.item.sources.map((source) => source.provider).sort(),
    ).toEqual(["local", "local", "youtube"]);
    expect(
      imported.item.sources.filter(
        (source) =>
          source.provider === "local" && source.status === "available",
      ),
    ).toHaveLength(1);
    expect((await ctx.library.snapshot(ctx.userId)).items).toHaveLength(1);
  });

  it("does not duplicate an item when the same local file is imported concurrently", async () => {
    const input = join(ctx.root, "tone.wav");
    await writeFile(input, wav());
    const results = await Promise.all([
      ctx.library.importLocal(ctx.userId, input),
      ctx.library.importLocal(ctx.userId, input),
    ]);
    expect(results[0]!.item.id).toBe(results[1]!.item.id);
    expect((await ctx.library.snapshot(ctx.userId)).items).toHaveLength(1);
  });

  it("keeps an outside write out of a concurrent transaction rollback", async () => {
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rollback = ctx.db.$transaction(async (tx) => {
      await tx.tag.create({
        data: { id: "temporary", ownerId: ctx.userId, name: "Temporary" },
      });
      entered();
      await gate;
      throw new Error("deliberate rollback");
    });
    const rejected = expect(rollback).rejects.toThrow("deliberate rollback");
    await ready;
    const outside = ctx.library.createTag(ctx.userId, {
      name: "Committed outside",
    });
    try {
      const result = await Promise.race([
        outside.then(() => "completed"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 30)),
      ]);
      expect(result).toBe("waiting");
    } finally {
      release();
    }
    await rejected;
    await outside;
    expect(
      (await ctx.library.snapshot(ctx.userId)).tags.map((tag) => tag.name),
    ).toEqual(["Committed outside"]);
  });
  it("cleans ordering and saved queues atomically when dynamic items are deleted", async () => {
    const items = await Promise.all(
      ["abcdefghijk", "lmnopqrstuv", "12345678901"].map((externalId) =>
        ctx.library.upsertYoutube(ctx.userId, {
          externalId,
          title: externalId,
        }),
      ),
    );
    const [a, b, c] = items.map((result) => result.item.id);
    const playlist = await ctx.library.savePlaylist(ctx.userId, {
      title: "Dynamic",
      definition: {
        version: 1,
        sort: "source",
        rule: { type: "filter" },
        manualOrder: [a, b, c],
      },
    });
    await ctx.library.setSettings(ctx.userId, {
      queue: [a, b, c],
      originalQueue: [c, a, b],
      queueIndex: 1,
      position: 24,
    });
    await ctx.library.deleteItem(ctx.userId, a!);
    expect(await ctx.library.getSettings(ctx.userId)).toMatchObject({
      queue: [b, c],
      originalQueue: [c, b],
      queueIndex: 0,
      position: 24,
    });
    expect(
      (await ctx.library.resolve(ctx.userId, playlist.id)).items.map(
        (item) => item.id,
      ),
    ).toEqual([b, c]);
    const destination = join(ctx.root, "after-delete.zip");
    await exportLibrary(ctx.db, ctx.userId, ctx.root, destination, {
      includeFiles: false,
    });
    expect(
      (await inspectArchive(destination, join(ctx.root, "after-delete")))
        .preview.canApply,
    ).toBe(true);
    await ctx.library.deleteItem(ctx.userId, b!);
    expect(await ctx.library.getSettings(ctx.userId)).toMatchObject({
      queue: [c],
      originalQueue: [c],
      queueIndex: 0,
      position: 0,
    });
    const explicit = await ctx.library.savePlaylist(ctx.userId, {
      title: "Explicit",
      definition: {
        version: 1,
        sort: "source",
        rule: { type: "items", ids: [c!] },
      },
    });
    await expect(ctx.library.deleteItem(ctx.userId, c!)).rejects.toThrow(
      /используется/,
    );
    expect(
      (await ctx.library.resolve(ctx.userId, explicit.id)).items,
    ).toHaveLength(1);
  });
  it("normalizes both queues, preserves the current retained item and clamps malformed playback values", async () => {
    const a = (
      await ctx.library.upsertYoutube(ctx.userId, { externalId: "abcdefghijk" })
    ).item.id;
    const b = (
      await ctx.library.upsertYoutube(ctx.userId, { externalId: "lmnopqrstuv" })
    ).item.id;
    expect(
      await ctx.library.setSettings(ctx.userId, {
        queue: ["foreign", a, b],
        originalQueue: ["foreign", b, a],
        queueIndex: 2,
        position: 17,
      }),
    ).toMatchObject({
      queue: [a, b],
      originalQueue: [b, a],
      queueIndex: 1,
      position: 17,
    });
    expect(
      await ctx.library.setSettings(ctx.userId, {
        queue: [null, a, b],
        queueIndex: 1,
        position: 19,
      }),
    ).toMatchObject({ queue: [a, b], queueIndex: 0, position: 19 });
    expect(
      await ctx.library.setSettings(ctx.userId, {
        queueIndex: 999,
        position: -5,
      }),
    ).toMatchObject({ queueIndex: 1, position: 0 });
    expect(
      await ctx.library.setSettings(ctx.userId, {
        queueIndex: 0.5,
        position: "garbage",
        originalQueue: ["foreign", a],
      }),
    ).toMatchObject({ queueIndex: 0, position: 0, originalQueue: [a] });
  });
  it("atomically reuses the YouTube identity for concurrent imports and preserves custom titles", async () => {
    const results = await Promise.all([
      ctx.library.upsertYoutube(ctx.userId, {
        externalId: "abcdefghijk",
        title: "Original",
      }),
      ctx.library.upsertYoutube(ctx.userId, {
        externalId: "abcdefghijk",
        title: "Updated",
      }),
    ]);
    expect(results[0]!.item.id).toBe(results[1]!.item.id);
    expect(await ctx.db.item.count({ where: { ownerId: ctx.userId } })).toBe(1);
    expect(await ctx.db.source.count({ where: { ownerId: ctx.userId } })).toBe(
      1,
    );
    await ctx.library.updateItem(ctx.userId, results[0]!.item.id, {
      title: "Mine",
    });
    await Promise.all([
      ctx.library.upsertYoutube(ctx.userId, {
        externalId: "abcdefghijk",
        title: "New 1",
      }),
      ctx.library.upsertYoutube(ctx.userId, {
        externalId: "abcdefghijk",
        title: "New 2",
      }),
    ]);
    expect(
      (await ctx.library.getItem(ctx.userId, results[0]!.item.id)).title,
    ).toBe("Mine");
  });
  it("rejects one of concurrent graph edits before they can introduce a cycle", async () => {
    const definition = {
      version: 1 as const,
      sort: "source" as const,
      rule: { type: "items" as const, ids: [] },
    };
    const a = await ctx.library.savePlaylist(ctx.userId, {
      title: "A",
      definition,
    });
    const b = await ctx.library.savePlaylist(ctx.userId, {
      title: "B",
      definition,
    });
    const results = await Promise.allSettled([
      ctx.library.savePlaylist(
        ctx.userId,
        {
          title: "A",
          definition: { ...definition, rule: { type: "playlist", id: b.id } },
        },
        a.id,
      ),
      ctx.library.savePlaylist(
        ctx.userId,
        {
          title: "B",
          definition: { ...definition, rule: { type: "playlist", id: a.id } },
        },
        b.id,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect((await ctx.library.resolve(ctx.userId, a.id)).items).toEqual([]);
    expect((await ctx.library.resolve(ctx.userId, b.id)).items).toEqual([]);
    await expect(
      ctx.library.savePlaylist(
        ctx.otherUserId,
        { title: "Foreign", definition },
        a.id,
      ),
    ).rejects.toThrow(/не найден/);
  });

  it.each(["missing", "corrupt"])(
    "repairs a %s stored file before reusing an available source",
    async (mode) => {
      const input = join(ctx.root, "repair.wav");
      await writeFile(input, wav());
      const first = await ctx.library.importLocal(ctx.userId, input);
      const file = await ctx.db.mediaFile.findUniqueOrThrow({
        where: { id: first.item.sources[0]!.fileId! },
      });
      if (mode === "missing") await rm(join(ctx.root, file.path));
      else {
        const bytes = wav();
        bytes[50] ^= 1;
        await writeFile(join(ctx.root, file.path), bytes);
      }
      const second = await ctx.library.importLocal(ctx.userId, input);
      expect(second.item.id).toBe(first.item.id);
      expect(second.item.sources[0]!.fileId).toBe(file.id);
      expect(
        await readFile(
          join(
            ctx.root,
            (
              await ctx.db.mediaFile.findUniqueOrThrow({
                where: { id: file.id },
              })
            ).path,
          ),
        ),
      ).toEqual(wav());
    },
  );
});
