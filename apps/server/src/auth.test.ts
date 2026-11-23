import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { AuthService } from "./auth";
import { testContext } from "./test-utils";
describe("account credentials", () => {
  let ctx: Awaited<ReturnType<typeof testContext>>;
  beforeEach(async () => {
    ctx = await testContext();
  });
  afterEach(async () => {
    await ctx.close();
  });
  it("blocks HTTP registration when accounts are provisioned", async () => {
    vi.stubEnv("PROVISIONED_ACCOUNTS_ONLY", "1");
    const app = await createApp({ db: ctx.db, storageRoot: ctx.root });
    try {
      const response = await app.inject({ method: "POST", url: "/api/auth/register", payload: {
        login: "listener", password: "test-password-123",
      } });
      expect(response.statusCode).toBe(403);
      expect(await ctx.db.user.findUnique({ where: { login: "listener" } })).toBeNull();
    } finally { await app.close(); vi.unstubAllEnvs(); }
  });
  it("hashes passwords, checks sessions and revokes personal tokens", async () => {
    const auth = new AuthService(ctx.db);
    const user = await auth.register("listener", "test-password-123");
    const catalog = await ctx.library.snapshot(user.id);
    expect(catalog.tags.filter(tag => tag.group === "source").map(tag => tag.name).sort())
      .toEqual(["Аниме", "Визуальная новелла", "Игра", "Песня", "Сериал", "Фильм"]);
    expect(catalog.tags.filter(tag => tag.group === "mood")).toHaveLength(4);
    expect(catalog.tags.some(tag => ["Любимое", "OST"].includes(tag.name))).toBe(false);
    expect(
      (await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } }))
        .passwordHash,
    ).not.toContain("test-password");
    await expect(auth.login("listener", "wrong")).rejects.toThrow();
    expect((await auth.login("LISTENER", "test-password-123")).id).toBe(
      user.id,
    );
    const session = await auth.createSession(user.id);
    expect((await auth.userBySession(session))?.id).toBe(user.id);
    const token = await auth.createToken(user.id, "My agent");
    expect((await auth.userByToken(token.token))?.id).toBe(user.id);
    expect(JSON.stringify(await auth.listTokens(user.id))).not.toContain(
      token.token,
    );
    await auth.deleteToken(user.id, token.id);
    expect(await auth.userByToken(token.token)).toBeNull();
    await auth.logout(session);
    expect(await auth.userBySession(session)).toBeNull();
  });
});
