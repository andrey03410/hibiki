import { useId, useRef } from "react";
import { AudioLines, Ellipsis, Mic2 } from "lucide-react";
import type { TagDto } from "@hibiki/contracts";
import {
  groupKeys,
  groupOf,
  groups,
  itemPerformance,
  TagCatalog,
  type Performance,
  type PerformanceFilter,
  type Voice,
} from "./taxonomy";

export function ItemTagList({
  tags,
  catalog,
  selected = [],
  performance,
  voices,
  onTag,
  onPerformance,
}: {
  tags: TagDto[];
  catalog: TagCatalog;
  selected?: string[];
  performance?: Performance;
  voices?: Voice[];
  onTag?: (id: string) => void;
  onPerformance?: (value: PerformanceFilter) => void;
}) {
  const popupId = useId();
  const popup = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const active = tags.filter((t) => !t.archived).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const visible = (["source", "genre", "mood"] as const).flatMap((group) => {
    const values = active.filter((t) => groupOf(t) === group);
    const match =
      values.find((t) => selected.includes(t.id)) ??
      values.find((t) => catalog.matchesAncestor(t, selected)) ??
      values[0];
    return match ? [match] : [];
  });
  const info = itemPerformance(performance, voices);
  function select(action: () => void) {
    popup.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
    action();
  }
  function tagButton(tag: TagDto, detail: boolean) {
    const path = catalog.paths(tag.id).join(" / ") || tag.name;
    const label = detail && groupOf(tag) === "source" ? path : tag.name;
    const css = "entry-tag group-" + groupOf(tag);
    return onTag ? (
      <button
        key={tag.id}
        type="button"
        className={css}
        title={path}
        onClick={() => (detail ? select(() => onTag(tag.id)) : onTag(tag.id))}
      >
        {label}
      </button>
    ) : (
      <span key={tag.id} className={css} title={path}>
        {label}
      </span>
    );
  }
  const VoiceIcon = performance === "vocal" ? Mic2 : AudioLines;
  return (
    <div className="entry-tags" aria-label="Разметка записи" role="group">
      {visible.map((t) => tagButton(t, false))}
      <button
        type="button"
        ref={trigger}
        className="entry-tags-more"
        popoverTarget={popupId}
        aria-label="Показать разметку"
        title="Показать разметку"
      >
        {[3, 2, 1].map((limit) => {
          const hidden =
            active.length -
            visible.filter(
              (t) => limit === 3 || (limit === 2 ? groupOf(t) !== "mood" : groupOf(t) === "source"),
            ).length;
          return (
            <span key={limit} className={"count-at-" + limit}>
              {hidden ? "+" + hidden : <Ellipsis size={12} />}
            </span>
          );
        })}
      </button>
      {performance && performance !== "unknown" && (
        <span className="entry-performance" role="img" aria-label={info.label} title={info.label}>
          <VoiceIcon size={13} />
        </span>
      )}
      <div
        popover="auto"
        id={popupId}
        ref={popup}
        className="entry-tags-popup"
        role="group"
        aria-label="Разметка композиции"
        onToggle={(event) => {
          if (event.oldState === "open" && event.newState === "closed")
            trigger.current?.focus({ preventScroll: true });
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            popup.current?.hidePopover();
            trigger.current?.focus();
          }
        }}
      >
        {groupKeys.map((key) => {
          const values = active.filter((t) => groupOf(t) === key);
          return (
            <div className="detail-tag-group" key={key}>
              <strong className={"group-" + key}>{groups[key]}</strong>
              {values.length ? values.map((t) => tagButton(t, true)) : <small>Не указано</small>}
            </div>
          );
        })}
        <div className="detail-tag-group">
          <strong>Исполнение</strong>
          {onPerformance && info.filter ? (
            <button
              className="entry-tag"
              type="button"
              onClick={() => select(() => onPerformance(info.filter))}
            >
              {info.label}
            </button>
          ) : (
            <span>{info.label}</span>
          )}
        </div>
      </div>
    </div>
  );
}
