import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Db } from "./db";
import { HttpError, invariant } from "./errors";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class AuthService {
  constructor(private db: Db) {}
  async register(login: string, password: string) {
    login = login.trim().toLowerCase();
    invariant(
      /^[a-z0-9_-]{3,40}$/.test(login),
      400,
      "invalid_login",
      "Логин: от 3 до 40 латинских букв, цифр, дефисов или подчёркиваний",
    );
    invariant(
      password.length >= 10 && password.length <= 200,
      400,
      "invalid_password",
      "Пароль: от 10 до 200 символов",
    );
    invariant(
      !(await this.db.user.findUnique({ where: { login } })),
      409,
      "login_taken",
      "Этот логин уже занят",
    );
    const user = await this.db.user.create({
      data: {
        id: randomUUID(),
        login,
        passwordHash: await bcrypt.hash(password, 12),
      },
    });
    await this.db.tag.createMany({
      data: [
        {
          id: randomUUID(),
          ownerId: user.id,
          name: "Любимое",
          color: "#ed9ac8",
        },
        { id: randomUUID(), ownerId: user.id, name: "Аниме", color: "#b8a5ff" },
        { id: randomUUID(), ownerId: user.id, name: "OST", color: "#8bd7c4" },
      ],
    });
    return { id: user.id, login: user.login };
  }
  async login(login: string, password: string) {
    const user = await this.db.user.findUnique({
      where: { login: login.trim().toLowerCase() },
    });
    // A fixed dummy hash keeps unknown-account verification on the same cost path.
    const hash =
      user?.passwordHash ??
      "$2b$12$C6UzMDM.H6dfI/f/IKcEe.0xJL7ChT.H9jATgbV8pMQjTyMJhSg7.";
    const valid = await bcrypt.compare(password, hash);
    if (!user || !valid)
      throw new HttpError(
        401,
        "invalid_credentials",
        "Неверный логин или пароль",
      );
    return { id: user.id, login: user.login };
  }
  async createSession(userId: string) {
    const token = randomBytes(32).toString("base64url");
    await this.db.session.create({
      data: {
        tokenHash: digest(token),
        userId,
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    });
    return token;
  }
  async userBySession(secret?: string) {
    if (!secret) return null;
    const session = await this.db.session.findUnique({
      where: { tokenHash: digest(secret) },
      include: { user: true },
    });
    return session && session.expiresAt > new Date()
      ? { id: session.user.id, login: session.user.login }
      : null;
  }
  async logout(secret?: string) {
    if (secret)
      await this.db.session.deleteMany({
        where: { tokenHash: digest(secret) },
      });
  }
  async createToken(userId: string, name: string) {
    const token = `hib_${randomBytes(32).toString("base64url")}`;
    const row = await this.db.apiToken.create({
      data: {
        id: randomUUID(),
        userId,
        name: name.trim().slice(0, 100) || "Агент",
        tokenHash: digest(token),
      },
    });
    return {
      id: row.id,
      name: row.name,
      token,
      createdAt: row.createdAt.toISOString(),
    };
  }
  async userByToken(secret?: string) {
    if (!secret || !secret.startsWith("hib_")) return null;
    const row = await this.db.apiToken.findUnique({
      where: { tokenHash: digest(secret) },
      include: { user: true },
    });
    return row ? { id: row.user.id, login: row.user.login } : null;
  }
  async listTokens(userId: string) {
    return this.db.apiToken.findMany({
      where: { userId },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
  }
  async deleteToken(userId: string, id: string) {
    await this.db.apiToken.deleteMany({ where: { id, userId } });
  }
}
