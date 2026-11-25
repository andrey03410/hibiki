import React, {createContext, useContext, useEffect, useRef, type ReactNode} from "react";
import {ChevronRight, CircleAlert, LoaderCircle, Music2, X} from "lucide-react";
import type {LibraryCardOverviewDto, LibraryDto} from "@hibiki/contracts";

export const EMPTY: LibraryDto = { items: [], tags: [], playlists: [], jobs: [] };
export const DataContext = createContext<{
  library: LibraryDto;
  overview: LibraryCardOverviewDto;
  refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
  openImport: () => void;
}>({
  library: EMPTY,
  overview: {...EMPTY, playlists: [], total: 0, tagCounts: {}, revision: ""},
  refresh: async () => {},
  notify: () => {},
  openImport: () => {},
});
export const useData = () => useContext(DataContext);
export function Button({
  children,
  busy,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`button ${className}`}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
    </button>
  );
}
export function ErrorMessage({ error }: { error?: string }) {
  return error ? (
    <div className="error-box" role="alert">
      <CircleAlert size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}
export function Modal({
  title,
  subtitle,
  children,
  close,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="modal-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" aria-label="Закрыть" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function EmptyState({
  title,
  text,
  action,
  icon = <Music2 size={29} />,
}: {
  title: string;
  text: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

export function PageTop({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="page-top">
      <div className="breadcrumb">
        <span>Ваше пространство</span>
        <ChevronRight size={13} />
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}
