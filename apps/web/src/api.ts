export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers:
      body instanceof FormData
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const data =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
  if (!response.ok)
    throw new ApiError(
      data?.error?.code ?? "REQUEST_FAILED",
      data?.error?.message ??
        `Не удалось выполнить запрос (${response.status})`,
    );
  return data as T;
}
export function formatDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.floor(value));
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function humanDuration(value: number): string {
  const minutes = Math.round(value / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
    : `${minutes} мин`;
}
export function mediaWord(count: number): string {
  const n = count % 100,
    last = n % 10;
  return n >= 11 && n <= 14
    ? "записей"
    : last === 1
      ? "запись"
      : last >= 2 && last <= 4
        ? "записи"
        : "записей";
}
