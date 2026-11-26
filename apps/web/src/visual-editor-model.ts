import type { SourceDto } from "@hibiki/contracts";

export function donorVideoFiles(sources: SourceDto[]) {
  return sources.filter(source => source.provider === "local" && !source.shared &&
    (source.status !== "unavailable" || source.reason === "unsupported_codec") &&
    (source.videoStreams ? source.videoStreams.length > 0 : source.mime?.startsWith("video/")));
}

// An upload job cannot offer its stream list until the server has inspected the incoming file.
export function offeredStreams(message?: string): NonNullable<SourceDto["videoStreams"]> {
  if (!message?.startsWith("Выберите videoStreamIndex:")) return [];
  return Array.from(message.matchAll(/(\d+) \(([^)]+)\)/g), ([, index, codec]) => ({index: Number(index), codec: codec!}));
}
