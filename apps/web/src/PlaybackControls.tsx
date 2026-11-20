import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { ListMusic, Music2, Video, X } from "lucide-react";
import type { ItemDto } from "@hibiki/contracts";
import { formatDuration, mediaWord } from "./api";
import { queueEntryUnavailableReason, type PlaybackSettings } from "./player-model";

const seekKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];

export function PlaybackSeekBar({
  position, duration, className, onSeek, onScrubStart, onScrubEnd,
}: {
  position: number;
  duration: number;
  className?: string;
  onSeek: (position: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
}) {
  const canSeek = Number.isFinite(duration) && duration > 0;
  const value = canSeek ? Math.min(position, duration) : 0;
  const valueText = canSeek
    ? `${formatDuration(value)} из ${formatDuration(duration)}`
    : "Длительность неизвестна";
  return (
    <input
      className={className}
      type="range"
      aria-label="Позиция воспроизведения"
      aria-valuetext={valueText}
      min="0"
      max={canSeek ? duration : 1}
      step="0.1"
      value={value}
      disabled={!canSeek}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onScrubStart();
      }}
      onLostPointerCapture={onScrubEnd}
      onPointerCancel={onScrubEnd}
      onKeyDown={(event) => {
        if (seekKeys.includes(event.key)) onScrubStart();
      }}
      onKeyUp={onScrubEnd}
      onBlur={onScrubEnd}
      onChange={(event) => onSeek(Number(event.target.value))}
      style={{ "--progress": canSeek ? `${value / duration * 100}%` : "0%" } as CSSProperties}
    />
  );
}

export function CompactPlaybackQueueRow({ title, kind, duration, current, unavailableReason, failed, buttonRef, onSelect }: {
  title: string;
  kind?: ItemDto["kind"];
  duration?: ItemDto["duration"];
  current: boolean;
  unavailableReason?: string;
  failed?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onSelect: () => void;
}) {
  const reasonId = useId();
  const reason = unavailableReason ?? (failed ? "Источник недоступен" : undefined);
  const Icon = kind === "video" ? Video : Music2;
  return (
    <li>
      <button
        ref={buttonRef}
        className="mini-queue-row"
        type="button"
        aria-label={title}
        aria-current={current ? "true" : undefined}
        aria-disabled={unavailableReason ? true : undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => { if (!unavailableReason) onSelect(); }}
      >
        <Icon size={15} aria-hidden="true" />
        <span className="mini-queue-name">
          <span title={title}>{title}</span>
          {reason && <small id={reasonId}>{reason}</small>}
        </span>
        <span className="mini-queue-duration">{formatDuration(duration)}</span>
      </button>
    </li>
  );
}

export function CompactPlaybackQueue({ settings, itemsById, failedIds, onSelect, onOpenChange, deleted }: {
  settings: Pick<PlaybackSettings, "queue" | "queueIndex" | "mode">;
  itemsById: ReadonlyMap<string, ItemDto>;
  failedIds: ReadonlySet<string>;
  onSelect: (index: number) => void;
  onOpenChange?: (open: boolean) => void;
  deleted?: (id: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);
  const region = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const focusSelected = useRef<string | undefined>(undefined);
  const panelId = useId();
  const { queue, queueIndex, mode } = settings;

  function closeAndFocus() {
    setOpen(false);
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (focusSelected.current === undefined) return;
    if (focusSelected.current === queue[queueIndex]) activeRow.current?.focus();
    focusSelected.current = undefined;
  }, [queue, queueIndex]);

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !region.current?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (region.current?.contains(document.activeElement)) closeAndFocus();
      else setOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function row(id: string, index: number) {
    const item = itemsById.get(id);
    const current = index === queueIndex;
    return (
      <CompactPlaybackQueueRow
        key={id}
        title={item?.title ?? (deleted && !deleted(id) ? "Загружаем запись…" : "Запись удалена")}
        kind={item?.kind}
        duration={item?.duration}
        current={current}
        unavailableReason={queueEntryUnavailableReason(item, mode)}
        failed={failedIds.has(id)}
        buttonRef={current ? activeRow : undefined}
        onSelect={() => {
          if (!current) focusSelected.current = id;
          onSelect(index);
        }}
      />
    );
  }

  return (
    <div className="mini-queue" ref={region}>
      <button
        ref={trigger}
        className="icon-button mini-queue-toggle"
        type="button"
        aria-label="Очередь воспроизведения"
        aria-expanded={open}
        aria-controls={panelId}
        title="Очередь"
        onClick={() => setOpen((value) => !value)}
      >
        <ListMusic size={20} aria-hidden="true" />
      </button>
      <section
        className="mini-queue-panel"
        id={panelId}
        aria-labelledby={`${panelId}-title`}
        hidden={!open}
        onKeyDown={(event) => {
          if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        {open && (
          <>
            <header className="mini-queue-heading">
              <h2 id={`${panelId}-title`}>Очередь</h2>
              <span>{queue.length} {mediaWord(queue.length)}</span>
              <button className="icon-button" type="button" aria-label="Закрыть очередь" onClick={closeAndFocus}>
                <X size={17} aria-hidden="true" />
              </button>
            </header>
            <div className="mini-queue-scroll" tabIndex={0} role="region" aria-label="Записи очереди">
              <h3>Сейчас</h3>
              <ul>{queue.slice(queueIndex, queueIndex + 1).map((id) => row(id, queueIndex))}</ul>
              <h3>Далее</h3>
              {queueIndex + 1 < queue.length
                ? <ul>{queue.slice(queueIndex + 1).map((id, index) => row(id, queueIndex + index + 1))}</ul>
                : <p>Дальше записей нет.</p>}
              {queueIndex > 0 && (
                <details className="mini-queue-past">
                  <summary>Предыдущие <span>{queueIndex}</span></summary>
                  <ul>{queue.slice(0, queueIndex).map(row)}</ul>
                </details>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
