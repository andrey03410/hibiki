import { type ReactNode, useCallback, useState } from "react";
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
  if (source.provider === "local" && /^\/api\/items\/[\w-]+\/artwork$/.test(source.thumbnail))
    return `${source.thumbnail}?size=${size}`;
}

const nearbyArtwork = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | undefined;
function watchArtwork(element: Element, load: () => void) {
  // Browser lazy loading can schedule dozens of covers well beyond the viewport,
  // ahead of a newly selected media file on the same connection pool.
  observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      nearbyArtwork.get(entry.target)?.();
      nearbyArtwork.delete(entry.target);
      observer!.unobserve(entry.target);
    }
  }, { rootMargin: "96px" });
  nearbyArtwork.set(element, load);
  observer.observe(element);
  return () => {
    nearbyArtwork.delete(element);
    observer!.unobserve(element);
  };
}

function useNearbyArtwork() {
  const [nearby, setNearby] = useState(() => typeof IntersectionObserver === "undefined");
  const attach = useCallback((element: Element | null) => {
    if (element && !nearby) return watchArtwork(element, () => setNearby(true));
  }, [nearby]);
  return { nearby, attach };
}

const youtubeSdCover = /^https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/sddefault\.jpg$/;

export function ArtworkImage({ urls, fallback = null }: { urls: (string | undefined)[]; fallback?: ReactNode }) {
  const [failed, setFailed] = useState<string[]>([]);
  const { nearby, attach } = useNearbyArtwork();
  const url = urls.flatMap(candidate => {
    if (!candidate) return [];
    return youtubeSdCover.test(candidate) ? [candidate, candidate.replace("sddefault.jpg", "hqdefault.jpg")] : [candidate];
  }).find(candidate => !failed.includes(candidate));
  if (!url) return fallback;
  const tryNext = () => setFailed(previous => [...previous, url]);
  return <img key={url} ref={attach} src={nearby ? url : undefined} alt="" loading="lazy" decoding="async" fetchPriority="low"
    onError={tryNext} onLoad={youtubeSdCover.test(url) ? event => {
      // Some unavailable YouTube sizes return a 120px placeholder with HTTP 200.
      if (event.currentTarget.naturalWidth <= 120) tryNext();
    } : undefined} />;
}

export function ItemArtwork({ source, kind, size = "thumb" }: Props) {
  const url = artworkUrl(source, size);
  return <ArtworkImage key={url} urls={[url]} fallback={kind === "video" ? <Video size={19} /> : <Music2 size={19} />} />;
}
