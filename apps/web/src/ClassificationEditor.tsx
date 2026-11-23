import { useState } from "react";
import { Search } from "lucide-react";
import { groupKeys, groups, TagCatalog, type TagGroup, type Performance, type Voice } from "./taxonomy";

export function GroupSelect({
  value,
  onChange,
  allowPerformance = false,
}: {
  value: TagGroup | "performance";
  onChange: (value: TagGroup | "performance") => void;
  allowPerformance?: boolean;
}) {
  return (
    <label>
      Раздел
      <select value={value} onChange={(e) => onChange(e.target.value as typeof value)}>
        {groupKeys.map((key) => (
          <option key={key} value={key}>
            {groups[key]}
          </option>
        ))}
        {allowPerformance && <option value="performance">Исполнение</option>}
      </select>
    </label>
  );
}

export function TagPicker({
  catalog,
  group,
  ids,
  onChange,
  excludeId,
}: {
  catalog: TagCatalog;
  group: TagGroup;
  ids: string[];
  onChange: (ids: string[]) => void;
  excludeId?: string;
}) {
  const [query, setQuery] = useState("");
  const choices = catalog.find(query, group).filter((t) => t.id !== excludeId);
  return (
    <div className="classification-picker">
      <label className="nav-query">
        <Search size={14} />
        <input
          type="search"
          aria-label={"Найти в разделе «" + groups[group] + "»"}
          placeholder="Название или псевдоним"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="classification-options">
        {choices.map((tag) => (
          <label className="check-row" key={tag.id}>
            <input
              type="checkbox"
              checked={ids.includes(tag.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...ids, tag.id] : ids.filter((id) => id !== tag.id))
              }
            />
            {group === "source" ? catalog.paths(tag.id).join(" / ") : tag.name}
          </label>
        ))}
        {!choices.length && <p className="nav-empty">{query ? "Совпадений нет" : "Пока нет значений"}</p>}
      </div>
    </div>
  );
}

export function PerformanceEditor({
  performance,
  voices,
  onChange,
}: {
  performance: Performance;
  voices: Voice[];
  onChange: (value: Performance, voices: Voice[]) => void;
}) {
  return (
    <fieldset className="performance-editor">
      <legend>Исполнение</legend>
      <select
        aria-label="Исполнение"
        value={performance}
        onChange={(e) => onChange(e.target.value as Performance, e.target.value === "vocal" ? voices : [])}
      >
        <option value="unknown">Не указано</option>
        <option value="ost">Без вокала (OST)</option>
        <option value="vocal">С вокалом</option>
      </select>
      {performance === "vocal" && (
        <div className="voice-checks">
          {(["male", "female"] as const).map((voice) => (
            <label className="check-row" key={voice}>
              <input
                type="checkbox"
                checked={voices.includes(voice)}
                onChange={(e) =>
                  onChange("vocal", e.target.checked ? [...voices, voice] : voices.filter((v) => v !== voice))
                }
              />
              {voice === "male" ? "Мужской голос" : "Женский голос"}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
