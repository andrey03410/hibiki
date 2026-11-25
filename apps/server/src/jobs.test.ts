import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobsService } from "./jobs.js";
import { hashFile } from "./media";
import { testContext, wav } from "./test-utils.js";
import { runTool } from "./youtube.js";

describe("durable jobs", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  let jobs: JobsService;
  beforeEach(async () => {
    ctx = await testContext();
    jobs = new JobsService(ctx.db, ctx.library, ctx.root);
  });
  afterEach(async () => {
    delete process.env.YTDLP_PATH;
    await jobs.stop();
    await ctx.close();
  });
  it("backfills only old metadata without changing the media or repeating updates", async () => {
    const input = join(ctx.root, "sound.wav");
    await writeFile(input, wav());
    const { item } = await ctx.library.importLocal(ctx.userId, input);
    const file = await ctx.db.mediaFile.update({ where: { id: item.sources[0].fileId }, data: {
      hintsVersion: 0, audioViewVersion: 0, audioStart: null,
    } });
    const before = await hashFile(join(ctx.root, file.path));
    expect(await jobs.backfillPlayback()).toEqual({ updated: 1, skipped: 0 });
    expect(await hashFile(join(ctx.root, file.path))).toBe(before);
    expect(await jobs.backfillPlayback()).toEqual({ updated: 0, skipped: 0 });
    expect(await ctx.db.mediaFile.findUnique({ where: { id: file.id } })).toMatchObject({
      audioStart: 0n, hintsVersion: 1, audioViewVersion: 1, audioViewBytes: null,
    });
  });
  it("does not expose private browser jobs through ordinary job access", async () => {
    await expect(jobs.create(ctx.userId, "export", { includeNotes: true })).rejects.toThrow();
    const privateJob = await jobs.create(ctx.userId, "export", { includeNotes: true }, true);
    expect(await jobs.list(ctx.userId)).toEqual([]);
    expect((await ctx.library.snapshot(ctx.userId)).jobs).toEqual([]);
    expect((await jobs.list(ctx.userId, true))[0].id).toBe(privateJob.id);
    await expect(jobs.get(ctx.userId, privateJob.id)).rejects.toThrow();
    await expect(jobs.cancel(ctx.userId, privateJob.id)).rejects.toThrow();
    await jobs.runOnce();
    await expect(jobs.exportPath(ctx.userId, privateJob.id)).rejects.toThrow();
    await expect(jobs.exportPath(ctx.otherUserId, privateJob.id, true)).rejects.toThrow();
    expect(await jobs.exportPath(ctx.userId, privateJob.id, true)).toMatch(/library\.hibiki\.zip$/);
  });
  it("requires a browser to import rules that query private history", async () => {
    await ctx.library.savePlaylist(ctx.userId, {
      title: "Browser history rule",
      definition: { version: 1, sort: "source", rule: { type: "history", condition: "never-started" } },
    });
    const exported = await jobs.create(ctx.userId, "export", {});
    await jobs.runOnce();
    const archivePath = await jobs.exportPath(ctx.userId, exported.id);
    const publicImport = await jobs.create(ctx.otherUserId, "import", { archivePath });
    await jobs.runOnce();
    expect(await jobs.get(ctx.otherUserId, publicImport.id)).toMatchObject({
      state: "failed", error: expect.stringContaining("только из браузера"),
    });
    const browserImport = await jobs.create(ctx.otherUserId, "import", { archivePath }, true);
    await jobs.runOnce();
    expect(await jobs.get(ctx.otherUserId, browserImport.id, true)).toMatchObject({
      state: "done", result: { preview: { canApply: true } },
    });
  });
  it("claims an export only once across workers and enforces ownership", async () => {
    const job = await jobs.create(ctx.userId, "export", {
      includeFiles: false,
    });
    await expect(jobs.get(ctx.otherUserId, job.id)).rejects.toThrow();
    const second = new JobsService(ctx.db, ctx.library, ctx.root);
    const claimed = await Promise.all([jobs.runOnce(), second.runOnce()]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect((await jobs.get(ctx.userId, job.id)).state).toBe("done");
    expect(await jobs.exportPath(ctx.userId, job.id)).toContain(
      "library.hibiki.zip",
    );
    await expect(jobs.exportPath(ctx.otherUserId, job.id)).rejects.toThrow();
    await second.stop();
  });
  it("keeps the source playlist title in the import report", async () => {
    const executable = join(ctx.root, "playlist-yt-dlp");
    await writeFile(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({title:"Anime openings",entries:[{id:"abcdefghijk",title:"Opening"}]}));\n');
    await chmod(executable, 0o755);
    process.env.YTDLP_PATH = executable;
    const job = await jobs.create(ctx.userId, "youtube-import", {url:"https://youtube.com/playlist?list=PLtest123"});
    await jobs.runOnce();
    const finished = await jobs.get(ctx.userId, job.id);
    expect(finished.state).toBe("done");
    expect(finished.result).toMatchObject({title:"Anime openings",added:1,errors:0});
  });
  it("checks untitled playlist positions and preserves unavailable identities", async () => {
    const executable = join(ctx.root, "untitled-yt-dlp");
    await writeFile(executable, `#!/usr/bin/env node
const url=process.argv.at(-1);
if(url.includes('/playlist')) console.log(JSON.stringify({title:'Mixed',entries:[{id:'abcdefghijk',title:null},{id:'lmnopqrstuv',title:null},{id:'zzzzzzzzzzz',title:null}]}));
else if(url.includes('abcdefghijk')) { console.error('ERROR: Video unavailable: This video is private'); process.exit(1); }
else if(url.includes('lmnopqrstuv')) console.log(JSON.stringify({id:'lmnopqrstuv',title:'Recovered title'}));
else { console.error('ERROR: Connection timed out'); process.exit(1); }
`);
    await chmod(executable, 0o755);
    process.env.YTDLP_PATH = executable;
    const job = await jobs.create(ctx.userId, "youtube-import", {url:"https://youtube.com/playlist?list=PLtest123"});
    await jobs.runOnce();
    const finished = await jobs.get(ctx.userId, job.id);
    expect(finished.result).toMatchObject({added:3,unavailable:1,errors:0});
    const items = (await ctx.library.snapshot(ctx.userId)).items;
    expect(items.find(i=>i.sources[0].externalId==='abcdefghijk')?.sources[0].status).toBe('unavailable');
    expect(items.find(i=>i.sources[0].externalId==='lmnopqrstuv')?.title).toBe('Recovered title');
    expect(items.find(i=>i.sources[0].externalId==='zzzzzzzzzzz')?.sources[0].status).toBe('unknown');
    expect((finished.result as any).warnings.join(' ')).toContain('Connection timed out');
  });
  it("cancels queued work and recovers expired work with a bounded attempt count", async () => {
    const cancelled = await jobs.create(ctx.userId, "export", {
      includeFiles: false,
    });
    expect((await jobs.cancel(ctx.userId, cancelled.id)).state).toBe(
      "cancelled",
    );
    expect(await jobs.runOnce()).toBe(false);
    const recover = await jobs.create(ctx.userId, "export", {
      includeFiles: false,
    });
    await ctx.db.job.update({
      where: { id: recover.id },
      data: {
        state: "running",
        attempt: 1,
        leaseUntil: new Date(Date.now() - 1000),
      },
    });
    expect(await jobs.runOnce()).toBe(true);
    expect((await jobs.get(ctx.userId, recover.id)).attempt).toBe(2);
    const exhausted = await jobs.create(ctx.userId, "export", {
      includeFiles: false,
    });
    await ctx.db.job.update({
      where: { id: exhausted.id },
      data: {
        state: "running",
        attempt: 3,
        leaseUntil: new Date(Date.now() - 1000),
      },
    });
    await jobs.runOnce();
    expect((await jobs.get(ctx.userId, exhausted.id)).state).toBe("failed");
    await expect(jobs.retry(ctx.userId, exhausted.id)).rejects.toThrow();
  });
  it("observes cancellation requested from another process during a running provider call", async () => {
    const executable = join(ctx.root, "slow-yt-dlp");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n",
    );
    await chmod(executable, 0o755);
    process.env.YTDLP_PATH = executable;
    const job = await jobs.create(ctx.userId, "youtube-import", {
      url: "https://youtube.com/watch?v=abcdefghijk",
    });
    const running = jobs.runOnce();
    for (
      let n = 0;
      n < 50 && (await jobs.get(ctx.userId, job.id)).state !== "running";
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const remote = new JobsService(ctx.db, ctx.library, ctx.root);
    await remote.cancel(ctx.userId, job.id);
    await running;
    expect((await jobs.get(ctx.userId, job.id)).state).toBe("cancelled");
    await remote.stop();
    const cancelled = await jobs.create(ctx.userId, "export", {
      includeFiles: false,
    });
    await ctx.db.job.update({
      where: { id: cancelled.id },
      data: {
        state: "running",
        attempt: 3,
        cancelRequested: true,
        leaseUntil: new Date(0),
      },
    });
    await jobs.runOnce();
    expect((await jobs.get(ctx.userId, cancelled.id)).state).toBe("cancelled");
  });
  it("persists YouTube positions so a restarted worker keeps completed items and custom titles", async () => {
    const executable = join(ctx.root, "yt-dlp");
    await writeFile(
      executable,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({entries:[{id:"abcdefghijk",title:"First"},{id:"lmnopqrstuv",title:"Second"}]}));\n',
    );
    await chmod(executable, 0o755);
    process.env.YTDLP_PATH = executable;
    const first = await ctx.library.upsertYoutube(ctx.userId, {
      externalId: "abcdefghijk",
      title: "First",
    });
    await ctx.library.updateItem(ctx.userId, first.item.id, { title: "Mine" });
    const job = await jobs.create(ctx.userId, "youtube-import", {
      url: "https://youtube.com/playlist?list=PLtest123",
    });
    await ctx.db.job.update({
      where: { id: job.id },
      data: {
        state: "running",
        attempt: 1,
        leaseUntil: new Date(0),
        completed: 1,
        total: 2,
        resultJson: JSON.stringify({
          entries: [
            { externalId: "abcdefghijk", title: "First" },
            { externalId: "lmnopqrstuv", title: "Second" },
          ],
          positions: [{ status: "done", itemId: first.item.id, reused: false }],
          warnings: [],
        }),
      },
    });
    await jobs.runOnce();
    const finished = await jobs.get(ctx.userId, job.id);
    expect(finished.state).toBe("done");
    expect(finished.completed).toBe(2);
    const items = (await ctx.library.snapshot(ctx.userId)).items;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.id === first.item.id)?.title).toBe("Mine");
  });
  it("kills an in-flight provider process promptly on cancellation", async () => {
    const abort = new AbortController();
    const task = runTool(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      signal: abort.signal,
      timeoutMs: 10000,
    });
    setTimeout(() => abort.abort(), 30);
    await expect(task).rejects.toThrow(/отмен/);
  });
  it("creates an import preview that must belong to the user before applying", async () => {
    const exported = await jobs.create(ctx.userId, "export", {
      includeFiles: false,
    });
    await jobs.runOnce();
    const preview = await jobs.create(ctx.otherUserId, "import", {
      archivePath: await jobs.exportPath(ctx.userId, exported.id),
    });
    await jobs.runOnce();
    expect((await jobs.get(ctx.otherUserId, preview.id)).state).toBe("done");
    await expect(jobs.applyImport(ctx.userId, preview.id)).rejects.toThrow();
    const apply = await jobs.applyImport(ctx.otherUserId, preview.id);
    await jobs.runOnce();
    expect((await jobs.get(ctx.otherUserId, apply.id)).state).toBe("done");
  });
  it("returns a third claimed attempt on graceful shutdown so a fresh worker can finish", async () => {
    const executable = join(ctx.root, "graceful-yt-dlp");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n",
    );
    await chmod(executable, 0o755);
    process.env.YTDLP_PATH = executable;
    const job = await jobs.create(ctx.userId, "youtube-import", {
      url: "https://youtube.com/watch?v=abcdefghijk",
    });
    await ctx.db.job.update({ where: { id: job.id }, data: { attempt: 2 } });
    const running = jobs.runOnce();
    for (
      let n = 0;
      n < 100 && (await jobs.get(ctx.userId, job.id)).state !== "running";
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await jobs.get(ctx.userId, job.id)).attempt).toBe(3);
    await jobs.stop();
    await running;
    expect(await jobs.get(ctx.userId, job.id)).toMatchObject({
      state: "queued",
      attempt: 2,
    });
    await writeFile(
      executable,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({id:"abcdefghijk",title:"Recovered",duration:1}));\n',
    );
    const restarted = new JobsService(ctx.db, ctx.library, ctx.root);
    try {
      expect(await restarted.runOnce()).toBe(true);
      expect(await restarted.get(ctx.userId, job.id)).toMatchObject({
        state: "done",
        attempt: 3,
      });
    } finally {
      await restarted.stop();
    }
  });
});
