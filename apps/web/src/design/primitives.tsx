import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import type { TagDto } from "@hibiki/contracts";
import { generativeCover, tagColor, type ColorGroup } from "./tag-colors";

export type ChipState = "plain" | "off" | "on" | "part";

/** Tag chip: the only way tags are drawn. See .ai/design/README.md → «Чип». */
export function TagChip({ tag, state = "plain", count, onClick, onRemove, size, title, className = "", enter, color }: {
  tag: Pick<TagDto, "name" | "color" | "group">;
  state?: ChipState;
  count?: number;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onRemove?: () => void;
  size?: "lg";
  title?: string;
  className?: string;
  enter?: boolean;
  /** Overrides the tag colour, e.g. `var(--g-performance)`. */
  color?: string;
}) {
  const style = { "--c": color ?? tagColor(tag) } as CSSProperties;
  const classes = `ds-chip ${state === "plain" ? "" : state} ${size ?? ""} ${enter ? "enter" : ""} ${className}`;
  const body = <>
    <span className="label">{tag.name}</span>
    {count !== undefined && <span className="n">{count}</span>}
  </>;
  if (onRemove) return <span className={classes} style={style} title={title}>
    {body}
    <button type="button" className="x" aria-label={`Убрать «${tag.name}»`} onClick={onRemove}><X size={11} /></button>
  </span>;
  if (onClick) return <button type="button" className={classes} style={style} title={title} aria-pressed={state === "on" ? true : state === "part" ? "mixed" : state === "off" ? false : undefined} onClick={onClick}>{body}</button>;
  return <span className={classes} style={style} title={title}>{body}</span>;
}

/** Small coloured square with a group icon. */
export function GroupIcon({ group, children }: { group: ColorGroup; children: ReactNode }) {
  return <span className={`ds-gi g-${group}`}>{children}</span>;
}

/** Gradient cover with a monogram for sections and playlists without artwork. */
export function GenerativeCover({ seed, className = "", style }: { seed: string; className?: string; style?: CSSProperties }) {
  const cover = generativeCover(seed);
  return <div className={`ds-gencover ${className}`} style={{ background: cover.background, ...style }} aria-hidden><span>{cover.monogram}</span></div>;
}

/**
 * Anchored popover on top of the native Popover API: light dismiss, Esc and
 * top layer come from the browser; we only place it next to the anchor.
 */
export function usePopover(placement: "start" | "end" = "start") {
  const anchorRef = useRef<HTMLElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const closedAt = useRef(0);

  const place = useCallback(() => {
    const anchor = anchorRef.current, pop = popRef.current;
    if (!anchor || !pop) return;
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth, height = pop.offsetHeight;
    const margin = 12;
    let left = placement === "end" ? rect.right - width : rect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    let top = rect.bottom + 6;
    let origin = "top";
    if (top + height > window.innerHeight - margin && rect.top - height - 6 > margin) {
      top = rect.top - height - 6;
      origin = "bottom";
    }
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.setProperty("--origin", `${origin} ${placement === "end" ? "right" : "left"}`);
  }, [placement]);

  const show = useCallback(() => {
    const pop = popRef.current;
    if (!pop || pop.matches(":popover-open")) return;
    pop.showPopover();
    place();
  }, [place]);
  const hide = useCallback(() => {
    const pop = popRef.current;
    if (pop?.matches(":popover-open")) pop.hidePopover();
  }, []);
  const toggle = useCallback(() => {
    // A light-dismiss caused by the click on the anchor itself must not reopen it.
    if (performance.now() - closedAt.current < 250) return;
    if (popRef.current?.matches(":popover-open")) hide(); else show();
  }, [hide, show]);

  useEffect(() => {
    if (!open) return;
    const update = () => place();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (popRef.current) observer?.observe(popRef.current);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [open, place]);

  const popoverProps = {
    ref: popRef,
    popover: "auto" as const,
    onToggle: (event: React.ToggleEvent<HTMLDivElement>) => {
      const opened = event.newState === "open";
      if (!opened) closedAt.current = performance.now();
      setOpen(opened);
    },
  };
  return { anchorRef, popoverProps, open, show, hide, toggle, place };
}

export function Popover({ control, className = "", children, label }: {
  control: ReturnType<typeof usePopover>;
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  return <div {...control.popoverProps} className={`ds-pop ${className}`} role="dialog" aria-label={label}>
    {control.open ? children : null}
  </div>;
}

/** Side drawer on a modal <dialog>; mounts when `open` becomes true and animates both ways. */
export function Drawer({ open, onClose, children, label, className = "" }: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(open);
  useLayoutEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) {
      dialog.close();
      const timer = window.setTimeout(() => setMounted(false), 320);
      return () => window.clearTimeout(timer);
    }
  }, [open, mounted]);
  if (!mounted) return null;
  return <dialog ref={ref} className={`ds-drawer ${className}`} aria-label={label}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {children}
  </dialog>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return <div className="ds-seg" role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" title={option.title} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

/** Progress ring for classification completeness, e.g. 5/6. */
export function ProgressRing({ done, total, size = 34 }: { done: number; total: number; size?: number }) {
  const r = size / 2 - 3, length = 2 * Math.PI * r, part = total ? done / total : 0;
  const complete = done >= total;
  return <span className="ds-ring" style={{ width: size, height: size }} title={`Разметка: ${done} из ${total}`}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="3" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={complete ? "var(--ok)" : "var(--accent)"} strokeWidth="3" strokeLinecap="round"
        strokeDasharray={length} strokeDashoffset={length * (1 - part)} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: "stroke-dashoffset var(--t-slow) var(--ease-out), stroke var(--t)" }} />
    </svg>
    <span className="num">{done}/{total}</span>
  </span>;
}
