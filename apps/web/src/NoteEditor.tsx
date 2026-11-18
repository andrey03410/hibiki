import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { NotebookPen } from "lucide-react";
import { api } from "./api";
import { noteFor, type NoteKind, type NotesIndex } from "./note-model";
import "./notes.css";

export function useNotesController() {
  const [notes, setNotes] = useState<NotesIndex>();
  const [error, setError] = useState("");
  const request = useRef(0);

  const reload = useCallback(async () => {
    const id = ++request.current;
    setError("");
    try {
      const result = await api<NotesIndex>("/notes");
      if (id === request.current) setNotes(result);
    } catch (e) {
      if (id === request.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => { request.current++; };
  }, [reload]);

  async function save(kind: NoteKind, id: string, text: string) {
    const saved = await api<{ text: string | null }>(`/notes/${kind}/${encodeURIComponent(id)}`, "PUT", { text });
    request.current++;
    setNotes((old) => {
      if (!old) return old;
      if (saved.text !== null) return { ...old, [kind]: { ...old[kind], [id]: saved.text } };
      const next = { ...old[kind] };
      delete next[id];
      return { ...old, [kind]: next };
    });
  }

  return { notes, error, reload, save };
}

export const NotesContext = createContext<ReturnType<typeof useNotesController> | null>(null);

export function useNotes() {
  const context = useContext(NotesContext);
  if (!context) throw new Error("NotesContext is required");
  return context;
}

export function NotesLoadError() {
  const { error, reload } = useNotes();
  return error ? (
    <p className="notes-error" role="alert">
      Не удалось загрузить заметки. {error}{" "}
      <button className="text-button" type="button" onClick={reload}>Повторить</button>
    </p>
  ) : null;
}

export function NoteIndicator({ label = "Есть заметка" }: { label?: string }) {
  return <span className="note-indicator" role="img" aria-label={label} title={label}><NotebookPen size={14} aria-hidden="true" /></span>;
}

export function NoteEditor({ kind, id }: { kind: NoteKind; id: string }) {
  const { notes, error, save } = useNotes();
  const saved = noteFor(notes, kind, id) ?? "";
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [status, setStatus] = useState("");
  const labelId = useId();

  async function saveNote(text: string) {
    setBusy(true);
    setSaveError("");
    setStatus("");
    try {
      await save(kind, id, text);
      setDraft(undefined);
      setStatus(text.trim() ? "Заметка сохранена" : "Заметка удалена");
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="note-editor">
      <summary>Заметка {saved && <NoteIndicator />}</summary>
      <NotesLoadError />
      {!notes ? (
        !error && <p className="small muted" role="status">Загружаем заметку…</p>
      ) : (
        <div className="note-fields">
          <label htmlFor={labelId}>Личный текст</label>
          <textarea
            id={labelId}
            rows={3}
            maxLength={4000}
            disabled={busy}
            value={draft ?? saved}
            onChange={(event) => {
              setDraft(event.target.value);
              setStatus("");
            }}
          />
          {saveError && <p className="notes-error" role="alert">{saveError}</p>}
          <div className="note-actions">
            <button
              className="button subtle compact"
              type="button"
              disabled={busy || draft === undefined || draft === saved}
              onClick={() => void saveNote(draft ?? "")}
            >
              Сохранить заметку
            </button>
            {saved && (
              <button className="text-button" type="button" disabled={busy} onClick={() => void saveNote("")}>
                Удалить заметку
              </button>
            )}
            <span className="small muted" role="status">{status}</span>
          </div>
        </div>
      )}
    </details>
  );
}
