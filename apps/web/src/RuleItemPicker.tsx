import { useMemo, useState } from "react";
import { Music2, Search, Video } from "lucide-react";
import type { ItemDto } from "@hibiki/contracts";
import { formatDuration } from "./api";

const PAGE_SIZE = 100;

export function RuleItemPicker({ items, ids, onChange }: {
  items: Pick<ItemDto, "id" | "title" | "kind" | "duration">[];
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const selected = useMemo(() => new Set(ids), [ids]);
  const matches = useMemo(() => {
    const query = search.toLowerCase();
    return query ? items.filter(item => item.title.toLowerCase().includes(query)) : items;
  }, [items, search]);

  return <>
    <label className="search-input rule-search">
      <Search size={14} />
      <input aria-label="Найти запись для правила" placeholder="Найти запись…" value={search}
        onChange={event => { setSearch(event.target.value); setVisible(PAGE_SIZE); }} />
    </label>
    <div className="rule-items">
      {matches.slice(0, visible).map(item => (
        <label className="check-row" key={item.id}>
          <input type="checkbox" checked={selected.has(item.id)}
            onChange={event => onChange(event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} />
          {item.kind === "audio" ? <Music2 size={14} /> : <Video size={14} />}
          <span className="truncate">{item.title}</span>
          <span className="muted small">{formatDuration(item.duration)}</span>
        </label>
      ))}
      {visible < matches.length && <button type="button" className="button subtle compact"
        onClick={() => setVisible(count => count + PAGE_SIZE)}>Показать ещё</button>}
      {!matches.length && <p className="muted small">
        {items.length ? "Записи не найдены." : "Сначала добавьте записи в медиатеку."}
      </p>}
    </div>
    <span className="small muted">Выбрано: {ids.length}. Порядок выбора сохраняется.</span>
  </>;
}
