import { useMemo } from "react";
import { Minus, Plus, X } from "lucide-react";
import type { LibraryDto, Rule } from "@hibiki/contracts";
import { RuleItemPicker } from "./RuleItemPicker";
import { HISTORY_CONDITIONS, type HistoryRule } from "./playlist-rules";
import { TagCatalog } from "./taxonomy";

function historyRule(condition: HistoryRule["condition"]): HistoryRule {
  if (condition === "skipped-at-least") return { type: "history", condition, count: 2 };
  if (condition === "last-started-before") return { type: "history", condition, days: 30 };
  return { type: "history", condition };
}

function newRule(
  type: Rule["type"],
  library: LibraryDto,
  playlistId?: string,
): Rule {
  switch (type) {
    case "items":
      return { type, ids: [] };
    case "playlist":
      return {
        type,
        id: library.playlists.find((p) => p.id !== playlistId)?.id ?? "",
      };
    case "tag":
      return { type, id: library.tags[0]?.id ?? "" };
    case "filter":
    case "favorite":
      return { type };
    case "history":
      return historyRule("never-started");
    case "union":
    case "intersection":
      return { type, rules: [{ type: "items", ids: [] }] };
    case "difference":
      return {
        type,
        include: { type: "items", ids: [] },
        exclude: { type: "items", ids: [] },
      };
  }
}
export default function RuleEditor({
  library,
  rule,
  onChange,
  playlistId,
  depth = 0,
}: {
  library: LibraryDto;
  rule: Rule;
  onChange: (rule: Rule) => void;
  playlistId?: string;
  depth?: number;
}) {
  const catalog = useMemo(() => new TagCatalog(library.tags),[library.tags]);
  return (
    <div className={`rule-editor depth-${depth % 2}`}>
      <div className="rule-type-row">
        <select
          aria-label={`Тип правила ${depth + 1}`}
          value={rule.type}
          onChange={(e) =>
            onChange(
              newRule(e.target.value as Rule["type"], library, playlistId),
            )
          }
        >
          <option value="items">Выбранные записи</option>
          <option value="tag">Записи с тегом</option>
          <option value="playlist">Другой плейлист</option>
          <option value="filter">Фильтр медиатеки</option>
          <option value="favorite">Избранные записи</option>
          <option value="history">История прослушивания</option>
          <option value="union">Объединить — любое правило</option>
          <option value="intersection">Пересечь — все правила</option>
          <option value="difference">Добавить с исключениями</option>
        </select>
        <span className="rule-depth">
          {depth === 0 ? "СОСТАВ" : `ПРАВИЛО ${depth + 1}`}
        </span>
      </div>
      {rule.type === "history" && (
        <div className="filter-fields">
          <label>
            Условие
            <select value={rule.condition} onChange={(event) => onChange(historyRule(event.target.value as HistoryRule["condition"]))}>
              {Object.entries(HISTORY_CONDITIONS).map(([condition, label]) => <option value={condition} key={condition}>{label}</option>)}
            </select>
          </label>
          {rule.condition === "skipped-at-least" && (
            <label>
              Минимум быстрых пропусков
              <input type="number" required min={1} max={1_000_000} step={1} value={rule.count ?? ""}
                onChange={(event) => onChange({ ...rule, count: event.target.value === "" ? undefined : event.target.valueAsNumber })} />
            </label>
          )}
          {rule.condition === "last-started-before" && (
            <label>
              Дней с последнего запуска, больше
              <input type="number" required min={1} max={36_500} step={1} value={rule.days ?? ""}
                onChange={(event) => onChange({ ...rule, days: event.target.value === "" ? undefined : event.target.valueAsNumber })} />
            </label>
          )}
        </div>
      )}
      {rule.type === "items" && <RuleItemPicker items={library.items} ids={rule.ids}
        onChange={ids => onChange({ type: "items", ids })} />}
      {rule.type === "tag" && <>
        <label>Тег<select value={rule.id} onChange={e => onChange({type:"tag",id:e.target.value})}>
          <option value="" disabled>Выберите тег</option>
          {rule.id && !catalog.byId.has(rule.id) && <option value={rule.id}>Прежнее точное назначение</option>}
          {catalog.active.map(t => <option value={t.id} key={t.id}>{catalog.paths(t.id).join(" / ")}</option>)}
        </select></label>
        {catalog.byId.get(rule.id)?.group === "source" && <label className="check-row"><input type="checkbox" checked={!!rule.descendants}
          onChange={e => onChange({...rule,descendants:e.target.checked})}/>Включая дочерние теги</label>}
      </>}
      {rule.type === "playlist" && (
        <label>
          Плейлист
          <select
            value={rule.id}
            onChange={(e) => onChange({ ...rule, id: e.target.value })}
          >
            <option value="" disabled>
              Выберите плейлист
            </option>
            {library.playlists
              .filter((p) => p.id !== playlistId)
              .map((p) => (
                <option value={p.id} key={p.id}>
                  {p.title}
                </option>
              ))}
          </select>
          <span className="small muted">
            Изменения вложенного плейлиста обновят эту подборку. Циклы
            запрещены.
          </span>
        </label>
      )}
      {rule.type === "filter" && (
        <div className="filter-fields">
          <label>
            Тип записи
            <select
              value={rule.kind ?? ""}
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value)
                  next.kind = e.target.value as "audio" | "video";
                else delete next.kind;
                onChange(next);
              }}
            >
              <option value="">Аудио и видео</option>
              <option value="audio">Только аудио</option>
              <option value="video">Только видео</option>
            </select>
          </label>
          <label>
            Локальный файл
            <select
              value={rule.local === undefined ? "" : String(rule.local)}
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value === "") delete next.local;
                else next.local = e.target.value === "true";
                onChange(next);
              }}
            >
              <option value="">Любой источник</option>
              <option value="true">Есть на устройстве</option>
              <option value="false">Нет локального файла</option>
            </select>
          </label>
          <label>
            Длительность от, сек.
            <input
              type="number"
              min="0"
              placeholder="Без минимума"
              value={rule.minDuration ?? ""}
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value === "") delete next.minDuration;
                else next.minDuration = Number(e.target.value);
                onChange(next);
              }}
            />
          </label>
          <label>
            Длительность до, сек.
            <input
              type="number"
              min="0"
              placeholder="Без максимума"
              value={rule.maxDuration ?? ""}
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value === "") delete next.maxDuration;
                else next.maxDuration = Number(e.target.value);
                onChange(next);
              }}
            />
          </label>
        </div>
      )}
      {(rule.type === "union" || rule.type === "intersection") && (
        <>
          <p className="small muted">
            {rule.type === "union"
              ? "Запись попадёт в подборку, если подходит хотя бы под одно правило. Повторы убираются."
              : "Запись должна подходить под каждое из правил ниже."}
          </p>
          {rule.rules.map((child, index) => (
            <div className="child-rule" key={index}>
              <div className="child-rule-heading">
                <span>
                  {index ? (rule.type === "union" ? "ИЛИ" : "И") : "ПРАВИЛО"}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Удалить правило ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...rule,
                      rules: rule.rules.filter((_, i) => i !== index),
                    })
                  }
                >
                  <X size={14} />
                </button>
              </div>
              <RuleEditor
                library={library}
                rule={child}
                playlistId={playlistId}
                depth={depth + 1}
                onChange={(next) =>
                  onChange({
                    ...rule,
                    rules: rule.rules.map((r, i) => (i === index ? next : r)),
                  })
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="button subtle compact"
            disabled={depth >= 10}
            onClick={() =>
              onChange({
                ...rule,
                rules: [
                  ...rule.rules,
                  { type: "tag", id: library.tags[0]?.id ?? "" },
                ],
              })
            }
          >
            <Plus size={14} />
            Добавить правило
          </button>
        </>
      )}
      {rule.type === "difference" && (
        <>
          <span className="rule-group-label">ДОБАВИТЬ</span>
          <RuleEditor
            library={library}
            rule={rule.include}
            playlistId={playlistId}
            depth={depth + 1}
            onChange={(include) => onChange({ ...rule, include })}
          />
          <span className="rule-group-label exclude">
            <Minus size={13} /> ИСКЛЮЧИТЬ
          </span>
          <RuleEditor
            library={library}
            rule={rule.exclude}
            playlistId={playlistId}
            depth={depth + 1}
            onChange={(exclude) => onChange({ ...rule, exclude })}
          />
          <p className="small muted">
            Исключение имеет приоритет, даже если запись подходит под
            добавление.
          </p>
        </>
      )}
    </div>
  );
}
