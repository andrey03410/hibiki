import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareLinkDto } from "@hibiki/contracts";
import { JobsService } from "./jobs";
import { ShareService } from "./sharing";
import { testContext, wav } from "./test-utils";

describe("delegated playlist listening", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  let shares: ShareService;
  const listener = "listener";

  beforeEach(async () => {
    ctx = await testContext();
    shares = new ShareService(ctx.db, ctx.library);
    await ctx.db.user.create({ data: { id: listener, login: listener, passwordHash: "test" } });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await ctx.close();
  });

  const token = (link: ShareLinkDto) => new URL(link.url!).pathname.split("/").at(-1)!;
  const playlist = (owner: string, ids: string[], id?: string) => ctx.library.savePlaylist(owner, {
    title: "Playlist", definition: { version: 1, sort: "source", rule: { type: "items", ids }, manualOrder: ids },
  }, id);

  async function mixed() {
    const { userId: author, otherUserId: curator } = ctx;
    const path = join(ctx.root, "test.wav");
    await writeFile(path, wav());
    const { item: original } = await ctx.library.importLocal(author, path, { title: "Original recording" });
    const { item: first } = await ctx.library.upsertYoutube(curator, { externalId: "12345678901" });
    const { item: last } = await ctx.library.upsertYoutube(curator, { externalId: "12345678902" });
    const upstream = await playlist(author, [original.id]);
    const grant = await shares.create(author, "playlist", upstream.id);
    const borrowed = await shares.save(curator, token(grant), original.id);
    const mix = await playlist(curator, [first.id, borrowed.id, last.id]);
    const link = await shares.create(curator, "playlist", mix.id);
    return { author, curator, original, first, last, upstream, grant, borrowed, mix, link };
  }

  it("lets the original owner listen to their own entry without enabling further sharing", async () => {
    const { author, curator, original, first, last, grant, borrowed, link } = await mixed();
    const url = token(link);
    const saved = await shares.save(author, url);
    const full = [first.id, borrowed.id, last.id];
    const publicPositions = [first.id, null, last.id];
    const due = new Date(Date.now() + 5000);
    await ctx.library.refreshDuePlaylistCounts(due);
    await ctx.library.refreshDuePlaylistCounts(due);

    const ownerView = await shares.open(author, url);
    expect(ownerView.positions).toEqual(full);
    expect((await shares.openSaved(author, saved.id)).positions).toEqual(full);
    expect(await shares.listSaved(author)).toMatchObject([{ trackCount: 3, totalCount: 3 }]);
    expect((await shares.open(listener, url)).positions).toEqual(publicPositions);
    expect(await shares.get(curator, link.id)).toMatchObject({ trackCount: 2, missingPermissionCount: 1 });

    const key = ownerView.items[1].sources[0].id;
    const ref = { kind: "link" as const, token: url, itemId: borrowed.id };
    const savedRef = { kind: "playlist" as const, id: saved.id, itemId: borrowed.id };
    await shares.revoke(author, grant.id);
    for (const address of [ref, savedRef]) {
      expect(await shares.file(author, address, key)).toMatchObject({ mime: "audio/wav" });
      expect(await shares.artworkOrigin(author, address)).toEqual({ ownerId: author, itemId: original.id });
    }
    await expect(shares.file(listener, ref, key)).rejects.toMatchObject({ status: 404 });
    await expect(shares.artworkOrigin(listener, ref)).rejects.toMatchObject({ status: 404 });
    await ctx.db.item.delete({ where: { id: original.id } });
    expect((await shares.open(author, url)).positions).toEqual(publicPositions);
    await expect(shares.file(author, ref, key)).rejects.toMatchObject({ status: 404 });
    await shares.revoke(curator, link.id);
    await expect(shares.openSaved(author, saved.id)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps closed slots anonymous and grants only live listening through either playlist address", async () => {
    const { author, curator, original, first, last, grant, borrowed, mix, link } = await mixed();
    const own = [first.id, null, last.id];
    const published = token(link);
    const saved = await shares.save(listener, published);
    const before = await shares.open(listener, published);
    expect(before).toMatchObject({ positions: own, totalCount: 3, trackCount: 2 });
    expect(before.items.map(item => item.id)).toEqual([first.id, last.id]);
    for (const secret of [borrowed.id, original.id, original.title, token(grant), "alice"]) {
      expect(JSON.stringify(before)).not.toContain(secret);
    }
    await shares.updateLink(curator, link.id, { allowReshare: true });
    const filesBefore = await ctx.db.mediaFile.count();
    const storageBefore = await ctx.db.kanameStorage.count();
    const now = new Date(Date.now() + 5_000);
    await ctx.library.refreshDuePlaylistCounts(now);
    await ctx.library.refreshDuePlaylistCounts(now);
    expect(await shares.get(curator, link.id)).toMatchObject({
      trackCount: 2, totalCount: 3, missingPermissionCount: 1, unavailableCount: 0, allowReshare: true,
    });
    await shares.updateLink(author, grant.id, { allowReshare: true });
    const allowedIds = [first.id, borrowed.id, last.id];
    const allowed = await shares.open(listener, published);
    const remembered = await shares.openSaved(listener, saved.id);
    for (const view of [allowed, remembered]) {
      expect(view.positions).toEqual(allowedIds);
      expect(view.items.map(item => item.id)).toEqual(allowedIds);
      expect(view.items[1]).toMatchObject({ title: original.title, shared: { delegated: true, sharedBy: "alice" } });
      for (const secret of [original.id, token(grant)]) expect(JSON.stringify(view)).not.toContain(secret);
    }
    expect(await shares.listSaved(listener)).toMatchObject([{ trackCount: 3, totalCount: 3 }]);
    expect(await shares.get(curator, link.id)).toMatchObject({
      trackCount: 3, totalCount: 3, missingPermissionCount: 0, unavailableCount: 0,
    });
    await expect(shares.save(listener, published, borrowed.id)).rejects.toMatchObject({ status: 404 });
    await expect(shares.saveFromSaved(listener, saved.id, borrowed.id)).rejects.toMatchObject({ status: 404 });
    expect(await ctx.db.item.count({ where: { ownerId: listener } })).toBe(0);
    expect(await ctx.db.mediaFile.count()).toBe(filesBefore);
    expect(await ctx.db.kanameStorage.count()).toBe(storageBefore);
    const source = allowed.items[1].sources[0];
    const linkRef = { kind: "link" as const, token: published, itemId: borrowed.id };
    const savedRef = { kind: "playlist" as const, id: saved.id, itemId: borrowed.id };
    for (const ref of [linkRef, savedRef]) {
      expect(await shares.file(listener, ref, source.id)).toMatchObject({ mime: "audio/wav" });
      expect(await shares.artworkOrigin(listener, ref)).toEqual({ ownerId: author, itemId: original.id });
    }
    await shares.updateLink(author, grant.id, { allowReshare: false });
    expect((await shares.openSaved(listener, saved.id)).positions).toEqual(own);
    for (const ref of [linkRef, savedRef]) {
      await expect(shares.file(listener, ref, source.id)).rejects.toMatchObject({ status: 404 });
      await expect(shares.artworkOrigin(listener, ref)).rejects.toMatchObject({ status: 404 });
    }
    expect(await shares.copySource(curator, borrowed.id)).toMatchObject({ provider: "local" });
    await shares.updateLink(author, grant.id, { allowReshare: true });
    await playlist(curator, [last.id, borrowed.id, first.id], mix.id);
    expect((await shares.openSaved(listener, saved.id)).positions).toEqual([last.id, borrowed.id, first.id]);
    await shares.revoke(curator, link.id);
    await expect(shares.file(listener, savedRef, source.id)).rejects.toMatchObject({ status: 404 });
  });

  it("resolves only the current composition through both playlist grants and closes both roles on withdrawal", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const ffmpeg = (await import("ffmpeg-static")).default;
    const { setVisual } = await import("./visuals");
    const { author, original, borrowed, grant, link } = await mixed();
    const path = join(ctx.root, "visual.mp4");
    await promisify(execFile)(String(ffmpeg), ["-v", "error", "-f", "lavfi", "-i", "color=red:s=32x32:d=0.5", path]);
    await setVisual(ctx.db, ctx.root, author, original.id, { expectedRevision: 0, uploadPath: path });
    await shares.updateLink(author, grant.id, { allowReshare: true });
    const outer = token(link);
    const saved = await shares.save(listener, outer);
    const refs = [
      { kind: "link" as const, token: outer, itemId: borrowed.id },
      { kind: "playlist" as const, id: saved.id, itemId: borrowed.id },
    ];
    for (const [index, view] of [await shares.open(listener, outer), await shares.openSaved(listener, saved.id)].entries()) {
      const entry = view.items.find(row => row.id === borrowed.id)!;
      expect(entry.visual?.soundSourceId).toBe(entry.sources[0].id);
      expect(entry.sources).toHaveLength(1);
      for (const secret of [original.id, original.sources[0].id, token(grant), "/files/"])
        expect(JSON.stringify(entry)).not.toContain(secret);
      for (const role of ["visual", "sound"] as const) expect((await shares.role(listener, refs[index], 1, role)).file.ownerId).toBe(author);
    }
    await shares.updateLink(author, grant.id, { allowReshare: false });
    for (const ref of refs) for (const role of ["visual", "sound"] as const)
      await expect(shares.role(listener, ref, 1, role)).rejects.toMatchObject({status:404});
  });

  it("uses any permitted direct grant, follows both playlist memberships, and counts missing originals", async () => {
    const { author, curator, original, first, last, upstream, grant, borrowed, mix, link } = await mixed();
    const published = token(link);
    const open = () => shares.open(listener, published);
    const partial = [first.id, null, last.id];
    const full = [first.id, borrowed.id, last.id];
    const alternate = await shares.create(author, "item", original.id, null, true);
    expect((await open()).positions).toEqual(partial);
    await shares.save(curator, token(alternate));
    expect((await open()).positions).toEqual(full);
    await shares.updateLink(author, grant.id, { allowReshare: true });
    await shares.revoke(author, alternate.id);
    expect((await open()).positions).toEqual(full);
    await playlist(author, [], upstream.id);
    expect((await open()).positions).toEqual(partial);
    const now = new Date(Date.now() + 5000);
    await ctx.library.refreshDuePlaylistCounts(now);
    await ctx.library.refreshDuePlaylistCounts(now);
    expect(await shares.get(curator, link.id)).toMatchObject({ missingPermissionCount: 0, unavailableCount: 1 });
    await playlist(author, [original.id], upstream.id);
    expect((await open()).positions).toEqual(full);
    await playlist(curator, [first.id, last.id], mix.id);
    const ref = { kind: "link" as const, token: published, itemId: borrowed.id };
    await expect(shares.artworkOrigin(listener, ref)).rejects.toMatchObject({ status: 404 });
    await playlist(curator, full, mix.id);
    const deadline = new Date(Date.now() + 3600_000);
    await shares.updateLink(author, grant.id, { expiresAt: deadline });
    const clock = vi.spyOn(Date, "now").mockReturnValue(+deadline);
    expect((await open()).positions).toEqual(partial);
    clock.mockRestore();
    await ctx.db.item.delete({ where: { id: original.id } });
    expect((await open()).positions).toEqual(partial);
  });

  it("publishes the curator's explicit copy independently after original access closes", async () => {
    const { author, curator, grant, borrowed, link } = await mixed();
    await shares.updateLink(author, grant.id, { allowReshare: true });
    const jobs = new JobsService(ctx.db, ctx.library, ctx.root);
    const job = await jobs.create(curator, "shared-copy", { itemId: borrowed.id });
    await jobs.runOnce();
    expect(await jobs.get(curator, job.id)).toMatchObject({ state: "done" });
    await shares.revoke(author, grant.id);
    const view = await shares.open(listener, token(link));
    expect(view.items[1]).toMatchObject({ id: borrowed.id, shared: { available: true, sharedBy: "bob" } });
    expect(view.items[1].shared?.delegated).toBeUndefined();
    expect(await shares.artworkOrigin(listener, { kind: "link", token: token(link), itemId: borrowed.id }))
      .toEqual({ ownerId: curator, itemId: borrowed.id });
    expect((await shares.save(listener, token(link), borrowed.id)).kind).toBe("item");
    expect(await ctx.db.mediaFile.count({ where: { ownerId: listener } })).toBe(0);
  });

  it("checks the original author's current Kaname authority before opening a SQLite transaction", async () => {
    const { author, curator, grant, borrowed, first, last, link } = await mixed();
    await shares.updateLink(author, grant.id, { allowReshare: true });
    const issuer = "https://issuer.example.test";
    vi.stubEnv("KANAME_ENABLED", "1");
    vi.stubEnv("KANAME_OIDC_ISSUER", issuer);
    vi.stubEnv("KANAME_URL", "https://kaname.example.test");
    vi.stubEnv("KANAME_SERVICE_TOKEN", "test");
    for (const id of [author, curator, listener]) {
      await ctx.db.user.update({ where: { id }, data: { kanameSubject: id, kanameIssuer: issuer } });
    }
    let status = 200;
    let authorStarted!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { authorStarted = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    vi.stubGlobal("fetch", async (url: URL) => {
      const subject = url.pathname.split("/").at(-1)!;
      if (subject === author) {
        authorStarted();
        await gate;
        if (status !== 200) return new Response(null, { status });
      }
      return Response.json({ subject, service: "hibiki", login: subject, role: "user",
        limits: { items: null, storageBytes: null }, permissions: { heavy: false } });
    });
    const opening = shares.open(listener, token(link));
    await Promise.race([started, opening.then(() => { throw Error("Skipped original author"); })]);
    const abort = new AbortController();
    try {
      expect(await Promise.race([ctx.db.user.count(), delay(500, null, { signal: abort.signal })])).toBe(3);
    } finally {
      resume();
      abort.abort();
    }
    const view = await opening;
    expect(view.trackCount).toBe(3);
    status = 403;
    const ref = { kind: "link" as const, token: token(link), itemId: borrowed.id };
    await expect(shares.file(listener, ref, view.items[1].sources[0].id)).rejects.toMatchObject({ status: 404 });
    status = 503;
    expect((await shares.open(listener, token(link))).positions).toEqual([first.id, null, last.id]);
    await expect(shares.artworkOrigin(listener, ref)).rejects.toMatchObject({ status: 404 });
  });
});
