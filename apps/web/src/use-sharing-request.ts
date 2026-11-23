import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

const updateInterval = 5000;

export function pollWhileVisible(read: () => Promise<void>) {
  let running = false;
  function poll() {
    if (running || document.hidden) return;
    running = true;
    void read().catch(() => {}).finally(() => { running = false; });
  }
  const timer = window.setInterval(poll, updateInterval);
  document.addEventListener("visibilitychange", poll);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", poll);
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
    void refresh();
    const stop = pollWhileVisible(refresh);
    return () => {
      ++request.current;
      stop();
    };
  }, [refresh]);
  return { data, error, refresh, setData };
}
