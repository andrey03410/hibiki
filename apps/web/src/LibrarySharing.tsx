import { Link2 } from "lucide-react";
import type { ItemDto, SavedSharedPlaylistDto } from "@hibiki/contracts";
import { playbackSources } from "./player-model";
import { useSharingRequest } from "./use-sharing-request";
import "./sharing.css";

export function useSavedSharedPlaylists() {
  const { data, error } = useSharingRequest<{ playlists: SavedSharedPlaylistDto[] }>("/shared-playlists");
  return { playlists: data?.playlists ?? [], error, loading: !data && !error };
}

export function SharedItemStatus({ item }: { item: ItemDto }) {
  if (!item.shared) return null;
  return <span className="shared-item-origin">
    <Link2 size={13} aria-hidden="true" />Поделился {item.shared.sharedBy}
    {!item.shared.available && !playbackSources(item).length && <span className="danger-text">· Доступ закрыт</span>}
  </span>;
}
