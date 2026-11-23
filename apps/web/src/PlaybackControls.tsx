import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { ListMusic, Music2, Video, Volume2, VolumeX, X } from "lucide-react";
import type { ItemDto } from "@hibiki/contracts";
import { formatDuration, mediaWord } from "./api";
import { queueEntryUnavailableReason, type PlaybackSettings } from "./player-model";
import { animatePlayback } from "./playback-feedback";

const seekKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];

export type BufferedRanges = [number, number][];
function bufferedGradient(ranges: BufferedRanges, duration: number) {
  if (!(duration > 0 && Number.isFinite(duration)) || !ranges.length) return "none";
  const stops: string[] = [];
  let previous = 0;
  for (const [start, end] of ranges) {
    const from = Math.min(100, Math.max(previous, start / duration * 100));
    const to = Math.min(100, end / duration * 100);
    if (to <= from) continue;
    if (from > previous) stops.push(`transparent ${previous}% ${from}%`);
    stops.push(`var(--buffer-color) ${from}% ${to}%`);
    previous = to;
  }
  if (previous < 100) stops.push(`transparent ${previous}% 100%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

export function PlaybackSeekBar({
  position, duration, className, buffered = [], moving = false, clock, onSeek, onScrubStart, onScrubEnd,
}: {
  position: number;
  duration: number;
  className?: string;
  buffered?: BufferedRanges;
  moving?: boolean;
  clock?: { read: () => number; refresh: () => void };
  onSeek: (position: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const scrubbing = useRef(false);
  const canSeek = Number.isFinite(duration) && duration > 0;
  const value = canSeek ? Math.max(0, Math.min(position, duration)) : 0;
  const valueText = canSeek
    ? `${formatDuration(value)} из ${formatDuration(duration)}`
    : "Длительность неизвестна";

  function paint(seconds: number) {
    const element = input.current;
    if (!element || !Number.isFinite(seconds)) return;
    const value = canSeek ? Math.max(0, Math.min(seconds, duration)) : 0;
    element.value = String(value);
    element.style.setProperty("--progress", `${canSeek ? value / duration * 100 : 0}%`);
  }
  useLayoutEffect(() => {
    if (!scrubbing.current) paint(moving && clock ? clock.read() : value);
  }, [clock, moving, value, duration]);
  useLayoutEffect(() => {
    if (!clock || !moving || !canSeek) return;
    return animatePlayback(() => { if (!scrubbing.current) paint(clock.read()); }, clock.refresh);
  }, [clock, moving, canSeek, duration]);

  function start() {
    scrubbing.current = true;
    onScrubStart();
  }
  function end() {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    onScrubEnd();
  }
  return (
    <input
      ref={input}
      className={`playback-seek ${className ?? ""}`}
      type="range"
      aria-label="Позиция воспроизведения"
      aria-valuetext={valueText}
      min="0"
      max={canSeek ? duration : 1}
      step="0.001"
      defaultValue={value}
      disabled={!canSeek}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        start();
      }}
      onLostPointerCapture={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        if (!seekKeys.includes(event.key) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        start();
        if (event.key.startsWith("Arrow")) {
          event.preventDefault();
          const step = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -0.1 : 0.1;
          paint(event.currentTarget.valueAsNumber + step);
          onSeek(event.currentTarget.valueAsNumber);
        }
      }}
      onKeyUp={end}
      onBlur={end}
      onChange={(event) => {
        const next = event.currentTarget.valueAsNumber;
        paint(next);
        onSeek(next);
      }}
      style={{ "--progress": canSeek ? `${value / duration * 100}%` : "0%",
        "--buffered": bufferedGradient(buffered, duration) } as CSSProperties}
    />
  );
}

export function PlaybackVolume({volume, onVolume, onMute, compact = false}: {
  volume: number; onVolume: (level: number) => void; onMute: () => void; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const Icon = volume ? Volume2 : VolumeX;
  const percent = Math.round(volume * 100);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !group.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);
  const mute = volume ? "Выключить звук" : "Включить звук";
  const controls = <>
    <button type="button" className="icon-button" aria-label={mute} title={`${mute} (M)`} onClick={onMute}><Icon size={19} /></button>
    <input aria-label="Громкость" title="Громкость (↑/↓)" aria-valuetext={`${percent}%`} type="range"
      min="0" max="100" step="1" value={percent} onChange={event => onVolume(event.currentTarget.valueAsNumber / 100)}
      style={{ "--progress": `${percent}%` } as CSSProperties} />
  </>;
  if (!compact) return controls;
  return <div className="mini-volume" ref={group} onKeyDown={event => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  }}>
    <button ref={trigger} type="button" className="icon-button" aria-label={`Громкость, ${percent}%`}
      aria-expanded={open} aria-controls={id} title="Громкость" onClick={() => setOpen(value => !value)}>
      <Icon size={19} />
    </button>
    <div id={id} className="mini-volume-panel" role="group" aria-label="Настройки громкости" hidden={!open}>
      {controls}<output>{percent}%</output>
    </div>
  </div>;
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

export function CompactPlaybackQueue({ settings, itemsById, failedIds, onSelect, onOpenChange, deleted, incomplete = false }: {
  settings: Pick<PlaybackSettings, "queue" | "queueIndex" | "mode">;
  itemsById: ReadonlyMap<string, ItemDto>;
  failedIds: ReadonlySet<string>;
  onSelect: (index: number) => void;
  onOpenChange?: (open: boolean) => void;
  deleted?: (id: string) => boolean;
  incomplete?: boolean;
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
              <span>{incomplete && "Загружено: "}{queue.length} {mediaWord(queue.length)}</span>
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
                : !incomplete && <p>Дальше записей нет.</p>}
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
