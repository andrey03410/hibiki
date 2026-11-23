import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Db } from "./db";
import { HttpError, invariant } from "./errors";

import { env, kanameEnabled, type Access } from "./kaname";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function seedTags() {
  return [
      ...["Аниме", "Визуальная новелла", "Игра", "Фильм", "Сериал", "Песня"].map(name => ({
        name, group: "source", aliases: JSON.stringify(name === "Визуальная новелла" ? ["ВН"] : []),
      })),
      ...["Спокойная", "Быстрая", "Загадочная", "Агрессивная"].map(name => ({ name, group: "mood" })),
      ...[["Cover", "Кавер"], ["Remix", "Ремикс"], ["Опенинг"], ["Эндинг"]].map(([name, alias]) => ({
        name, group: "extra", aliases: JSON.stringify(alias ? [alias] : []),
      })),
    ];
}
export class AuthService {
  constructor(private db: Db) {}
  async register(login: string, password: string, { provisioned = false } = {}) {
    invariant(!kanameEnabled(), 403, "kaname_only", "Войдите через Kaname");
    login = login.trim().toLowerCase();
    invariant(
      /^[a-z0-9_-]{3,40}$/.test(login),
      400,
      "invalid_login",
      "Логин: от 3 до 40 латинских букв, цифр, дефисов или подчёркиваний",
    );
    invariant(
      password.length >= (provisioned ? 1 : 10) && password.length <= 200,
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
        id: randomUUID(), login, passwordHash: await bcrypt.hash(password, 12),
        tags: { create: seedTags().map(tag => ({ ...tag, id: randomUUID() })) },
      },
    });
    return { id: user.id, login: user.login };
  }
  async login(login: string, password: string) {
    invariant(!kanameEnabled(), 403, "kaname_only", "Войдите через Kaname");
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
  async federatedUser(access: Access) {
    const identity = { kanameIssuer: env("KANAME_OIDC_ISSUER"), kanameSubject: access.subject };
    return this.db.$transaction(async tx => {
      const existing = await tx.user.findUnique({ where: { kanameIssuer_kanameSubject: identity } });
      if (existing) return existing;
      const login = access.login.toLowerCase();
      invariant(login !== "andrey" && access.role !== "overlord" && !(await tx.user.findUnique({ where: { login } })),
        409, "kaname_binding_required", "Администратору нужно связать существующий профиль с Kaname");
      return tx.user.create({ data: { id: randomUUID(), login, passwordHash: "federated", ...identity,
        tags: { create: seedTags().map(tag => ({ ...tag, id: randomUUID() })) } } });
    });
  }
  async createSession(userId: string, kaname = false) {
    const token = randomBytes(32).toString("base64url");
    await this.db.session.create({
      data: {
        tokenHash: digest(token),
        kaname, userId,
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
    return session && session.kaname === kanameEnabled() && session.expiresAt > new Date()
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
        kaname: kanameEnabled(),
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
    return row && row.kaname === kanameEnabled() ? { id: row.user.id, login: row.user.login } : null;
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
