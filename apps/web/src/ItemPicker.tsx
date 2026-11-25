import { useEffect, useMemo, useRef, useState } from "react";
import type { ItemDto } from "@hibiki/contracts";
import { api } from "./api";

export type PickerItem = Pick<ItemDto, "id" | "title" | "kind" | "duration">;
type Named = Pick<ItemDto, "id" | "title">;
type Page = { items: PickerItem[]; nextCursor: string | null };

export function useItemSearch(revision?: string) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const controller = useRef<AbortController>(undefined);
  async function read(signal: AbortSignal, cursor?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<Page>("/library/page", "POST", {filters: {query}, picker: true, cursor}, undefined, signal);
      if (!signal.aborted) setPage(old => cursor && old ? {...result, items: [...old.items, ...result.items]} : result);
    } catch (failure) {
      if (!signal.aborted) setError((failure as Error).message);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    setPage(undefined);
    setBusy(true);
    setError("");
    const timer = setTimeout(() => void read(request.signal), query.trim() ? 150 : 0);
    return () => { clearTimeout(timer); request.abort(); };
  }, [query, revision, retry]);
  function more() {
    if (!busy && page?.nextCursor && controller.current) void read(controller.current.signal, page.nextCursor);
  }
  return { query, setQuery, page, busy, error, more, retry: () => setRetry(n => n + 1) };
}

export function useItemNames(ids: string[], revision?: string) {
  const key = JSON.stringify(ids);
  const [names, setNames] = useState<Named[]>([]);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    const selected: string[] = JSON.parse(key);
    async function load() {
      const found: Named[] = [];
      for (let offset = 0; offset < selected.length; offset += 100) {
        const page = await api<{items: Named[]}>("/library/items", "POST", {ids: selected.slice(offset, offset + 100), picker:true}, undefined, controller.signal);
        found.push(...page.items);
      }
      if (!controller.signal.aborted) setNames(found);
    }
    void load().catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [key, revision, attempt]);
  return { names, error, retry: () => setAttempt(n => n + 1) };
}

export function PickerFooter({ result }: { result: ReturnType<typeof useItemSearch> }) {
  return <>
    {result.busy && <span role="status" className="muted small">Загружаем записи…</span>}
    {result.error && <div role="alert">{result.error} <button className="text-button" type="button" onClick={result.retry}>Повторить</button></div>}
    {result.page?.nextCursor && <button type="button" className="button subtle compact" disabled={result.busy} onClick={result.more}>Показать ещё</button>}
  </>;
}

export function ItemSelect({ label, empty, value, onChange, excluded, known = [], disabled, revision }: {
  label: string; empty: string; value: string; onChange: (id: string) => void;
  excluded?: Set<string>; known?: Named[]; disabled?: boolean; revision?: string;
}) {
  const result = useItemSearch(revision);
  const options = result.page?.items ?? known;
  const missing = value && !options.some(item => item.id === value) ? [value] : [];
  const selected = useItemNames(missing, revision);
  const items = useMemo(() => options.filter(item => !excluded?.has(item.id)), [options, excluded]);
  return <div>
    <label>Найти запись<input type="search" value={result.query} onChange={e => result.setQuery(e.target.value)} /></label>
    <label>{label}<select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {missing.length > 0 && <option value={value}>{selected.names.find(item => item.id === value)?.title ?? "Выбранная запись"}</option>}
      {items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select></label>
    <PickerFooter result={result} />
    {selected.error && <p role="alert">{selected.error} <button type="button" onClick={selected.retry}>Повторить</button></p>}
  </div>;
}
