import { useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import type { TagDto } from "@hibiki/contracts";
import { api } from "./api";
import { GroupSelect, TagPicker } from "./ClassificationEditor";
import { NoteEditor, useNotes } from "./NoteEditor";
import { Button, ErrorMessage, Modal, useData } from "./WorkspaceUi";
import { groupOf, type TagCatalog, type TagGroup } from "./taxonomy";

const colors = ["#b6a0ed", "#92b8a5", "#ddb18a", "#8faed3", "#d494a8", "#c4bd80", "#7cbcb8", "#b5b5bc"];

export function TagEditor({ tag, section, catalog, close }: {
  tag?: TagDto;
  section: TagGroup;
  catalog: TagCatalog;
  close: (savedId?: string) => void;
}) {
  const { refresh, notify } = useData();
  const { save: saveNote } = useNotes();
  const [name, setName] = useState(tag?.name ?? "");
  const [group, setGroup] = useState(tag ? groupOf(tag) : section);
  const [parents, setParents] = useState(tag?.parentIds ?? []);
  const [aliases, setAliases] = useState((tag?.aliases ?? []).join("\n"));
  const [color, setColor] = useState(tag?.color ?? colors[0]!);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useRef(tag?.id);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = await api<TagDto>(id.current ? "/tags/" + id.current : "/tags", id.current ? "PATCH" : "POST", {
        name, color, group, aliases: aliases.split(/\r?\n/).map(a => a.trim()).filter(Boolean),
        parentIds: group === "source" ? parents : [],
      });
      id.current = saved.id;
      await refresh();
      if (!tag && note.trim()) await saveNote("tag", saved.id, note);
      notify(tag ? "Тег обновлён" : "Тег создан");
      close(saved.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <Modal title={tag ? "Изменить тег" : "Новый тег"} close={() => { if (!busy) close(); }}>
    <form onSubmit={submit}>
      <label>Название<input value={name} maxLength={200} onChange={e => setName(e.target.value)}
        placeholder="Например, Для работы" required autoFocus /></label>
      <GroupSelect value={group} onChange={value => { if (value !== "performance") setGroup(value); }} />
      <label>Псевдонимы (по одному на строку)<textarea rows={3} value={aliases} onChange={e => setAliases(e.target.value)} /></label>
      {group === "source" && <details className="edit-group">
        <summary>Родители в дереве <span>{parents.length}</span></summary>
        <TagPicker catalog={catalog} ids={parents} group="source" excludeId={id.current} onChange={setParents} />
      </details>}
      <label>Цвет</label>
      <div className="color-picker" role="group" aria-label="Цвет тега">
        {colors.map(value => <button type="button" key={value} aria-label={"Цвет " + value} aria-pressed={color === value}
          style={{ background: value }} onClick={() => setColor(value)}>{color === value && <Check size={17} />}</button>)}
        <input type="color" aria-label="Другой цвет тега" value={/^#[a-f\d]{6}$/i.test(color) ? color : colors[0]} onChange={e => setColor(e.target.value)} />
      </div>
      {!tag && <details className="note-editor"><summary>Заметка</summary><label>Личный текст
        <textarea rows={3} maxLength={4000} value={note} onChange={e => setNote(e.target.value)} /></label></details>}
      <ErrorMessage error={error} />
      <div className="modal-actions">
        <Button type="button" className="subtle" disabled={busy} onClick={() => close()}>Отмена</Button>
        <Button type="submit" className="primary" busy={busy}>Сохранить</Button>
      </div>
    </form>
    {tag && <NoteEditor kind="tag" id={tag.id} />}
  </Modal>;
}

export function DeleteTag({ tag, close }: { tag: TagDto; close: (deleted: boolean) => void }) {
  const { refresh, notify } = useData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const deleted = useRef(false);
  async function remove() {
    setBusy(true);
    setError("");
    try {
      if (!deleted.current) await api("/tags/" + tag.id, "DELETE");
      deleted.current = true;
      await refresh();
      notify("Тег удалён");
      close(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return <Modal title="Удалить тег?" subtitle={`Тег «${tag.name}» исчезнет у записей. Зависимые плейлисты нужно сначала изменить.`}
    close={() => { if (!busy) close(deleted.current); }}>
    <ErrorMessage error={error} />
    <div className="modal-actions">
      <Button className="subtle" disabled={busy} onClick={() => close(deleted.current)}>Отмена</Button>
      <Button className="danger" busy={busy} onClick={remove}>Удалить</Button>
    </div>
  </Modal>;
}
