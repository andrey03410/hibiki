import { useState } from "react";
import { Download, Plus, LoaderCircle, CircleAlert, CheckCircle2, RefreshCw } from "lucide-react";
import { api } from "./api";
import { Button, EmptyState, ErrorMessage, PageTop, useData } from "./WorkspaceUi";

const JOB_NAMES: Record<string, string> = {
  "youtube-import": "Импорт из YouTube",
  "youtube-download": "Скачивание YouTube",
  "youtube-refresh": "Проверка источника",
  "shared-copy": "Создание локальной копии",
  export: "Экспорт медиатеки",
  import: "Импорт архива",
  "import-preview": "Проверка архива",
  "import-apply": "Применение архива",
};
const STATE_NAMES: Record<string, string> = {
  queued: "В очереди",
  running: "Выполняется",
  done: "Завершено",
  failed: "Ошибка",
  cancelled: "Отменено",
};
function JobReport({ result }: { result: any }) {
  const report = result.preview ?? result,
    counts = report.counts,
    duplicates = report.duplicates;
  const metrics: [string, unknown][] = counts
    ? [
        ["Записей", counts.items],
        ["Тегов", counts.tags],
        ["Плейлистов", counts.playlists],
        ["Файлов", counts.files],
      ]
    : [
        ["Добавлено", report.added],
        ["Уже в библиотеке", report.existing ?? report.reused],
        ["Недоступно", report.unavailable],
        ["Ошибок", report.errors],
      ];
  const notices = [...(report.issues ?? []), ...(report.warnings ?? [])];
  return (
    <div className="job-report">
      {metrics.some(([, n]) => typeof n === "number") && (
        <div className="report-counts">
          {metrics
            .filter(([, n]) => typeof n === "number")
            .map(([label, n]) => (
              <span key={label}>
                <strong>{String(n)}</strong>
                {label}
              </span>
            ))}
        </div>
      )}
      {duplicates && (
        <p className="small muted">
          Совпадения: {duplicates.items} записей, {duplicates.tags} тегов,{" "}
          {duplicates.playlists} плейлистов. Существующие названия сохранятся.
        </p>
      )}
      {!!report.missingFiles?.length && (
        <p className="report-warning">
          Локальных файлов вне архива: {report.missingFiles.length}. Их
          источники могут быть недоступны после переноса.
        </p>
      )}
      {notices.map((notice: string, index: number) => (
        <p className="report-warning" key={index}>
          {notice}
        </p>
      ))}
      {result.preview && (
        <p className={`report-verdict ${report.canApply ? "" : "danger-text"}`}>
          {report.canApply
            ? "Архив проверен. Можно применить импорт."
            : "Импорт заблокирован. Исправьте ошибки архива."}
        </p>
      )}
      {result.itemId && (
        <p className="small muted">
          Локальный источник добавлен к существующей записи.
        </p>
      )}
      <details className="job-result">
        <summary>Технические подробности</summary>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}
export default function JobsPage() {
  const { library, refresh, notify, openImport } = useData(),
    [filter, setFilter] = useState("all"),
    [pending, setPending] = useState("");
  const jobs = [...library.jobs]
    .filter(
      (j) =>
        filter === "all" ||
        (filter === "active" &&
          (j.state === "running" || j.state === "queued")) ||
        (filter === "failed" && j.state === "failed"),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  async function action(id: string, name: string) {
    setPending(`${id}:${name}`);
    try {
      await api(
        name === "apply" ? `/imports/${id}/apply` : `/jobs/${id}/${name}`,
        "POST",
      );
      await refresh();
      notify(
        name === "cancel"
          ? "Задание отменено"
          : name === "retry"
            ? "Задание добавлено на повтор"
            : "Импорт запущен",
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setPending("");
    }
  }
  return (
    <>
      <PageTop label="Задания">
        <span className="status-pill">
          <span className="online-dot" />
          Обновляется автоматически
        </span>
      </PageTop>
      <div className="title-row">
        <div>
          <span className="eyebrow">ПУСТЬ HIBIKI ЗАЙМЁТСЯ ЭТИМ</span>
          <h1>
            Задания<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Импорт, скачивание и перенос продолжаются, пока вы слушаете.
          </p>
        </div>
        <Button className="primary" onClick={openImport}>
          <Plus size={17} />
          Добавить медиа
        </Button>
      </div>
      <div className="segmented jobs-filter">
        {[
          ["all", "Все задания"],
          ["active", "В работе"],
          ["failed", "С ошибками"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={filter === id ? "active" : ""}
            onClick={() => setFilter(id!)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="jobs-list">
        {jobs.map((job) => {
          const active = job.state === "running" || job.state === "queued",
            result = job.result as any;
          const isPreview =
            job.kind === "import" &&
            job.state === "done" &&
            result?.preview?.canApply === true;
          const percent = Math.min(100, Math.round(job.progress * 100));
          return (
            <article className="job-card" key={job.id}>
              <div className={`job-icon ${job.state}`}>
                {active ? (
                  <LoaderCircle size={23} className="spin" />
                ) : job.state === "done" ? (
                  <CheckCircle2 size={23} />
                ) : job.state === "failed" ? (
                  <CircleAlert size={23} />
                ) : (
                  <Download size={23} />
                )}
              </div>
              <div className="job-body">
                <div className="job-title-row">
                  <h3>{JOB_NAMES[job.kind] ?? job.kind}</h3>
                  <span className={`state-badge ${job.state}`}>
                    {STATE_NAMES[job.state]}
                  </span>
                </div>
                <p className="small muted">
                  {new Date(job.createdAt).toLocaleString("ru-RU", {
                    day: "numeric",
                    month: "long",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {job.attempt > 1 ? ` · Попытка ${job.attempt}` : ""}
                </p>
                {active && (
                  <>
                    <div className="progress-track">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                    <div className="progress-meta">
                      <span>
                        {job.state === "queued"
                          ? "Ожидает свободного обработчика"
                          : `${job.completed} из ${job.total || "…"}`}
                      </span>
                      <span>{percent}%</span>
                    </div>
                  </>
                )}
                {job.error && <ErrorMessage error={job.error} />}{" "}
                {result && <JobReport result={result} />}
              </div>
              <div className="job-actions">
                {active && (
                  <Button
                    className="subtle compact"
                    busy={pending === `${job.id}:cancel`}
                    onClick={() => action(job.id, "cancel")}
                  >
                    Отменить
                  </Button>
                )}
                {(job.state === "failed" || job.state === "cancelled") && (
                  <Button
                    className="subtle compact"
                    busy={pending === `${job.id}:retry`}
                    onClick={() => action(job.id, "retry")}
                  >
                    <RefreshCw size={14} />
                    Повторить
                  </Button>
                )}
                {job.kind === "export" && job.state === "done" && (
                  <a
                    href={`/api/jobs/${job.id}/download`}
                    className="button primary compact"
                    download
                  >
                    <Download size={14} />
                    Скачать архив
                  </a>
                )}
                {isPreview && (
                  <Button
                    className="primary compact"
                    busy={pending === `${job.id}:apply`}
                    onClick={() => action(job.id, "apply")}
                  >
                    Применить импорт
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!jobs.length && (
        <EmptyState
          title={
            filter === "all"
              ? "Всё спокойно"
              : filter === "active"
                ? "Нет активных заданий"
                : "Ошибок нет"
          }
          text={
            filter === "all"
              ? "Здесь появится прогресс импорта, скачивания и экспорта вашей медиатеки."
              : "Новые задания появятся здесь автоматически."
          }
          icon={<CheckCircle2 size={29} />}
        />
      )}
    </>
  );
}
