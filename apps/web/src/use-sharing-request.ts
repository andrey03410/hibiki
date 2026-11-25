import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export const overviewInterval = 10_000;
export const activeJobsInterval = 3_000;

export function pollWhileVisible(read: () => Promise<void>, interval = 30_000) {
  let running = false;
  function poll() {
    if (running || document.hidden) return;
    running = true;
    void read().catch(() => {}).finally(() => { running = false; });
  }
  const timer = window.setInterval(poll, interval);
  document.addEventListener("visibilitychange", poll);
  window.addEventListener("focus", poll);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", poll);
    window.removeEventListener("focus", poll);
  };
}

export function useSharingRequest<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const result = await api<T>(path, "GET", undefined, "low");
      if (sequence === request.current) { setData(result); setError(undefined); }
    } catch (failure) {
      if (sequence === request.current) setError(failure as Error);
    }
  }, [path]);
  useEffect(() => {
    if (!document.hidden) void refresh();
    const stop = pollWhileVisible(refresh);
    return () => {
      ++request.current;
      stop();
    };
  }, [refresh]);
  return { data, error, refresh, setData };
}
