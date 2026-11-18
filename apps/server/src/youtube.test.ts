import { describe, expect, it } from "vitest";
import {
  normalizeYoutubeUrl,
  parseYoutubeEntry,
  YoutubeProviderError,
} from "./youtube.js";

describe("YouTube input boundary", () => {
  it.each([
    [
      "https://youtu.be/dQw4w9WgXcQ?t=12",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ],
    [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest_123",
      "https://www.youtube.com/playlist?list=PLtest_123",
    ],
    [
      "https://m.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ],
  ])(
    "normalizes %s without forwarding arbitrary parameters",
    (url, canonical) => {
      expect(normalizeYoutubeUrl(url)).toBe(canonical);
    },
  );
  it.each([
    "http://localhost/x",
    "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
    "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ",
    "file:///etc/passwd",
    "https://youtube.com/watch?v=../../x",
    "https://youtube.com:444/watch?v=dQw4w9WgXcQ",
  ])("rejects unsupported address %s", (url) => {
    expect(() => normalizeYoutubeUrl(url)).toThrow();
  });
  it("retains a private video identity without inventing its title", () => {
    expect(
      parseYoutubeEntry({
        id: "dQw4w9WgXcQ",
        title: "[Private video]",
        availability: "private",
      }),
    ).toEqual({
      externalId: "dQw4w9WgXcQ",
      available: false,
      reason: "private",
    });
    expect(parseYoutubeEntry({ id: "not a video" })).toBeNull();
  });
  it("distinguishes network failure from confirmed unavailability", () => {
    expect(new YoutubeProviderError("Connection timed out").unavailable).toBe(
      false,
    );
    expect(
      new YoutubeProviderError("Video unavailable: This video is private")
        .unavailable,
    ).toBe(true);
  });
});

import { afterEach, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverYoutube, discoverYoutubePlaylist } from "./youtube.js";

describe("complete YouTube snapshots", () => {
  const url = "https://www.youtube.com/playlist?list=PLtest";
  const entry = { id: "abcdefghijk", title: "[Deleted video]" };

  async function withProvider(
    payload: unknown,
    stderr: string,
    run: () => Promise<unknown>,
  ) {
    const root = await mkdtemp(join(tmpdir(), "hibiki-snapshot-"));
    try {
      const binary = join(root, "yt-dlp");
      await writeFile(
        binary,
        `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (!args.includes("--no-ignore-errors") || args.includes("--ignore-errors"))
          process.exit(1);
        console.log(${JSON.stringify(JSON.stringify(payload))});
        if (${JSON.stringify(stderr)}) console.error(${JSON.stringify(stderr)});
      `,
      );
      await chmod(binary, 0o755);
      vi.stubEnv("YTDLP_PATH", binary);
      return await run();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }

  it("accepts listed unavailable videos and explicitly empty playlists", async () => {
    await withProvider(
      { _type: "playlist", id: "PLtest", entries: [entry], playlist_count: 1 },
      "",
      async () => {
        expect(await discoverYoutubePlaylist(url)).toMatchObject({
          entries: [{ externalId: "abcdefghijk", available: false }],
        });
      },
    );
    await withProvider(
      { _type: "playlist", id: "PLtest", entries: [], playlist_count: 0 },
      "",
      async () => {
        expect(await discoverYoutubePlaylist(url)).toMatchObject({
          entries: [],
        });
      },
    );
  });

  it.each([
    ["another playlist", { id: "PLother", entries: [entry] }, ""],
    ["a malformed position", { entries: [entry, null] }, ""],
    ["a nested playlist", { entries: [{ ...entry, _type: "playlist" }] }, ""],
    ["an incomplete count", { entries: [entry], playlist_count: 2 }, ""],
    [
      "a gap in the positions",
      { entries: [entry], requested_entries: [2] },
      "",
    ],
    ["a provider warning", { entries: [entry] }, "WARNING: incomplete data"],
    ["the truncation sentinel", { entries: Array(10_001).fill(entry) }, ""],
  ])("rejects %s", async (_label, payload, stderr) => {
    await withProvider(
      { _type: "playlist", id: "PLtest", ...payload },
      stderr,
      () =>
        expect(discoverYoutubePlaylist(url)).rejects.toBeInstanceOf(
          YoutubeProviderError,
        ),
    );
  });
});

describe("official metadata fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.YTDLP_PATH;
  });
  it("retains the known identity of a confirmed unavailable single video", async () => {
    const root = await mkdtemp(join(tmpdir(), "hibiki-unavailable-"));
    try {
      const binary = join(root, "yt-dlp");
      await writeFile(
        binary,
        '#!/usr/bin/env node\nconsole.error("ERROR: Video unavailable: This video is private");console.log("null");\n',
      );
      await chmod(binary, 0o755);
      process.env.YTDLP_PATH = binary;
      const result = await discoverYoutube("https://youtu.be/abcdefghijk");
      expect(result.entries[0]).toMatchObject({
        externalId: "abcdefghijk",
        available: false,
      });
      expect(result.entries[0].title).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps real oEmbed title when yt-dlp cannot extract formats, without asserting playback availability", async () => {
    const root = await mkdtemp(join(tmpdir(), "hibiki-provider-"));
    try {
      const binary = join(root, "yt-dlp");
      await writeFile(
        binary,
        '#!/usr/bin/env node\nconsole.error("ERROR: Sign in to confirm you are not a bot");process.exit(1);\n',
      );
      await chmod(binary, 0o755);
      process.env.YTDLP_PATH = binary;
      vi.stubGlobal("fetch", async (url: URL) =>
        new URL(String(url)).hostname === "www.youtube.com" &&
        new URL(String(url)).pathname === "/oembed"
          ? new Response(
              JSON.stringify({
                title: "Official opening",
                thumbnail_url:
                  "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
              }),
              { status: 200 },
            )
          : new Response("", { status: 404 }),
      );
      const result = await discoverYoutube("https://youtu.be/abcdefghijk");
      expect(result.entries).toEqual([
        {
          externalId: "abcdefghijk",
          title: "Official opening",
          thumbnail: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
        },
      ]);
      expect(result.warnings.join(" ")).toMatch(/oEmbed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
