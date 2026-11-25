import { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;
export type ShareTarget = { ownerId: string; kind: string; targetId: string };
export type UpstreamScope = { itemId?: string; publishedOnly?: boolean; requireReshare?: boolean };

const hasPublishedQueue = (now: Date) => Prisma.sql`
  w.publishedVersion = w.version AND (w.validUntil IS NULL OR w.validUntil > ${BigInt(+now)})
  AND p.queueIdsJson IS NOT NULL AND p.trackCount IS NOT NULL`;

const borrowedOnly = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM Source s WHERE s.itemId = t.recipientItemId AND s.ownerId = t.recipientId AND (
    (s.provider = 'youtube' AND s.fileId IS NULL) OR
    (s.provider = 'local' AND EXISTS (SELECT 1 FROM MediaFile f WHERE f.id = s.fileId AND f.ownerId = t.recipientId))
  )
)`;

// For an unpublished manual rule its IDs bound the candidates. An unpublished
// dynamic rule uses NULL to request the live membership check in ShareLookup.
function candidateRows(targets: ShareTarget[], now: Date, { itemId, publishedOnly }: UpstreamScope) {
  const fresh = hasPublishedQueue(now);
  const members = itemId === undefined ? Prisma.sql`CASE
    WHEN ${fresh} THEN p.queueIdsJson
    WHEN ${!!publishedOnly} OR NOT json_valid(p.definitionJson) THEN '[]'
    WHEN json_extract(p.definitionJson, '$.rule.type') = 'items' THEN json_extract(p.definitionJson, '$.rule.ids')
  END` : Prisma.sql`json_array(${itemId})`;
  return Prisma.sql`WITH scope AS (
    SELECT p.id, p.ownerId, CASE WHEN ${fresh} THEN p.trackCount END AS total,
      CASE WHEN EXISTS (SELECT 1 FROM SharedTrack t WHERE t.recipientId = p.ownerId)
        THEN ${members} ELSE '[]' END AS members
    FROM json_each(${JSON.stringify(targets.map(p => [p.targetId, p.ownerId]))}) target
    JOIN Playlist p ON p.id = json_extract(target.value, '$[0]') AND p.ownerId = json_extract(target.value, '$[1]')
    LEFT JOIN PlaylistCountWork w ON w.ownerId = p.ownerId
  ), borrowed AS (
    SELECT p.id AS playlistId, t.recipientItemId, t.originOwnerId
    FROM scope p CROSS JOIN json_each(p.members) m
    CROSS JOIN SharedTrack t ON t.recipientItemId = m.value AND t.recipientId = p.ownerId
    WHERE ${borrowedOnly}
    UNION ALL
    SELECT p.id, t.recipientItemId, t.originOwnerId
    FROM scope p JOIN SharedTrack t ON t.recipientId = p.ownerId
    WHERE p.members IS NULL AND ${borrowedOnly}
  )`;
}

export async function countInputs(tx: Tx, target: ShareTarget, now: Date, eager: boolean) {
  const [row] = await tx.$queryRaw<{ total: bigint | null; borrowed: string }[]>`
    ${candidateRows([target], now, { publishedOnly: !eager })}
    SELECT total, (SELECT json_group_array(DISTINCT recipientItemId) FROM borrowed) AS borrowed FROM scope
  `;
  return {
    total: row?.total == null ? null : Number(row.total),
    borrowed: JSON.parse(row?.borrowed ?? "[]") as string[],
  };
}

export async function upstreamAuthorIds(tx: Tx, targets: ShareTarget[], now: Date, scope: UpstreamScope = {}) {
  const playlists = targets.filter(target => target.kind === "playlist");
  if (!playlists.length) return [];
  const authors = await tx.$queryRaw<{ ownerId: string }[]>`
    ${candidateRows(playlists, now, scope)}
    SELECT DISTINCT b.originOwnerId AS ownerId FROM borrowed b WHERE EXISTS (
      SELECT 1 FROM SharedTrackGrant g JOIN ShareLink l ON l.id = g.shareLinkId
      WHERE g.recipientItemId = b.recipientItemId AND l.ownerId = b.originOwnerId
        AND l.revokedAt IS NULL AND (l.expiresAt IS NULL OR l.expiresAt > ${now.toISOString()})
        AND (${!scope.requireReshare} OR l.allowReshare)
    )
  `;
  return authors.map(author => author.ownerId);
}
