import { useEffect, useState } from "react";

const historyChanged = "hibiki:history-changed";

export function announceHistoryChanged() {
  window.dispatchEvent(new Event(historyChanged));
  try {
    localStorage.setItem(historyChanged, String(Date.now() + Math.random()));
  } catch {}
}

export function useHistoryRevision(enabled: boolean) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setRevision((previous) => previous + 1);
    const storage = (event: StorageEvent) => {
      if (event.key === historyChanged) update();
    };
    window.addEventListener(historyChanged, update);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(historyChanged, update);
      window.removeEventListener("storage", storage);
    };
  }, [enabled]);
  return revision;
}
