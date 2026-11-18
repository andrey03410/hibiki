export type NoteKind = "item" | "source" | "playlist" | "tag";
export type NotesIndex = Record<NoteKind, Record<string, string>>;

export function noteFor(notes: NotesIndex | undefined, kind: NoteKind, id: string) {
  const entries = notes?.[kind];
  return entries && Object.hasOwn(entries, id) ? entries[id] : undefined;
}
