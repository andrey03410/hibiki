import { useEffect, useRef, useState } from "react";
import { HardDrive } from "lucide-react";
import { api } from "./api";
import { Button, ErrorMessage, Modal, useData } from "./WorkspaceUi";
import "./storage-settings.css";

type StorageUsage = {
  mediaBytes: number;
  importBytes: number;
  exportBytes: number;
  otherBytes: number;
  temporaryBytes: number;
  limitBytes: number | null;
  cleanable: { count: number; bytes: number };
};
type CleanupResult = StorageUsage["cleanable"] & { failedCount: number };

const archivePlural = new Intl.PluralRules("ru-RU");
function archiveCount(count: number) {
  const form = archivePlural.select(count);
  const word = form === "one" ? "архив" : form === "few" ? "архива" : "архивов";
  return `${count.toLocaleString("ru-RU")} ${word}`;
}

function formatBytes(bytes: number) {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"];
  let unit = 0;
  while (bytes >= 1000 && unit < units.length - 1) {
    bytes /= 1000;
    unit++;
  }
  return `${bytes.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${units[unit]}`;
}

export function StorageSettings() {
  const { refresh } = useData();
  const [usage, setUsage] = useState<StorageUsage>();
  const [result, setResult] = useState<CleanupResult>();
  const [loadError, setLoadError] = useState("");
  const [cleanupError, setCleanupError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const lifetime = useRef<AbortController | null>(null);

  async function load(signal: AbortSignal) {
    setLoadError("");
    try {
      setUsage(await api<StorageUsage>("/storage", "GET", undefined, undefined, signal));
    } catch (error) {
      if (!signal.aborted) setLoadError((error as Error).message);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  async function cleanup() {
    const signal = lifetime.current!.signal;
    setCleaning(true);
    setConfirm(false);
    setCleanupError("");
    setResult(undefined);
    setUsage(undefined);
    try {
      const removed = await api<CleanupResult>("/storage/cleanup", "POST", { confirm: true }, undefined, signal);
      // Keep the preview cards current when the user opens Jobs after cleanup.
      await refresh().catch(() => {});
      if (!signal.aborted) setResult(removed);
    } catch (error) {
      if (!signal.aborted) setCleanupError((error as Error).message);
    } finally {
      if (!signal.aborted) {
        await load(signal);
        if (!signal.aborted) setCleaning(false);
      }
    }
  }

  const permanent = usage && usage.mediaBytes + usage.importBytes + usage.exportBytes + usage.otherBytes;
  return (
    <section className="settings-card storage-settings" aria-labelledby="storage-heading">
      <div className="settings-card-heading">
        <span className="settings-icon" aria-hidden="true"><HardDrive size={22} /></span>
        <h2 id="storage-heading">Хранилище</h2>
      </div>
      <ErrorMessage error={loadError} />
      {loadError && <Button className="subtle" onClick={() => void load(lifetime.current!.signal)}>Обновить данные</Button>}
      {cleaning && <p className="small muted" role="status">Очистка хранилища…</p>}
      {!usage && !loadError && !cleaning && <p className="small muted" role="status">Загружаем данные хранилища…</p>}
      {usage && permanent !== undefined && (
        <>
          <dl className="storage-usage">
            <div className="storage-usage-total"><dt>Постоянно занято</dt><dd>{formatBytes(permanent)}</dd></div>
            <div><dt>Медиафайлы</dt><dd>{formatBytes(usage.mediaBytes)}</dd></div>
            <div><dt>Архивы импортов</dt><dd>{formatBytes(usage.importBytes)}</dd></div>
            <div><dt>Архивы экспортов</dt><dd>{formatBytes(usage.exportBytes)}</dd></div>
            <div><dt>Прочие файлы</dt><dd>{formatBytes(usage.otherBytes)}</dd></div>
            <div className="storage-usage-total"><dt>Временно зарезервировано</dt><dd>{formatBytes(usage.temporaryBytes)}</dd></div>
            <div><dt>Лимит аккаунта</dt><dd>{usage.limitBytes === null ? "Без лимита" : formatBytes(usage.limitBytes)}</dd></div>
            {usage.limitBytes !== null && (
              <div className="storage-usage-total">
                <dt>Доступно для загрузки</dt>
                <dd>{formatBytes(Math.max(0, usage.limitBytes - permanent - usage.temporaryBytes))}</dd>
              </div>
            )}
          </dl>
          {usage.cleanable.count > 0 ? (
            <>
              <p className="small muted">Можно освободить {formatBytes(usage.cleanable.bytes)} за счёт архивов завершённых импортов. К удалению {archiveCount(usage.cleanable.count)}.</p>
              <Button className="subtle" disabled={cleaning} onClick={() => setConfirm(true)}>
                Освободить архивы завершённых импортов
              </Button>
            </>
          ) : (
            <p className="small muted">Нет архивов завершённых импортов, которые можно удалить.</p>
          )}
        </>
      )}
      <ErrorMessage error={cleanupError} />
      {result && (
        <div className="storage-cleanup-result" role="status">
          <p>
            {result.count === 1 ? "Удалён" : "Удалено"} {archiveCount(result.count)}, освобождено {formatBytes(result.bytes)}.
          </p>
          {result.failedCount > 0 && (
            <p className="small">Не удалось удалить архивы: {result.failedCount.toLocaleString("ru-RU")}. Очистку можно повторить.</p>
          )}
        </div>
      )}
      {confirm && usage && (
        <Modal title="Освободить архивы завершённых импортов" close={() => setConfirm(false)}>
          <p>К удалению: {archiveCount(usage.cleanable.count)}, {formatBytes(usage.cleanable.bytes)}.</p>
          <p className="muted">Медиафайлы, теги, плейлисты и история заданий сохранятся.</p>
          <div className="modal-actions">
            <Button className="subtle" onClick={() => setConfirm(false)}>Отмена</Button>
            <Button className="danger" onClick={() => void cleanup()}>Удалить архивы</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
