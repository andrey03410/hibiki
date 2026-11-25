import { ItemSelect } from "./ItemPicker";
import { Clock3, Download } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useLocation } from "react-router";
import { api, formatDuration } from "./api";
import {
  type HistoryPreference, type ListeningOutcome, type ListeningTrigger,
  notifyHistoryPreference,
} from "./listening-client";
import "./history.css";

type Named = { id: string; title: string };
type Attempt = {
  id: string;
  itemId: string;
  itemTitle: string;
  playlistId: string | null;
  playlistTitle: string | null;
  startedAt: string;
  outcome: ListeningOutcome;
  trigger: ListeningTrigger;
  listened: number;
  seeks: number;
};
type Totals = {
  launches: number;
  completed: number;
  partial: number;
  skipped: number;
  errors: number;
  listened: number;
  seeks: number;
};
type Overview = HistoryPreference & {
  bytes: number;
  overThreshold: boolean;
  ever: Totals;
  sevenDays: Totals;
  thirtyDays: Totals;
};
type Page = { attempts: Attempt[]; nextCursor: string | null };
type Preview = {
  count: number;
  unfinishedCount: number;
  bytes: number;
  attempts: Attempt[];
  from: string | null;
  to: string;
  token: string | null;
};
type Period = { month: string; count: number; bytes: number };

const labels: Record<ListeningOutcome, string> = {
  active: "Без отметки о завершении", completed: "Дослушано", partial: "Частично",
  skipped: "Быстрый пропуск", error: "Ошибка",
};
const triggerLabels: Record<ListeningTrigger, string> = {
  manual: "Вручную", advance: "Автопереход", repeat: "Повтор",
};
const dateTime = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" });
const numbers = new Intl.NumberFormat("ru-RU");
const byteNumber = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const dateLabel = (value: string) => dateTime.format(new Date(value));

function storageSize(bytes: number) {
  if (bytes < 1_000) return `${byteNumber.format(bytes)} Б`;
  if (bytes < 1_000_000) return `${byteNumber.format(bytes / 1_000)} КБ`;
  if (bytes < 1_000_000_000) return `${byteNumber.format(bytes / 1_000_000)} МБ`;
  return `${byteNumber.format(bytes / 1_000_000_000)} ГБ`;
}

export function historyDateRange(from: string, through: string) {
  const start = from ? new Date(from + "T00:00:00") : undefined;
  const end = through ? new Date(through + "T00:00:00") : undefined;
  if (end) end.setDate(end.getDate() + 1);
  if (start && end && start >= end) throw new Error("Дата начала должна быть раньше даты окончания или совпадать с ней.");
  return { from: start?.toISOString(), to: end?.toISOString() };
}

export function cleanupPrompt(periods: Period[]) {
  return [
    "Помоги выбрать период для очистки подробной истории в Hibiki. Сначала предложи один период из старых месяцев и оцени, сколько места освободится. Если возможны разные варианты, покажи до трёх.",
    "Сводные счётчики сохранятся. Период я проверю и применю самостоятельно в Hibiki.",
    "",
    "Месяц (UTC), попытки, объём в байтах",
    ...periods.map(({ month, count, bytes }) => `${month}, ${count}, ${bytes}`),
  ].join("\n");
}

function historyUrl(path: string, filters: Record<string, string | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) if (value) search.set(name, value);
  return "/history/" + path + (search.size ? "?" + search.toString() : "");
}

export function HistorySettings({ items = [], playlists = [], revision }: { items?: Named[]; playlists?: Named[]; revision?:string }) {
  const { search, hash } = useLocation();
  const linkedItemId = new URLSearchParams(search).get("historyItem") ?? "";
  const id = useId();
  const [overview, setOverview] = useState<Overview>();
  const [page, setPage] = useState<Page>();
  const [cursors, setCursors] = useState<string[]>([]);
  const [itemId, setItemId] = useState(linkedItemId);
  const [playlistId, setPlaylistId] = useState("");
  const [outcome, setOutcome] = useState<ListeningOutcome | "">("");
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");
  const [cleanFrom, setCleanFrom] = useState("");
  const [cleanThrough, setCleanThrough] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [prompt, setPrompt] = useState("");
  const [cleanOpen, setCleanOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [pageError, setPageError] = useState("");
  const [actionError, setActionError] = useState("");
  const [status, setStatus] = useState("");
  const [refresh, setRefresh] = useState(0);

  let range: ReturnType<typeof historyDateRange> = { from: undefined, to: undefined };
  let dateError = "";
  try {
    range = historyDateRange(from, through);
  } catch (error) {
    dateError = (error as Error).message;
  }
  const filters = { ...range, itemId, playlistId, outcome };
  const journalUrl = historyUrl("attempts", { ...filters, cursor: cursors.at(-1) });
  const refreshData = () => setRefresh(value => value + 1);
  const firstPage = () => setCursors([]);

  useEffect(() => {
    setItemId(linkedItemId);
    setCursors([]);
  }, [linkedItemId]);
  useEffect(() => {
    if (hash !== "#history") return;
    const frame = requestAnimationFrame(() => document.getElementById("history")?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [hash, linkedItemId]);

  useEffect(() => {
    let live = true;
    setLoadError("");
    void api<Overview>("/history/summary").then(
      data => { if (live) setOverview(data); },
      error => { if (live) setLoadError(error.message); },
    );
    return () => { live = false; };
  }, [refresh]);
  useEffect(() => {
    setPage(undefined);
    setPageError("");
    if (dateError) return;
    let live = true;
    void api<Page>(journalUrl).then(
      data => { if (live) setPage(data); },
      error => { if (live) setPageError(error.message); },
    );
    return () => { live = false; };
  }, [journalUrl, dateError, refresh]);

  async function perform(task: () => Promise<void>) {
    setBusy(true);
    setActionError("");
    setStatus("");
    try {
      await task();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function showSelection() {
    setFrom(cleanFrom);
    setThrough(cleanThrough);
    setItemId("");
    setPlaylistId("");
    setOutcome("");
    firstPage();
    document.getElementById(id + "-journal")?.scrollIntoView({ block: "start" });
  }

  return (
    <section id="history" className="settings-card history-settings" aria-labelledby={id}>
      <div className="settings-card-heading">
        <span className="settings-icon" aria-hidden="true"><Clock3 size={20} /></span>
        <div>
          <h2 id={id}>История и данные</h2>
          <p>Журнал прослушиваний и сводка для правил плейлистов.</p>
        </div>
      </div>
      <div className="history-overview">
        <label className="history-check">
          <input type="checkbox" checked={overview?.enabled ?? false} disabled={busy || !overview}
            onChange={event => {
              const enabled = event.currentTarget.checked;
              void perform(async () => {
                const value = await api<HistoryPreference>("/history/preference", "PUT", { enabled });
                setOverview(previous => previous && { ...previous, ...value });
                notifyHistoryPreference();
                setStatus(enabled ? "Запись истории включена." : "Сбор остановлен. Записанная история сохранена.");
              });
            }} />
          Записывать историю
        </label>
        {overview && <span>Объём журнала&nbsp;≈&nbsp;{storageSize(overview.bytes)}</span>}
      </div>
      {loadError && <p role="alert">{loadError}</p>}
      {overview && !overview.enabled && <p className="muted">Правила плейлистов используют историю, записанную до отключения сбора.</p>}
      {overview?.resetAt && <p className="muted">Последний полный сброс {dateLabel(overview.resetAt)}.</p>}
      {overview?.pruned && <p className="muted">Часть подробностей удалена. Показатели за 7 и 30 дней рассчитаны по оставшемуся журналу.</p>}
      {overview && (
        <div className="history-table-scroll">
          <table className="history-table">
            <caption>Прослушивания по периодам</caption>
            <thead><tr>
              <th scope="col">Период</th><th scope="col">Запуски</th><th scope="col">Дослушано</th>
              <th scope="col">Частично</th><th scope="col">Пропуски</th><th scope="col">Ошибки</th>
              <th scope="col">Время</th><th scope="col">Перемотки</th>
            </tr></thead>
            <tbody>
              {([["7 дней", overview.sevenDays], ["30 дней", overview.thirtyDays],
                ["Всё время", overview.ever]] as const).map(([label, total]) => (
                <tr key={label}><th scope="row">{label}</th>
                  {[total.launches, total.completed, total.partial, total.skipped, total.errors].map((value, index) =>
                    <td key={index}>{numbers.format(value)}</td>)}
                  <td>{formatDuration(total.listened)}</td><td>{numbers.format(total.seeks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div id={id + "-journal"} className="history-journal">
        <div className="history-actions">
          <h3>Журнал</h3>
          <a className="button subtle compact" href="/api/history/summary.csv" download><Download size={14} /> Скачать сводку CSV</a>
          {!dateError && <a className="button subtle compact" href={"/api" + historyUrl("attempts.csv", filters)} download><Download size={14} /> Скачать историю CSV</a>}
          <button className="button subtle compact" onClick={refreshData}>Обновить</button>
        </div>
        <div className="history-filters">
          <label>С даты <input type="date" value={from} onChange={e => { setFrom(e.target.value); firstPage(); }} /></label>
          <label>По дату <input type="date" value={through} onChange={e => { setThrough(e.target.value); firstPage(); }} /></label>
          <ItemSelect label="Запись" empty="Все записи" value={itemId} known={items} revision={revision}
            onChange={id => { setItemId(id); firstPage(); }} />
          <label>Плейлист <select value={playlistId} onChange={e => { setPlaylistId(e.target.value); firstPage(); }}>
            <option value="">Все плейлисты</option>
            {playlistId && !playlists.some(p => p.id === playlistId) && <option value={playlistId}>Выбранный плейлист</option>}
            {playlists.map(playlist => <option key={playlist.id} value={playlist.id}>{playlist.title}</option>)}
          </select></label>
          <label>Исход <select value={outcome} onChange={e => { setOutcome(e.target.value as typeof outcome); firstPage(); }}>
            <option value="">Все исходы</option>
            {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
        </div>
        {dateError || pageError ? <p role="alert">{dateError || pageError}</p> :
          !page ? <p className="muted" role="status">Загрузка журнала…</p> :
          !page.attempts.length ? <p className="muted">За выбранный период попыток нет.</p> :
          <div className="history-table-scroll">
            <table className="history-table">
              <thead><tr>
                <th scope="col">Старт</th><th scope="col">Запись</th><th scope="col">Плейлист</th>
                <th scope="col">Запуск</th><th scope="col">Исход</th><th scope="col">Время</th><th scope="col">Перемотки</th>
              </tr></thead>
              <tbody>{page.attempts.map(attempt => (
                <tr key={attempt.id}>
                  <td><time dateTime={attempt.startedAt}>{dateLabel(attempt.startedAt)}</time></td>
                  <td><button type="button" className="history-filter-link" onClick={() => { setItemId(attempt.itemId); firstPage(); }}>
                    {attempt.itemTitle || "Удалённая запись"}
                  </button></td>
                  <td>{attempt.playlistId ? <button type="button" className="history-filter-link" onClick={() => {
                    setPlaylistId(attempt.playlistId!); firstPage();
                  }}>{attempt.playlistTitle || "Удалённый плейлист"}</button> : "—"}</td>
                  <td>{triggerLabels[attempt.trigger]}</td><td>{labels[attempt.outcome]}</td>
                  <td>{formatDuration(attempt.listened)}</td><td>{numbers.format(attempt.seeks)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>}
        {(cursors.length > 0 || page?.nextCursor) && <div className="history-actions">
          <button className="button subtle compact" disabled={!cursors.length}
            onClick={() => setCursors(cursors.slice(0, -1))}>Назад</button>
          <button className="button subtle compact" disabled={!page?.nextCursor} onClick={() => {
            if (page?.nextCursor) setCursors([...cursors, page.nextCursor]);
          }}>Далее</button>
        </div>}
      </div>

      <div className="history-cleanup">
        <h3>Очистка истории</h3>
        {overview?.overThreshold && <div className="history-notice">
          <p>Журнал превысил 1 ГБ. Hibiki продолжит записывать историю и хранить прошлые попытки.</p>
          <button className="button subtle compact" disabled={busy} onClick={() => void perform(async () => {
            const { periods } = await api<{ periods: Period[] }>("/history/cleanup/context");
            setCleanOpen(true);
            setPrompt(cleanupPrompt(periods));
          })}>Подобрать очистку с агентом</button>
        </div>}
        <div className="history-actions">
          <button className="button subtle compact" aria-expanded={cleanOpen} disabled={busy} onClick={() => {
            setCleanOpen(!cleanOpen); setPreview(undefined); setPrompt(""); setResetOpen(false);
          }}>Выбрать период</button>
          <button className="button subtle compact" aria-expanded={resetOpen} disabled={busy}
            onClick={() => { setResetOpen(!resetOpen); setCleanOpen(false); setPreview(undefined); setPrompt(""); }}>Полный сброс</button>
        </div>
        {cleanOpen && <div className="history-confirm">
          {prompt && <div className="history-agent">
            <label>Контекст для агента<textarea value={prompt} readOnly rows={7} onFocus={e => e.currentTarget.select()} /></label>
            <button className="button subtle compact" onClick={() => void perform(async () => {
              if (!navigator.clipboard) throw new Error("Выделите текст и скопируйте его вручную.");
              await navigator.clipboard.writeText(prompt);
              setStatus("Контекст скопирован.");
            })}>Скопировать</button>
          </div>}
          <p className="muted">При очистке периода сохраняются попытки без отметки о завершении, счётчики и даты запусков.</p>
          <form className="history-filters" onSubmit={event => {
            event.preventDefault();
            if (!cleanThrough || busy) return;
            void perform(async () => {
              setPreview(undefined);
              setPreview(await api<Preview>("/history/cleanup/preview", "POST", historyDateRange(cleanFrom, cleanThrough)));
            });
          }}>
            <label>С даты <input type="date" value={cleanFrom} disabled={busy} onChange={e => { setCleanFrom(e.target.value); setPreview(undefined); }} /></label>
            <label>По дату <input type="date" value={cleanThrough} required disabled={busy} onChange={e => { setCleanThrough(e.target.value); setPreview(undefined); }} /></label>
            <button type="submit" className="button subtle compact" disabled={busy || !cleanThrough}>Предпросмотр</button>
          </form>
          {preview && <div aria-live="polite">
            <p>{preview.from ? "С " + dateLabel(preview.from) + " до " : "До "}{dateLabel(preview.to)}.
              К удалению — {numbers.format(preview.count)}. Объём подробностей — около {storageSize(preview.bytes)}.</p>
            {preview.unfinishedCount > 0 &&
              <p>В журнале останутся попытки без отметки о завершении — {numbers.format(preview.unfinishedCount)}.</p>}
            {preview.attempts.length > 0 && <ul className="history-preview-list">
              {preview.attempts.map(attempt => <li key={attempt.id}>
                {dateLabel(attempt.startedAt)} · {attempt.itemTitle || "Удалённая запись"} · {labels[attempt.outcome]}
              </li>)}
            </ul>}
            {(preview.count > 0 || preview.unfinishedCount > 0) && <div className="history-actions">
              <button className="button subtle compact" onClick={showSelection}>Показать период в журнале</button>
              <a className="button subtle compact" href={"/api" + historyUrl("attempts.csv", {
                from: preview.from ?? undefined, to: preview.to,
              })} download>Скачать этот период CSV</a>
              {preview.token && <button className="button subtle compact history-danger" disabled={busy} onClick={() => void perform(async () => {
                const { deleted } = await api<{ deleted: number }>("/history/cleanup/confirm", "POST", { token: preview.token });
                setPreview(undefined); setCleanOpen(false); setPrompt(""); firstPage(); refreshData();
                setStatus(`Удалено попыток — ${numbers.format(deleted)}.`);
              })}>Подтвердить удаление</button>}
            </div>}
          </div>}
        </div>}
        {resetOpen && <div className="history-confirm">
          <p>Полный сброс удалит журнал и все счётчики прослушиваний. Состав живых плейлистов с правилами истории изменится.</p>
          <div className="history-actions">
            <button className="button subtle compact" disabled={busy} onClick={() => setResetOpen(false)}>Отмена</button>
            <button className="button subtle compact history-danger" disabled={busy} onClick={() => void perform(async () => {
              await api("/history/reset", "POST", { confirm: true });
              notifyHistoryPreference({ historyReset: true });
              setResetOpen(false); firstPage(); refreshData();
              setStatus("Журнал и сводка удалены.");
            })}>Подтвердить полный сброс</button>
          </div>
        </div>}
      </div>
      {actionError && <p role="alert">{actionError}</p>}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
