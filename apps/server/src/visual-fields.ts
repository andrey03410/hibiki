import type { Prisma } from "@prisma/client";
import type { ItemDto } from "@hibiki/contracts";

export const visualSelect = {
  soundSourceId: true,
  soundFileId: true,
  soundFile: { select: { ownerId: true, mime: true, bytes: true } },
  visualTrack: {
    select: {
      id: true,
      ownerId: true,
      duration: true,
      signature: true,
      file: { select: { ownerId: true, path: true } },
    },
  },
} satisfies Prisma.ItemVisualSelect;
type Assignment = Prisma.ItemVisualGetPayload<{ select: typeof visualSelect }>;
export function visualFields(
  item: { ownerId: string; visualRevision: number; visual?: Assignment | null },
  base: string,
  sourceId?: string,
): Pick<ItemDto, "visualRevision" | "visual"> {
  const assignment = item.visual;
  return {
    visualRevision: item.visualRevision,
    ...(assignment?.visualTrack.ownerId === item.ownerId &&
      sourceId && {
        visual: {
          ...((assignment.visualTrack.signature.startsWith("pending:") ||
            assignment.visualTrack.file.path.startsWith("missing/") ||
            assignment.visualTrack.file.ownerId !== item.ownerId) && { available: false }),
          streamUrl: base + "/visual/" + item.visualRevision,
          revision: item.visualRevision,
          soundSourceId: sourceId,
          duration: assignment.visualTrack.duration,
        },
      }),
  };
}
