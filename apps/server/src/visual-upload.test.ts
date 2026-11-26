import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { createApp } from "./app";
import { testContext, wav } from "./test-utils";

it("attaches an uploaded clip through MCP, releases its container and reuses the same role from an existing source", async () => {
  const ctx = await testContext();
  const app = await createApp({ db: ctx.db, storageRoot: ctx.root });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "visual-test", version: "1" });
  try {
    const path = join(ctx.root, "music.wav");
    await writeFile(path, wav(3));
    const { item } = await ctx.library.importLocal(ctx.userId, path);
    const { token } = await app.auth.createToken(ctx.userId, "visual-test");
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }));

    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      const value = JSON.parse((response.content as { text: string }[])[0]!.text);
      expect(response.isError, JSON.stringify(value)).toBeFalsy();
      return value;
    };
    expect((await client.listTools()).tools.map(t => t.name)).toContain("media_visual_upload_begin");
    const operation = { itemId: item.id, expectedRevision: 0, operationId: "clip-1" };
    const grant = await call("media_visual_upload_begin", operation);
    const duplicate = await call("media_visual_upload_begin", operation);
    expect(duplicate.jobId).toBe(grant.jobId);
    const mp4 = join(ctx.root, "clip.mp4");
    execFileSync(String(ffmpeg), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=48x32:rate=8",
      "-f", "lavfi", "-i", "sine=frequency=200", "-t", "1", "-c:v", "libx264", "-c:a", "aac", mp4]);
    const body = new FormData();
    body.append("file", new Blob([new Uint8Array(await readFile(mp4))]), "clip.mp4");
    const upload = (link: string) => fetch(new URL(new URL(link).pathname, url), { method: "POST", body });
    const [response, secondResponse] = await Promise.all([upload(grant.uploadUrl), upload(duplicate.uploadUrl)]);
    expect(secondResponse.status).toBe(200);
    expect((await secondResponse.json()).id).toBe(grant.jobId);
    expect(response.status).toBe(200);
    const job = await response.json();
    expect(job).toMatchObject({ id: grant.jobId, kind: "visual-attach", state: "queued" });
    expect((await upload(grant.uploadUrl)).status).toBe(401);
    expect((await readdir(join(ctx.root, "visual-inputs", ctx.userId))).length).toBe(1);
    await app.jobs.runOnce();
    expect(await call("job_get", { jobId: job.id })).toMatchObject({ state: "done", result: { itemId: item.id, revision: 1 } });
    expect((await call("media_get", { itemId: item.id })).visual.soundSourceId).toBe(item.sources[0]!.id);
    expect(await ctx.db.item.count({ where: { ownerId: ctx.userId } })).toBe(1);
    expect(await ctx.db.kanameStorage.count({ where: { id: "visual-input-" + job.id } })).toBe(0);
    expect(await readdir(join(ctx.root, "visual-inputs", ctx.userId))).toEqual([]);

    expect(await call("media_visual_upload_begin", operation)).toMatchObject({ jobId: grant.jobId, state: "done" });
    const donor = (await ctx.library.importLocal(ctx.userId, mp4)).item;
    const streams = (await call("media_get", { itemId: donor.id })).sources[0].videoStreams;
    expect(streams).toMatchObject([{ index: 0, codec: "h264" }]);
    const args = { itemId: item.id, visualSourceId: donor.sources[0]!.id, expectedRevision: 1 };
    const attach = await call("media_set_visual", args);
    await app.jobs.runOnce();
    const finished = await call("job_get", { jobId: attach.jobId });
    expect(finished.state, finished.error).toBe("done");
    expect((await call("media_set_visual", args)).jobId).toBe(attach.jobId);
    await call("media_clear_visual", { itemId: item.id, expectedRevision: finished.result.revision });
    expect((await call("media_get", { itemId: item.id })).visual).toBeUndefined();
  } finally {
    await client.close();
    await app.close();
    await ctx.close();
  }
});

it("removes failed and cancelled browser uploads without publishing them or retaining their quota", async () => {
  const ctx = await testContext();
  const app = await createApp({ db: ctx.db, storageRoot: ctx.root });
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const session = await app.auth.createSession(ctx.userId);
    const path = join(ctx.root, "music.wav");
    await writeFile(path, wav());
    const { item } = await ctx.library.importLocal(ctx.userId, path);
    const body = new FormData();
    body.append("file", new Blob(["invalid media"]), "broken.mp4");
    for (const cancel of [true, false]) {
      const response = await fetch(new URL("/api/items/" + item.id + "/visual/upload?expectedRevision=0", base), {
        method: "POST", body, headers: { Cookie: "hibiki_session=" + session },
      });
      expect(response.status).toBe(200);
      const job = await response.json();
      if (cancel) await app.jobs.cancel(ctx.userId, job.id);
      else await app.jobs.runOnce();
      expect((await app.jobs.get(ctx.userId, job.id)).state).toBe(cancel ? "cancelled" : "failed");
      expect(await ctx.db.kanameStorage.count({ where: { id: "visual-input-" + job.id } })).toBe(0);
      expect(await readdir(join(ctx.root, "visual-inputs", ctx.userId))).toEqual([]);
    }
    expect((await ctx.library.getItem(ctx.userId, item.id)).visualRevision).toBe(0);
  } finally {
    await app.close();
    await ctx.close();
  }
});
