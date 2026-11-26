import { type ReactNode, useCallback, useState } from "react";
import { watchArtwork } from "./artwork-requests";
import { Music2, Video } from "lucide-react";
import type { ItemDto, SourceDto } from "@hibiki/contracts";

interface Props {
  source?: Pick<SourceDto, "provider" | "thumbnail" | "externalId" | "shared">;
  kind: ItemDto["kind"];
  size?: "thumb" | "cover";
}

function artworkUrl(source: Props["source"], size: NonNullable<Props["size"]>) {
  if (!source?.thumbnail) return;
  if (source.shared && /^\/api\/(?:(?:shared|shared-playlists)\/[\w-]+\/items|shared-items)\/[\w-]+\/artwork$/.test(source.thumbnail))
    return `${source.thumbnail}?size=${size}`;
  if (source.provider === "youtube" && /^[\w-]{11}$/.test(source.externalId ?? ""))
    return `https://i.ytimg.com/vi/${source.externalId}/${size === "cover" ? "sddefault" : "default"}.jpg`;
  if (source.provider === "local" && /^\/api\/items\/[\w-]+\/artwork(?:\?v=[a-f0-9]{64})?$/.test(source.thumbnail))
    return `${source.thumbnail}${source.thumbnail.includes("?") ? "&" : "?"}size=${size}`;
}

const youtubeSdCover = /^https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/sddefault\.jpg$/;

export function ArtworkImage({ urls, fallback = null }: { urls: (string | undefined)[]; fallback?: ReactNode }) {
  const [failed, setFailed] = useState<string[]>([]);
  const url = urls.flatMap(candidate => {
    if (!candidate) return [];
    return youtubeSdCover.test(candidate) ? [candidate, candidate.replace("sddefault.jpg", "hqdefault.jpg")] : [candidate];
  }).find(candidate => !failed.includes(candidate));
  const observed = typeof IntersectionObserver !== "undefined";
  const attach = useCallback((element: HTMLImageElement | null) => {
    if (observed && element && url) return watchArtwork(element, url);
  }, [url, observed]);
  if (!url) return fallback;
  const tryNext = () => setFailed(previous => [...previous, url]);
  return <img key={url} ref={attach} src={observed ? undefined : url} alt="" loading="lazy" decoding="async" fetchPriority="low"
    onError={event => {
      const image = event.currentTarget;
      if (image.hasAttribute("src") && image.complete && !image.naturalWidth) tryNext();
    }} onLoad={youtubeSdCover.test(url) ? event => {
      // Some unavailable YouTube sizes return a 120px placeholder with HTTP 200.
      if (event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalWidth <= 120) tryNext();
    } : undefined} />;
}

export function ItemArtwork({ source, kind, size = "thumb" }: Props) {
  const url = artworkUrl(source, size);
  return <ArtworkImage key={url} urls={[url]} fallback={kind === "video" ? <Video size={19} /> : <Music2 size={19} />} />;
}
