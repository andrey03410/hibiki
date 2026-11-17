// Populate the local owner's library through the real MCP transport. No credentials in source.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
if (process.env.HIBIKI_ENV_FILE)
  process.loadEnvFile(process.env.HIBIKI_ENV_FILE);
const storage = path.resolve(process.env.STORAGE_DIR ?? "storage");
const base = process.env.PUBLIC_URL ?? "http://localhost:8790";
const access = JSON.parse(
  await readFile(path.join(storage, "verification/01-mvp/access.json"), "utf8"),
);
const client = new Client({ name: "hibiki-demo-seed", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${access.token}` } },
  }),
);
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const parsed = JSON.parse(result.content.find((c) => c.type === "text").text);
  if (result.isError)
    throw new Error(
      `${name}: ${parsed.error?.message ?? JSON.stringify(parsed)}`,
    );
  return parsed;
}
const outputDir = path.join(storage, "verification/01-mvp");
await mkdir(outputDir, { recursive: true });
try {
  const capabilities = await call("capabilities");
  const tags = {};
  for (const [name, color] of [
    ["Key", "#8bd7c4"],
    ["OST", "#8bd7c4"],
    ["Опенинги", "#b8a5ff"],
    ["Аниме", "#b8a5ff"],
  ])
    tags[name] = (await call("tag_save", { name, color })).id;
  const directory =
    process.env.HIBIKI_DEMO_MUSIC_DIR ??
    process.env.LOCAL_MEDIA_DIRS?.split(path.delimiter)[0];
  const audioIds = [];
  if (directory) {
    const names = [
      "1-05. Nagisa.mp3",
      "1-03. Bird's Poem.mp3",
      "03 Last regrets (Full Chorus Version).mp3",
      "1-01 - Philosophyz.mp3",
      "1-01. Ushio.mp3",
      "01. Light colors.mp3",
    ];
    const imported = await call("media_import_local", {
      paths: names.map((name) => path.join(directory, name)),
    });
    for (const entry of imported.items) audioIds.push(entry.item.id);
    if (imported.failed.length)
      console.log(`Local import failures: ${imported.failed.length}`);
    await call("media_update_many", {
      changes: audioIds.map((id) => ({ id, tagIds: [tags.Key, tags.OST] })),
    });
  }
  const youtube = [
    "https://www.youtube.com/watch?v=Yd8kUoB72xU",
    "https://www.youtube.com/watch?v=QoGM9hCxr4k",
  ];
  const jobIds = [];
  for (const url of youtube)
    jobIds.push((await call("media_import_youtube", { url })).id);
  const videoIds = [];
  const deadline = Date.now() + 10 * 60 * 1000;
  for (const jobId of jobIds) {
    let job;
    do {
      job = await call("job_get", { jobId });
      if (["done", "failed", "cancelled"].includes(job.state)) break;
      await new Promise((r) => setTimeout(r, 1500));
    } while (Date.now() < deadline);
    console.log(
      `YouTube job ${jobId}: ${job.state}${job.error ? ` — ${job.error}` : ""}`,
    );
    if (job.state === "done")
      for (const position of job.result?.positions ?? [])
        if (position.itemId) videoIds.push(position.itemId);
  }
  if (videoIds.length)
    await call("media_update_many", {
      changes: [...new Set(videoIds)].map((id) => ({
        id,
        tagIds: [tags["Опенинги"], tags["Аниме"]],
      })),
    });
  const existing = (await call("playlists_list")).playlists;
  async function playlist(title, description, rule) {
    const prior = existing.find((p) => p.title === title);
    return call("playlist_save", {
      title,
      description,
      definition: { version: 1, sort: "source", rule },
      ...(prior ? { playlistId: prior.id } : {}),
    });
  }
  const key = await playlist(
    "Key OST",
    "Clannad · AIR · Kanon · Rewrite — локальная коллекция",
    { type: "tag", id: tags.Key },
  );
  const openings = await playlist(
    "Аниме-опенинги",
    "Официальные видеоклипы с YouTube",
    { type: "tag", id: tags["Опенинги"] },
  );
  const mixed = await playlist(
    "Hibiki Mix",
    "Видео и музыка вместе · автоматически из двух подборок",
    {
      type: "union",
      rules: [
        { type: "playlist", id: openings.id },
        { type: "playlist", id: key.id },
      ],
    },
  );
  const preview = await call("playlist_get", { playlistId: mixed.id });
  const summary = {
    audioIds,
    videoIds: [...new Set(videoIds)],
    playlists: { key: key.id, openings: openings.id, mixed: mixed.id },
    jobs: jobIds,
    mixedCount: preview.resolved.total,
    mediaKinds: [...new Set(preview.resolved.items.map((i) => i.kind))],
    capabilityVersion: capabilities.version,
  };
  await writeFile(
    path.join(outputDir, "demo.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client.close();
}
