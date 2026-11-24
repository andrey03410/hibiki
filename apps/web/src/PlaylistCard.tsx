import { Link } from "react-router";
import { Link2, ListMusic, Pencil, Sparkles, Youtube } from "lucide-react";
import type { ItemDto, PlaylistSummaryDto } from "@hibiki/contracts";
import { mediaWord } from "./api";
import { ArtworkImage } from "./ItemArtwork";
import { NoteIndicator } from "./NoteEditor";

export function PlaylistCover({
  title,
  items,
  coverUrls,
  large = false,
  className = "",
}: {
  title: string;
  items?: ItemDto[];
  coverUrls?: string[];
  large?: boolean;
  className?: string;
}) {
  const seed = [...title].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const detailThumbnail = items?.find(item => item.sources.some(source => source.thumbnail))
    ?.sources.find(source => source.thumbnail)?.thumbnail;
  return (
    <div className={`cover art-${seed % 6} ${large ? "large" : ""} ${className}`}>
      <span className="cover-orbit" />
      <span className="cover-orbit second" />
      <span className="cover-mark">響</span>
      <ArtworkImage urls={[detailThumbnail, ...(coverUrls ?? [])]} />
      <div className="cover-grain" />
    </div>
  );
}

export function PlaylistCard({ playlist, hasNote, onShare }: {
  playlist: PlaylistSummaryDto;
  hasNote: boolean;
  onShare: () => void;
}) {
  return (
    <article className="playlist-card">
      <Link className="playlist-cover-wrap" to={`/playlists/${playlist.id}?edit=1`}
        aria-label={`Редактировать плейлист «${playlist.title}»`} title="Редактировать плейлист">
        <PlaylistCover title={playlist.title} coverUrls={playlist.coverUrls} />
        <span className="cover-type">
          {playlist.youtubeLinked ? <Youtube size={13} /> : playlist.manual ? <ListMusic size={13} /> : <Sparkles size={13} />}
          {playlist.youtubeLinked ? "СВЯЗЬ С YOUTUBE" : playlist.manual ? "ВАШ ВЫБОР" : "ПО ПРАВИЛАМ"}
        </span>
        <span className="playlist-cover-edit" aria-hidden="true"><Pencil size={15} /></span>
      </Link>
      <Link className="playlist-card-title" to={`/playlists/${playlist.id}`} title={playlist.title}>
        {playlist.title}
      </Link>
      {hasNote && <NoteIndicator />}
      {playlist.description && <p>{playlist.description}</p>}
      <div className="playlist-card-footer">
        <span className="small muted">
          {playlist.trackCount === null ? "—" : `${playlist.trackCount} ${mediaWord(playlist.trackCount)}`}
        </span>
        <button type="button" className="button subtle compact playlist-card-share" onClick={onShare}
          onFocus={() => void import("./Sharing")} onPointerEnter={() => void import("./Sharing")}>
          <Link2 size={14} aria-hidden="true" /> Поделиться
        </button>
      </div>
    </article>
  );
}
