import { useCallback, useState } from "react";
import { Music2, Video } from "lucide-react";
import type { ItemDto, SourceDto } from "@hibiki/contracts";

interface Props {
  source?: Pick<SourceDto, "provider" | "thumbnail" | "externalId" | "shared">;
  kind: ItemDto["kind"];
}

function libraryThumbnail(source: Props["source"]) {
  if (!source?.thumbnail) return;
  if (source.shared && /^\/api\/(?:(?:shared|shared-playlists)\/[\w-]+\/items|shared-items)\/[\w-]+\/artwork$/.test(source.thumbnail))
    return `${source.thumbnail}?size=thumb`;
  if (source.provider === "youtube" && /^[\w-]{11}$/.test(source.externalId ?? ""))
    return `https://i.ytimg.com/vi/${source.externalId}/default.jpg`;
  if (source.provider === "local" && /^\/api\/items\/[\w-]+\/artwork$/.test(source.thumbnail))
    return `${source.thumbnail}?size=thumb`;
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

export function useNearbyArtwork() {
  const [nearby, setNearby] = useState(() => typeof IntersectionObserver === "undefined");
  const attach = useCallback((element: Element | null) => {
    if (element && !nearby) return watchArtwork(element, () => setNearby(true));
  }, [nearby]);
  return { nearby, attach };
}

export function ItemArtwork({ source, kind }: Props) {
  const url = libraryThumbnail(source);
  const [failed, setFailed] = useState<string>();
  const { nearby, attach } = useNearbyArtwork();
  if (url && url !== failed)
    return <img ref={attach} src={nearby ? url : undefined} alt="" loading="lazy" decoding="async" fetchPriority="low"
      onError={() => setFailed(url)} />;
  return kind === "video" ? <Video size={19} /> : <Music2 size={19} />;
}
