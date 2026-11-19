import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Headphones, ListMusic, Music2, Play, Video, X } from "lucide-react";
import type { ItemDto } from "@hibiki/contracts";
import { formatDuration, mediaWord } from "./api";
import { playbackSources, soundUnavailableReason, type PlaybackSettings } from "./player-model";

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

export function CompactPlaybackQueue({ settings, itemsById, failedIds }: {
  settings: Pick<PlaybackSettings, "queue" | "queueIndex" | "mode">;
  itemsById: ReadonlyMap<string, ItemDto>;
  failedIds: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const region = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const { queue, queueIndex, mode } = settings;

  function closeAndFocus() {
    setOpen(false);
    trigger.current?.focus();
  }

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

  function row(id: string) {
    const item = itemsById.get(id);
    const title = item?.title ?? "Запись удалена";
    const current = id === queue[queueIndex];
    const available = item && !failedIds.has(id) && playbackSources(item, mode).length > 0;
    const state = !item ? "Нет в медиатеке" : available ? undefined
      : (mode === "audio" && soundUnavailableReason(item)) || "Источник недоступен";
    const Icon = item?.kind === "video" ? Video : Music2;
    return (
      <li key={id} className="mini-queue-row" aria-current={current ? "true" : undefined}>
        <Icon size={15} aria-hidden="true" />
        <span className="mini-queue-name">
          <span title={title}>{title}</span>
          {state && <small>{state}</small>}
        </span>
        <span className="mini-queue-duration">{formatDuration(item?.duration)}</span>
      </li>
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
              <ul>{queue.slice(queueIndex, queueIndex + 1).map(row)}</ul>
              <h3>Далее</h3>
              {queueIndex + 1 < queue.length
                ? <ul>{queue.slice(queueIndex + 1).map(row)}</ul>
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

const libraryActions = {
  play: { label: "Воспроизвести", Icon: Play },
  watch: { label: "Смотреть", Icon: Video },
  listen: { label: "Слушать", Icon: Headphones },
};

export function LibraryPlaybackButton({ action, itemTitle, unavailableReason, onActivate }: {
  action: keyof typeof libraryActions;
  itemTitle: string;
  unavailableReason?: string;
  onActivate: () => void;
}) {
  const tooltipId = useId();
  const { label, Icon } = libraryActions[action];
  return (
    <span className="library-playback-action">
      <button
        className="library-item-play library-item-play-icon"
        type="button"
        aria-label={`${label} ${itemTitle}`}
        aria-disabled={unavailableReason ? true : undefined}
        aria-describedby={unavailableReason ? tooltipId : undefined}
        onClick={() => { if (!unavailableReason) onActivate(); }}
      >
        <Icon size={16} fill={action === "play" ? "currentColor" : "none"} aria-hidden="true" />
      </button>
      <span className="library-playback-tooltip" id={tooltipId} role="tooltip">
        {label}
        {unavailableReason && <><br />{unavailableReason}</>}
      </span>
    </span>
  );
}
