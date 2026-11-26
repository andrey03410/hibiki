import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties, type Ref } from "react";
import { ListMusic, Music2, Video, Volume2, VolumeX, X } from "lucide-react";
import type { ItemDto } from "@hibiki/contracts";
import { formatDuration, mediaWord } from "./api";
import { queueEntryUnavailableReason, type PlaybackSettings } from "./player-model";
import { animatePlayback } from "./playback-feedback";

import type { AudioCoverage } from "./audio-delivery";

const seekKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];

export type BufferedRanges = [number, number][];
export function playbackBuffer(native: BufferedRanges, coverage: AudioCoverage | undefined, duration: number): BufferedRanges {
  if (!coverage || duration <= 0) return native;
  if (coverage.complete) return [[0, duration]];
  const {audioStart, size} = coverage;
  if (audioStart >= size) return native;
  const time = (byte: number) => Math.max(0, byte - audioStart) / (size - audioStart) * duration;
  const ranges: BufferedRanges = [...native];
  for (const [start, end] of coverage.ranges)
    if (end > audioStart) ranges.push([time(start), time(end)]);
  ranges.sort(([a], [b]) => a - b);
  const merged: BufferedRanges = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
    else merged.push([start, end]);
  }
  return merged;
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
  const activeRange = canSeek ? buffered.find(([start, end]) => start <= value && value < end) : undefined;
  const bufferEnd = activeRange ? Math.min(100, activeRange[1] / duration * 100) : 0;
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
        "--buffer-end": `${bufferEnd}%` } as CSSProperties}
    />
  );
}

export function PlaybackVolume({volume, onVolume, onMute, compact = false}: {
  volume: number; onVolume: (level: number) => void; onMute: () => void; compact?: boolean;
}) {
  const Icon = volume ? Volume2 : VolumeX;
  const percent = Math.round(volume * 100);
  const mute = volume ? "Выключить звук" : "Включить звук";
  const controls = <>
    <button type="button" className="icon-button" aria-label={mute} title={`${mute} (M)`} onClick={onMute}><Icon size={19} /></button>
    <input aria-label="Громкость" title="Громкость (↑/↓)" aria-valuetext={`${percent}%`} type="range"
      min="0" max="100" step="1" value={percent} onChange={event => onVolume(event.currentTarget.valueAsNumber / 100)}
      style={{ "--progress": `${percent}%` } as CSSProperties} />
  </>;
  return compact ? <div className="mini-volume" role="group" aria-label="Громкость">{controls}</div> : controls;
}

// Sections share their surrounding scroller so headings, the current row and
// the expandable previous entries keep their usual keyboard and scroll order.
export const QueueRows = memo(function QueueRows({queue, start, end, row, compact = false, onVisible}: {
  queue: string[]; start: number; end: number; row: (id: string, index: number) => ReactNode;
  compact?: boolean; onVisible?: (ids: string[]) => void;
}) {
  const host = useRef<HTMLElement | null>(null);
  const [visibleRows, setVisibleRows] = useState({first: 0, count: 20});
  const virtual = queue.length > 200;
  const height = compact ? 46 : 68;
  useLayoutEffect(() => {
    const list = host.current;
    const scroller = list?.closest<HTMLElement>(".mini-queue-scroll, .watch-queue-list");
    if (!virtual || !list || !scroller) return;
    const measure = () => {
      const top = scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
      const first = Math.max(0, Math.min(end - start, Math.floor(top / height) - 5));
      const count = list.getClientRects().length
        ? Math.max(0, Math.ceil((top + scroller.clientHeight) / height) + 5 - first) : 0;
      setVisibleRows(old => old.first === first && old.count === count ? old : {first, count});
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(scroller);
    scroller.addEventListener("scroll", measure, {passive:true});
    scroller.addEventListener("toggle", measure, true);
    return () => {
      resize.disconnect();
      scroller.removeEventListener("scroll", measure);
      scroller.removeEventListener("toggle", measure, true);
    };
  }, [virtual, height, start, end]);
  const lower = virtual ? Math.min(end, start + visibleRows.first) : start;
  const upper = virtual ? Math.min(end, lower + visibleRows.count) : end;
  useEffect(() => {
    if (lower < upper) onVisible?.(queue.slice(lower, upper));
  }, [queue, lower, upper, onVisible]);
  const Tag = compact ? "ul" : "div";
  return <Tag ref={(element: HTMLElement | null) => {host.current = element;}} style={virtual ? {
    display: "grid", gridAutoRows: height, paddingTop: (lower - start) * height, paddingBottom: (end - upper) * height,
  } : undefined}>{queue.slice(lower, upper).map((id, i) => row(id, lower + i))}</Tag>;
});

export function CompactPlaybackQueueRow({ title, kind, duration, current, unavailableReason, canRecheck, failed, buttonRef, onSelect }: {
  title: string;
  kind?: ItemDto["kind"];
  duration?: ItemDto["duration"];
  current: boolean;
  unavailableReason?: string;
  canRecheck?: boolean;
  failed?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onSelect: () => void;
}) {
  const reasonId = useId();
  const reason = unavailableReason ?? (failed ? "Источник недоступен" : undefined);
  const disabled = !!unavailableReason && !canRecheck;
  const Icon = kind === "video" ? Video : Music2;
  return (
    <li>
      <button
        ref={buttonRef}
        className="mini-queue-row"
        type="button"
        aria-label={title}
        aria-current={current ? "true" : undefined}
        aria-disabled={disabled || undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => { if (!disabled) onSelect(); }}
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

export const CompactPlaybackQueue = memo(function CompactPlaybackQueue({ settings, onVisible, itemsById, failedIds, onSelect, onOpenChange, deleted, canRecheck, incomplete = false }: {
  settings: Pick<PlaybackSettings, "queue" | "queueIndex" | "mode">;
  onVisible?: (ids: string[]) => void;
  version?: number;
  itemsById: ReadonlyMap<string, ItemDto>;
  failedIds: ReadonlySet<string>;
  onSelect: (index: number) => void;
  onOpenChange?: (open: boolean) => void;
  deleted?: (id: string) => boolean;
  canRecheck?: (id: string) => boolean;
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
        canRecheck={canRecheck?.(id)}
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
                ? <QueueRows compact queue={queue} start={queueIndex + 1} end={queue.length} row={row} onVisible={onVisible} />
                : !incomplete && <p>Дальше записей нет.</p>}
              {queueIndex > 0 && (
                <details className="mini-queue-past">
                  <summary>Предыдущие <span>{queueIndex}</span></summary>
                  <QueueRows compact queue={queue} start={0} end={queueIndex} row={row} onVisible={onVisible} />
                </details>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
});
