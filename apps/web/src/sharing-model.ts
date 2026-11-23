import type { ShareKind, ShareLinkDto, ShareStatus } from "@hibiki/contracts";
import { api, ApiError } from "./api";

export const shareStatusLabel: Record<ShareStatus, string> = {
  active: "Действует",
  expired: "Срок истёк",
  revoked: "Отозвана",
  unavailable: "Доступ закрыт",
};

export function isClosedShare(error: unknown) {
  return error instanceof ApiError && (error.status === 404 || error.status === 410);
}

export function kanameLoginHref(path: string) {
  const base = "/api/auth/kaname/login";
  return path === "/admin" || path === "/settings" || /^\/share\/[A-Za-z0-9_-]{43}$/.test(path)
    ? `${base}?next=${encodeURIComponent(path)}` : base;
}

export function issueShare(kind: ShareKind, targetId: string) {
  const request = api<ShareLinkDto>("/share-links", "POST", { kind, targetId, expiresAt: null });
  // The request can settle before the dialog's module finishes loading.
  void request.catch(() => {});
  return request;
}

export function formatShareExpiry(expiresAt: string | null) {
  if (expiresAt === null) return "Бессрочно";
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(expiresAt));
}

export function shareLocalTime(expiresAt: string) {
  const date = new Date(expiresAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type ShareDuration = "never" | "day" | "custom";

export function shareExpiry(duration: ShareDuration, localTime: string, now = Date.now()) {
  if (duration === "never") return null;
  if (duration === "day") return new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const time = Date.parse(localTime);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localTime) || !Number.isFinite(time) ||
      shareLocalTime(new Date(time).toISOString()) !== localTime) {
    throw new Error("Укажите дату и время окончания");
  }
  if (time <= now) throw new Error("Укажите время в будущем");
  return new Date(time).toISOString();
}
