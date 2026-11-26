import type { ItemDto, PlaylistPlaybackDto, SharedViewDto } from "@hibiki/contracts";
import { api } from "./api";
import { isClosedShare, orderedSharedItems } from "./sharing-model";

export type PlaylistTarget = { id: string; title: string } & ({kind: "own"} | {kind: "saved"});
export type PlaylistScope = {id: string; title: string} & (
  {kind: "own"; order: string[]} | {kind: "saved"; order: (string | null)[]}
) & {
  initialRows: (ItemDto | null)[];
  closed?: boolean;
};

export function savedPlaylistPath(id: string) {
  return "/shared-playlists/" + encodeURIComponent(id);
}

export function availableRows(rows: (ItemDto | null)[]) {
  return rows.filter((item): item is ItemDto => item !== null);
}

export async function readSharedRows(path: string, order?: (string | null)[], signal?: AbortSignal) {
  const view = await api<SharedViewDto>(path, "GET", undefined, "high", signal);
  return orderedSharedItems(view, order);
}

export async function readOwnedRows(ids: string[], signal?: AbortSignal) {
  const byId = new Map<string, ItemDto>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const page = await api<{items: ItemDto[]}>("/library/items", "POST",
      {ids: ids.slice(offset, offset + 100), verifyShared: true}, undefined, signal);
    for (const item of page.items) byId.set(item.id, item);
  }
  return ids.map(id => byId.get(id) ?? null);
}

export async function readPlaylistScope(target: PlaylistTarget, signal: AbortSignal): Promise<PlaylistScope> {
  if (target.kind === "saved") {
    try {
      const view = await api<SharedViewDto>(savedPlaylistPath(target.id), "GET", undefined, "high", signal);
      const initialRows = orderedSharedItems(view);
      return { ...target, title: view.title, order: initialRows.map(item => item?.id ?? null), initialRows };
    } catch (error) {
      if (isClosedShare(error)) return {...target, order: [], initialRows: [], closed: true};
      throw error;
    }
  }
  const {ids, items} = await api<PlaylistPlaybackDto>("/playlists/" + encodeURIComponent(target.id) + "/playback",
    "GET", undefined, "high", signal);
  const byId = new Map(items.map(item => [item.id, item]));
  const loaded = ids.findLastIndex(id => byId.has(id)) + 1;
  const initialRows = ids.slice(0, loaded).map(id => byId.get(id) ?? null);
  // A cached order can outlive deleted items in the first page.
  while (!items.length && initialRows.length < ids.length) {
    const page = await readOwnedRows(ids.slice(initialRows.length, initialRows.length + 100), signal);
    initialRows.push(...page);
    if (page.some(Boolean)) break;
  }
  return {...target, order: ids, initialRows};
}

export async function currentSharedEntries(scope: PlaylistScope) {
  try {
    return availableRows(await readSharedRows(savedPlaylistPath(scope.id), scope.order));
  } catch (error) {
    if (isClosedShare(error)) return [];
    throw error;
  }
}

export function watchPlaylistEnd(target: Element, load: () => void) {
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) load();
  }, { rootMargin: "400px" });
  // A tall viewport can fit the entire launch window. Give the first sound a
  // head start, then let the observer fill the viewport even without scrolling.
  let timer: number;
  function stopWaiting() {
    window.clearTimeout(timer);
    window.removeEventListener("scroll", observe);
    document.removeEventListener("playing", afterSound, true);
  }
  function observe() {
    stopWaiting();
    observer.observe(target);
  }
  function afterSound(event: Event) {
    if (event.target instanceof HTMLMediaElement && !event.target.muted) {
      document.removeEventListener("playing", afterSound, true);
      window.clearTimeout(timer);
      timer = window.setTimeout(observe, 120);
    }
  }
  if (window.scrollY > 0) observe();
  else {
    window.addEventListener("scroll", observe, { once: true, passive: true });
    document.addEventListener("playing", afterSound, true);
    // Paused, silent or unavailable media may never emit a playing event.
    timer = window.setTimeout(observe, 1_800);
  }
  return () => { stopWaiting(); observer.disconnect(); };
}
