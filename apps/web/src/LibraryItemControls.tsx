import { useId, useRef } from "react";
import { TagChip } from "./design/primitives";
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
  // The row already shows the source path and artists: chips show the mood
  // and genre (selected filters first), the popup shows everything.
  const candidates = active.filter((t) => groupOf(t) !== "source" && groupOf(t) !== "artist");
  const rank = (t: TagDto) => (selected.includes(t.id) ? 0 : 1) * 10 + ["mood", "genre", "extra"].indexOf(groupOf(t));
  const visible = [...candidates].sort((a, b) => rank(a) - rank(b)).slice(0, 2);
  // Source and artist are already visible in the row, so only hidden descriptive tags count.
  const hidden = candidates.length - visible.length;
  const info = itemPerformance(performance, voices);
  function select(action: () => void) {
    popup.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
    action();
  }
  function chip(tag: TagDto, detail: boolean) {
    const path = catalog.paths(tag.id).join(" / ") || tag.name;
    const shown = detail && groupOf(tag) === "source" ? { ...tag, name: path } : tag;
    const on = selected.includes(tag.id);
    return <TagChip key={tag.id} tag={shown} title={path} state={on ? "on" : "plain"}
      onClick={onTag ? () => (detail ? select(() => onTag(tag.id)) : onTag(tag.id)) : undefined} />;
  }
  const VoiceIcon = performance === "vocal" ? Mic2 : AudioLines;
  return (
    <div className="entry-tags" aria-label="Разметка записи" role="group">
      {visible.map((t) => chip(t, false))}
      {!active.length && <span className="entry-tags-empty">Без тегов</span>}
      <button
        type="button"
        ref={trigger}
        className="entry-tags-more"
        popoverTarget={popupId}
        aria-label="Показать разметку"
        title="Показать разметку"
      >
        {hidden > 0 ? "+" + hidden : <Ellipsis size={12} />}
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
        className="entry-tags-popup ds-pop"
        role="group"
        aria-label="Разметка композиции"
        onToggle={(event) => {
          if (event.newState === "open") {
            const box = trigger.current?.getBoundingClientRect();
            const element = event.currentTarget;
            if (box) {
              const width = element.offsetWidth, height = element.offsetHeight;
              element.style.left = Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12)) + "px";
              element.style.top = (box.bottom + height + 12 > window.innerHeight ? Math.max(12, box.top - height - 6) : box.bottom + 6) + "px";
            }
          }
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
              <strong>{groups[key]}</strong>
              <div className="detail-tag-values">{values.length ? values.map((t) => chip(t, true)) : <small>Не указано</small>}</div>
            </div>
          );
        })}
        <div className="detail-tag-group">
          <strong>Исполнение</strong>
          <div className="detail-tag-values">
            {onPerformance && info.filter ? (
              <TagChip tag={{ name: info.label, color: "" }} color="var(--g-performance)"
                onClick={() => select(() => onPerformance(info.filter))} />
            ) : (
              <small>{info.label}</small>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
