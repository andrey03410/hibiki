import { useEffect, useState } from "react";
import { api } from "./api";
import { missingLabels } from "./taxonomy";

type Batch = {
  id: string;
  state: "preview" | "applied" | "undone";
  items?: number;
  tags?: number;
  archivedTags?: number;
  incomplete?: number;
  missing?: Record<string, number>;
  favoritesAdded?: number;
  skipped?: number;
  examples?: { before: string; after: string; count: number }[];
};
const stateNames = { preview: "Предпросмотр", applied: "Применён", undone: "Отменён" };

export function ClassificationMigration({ reload }: { reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false),
    [batch, setBatch] = useState<Batch | null>(null);
  const [file, setFile] = useState<File | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true);
    api<{ batch: Batch | null }>("/classification/latest")
      .then(({ batch: latest }) => {
        if (active)
          setBatch((old) => (latest?.id === old?.id && latest?.state === old?.state ? old : latest));
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [open]);
  async function run(action: "preview" | "apply" | "undo") {
    setBusy(true);
    setError("");
    try {
      if (action === "preview" && file) {
        const data = JSON.parse(await file.text());
        setBatch(await api<Batch>("/classification/preview", "POST", data));
      } else if (batch) {
        const updated = await api<Batch>("/classification/" + batch.id + "/" + action, "POST");
        setBatch({ ...batch, ...updated });
        await reload();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="classification-migration" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Перенос разметки</summary>
      {open && (
        <div className="migration-body">
          <label>
            Пакет разметки (JSON)
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setBatch((old) => (old?.state === "preview" ? null : old));
              }}
            />
          </label>
          <button
            className="button subtle compact"
            type="button"
            disabled={!file || busy}
            onClick={() => void run("preview")}
          >
            Показать предпросмотр
          </button>
          {batch && (
            <section>
              <h3>Пакет · {stateNames[batch.state]}</h3>
              {batch.items !== undefined && (
                <>
                  <p>
                    Записей {batch.items} · Значений {batch.tags} · В архив {batch.archivedTags} · Добавится в
                    избранное {batch.favoritesAdded}
                  </p>
                  <p>Требуют разметки: {batch.incomplete}</p>
                  <ul>
                    {Object.entries(batch.missing ?? {}).map(([key, count]) => (
                      <li key={key}>
                        {missingLabels[key as keyof typeof missingLabels] ?? key} — {count}
                      </li>
                    ))}
                  </ul>
                  {!!batch.examples?.length && (
                    <div className="migration-examples">
                      <table>
                        <thead>
                          <tr>
                            <th>Прежние теги</th>
                            <th>Новая разметка</th>
                            <th>Записи</th>
                          </tr>
                        </thead>
                        <tbody>
                          {batch.examples.map((row, i) => (
                            <tr key={i}>
                              <td>{row.before || "—"}</td>
                              <td>{row.after || "—"}</td>
                              <td>{row.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
              {batch.state === "preview" && batch.items !== undefined && (
                <button
                  type="button"
                  disabled={busy}
                  className="button primary"
                  onClick={() => void run("apply")}
                >
                  Применить пакет
                </button>
              )}
              {batch.state === "applied" && (
                <button
                  type="button"
                  disabled={busy}
                  className="button subtle"
                  onClick={() => void run("undo")}
                >
                  Отменить пакет
                </button>
              )}
              {batch.skipped !== undefined && <p>Сохранено последующих изменений: {batch.skipped}</p>}
            </section>
          )}
          {error && (
            <p role="alert" className="error-box">
              {error}
            </p>
          )}
        </div>
      )}
    </details>
  );
}
