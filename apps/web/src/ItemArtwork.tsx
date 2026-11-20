import { useState } from "react";
import { Music2, Video } from "lucide-react";
import type { ItemDto, SourceDto } from "@hibiki/contracts";

interface Props {
  source?: Pick<SourceDto, "provider" | "thumbnail" | "externalId">;
  kind: ItemDto["kind"];
}

function libraryThumbnail(source: Props["source"]) {
  if (!source?.thumbnail) return;
  if (source.provider === "youtube" && /^[\w-]{11}$/.test(source.externalId ?? ""))
    return `https://i.ytimg.com/vi/${source.externalId}/default.jpg`;
  if (source.provider === "local" && /^\/api\/items\/[\w-]+\/artwork$/.test(source.thumbnail))
    return `${source.thumbnail}?size=thumb`;
}

export function ItemArtwork({ source, kind }: Props) {
  const url = libraryThumbnail(source);
  const [failed, setFailed] = useState<string>();
  if (url && url !== failed)
    return <img src={url} alt="" loading="lazy" decoding="async" fetchPriority="low"
      onError={() => setFailed(url)} />;
  return kind === "video" ? <Video size={19} /> : <Music2 size={19} />;
}
