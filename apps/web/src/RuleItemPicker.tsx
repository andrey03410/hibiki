import { useMemo } from "react";
import { Music2, Search, Video } from "lucide-react";
import { formatDuration } from "./api";
import { useItemSearch, PickerFooter } from "./ItemPicker";

export function RuleItemPicker({ ids, onChange, revision }: {
  revision?: string;
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const result = useItemSearch(revision);
  const selected = useMemo(() => new Set(ids), [ids]);
  const matches = result.page?.items ?? [];

  return <>
    <label className="search-input rule-search">
      <Search size={14} />
      <input aria-label="Найти запись для правила" placeholder="Найти запись…" value={result.query}
        onChange={event => result.setQuery(event.target.value)} />
    </label>
    <div className="rule-items">
      {matches.map(item => (
        <label className="check-row" key={item.id}>
          <input type="checkbox" checked={selected.has(item.id)}
            onChange={event => onChange(event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} />
          {item.kind === "audio" ? <Music2 size={14} /> : <Video size={14} />}
          <span className="truncate">{item.title}</span>
          <span className="muted small">{formatDuration(item.duration)}</span>
        </label>
      ))}
      <PickerFooter result={result} />
      {!matches.length && result.page && !result.busy && !result.error && <p className="muted small">
        {result.query ? "Записи не найдены." : "Сначала добавьте записи в медиатеку."}
      </p>}
    </div>
    <span className="small muted">Выбрано: {ids.length}. Порядок выбора сохраняется.</span>
  </>;
}
