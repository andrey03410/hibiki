import { Link } from "react-router";
import { Link2, ListMusic, Pencil, Play, Sparkles, Youtube } from "lucide-react";
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

export function PlaylistCard({ playlist, hasNote, onShare, onPlay, onEdit }: {
  playlist: PlaylistSummaryDto;
  hasNote: boolean;
  onShare: () => void;
  onPlay: () => void;
  onEdit: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <article className="playlist-card">
      <div className="playlist-cover-wrap">
        <button type="button" className="playlist-cover-play" onClick={onPlay}
          aria-label={`Воспроизвести плейлист «${playlist.title}»`}>
          <PlaylistCover title={playlist.title} coverUrls={playlist.coverUrls} />
          <span className="cover-type">
            {playlist.youtubeLinked ? <Youtube size={13} /> : playlist.manual ? <ListMusic size={13} /> : <Sparkles size={13} />}
            {playlist.youtubeLinked ? "СВЯЗЬ С YOUTUBE" : playlist.manual ? "ВАШ ВЫБОР" : "ПО ПРАВИЛАМ"}
          </span>
          <span className="playlist-play-mark" aria-hidden="true"><Play size={22} fill="currentColor" /></span>
        </button>
        <button type="button" className="playlist-cover-edit" aria-label={`Редактировать плейлист «${playlist.title}»`}
          title="Редактировать плейлист" onClick={event => onEdit(event.currentTarget)}><Pencil size={15} /></button>
      </div>
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
