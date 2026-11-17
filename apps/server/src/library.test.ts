import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { testContext, wav } from "./test-utils";
import { hashFile, inspectFile } from "./media";

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
});
