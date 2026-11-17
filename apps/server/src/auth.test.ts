import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("hashes passwords, checks sessions and revokes personal tokens", async () => {
    const auth = new AuthService(ctx.db);
    const user = await auth.register("listener", "test-password-123");
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
