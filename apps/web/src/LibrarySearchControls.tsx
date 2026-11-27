import { useEffect, useState } from "react";
import { defaultLibrarySearch, restoreLibrarySearch, type LibrarySearch } from "./library-search";

/** Library search state of this browser tab (restored after reloads). */
export function useLibrarySearch(userId: string) {
  const key = `hibiki:library-search:${userId}`;
  const [value, setValue] = useState<LibrarySearch>(() => {
    try {
      return restoreLibrarySearch(sessionStorage.getItem(key));
    } catch {
      return defaultLibrarySearch;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Search state is still kept in the workspace for this visit.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
