import { useEffect, useId, useRef, useState } from "react";
import type { ItemDto } from "@hibiki/contracts";
import { api, formatDuration } from "./api";
import "./SourceReplacement.css";

interface Proposal {
  id: string;
  kind: "youtube" | "local";
  url: string | null;
  reason: string | null;
  preview: {
    title: string;
    duration: number | null;
    warnings: string[];
  } | null;
}

interface Props {
  item: Pick<ItemDto, "id">;
  reload: () => void | Promise<void>;
}

async function listProposals(path: string) {
  return (await api<{ proposals: Proposal[] }>(path)).proposals;
}

export function SourceReplacement({ item, reload }: Props) {
  return <ReplacementForm key={item.id} item={item} reload={reload} />;
}

function ReplacementForm({ item, reload }: Props) {
  const path = `/items/${encodeURIComponent(item.id)}/replacements`;
  const headingId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File>();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const loading = proposals === null;

  useEffect(() => {
    let current = true;
    listProposals(path).then(
      (rows) => { if (current) setProposals(rows); },
      (failure: Error) => {
        if (!current) return;
        setProposals([]);
        setError(failure.message);
      },
    );
    return () => { current = false; };
  }, [path]);

  function remember(proposal: Proposal) {
    setProposals((rows) => {
      const current = rows ?? [];
      return current.some((row) => row.id === proposal.id)
        ? current.map((row) => row.id === proposal.id ? proposal : row)
        : [proposal, ...current];
    });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
      // A failed local confirmation can remove the staged candidate on the server.
      await listProposals(path).then(setProposals, () => {});
    } finally {
      setBusy(false);
    }
  }

  async function previewLink() {
    const { proposal } = await api<{ proposal: Proposal }>(`${path}/preview`, "POST", { url });
    remember(proposal);
    setUrl("");
  }

  async function previewFile(candidate: File) {
    const body = new FormData();
    body.append("file", candidate);
    const { proposal } = await api<{ proposal: Proposal }>(`${path}/preview`, "POST", body);
    remember(proposal);
    setFile(undefined);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function check(proposal: Proposal) {
    const { proposal: checked } = await api<{ proposal: Proposal }>(
      `${path}/${encodeURIComponent(proposal.id)}/preview`, "POST", {},
    );
    remember(checked);
  }

  async function resolve(proposal: Proposal, action: "confirm" | "decline") {
    await api(`${path}/${encodeURIComponent(proposal.id)}/${action}`, "POST", {});
    setProposals((rows) => rows?.filter((row) => row.id !== proposal.id) ?? []);
    if (action === "confirm") {
      setNotice("Предпочтительный источник обновлён");
      await reload();
    } else {
      setNotice(proposal.reason ? "Предложение отклонено" : "Замена отменена");
    }
  }

  return (
    <section className="source-replacement" aria-labelledby={headingId} aria-busy={busy}>
      <h3 id={headingId}>Заменить источник</h3>
      <div className="source-replacement-input">
        <label>
          Ссылка на ролик YouTube
          <input
            type="text"
            inputMode="url"
            maxLength={4000}
            value={url}
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (url.trim() && !busy && !loading) void run(previewLink);
            }}
          />
        </label>
        <button type="button" className="button subtle" disabled={busy || loading || !url.trim()}
          onClick={() => void run(previewLink)}>
          Проверить ссылку
        </button>
      </div>
      <div className="source-replacement-input">
        <label>
          Локальный файл
          <input ref={fileInput} type="file" disabled={busy}
            accept="audio/*,video/*,.mkv,.m4v,.opus,.wma"
            onChange={(event) => setFile(event.target.files?.[0])}
          />
        </label>
        <button type="button" className="button subtle" disabled={busy || loading || !file}
          onClick={() => file && void run(() => previewFile(file))}>
          Проверить файл
        </button>
      </div>
      {busy && <p className="small muted" role="status">Обрабатываем источник…</p>}
      {notice && <p className="small" role="status">{notice}</p>}
      {error && <p className="small danger-text" role="alert">{error}</p>}
      {proposals?.map((proposal) => (
        <div className="source-replacement-proposal" key={proposal.id}>
          <div className="source-replacement-preview">
            <strong>{proposal.preview?.title ?? "Предложение агента"}</strong>
            {proposal.preview?.duration != null && <span>{formatDuration(proposal.preview.duration)}</span>}
          </div>
          {proposal.url && <a href={proposal.url} target="_blank" rel="noreferrer">{proposal.url}</a>}
          {proposal.reason && <p>{proposal.reason}</p>}
          <p className="small muted">
            {proposal.preview
              ? proposal.kind === "local" ? "Файл проверен" : "YouTube подтвердил доступность"
              : "Ожидает проверки"}
          </p>
          {proposal.preview?.warnings.map((warning) => <p className="small muted" key={warning}>{warning}</p>)}
          <div className="source-replacement-actions">
            {proposal.preview ? (
              <button type="button" className="button primary" disabled={busy}
                onClick={() => void run(() => resolve(proposal, "confirm"))}>
                Подтвердить замену
              </button>
            ) : (
              <button type="button" className="button subtle" disabled={busy}
                onClick={() => void run(() => check(proposal))}>
                Проверить источник
              </button>
            )}
            <button type="button" className="button subtle" disabled={busy}
              onClick={() => void run(() => resolve(proposal, "decline"))}>
              {proposal.reason ? "Отклонить предложение" : "Отменить замену"}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
