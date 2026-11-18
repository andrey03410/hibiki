import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { proposeReplacement } from "./replacement";
import { testContext, wav } from "./test-utils";
import { refreshYoutube } from "./youtube";

vi.mock("./youtube", async (importOriginal) => ({
  ...await importOriginal<typeof import("./youtube")>(),
  refreshYoutube: vi.fn(),
}));

describe("source replacement", () => {
  const video = "abcdefghijk";
  const link = "https://www.youtube.com/watch?v=abcdefghijk";
  let ctx: Awaited<ReturnType<typeof testContext>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let itemId: string;
  let path: string;
  let cookie: string;
  let otherCookie: string;
  let oldSources: Awaited<ReturnType<typeof ctx.db.source.findMany>>;

  beforeEach(async () => {
    vi.mocked(refreshYoutube).mockReset().mockResolvedValue({
      externalId: video, title: "Candidate video", duration: 42, available: true,
    });
    ctx = await testContext();
    app = await createApp({ db: ctx.db, storageRoot: ctx.root });
    cookie = await app.auth.createSession(ctx.userId);
    otherCookie = await app.auth.createSession(ctx.otherUserId);
    const { item } = await ctx.library.upsertYoutube(ctx.userId, {
      externalId: "12345678901", title: "Original", available: false,
      reason: "removed", duration: 7,
    });
    itemId = item.id;
    await ctx.db.item.update({
      where: { id: itemId }, data: { title: "My title", favorite: true, note: "My note" },
    });
    path = `/api/items/${itemId}/replacements`;
    oldSources = await ctx.db.source.findMany({ where: { itemId } });
  });

  afterEach(async () => {
    await app?.close();
    await ctx?.close();
  });

  function post(route: string, payload?: object, session = cookie) {
    return app.inject({
      method: "POST", url: path + route, payload,
      cookies: { hibiki_session: session },
    });
  }

  function upload(filename: string, bytes = wav()) {
    return app.inject({
      method: "POST", url: path + "/preview", cookies: { hibiki_session: cookie },
      headers: { "content-type": "multipart/form-data; boundary=hibiki" },
      payload: Buffer.concat([
        Buffer.from(`--hibiki\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        bytes,
        Buffer.from("\r\n--hibiki--\r\n"),
      ]),
    });
  }

  it("stores only a canonical single-video proposal without contacting YouTube", async () => {
    const proposal = await proposeReplacement(
      ctx.db, ctx.userId, itemId, `https://youtu.be/${video}?t=15`, " Same recording ",
    );
    expect(proposal).toMatchObject({ url: link, reason: "Same recording", preview: null });
    await expect(proposeReplacement(ctx.db, ctx.userId, itemId,
      "https://www.youtube.com/playlist?list=PL123", "Playlist")).rejects.toMatchObject({ status: 400 });
    await expect(proposeReplacement(ctx.db, ctx.otherUserId, itemId, link, "Foreign"))
      .rejects.toMatchObject({ status: 404 });
    expect(refreshYoutube).not.toHaveBeenCalled();
    expect(await ctx.db.source.findMany({ where: { itemId } })).toEqual(oldSources);
  });

  it("requires an owner session to see, preview, and resolve a proposal", async () => {
    const proposal = await proposeReplacement(ctx.db, ctx.userId, itemId, link, "Same recording");
    const { token } = await app.auth.createToken(ctx.userId, "test");
    for (const [method, route] of [
      ["GET", ""], ["POST", "/preview"], ["POST", `/${proposal.id}/preview`],
      ["POST", `/${proposal.id}/confirm`], ["POST", `/${proposal.id}/decline`],
    ] as const) {
      const bearer = await app.inject({ method, url: path + route,
        headers: { authorization: `Bearer ${token}` } });
      expect(bearer.statusCode).toBe(403);
      const foreign = await app.inject({ method, url: path + route,
        cookies: { hibiki_session: otherCookie } });
      expect(foreign.statusCode).toBe(404);
    }
    const own = await app.inject({ url: path, cookies: { hibiki_session: cookie } });
    expect(own.json().proposals).toEqual([proposal]);
    expect((await post(`/${proposal.id}/confirm`)).statusCode).toBe(409);
    expect((await post(`/${proposal.id}/decline`)).statusCode).toBe(200);
    expect((await app.inject({ url: path, cookies: { hibiki_session: cookie } })).json().proposals).toEqual([]);
  });

  it("adds a checked YouTube source exactly once while preserving the record and old source", async () => {
    const before = await ctx.db.item.findUniqueOrThrow({ where: { id: itemId } });
    const result = await post("/preview", { url: link });
    expect(result.statusCode).toBe(200);
    const proposal = result.json().proposal;
    expect(proposal.preview).toMatchObject({
      title: "Candidate video", duration: 42,
      warnings: expect.arrayContaining([expect.stringMatching(/воспроизведени/i)]),
    });
    expect(await ctx.db.item.findUniqueOrThrow({ where: { id: itemId } })).toEqual(before);
    expect(await ctx.db.source.findMany({ where: { itemId } })).toEqual(oldSources);

    const responses = await Promise.all([
      post(`/${proposal.id}/confirm`), post(`/${proposal.id}/confirm`),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    const sources = await ctx.db.source.findMany({ where: { itemId } });
    const candidate = sources.find((s) => s.externalId === video);
    expect(sources).toHaveLength(2);
    expect(sources.find((s) => s.id === oldSources[0].id)).toEqual(oldSources[0]);
    expect(candidate).toMatchObject({ status: "available", url: link });
    const { updatedAt, preferredSourceId, ...rest } =
      await ctx.db.item.findUniqueOrThrow({ where: { id: itemId } });
    expect({ ...rest, updatedAt: before.updatedAt, preferredSourceId: before.preferredSourceId }).toEqual(before);
    expect(preferredSourceId).toBe(candidate!.id);
  });

  it("detects a YouTube key claimed by another item both before and after preview", async () => {
    const result = await post("/preview", { url: link });
    expect(result.statusCode).toBe(200);
    const proposal = result.json().proposal;
    await ctx.library.upsertYoutube(ctx.userId, { externalId: video, title: "Other item" });
    expect((await post(`/${proposal.id}/confirm`)).statusCode).toBe(409);
    expect((await post("/preview", { url: link })).statusCode).toBe(409);
    expect(await ctx.db.source.findMany({ where: { itemId } })).toEqual(oldSources);
    expect(refreshYoutube).toHaveBeenCalledTimes(1);
  });

  it("requires a successful YouTube check for an agent proposal", async () => {
    const proposal = await proposeReplacement(ctx.db, ctx.userId, itemId, link, "Same recording");
    vi.mocked(refreshYoutube).mockResolvedValueOnce({ externalId: video, available: false });
    expect((await post(`/${proposal.id}/preview`)).statusCode).toBe(422);
    vi.mocked(refreshYoutube).mockRejectedValueOnce(new Error("Provider timed out"));
    expect((await post(`/${proposal.id}/preview`)).statusCode).toBe(502);
    expect((await post(`/${proposal.id}/confirm`)).statusCode).toBe(409);
    expect((await post(`/${proposal.id}/preview`)).json().proposal.preview.title).toBe("Candidate video");
    expect((await post(`/${proposal.id}/confirm`)).statusCode).toBe(200);
  });

  it("stages a playable local file until confirmation, then imports it onto the same item", async () => {
    const response = await upload("../../tone.wav");
    expect(response.statusCode).toBe(200);
    const proposal = response.json().proposal;
    expect(proposal).toMatchObject({ kind: "local", preview: { title: "tone", duration: 1 } });
    expect(proposal).not.toHaveProperty("stagedPath");
    expect(await ctx.db.source.findMany({ where: { itemId } })).toEqual(oldSources);
    expect(await ctx.db.mediaFile.count()).toBe(0);
    const staged = (await ctx.db.sourceProposal.findUniqueOrThrow({ where: { id: proposal.id } })).stagedPath!;
    expect(staged).toMatch(/^uploads\/replacements\/[\w-]+\/tone\.wav$/);
    expect((await stat(join(ctx.root, staged))).mode & 0o777).toBe(0o600);

    const applied = await post(`/${proposal.id}/confirm`);
    expect(applied.statusCode).toBe(200);
    const row = await ctx.db.item.findUniqueOrThrow({ where: { id: itemId } });
    expect(row).toMatchObject({ title: "My title", originalTitle: "Original", duration: 7,
      favorite: true, note: "My note" });
    const source = await ctx.db.source.findUnique({ where: { id: row.preferredSourceId! } });
    expect(source).toMatchObject({ itemId, provider: "local", status: "available" });
    expect(await ctx.db.source.findUnique({ where: { id: oldSources[0].id } })).toEqual(oldSources[0]);
    await expect(stat(join(ctx.root, staged))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prefers the prepared playback copy over the unsupported original or an unrelated local source", async () => {
    const existing = join(ctx.root, "other.wav");
    await writeFile(existing, wav());
    const { item } = await ctx.library.importLocal(ctx.userId, existing, { itemId });
    const earlierSource = item.sources.find((source) => source.provider === "local")!;
    const aac = join(ctx.root, "replacement.aac");
    await promisify(execFile)(String(ffmpeg), [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=522:duration=0.2",
      "-c:a", "aac", aac,
    ], { timeout: 10_000 });
    const response = await upload("replacement.aac", await readFile(aac));
    expect(response.statusCode).toBe(200);
    const { proposal } = response.json();
    expect(proposal.preview.warnings).toEqual([expect.stringMatching(/копию/i)]);
    expect((await post(`/${proposal.id}/confirm`)).statusCode).toBe(200);
    const replaced = await ctx.library.getItem(ctx.userId, itemId);
    const preferred = replaced.sources.find((source) => source.id === replaced.preferredSourceId);
    expect(preferred).toMatchObject({ provider: "local", mime: "audio/mp4", status: "available" });
    expect(preferred?.id).not.toBe(earlierSource.id);
    expect(replaced.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ mime: "audio/aac", status: "unavailable", reason: "unsupported_codec" }),
    ]));

    const retry = (await upload("replacement.aac", await readFile(aac))).json().proposal;
    expect((await post(`/${retry.id}/confirm`)).statusCode).toBe(200);
    expect((await ctx.library.getItem(ctx.userId, itemId)).preferredSourceId).toBe(preferred?.id);
    expect(await ctx.db.source.count({ where: { itemId } })).toBe(4);
  });

  it("rejects multipart batches without leaving a staged proposal or file", async () => {
    const response = await app.inject({
      method: "POST", url: path + "/preview", cookies: { hibiki_session: cookie },
      headers: { "content-type": "multipart/form-data; boundary=hibiki" },
      payload: Buffer.concat([
        Buffer.from('--hibiki\r\nContent-Disposition: form-data; name="file"; filename="one.wav"\r\n\r\n'),
        wav(),
        Buffer.from('\r\n--hibiki\r\nContent-Disposition: form-data; name="file"; filename="two.wav"\r\n\r\n'),
        wav(),
        Buffer.from("\r\n--hibiki--\r\n"),
      ]),
    });
    expect(response.statusCode).toBe(413);
    expect(await ctx.db.sourceProposal.count()).toBe(0);
    expect(await readdir(join(ctx.root, "uploads", "replacements"))).toEqual([]);
  });

  it("cleans rejected candidates, unavailable staging and invalid uploads", async () => {
    expect((await upload("broken.wav", Buffer.from("not media"))).statusCode).toBe(415);
    expect(await readdir(join(ctx.root, "uploads", "replacements"))).toEqual([]);
    const rejected = (await upload("reject.wav")).json().proposal;
    expect((await post(`/${rejected.id}/decline`)).statusCode).toBe(200);
    expect(await readdir(join(ctx.root, "uploads", "replacements"))).toEqual([]);

    const missing = (await upload("missing.wav")).json().proposal;
    const { stagedPath } = await ctx.db.sourceProposal.findUniqueOrThrow({ where: { id: missing.id } });
    await unlink(join(ctx.root, stagedPath!));
    expect((await post(`/${missing.id}/confirm`)).statusCode).toBe(422);
    expect(await readdir(join(ctx.root, "uploads", "replacements"))).toEqual([]);
    expect(await ctx.db.source.findMany({ where: { itemId } })).toEqual(oldSources);
  });

  it("cleans abandoned staging on startup", async () => {
    const orphan = join(ctx.root, "uploads", "replacements", "a1153e41-9bbf-47dd-8b2e-93a2acead436");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "candidate.wav"), wav());
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(orphan, old, old);
    await app.ready();
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
