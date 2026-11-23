import { useEffect, useState } from "react";
import { api } from "./api";

type Account = {
  role: "user" | "admin" | "overlord";
  limits: { storageBytes: number | null; items: number | null };
  usage: { storageBytes: number; counts: { items: number } };
  portal: string;
};
type Admin = {
  users: { id: string; login: string; suspended: boolean; _count: { items: number; jobs: number } }[];
  jobs: { id: string; ownerId: string; owner: { login: string }; kind: string; state: string }[];
};
const roleNames = { user: "Пользователь", admin: "Администратор", overlord: "Владелец" };
const formatGB = (bytes: number) => (bytes / 1_000_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 3 }) + " ГБ";
export function KanameSettings({ userId, adminPage = false }: { userId: string; adminPage?: boolean }) {
  const [account, setAccount] = useState<Account>();
  const [admin, setAdmin] = useState<Admin>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const profile = await api<Account>("/kaname/account");
    setAccount(profile);
    if (adminPage && profile.role === "user") setError("Для управления Hibiki требуются права администратора.");
    if (profile.role !== "user") setAdmin(await api<Admin>("/kaname/admin"));
  }
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [userId, adminPage]);
  async function moderate(url: string, method: string, data?: object) {
    setBusy(true); setError("");
    try { await api(url, method, data); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="settings-card">
    <h2>Аккаунт Kaname</h2>
    {error && <p role="alert">{error}</p>}
    {account && <>
      <p>{roleNames[account.role]} Hibiki</p>
      <p>Записи: {account.usage.counts.items}{account.limits.items === null ? " · без ограничения" : " из " + account.limits.items}</p>
      <p>Хранилище: {formatGB(account.usage.storageBytes)}{account.limits.storageBytes === null ? " · без ограничения" : " из " + formatGB(account.limits.storageBytes)}</p>
      <a href={account.portal}>Личный кабинет Kaname ↗</a>
    </>}
    {admin && <details open={adminPage || undefined}><summary>Управление Hibiki</summary>
      <h3>Пользователи площадки</h3>
      {admin.users.map(u => <p key={u.id}><strong>{u.login}</strong> · {u._count.items} записей · {u.suspended ? "Доступ приостановлен" : "Активен"}{" "}
        {u.id !== userId && <button disabled={busy} onClick={() => moderate("/kaname/admin/users/" + u.id, "PATCH", { suspended: !u.suspended })}>
          {u.suspended ? "Восстановить доступ" : "Приостановить доступ"}</button>}</p>)}
      <h3>Последние задания</h3>
      {!admin.jobs.length && <p>Заданий пока нет.</p>}
      {admin.jobs.map(j => <p key={j.id}>{j.owner.login} · {j.kind} · {j.state}{" "}
        {["running", "queued"].includes(j.state) && <button disabled={busy} onClick={() => moderate("/kaname/admin/jobs/" + j.id + "/cancel", "POST")}>Отменить задание</button>}</p>)}
    </details>}
  </section>;
}
