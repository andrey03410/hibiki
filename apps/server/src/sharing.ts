import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma, type ShareLink } from "@prisma/client";
import type {
  ItemDto, SavedSharedPlaylistDto, ShareKind, ShareLinkDto, ShareStatus,
  SharedViewDto, SourceDto,
} from "@hibiki/contracts";
import { playbackFields } from "./media-playback";
import type { Db } from "./db";
import type { LibraryService } from "./library";
import { HttpError, invariant } from "./errors";
import { countInputs, upstreamAuthorIds, type ShareTarget, type UpstreamScope } from "./share-playlist-counts";
import { centralAccess, checkItems, env, kanameEnabled, ownerAccess } from "./kaname";

type Tx = Prisma.TransactionClient;
type LinkTarget = { title: string };
type SaveResult = { id: string; kind: ShareKind };
type ValidLink = { link: ShareLink; target: LinkTarget; sharedBy: string };
type CopySource =
  | { provider: "local"; path: string; sourceId: string }
  | { provider: "youtube"; externalId: string; sourceId: string };
type AuthorProof = { ownerId: string; issuer: string; subject: string };
type AuthorAccount = { login: string; kanameIssuer: string | null; kanameSubject: string | null };
type AuthorProbe = { checkedUntil: number; allowed: boolean; pending?: Promise<boolean> };
const authorProbes = new WeakMap<Db, Map<string, AuthorProbe>>();
const accountSelect = { login: true, kanameIssuer: true, kanameSubject: true } as const;
const authorCacheTtlMs = 10_000;
const authorRetryDelayMs = 1_000;

function authorIdentity(ownerId: string, account: AuthorAccount): AuthorProof | null {
  if (!account.kanameSubject || account.kanameIssuer !== env("KANAME_OIDC_ISSUER")) return null;
  return { ownerId, issuer: account.kanameIssuer, subject: account.kanameSubject };
}

function authorProbe(db: Db, identity: AuthorProof) {
  let probes = authorProbes.get(db);
  if (!probes) {
    probes = new Map();
    authorProbes.set(db, probes);
  }
  const key = JSON.stringify([identity.ownerId, identity.issuer, identity.subject]);
  let probe = probes.get(key);
  if (!probe) {
    probe = { checkedUntil: 0, allowed: false };
    probes.set(key, probe);
  }
  return probe;
}

function probeAuthor(probe: AuthorProbe, subject: string) {
  if (probe.pending) return probe.pending;
  probe.checkedUntil = 0;
  probe.allowed = false;
  probe.pending = centralAccess(subject).then(() => {
    probe.allowed = true;
    probe.checkedUntil = Date.now() + authorCacheTtlMs;
    return true;
  }).catch(error => {
    probe.allowed = false;
    probe.checkedUntil = Date.now() + authorRetryDelayMs;
    if (error instanceof HttpError && error.status === 403) return false;
    throw error;
  }).finally(() => { probe.pending = undefined; });
  return probe.pending;
}

export type SharedMediaRef =
  | { kind: "link"; token: string; itemId: string }
  | { kind: "playlist"; id: string; itemId: string }
  | { kind: "item"; id: string };

const originSelect = {
  id: true,
  ownerId: true,
  title: true,
  kind: true,
  duration: true,
  preferredSourceId: true,
  sharedTrack: { select: { recipientItemId: true } },
  sources: {
    select: {
      id: true, ownerId: true, provider: true, externalId: true, status: true, fileId: true,
      file: { select: { ownerId: true, mime: true, kind: true, path: true, id: true, hash: true, bytes: true, hasAudio: true,
        audioStart: true, tailStart: true, hintsVersion: true, audioViewStart: true, audioViewBytes: true, audioViewVersion: true } },
    },
  },
} satisfies Prisma.ItemSelect;

type Origin = Prisma.ItemGetPayload<{ select: typeof originSelect }>;
type Counts = Pick<ShareLinkDto, "trackCount" | "totalCount" | "missingPermissionCount" | "unavailableCount">;
const unknownCounts: Counts = { trackCount: null, totalCount: null, missingPermissionCount: null, unavailableCount: null };
type Position =
  | { access: "direct" | "delegated"; id: string; origin: Origin; sharedBy: string }
  | { access: "missingPermission" | "unavailable" };
type OriginSource = Origin["sources"][number];
const includeGrants = { grants: { include: { link: true } } } as const;
type ReceivedTrack = Prisma.SharedTrackGetPayload<{ include: typeof includeGrants }>;
const queryBatchSize = 500;

function ownedSources(item: Origin) {
  return item.sources.filter(source =>
    source.ownerId === item.ownerId &&
    (source.provider === "local" && source.file?.ownerId === item.ownerId ||
      source.provider === "youtube" && source.fileId === null),
  );
}

function shareable(item: Origin | null, ownerId: string) {
  return item?.ownerId === ownerId && (!item.sharedTrack || ownedSources(item).length > 0);
}

const youtubeId = (source: OriginSource) =>
  source.externalId && /^[\w-]{11}$/.test(source.externalId) ? source.externalId : undefined;
const sourceKey = (sourceId: string) => createHash("sha256").update(sourceId).digest("base64url");
const mediaBase = (ref: SharedMediaRef) => {
  if (ref.kind === "item") return `/api/shared-items/${encodeURIComponent(ref.id)}`;
  const parent = ref.kind === "link"
    ? `/api/shared/${encodeURIComponent(ref.token)}`
    : `/api/shared-playlists/${encodeURIComponent(ref.id)}`;
  return `${parent}/items/${encodeURIComponent(ref.itemId)}`;
};

function projectedSources(item: Origin, ref: SharedMediaRef): SourceDto[] {
  return ownedSources(item).flatMap((source): SourceDto[] => {
    const id = sourceKey(source.id);
    const status = source.status === "available" || source.status === "unavailable"
      ? source.status : "unknown";
    if (source.provider === "youtube") {
      const externalId = youtubeId(source);
      return externalId ? [{
        id, status, externalId, provider: "youtube", shared: true,
        thumbnail: `https://i.ytimg.com/vi/${externalId}/mqdefault.jpg`,
      }] : [];
    }
    const base = mediaBase(ref);
    const file = source.file!;
    return [{
      id, status, provider: "local", shared: true,
      mime: file.mime, bytes: Number(file.bytes), hasAudio: file.hasAudio ?? undefined,
      ...playbackFields(file, `${base}/sources/${id}`),
      streamUrl: `${base}/sources/${id}`,
      thumbnail: file.kind === "audio" ? `${base}/artwork` : undefined,
    }];
  });
}

function projectedItem(slot: Extract<Position, { origin: Origin }>, ref: SharedMediaRef, sharedAt: string): ItemDto {
  const { id, origin, sharedBy } = slot;
  const { title, duration, preferredSourceId } = origin;
  const sources = projectedSources(origin, ref);
  const sharedPreferred = preferredSourceId ? sourceKey(preferredSourceId) : undefined;
  return {
    id, title, originalTitle: title, duration,
    kind: origin.kind === "video" ? "video" : "audio",
    createdAt: sharedAt,
    updatedAt: sharedAt,
    tags: [], sources,
    preferredSourceId: sources.find(source => source.id === sharedPreferred)?.id,
    shared: { sharedBy, available: true, ...(slot.access === "delegated" && { delegated: true }) },
  };
}

function linkStatus(link: Pick<ShareLink, "revokedAt" | "expiresAt">, now: Date): ShareStatus {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && link.expiresAt <= now) return "expired";
  return "active";
}

function parseExpiry(value: string | Date | null | undefined, now: Date) {
  if (value == null) return null;
  const date = new Date(value);
  invariant(Number.isFinite(+date) && date > now, 400, "invalid_share_expiry", "Укажите срок в будущем");
  return date;
}

function requireShared<T>(data: T | null | undefined | false): T {
  invariant(data != null && data !== false, 404, "share_unavailable", "Доступ по ссылке закрыт");
  return data;
}

class ShareLookup {
  private accounts = new Map<string, Promise<AuthorAccount | null>>();
  private authors = new Map<string, Promise<string | null>>();
  private origins = new Map<string, Promise<Origin | null>>();
  private playlists = new Map<string, Promise<LinkTarget | null>>();
  private memberships = new Map<string, Promise<Set<string> | null>>();
  private links = new Map<string, Promise<ValidLink | null>>();
  private counts = new Map<string, Promise<Counts>>();
  readonly now = new Date(Date.now());

  private readonly proofs: Map<string, AuthorProof> | null;

  constructor(readonly tx: Tx, private library: LibraryService, authorizations: AuthorProof[] | "cached" = []) {
    this.proofs = authorizations === "cached" ? null : new Map(authorizations.map(proof => [proof.ownerId, proof]));
  }

  async viewer(id: string) {
    const account = await this.account(id);
    invariant(account, 403, "share_access_denied", "Доступ к Hibiki закрыт");
    return account;
  }

  private account(id: string) {
    let result = this.accounts.get(id);
    if (!result) {
      result = this.tx.user.findFirst({
        where: { id, suspended: false },
        select: accountSelect,
      });
      this.accounts.set(id, result);
    }
    return result;
  }

  author(id: string) {
    let result = this.authors.get(id);
    if (!result) {
      result = this.authorLogin(id);
      this.authors.set(id, result);
    }
    return result;
  }

  private async authorLogin(id: string) {
    const account = await this.account(id);
    if (!account) return null;
    if (!kanameEnabled()) return account.login;
    const identity = authorIdentity(id, account);
    if (!identity) return null;
    if (this.proofs) {
      const proof = this.proofs.get(id);
      return proof?.issuer === identity.issuer && proof.subject === identity.subject ? account.login : null;
    }
    const probe = authorProbe(this.library.db, identity);
    if (probe.checkedUntil > Date.now()) return probe.allowed ? account.login : null;
    // Hydration can run inside a transaction. Refresh without awaiting network
    // or touching the root DB connection while the transaction holds its lock.
    void probeAuthor(probe, identity.subject).catch(() => {});
    return null;
  }

  async loadOrigins(ids: string[]) {
    const missing = [...new Set(ids)].filter(id => !this.origins.has(id));
    for (let offset = 0; offset < missing.length; offset += queryBatchSize) {
      const batch = missing.slice(offset, offset + queryBatchSize);
      const results = await this.tx.item.findMany({ where: { id: { in: batch } }, select: originSelect });
      const byId = new Map(results.map(item => [item.id, item]));
      for (const id of batch) this.origins.set(id, Promise.resolve(byId.get(id) ?? null));
    }
  }

  origin(id: string) {
    let result = this.origins.get(id);
    if (!result) {
      result = this.tx.item.findUnique({ where: { id }, select: originSelect });
      this.origins.set(id, result);
    }
    return result;
  }

  async target(kind: ShareKind, ownerId: string, id: string): Promise<LinkTarget | null> {
    if (kind === "item") {
      const item = await this.origin(id);
      return shareable(item, ownerId) ? item : null;
    }
    const key = JSON.stringify([ownerId, id]);
    let result = this.playlists.get(key);
    if (!result) {
      result = this.tx.playlist.findFirst({ where: { ownerId, id }, select: { title: true } });
      this.playlists.set(key, result);
    }
    return result;
  }

  members(link: ShareLink) {
    const key = JSON.stringify([link.ownerId, link.targetId]);
    let members = this.memberships.get(key);
    if (!members) {
      members = this.library.playlistIds(this.tx, link.ownerId, link.targetId, this.now)
        .then(ids => new Set(ids))
        .catch(error => {
          if (error instanceof HttpError && ["playlist_not_found", "invalid_playlist"].includes(error.code))
            return null;
          throw error;
        });
      this.memberships.set(key, members);
    }
    return members;
  }

  valid(link: ShareLink | null) {
    if (!link) return Promise.resolve(null);
    let valid = this.links.get(link.id);
    if (!valid) {
      valid = this.verifyLink(link);
      this.links.set(link.id, valid);
    }
    return valid;
  }

  private async verifyLink(link: ShareLink): Promise<ValidLink | null> {
    if (linkStatus(link, this.now) !== "active") return null;
    const [target, sharedBy] = await Promise.all([
      this.target(link.kind as ShareKind, link.ownerId, link.targetId),
      this.author(link.ownerId),
    ]);
    return target && sharedBy ? { link, target, sharedBy } : null;
  }

  async includes(link: ShareLink, origin: Origin) {
    if (!shareable(origin, link.ownerId)) return false;
    return link.kind === "item" ? link.targetId === origin.id : (await this.members(link))?.has(origin.id) ?? false;
  }

  async receivedOrigin(track: ReceivedTrack) {
    const origin = await this.origin(track.originItemId);
    if (!origin || !shareable(origin, track.originOwnerId)) return;
    const active = track.grants.filter(({ link }) =>
      linkStatus(link, this.now) === "active" && link.ownerId === track.originOwnerId);
    if (!active.length) return;
    const sharedBy = await this.author(track.originOwnerId);
    if (!sharedBy) return;
    const matches = await Promise.all(active.map(async ({ link }) =>
      await this.includes(link, origin) ? link : null));
    if (matches.some(link => link !== null)) return {
      origin, sharedBy, allowReshare: matches.some(link => link?.allowReshare),
    };
  }

  private async delegatedPositions(ownerId: string, ids: string[]) {
    const positions = new Map<string, Position>();
    const received: ReceivedTrack[] = [];
    for (let offset = 0; offset < ids.length; offset += queryBatchSize) {
      received.push(...await this.tx.sharedTrack.findMany({
        where: { recipientId: ownerId, recipientItemId: { in: ids.slice(offset, offset + queryBatchSize) } },
        include: includeGrants,
      }));
    }
    await this.loadOrigins(received.map(track => track.originItemId));
    const authorIds = [...new Set(received.map(track => track.originOwnerId))].filter(id => !this.accounts.has(id));
    for (let offset = 0; offset < authorIds.length; offset += queryBatchSize) {
      const ids = authorIds.slice(offset, offset + queryBatchSize);
      const accounts = await this.tx.user.findMany({
        where: { id: { in: ids }, suspended: false }, select: { id: true, ...accountSelect },
      });
      const byId = new Map(accounts.map(account => [account.id, account]));
      for (const id of ids) this.accounts.set(id, Promise.resolve(byId.get(id) ?? null));
    }
    await Promise.all(received.map(async track => {
      const match = await this.receivedOrigin(track);
      const id = track.recipientItemId;
      positions.set(id, match?.allowReshare ? {
        access: "delegated", id, origin: match.origin, sharedBy: match.sharedBy,
      } : { access: match ? "missingPermission" : "unavailable" });
    }));
    return positions;
  }

  async positions(link: ShareLink, ids: string[], sharedBy: string): Promise<Position[]> {
    await this.loadOrigins(ids);
    const rows = await Promise.all(ids.map(id => this.origin(id)));
    const borrowed = rows.flatMap(item => item && item.ownerId === link.ownerId && !shareable(item, link.ownerId) ? [item.id] : []);
    const delegated = await this.delegatedPositions(link.ownerId, borrowed);
    return rows.map((item, i) => item && shareable(item, link.ownerId)
      ? { access: "direct", id: item.id, origin: item, sharedBy }
      : delegated.get(ids[i]) ?? { access: "unavailable" });
  }

  publishedCounts(link: ShareLink, eager = false): Promise<Counts> {
    if (link.kind === "item") return Promise.resolve({
      trackCount: 1, totalCount: 1, missingPermissionCount: 0, unavailableCount: 0,
    });
    let count = this.counts.get(link.targetId);
    if (!count) {
      count = this.countPublishedPlaylist(link, eager);
      this.counts.set(link.targetId, count);
    }
    return count;
  }

  private async countPublishedPlaylist(link: ShareLink, eager: boolean): Promise<Counts> {
    let { total, borrowed } = await countInputs(this.tx, link, this.now, eager);
    if (total === null) {
      if (!borrowed.length) return unknownCounts;
      const members = await this.members(link);
      if (!members) return unknownCounts;
      total = members.size;
      borrowed = borrowed.filter(id => members.has(id));
    }
    const positions = await this.delegatedPositions(link.ownerId, borrowed);
    let missingPermissionCount = 0;
    let unavailableCount = 0;
    for (const id of borrowed) {
      const access = positions.get(id)?.access;
      if (access === "missingPermission") missingPermissionCount++;
      else if (access !== "delegated") unavailableCount++;
    }
    return {
      totalCount: total, trackCount: total - missingPermissionCount - unavailableCount,
      missingPermissionCount, unavailableCount,
    };
  }
}

export async function decorateSharedItems(
  tx: Tx, viewerId: string, items: ItemDto[], library: LibraryService,
): Promise<ItemDto[]> {
  if (!items.length) return items;
  const tracks: ReceivedTrack[] = [];
  for (let offset = 0; offset < items.length; offset += queryBatchSize) {
    const ids = items.slice(offset, offset + queryBatchSize).map(item => item.id);
    tracks.push(...await tx.sharedTrack.findMany({
      where: { recipientId: viewerId, recipientItemId: { in: ids } },
      include: includeGrants,
    }));
  }
  if (!tracks.length) return items;
  const lookup = new ShareLookup(tx, library, "cached");
  await lookup.loadOrigins(tracks.map(track => track.originItemId));
  const byId = new Map(tracks.map(track => [track.recipientItemId, track]));
  return Promise.all(items.map(async item => {
    const track = byId.get(item.id);
    if (!track) return item;
    const received = await lookup.receivedOrigin(track);
    if (!received) return { ...item, shared: { sharedBy: track.sharedBy, available: false } };
    const { origin, sharedBy } = received;
    const sources = projectedSources(origin, { kind: "item", id: item.id });
    const preferred = origin.preferredSourceId ? sourceKey(origin.preferredSourceId) : undefined;
    return {
      ...item, sources: [...item.sources, ...sources],
      preferredSourceId: item.preferredSourceId ??
        (item.sources.length === 0 ? sources.find(source => source.id === preferred)?.id : undefined),
      shared: { sharedBy, available: true },
    };
  }));
}

export class ShareService {
  constructor(private db: Db, private library: LibraryService) {}

  private async withViewer<T>(viewerId: string, run: (lookup: ShareLookup) => Promise<T>, proofs: AuthorProof[] = []) {
    return this.db.$transaction(async tx => {
      const lookup = new ShareLookup(tx, this.library, proofs);
      await lookup.viewer(viewerId);
      return run(lookup);
    });
  }

  private async verifyAuthors(
    ownerIds: string[], options: { cached?: boolean; bestEffort?: boolean } = {},
  ): Promise<AuthorProof[]> {
    if (!ownerIds.length || !kanameEnabled()) return [];
    const accounts = await this.db.user.findMany({
      where: { id: { in: [...new Set(ownerIds)] }, suspended: false },
      select: { id: true, ...accountSelect },
    });
    const proofs = await Promise.all(accounts.map(async ({ id, ...account }) => {
      const identity = authorIdentity(id, account);
      if (!identity) return null;
      const probe = authorProbe(this.db, identity);
      try {
        const allowed = options.cached && probe.checkedUntil > Date.now()
          ? probe.allowed : await probeAuthor(probe, identity.subject);
        return allowed ? identity : null;
      } catch (error) {
        if (options.bestEffort && error instanceof HttpError && error.status === 503) return null;
        throw error;
      }
    }));
    return proofs.filter(proof => proof !== null);
  }

  async prefetchForViewer(viewerId: string, itemIds?: string[], fresh = false) {
    if (!kanameEnabled() || itemIds?.length === 0) return;
    const now = new Date(Date.now()).toISOString();
    const wanted = itemIds ? Prisma.sql`AND t.recipientItemId IN (SELECT value FROM json_each(${JSON.stringify(itemIds)}))` : Prisma.empty;
    const authors = await this.db.$queryRaw<{ ownerId: string }[]>`
      SELECT DISTINCT t.originOwnerId AS ownerId
      FROM SharedTrack AS t
      JOIN SharedTrackGrant AS g ON g.recipientItemId = t.recipientItemId
      JOIN ShareLink AS l ON l.id = g.shareLinkId AND l.ownerId = t.originOwnerId
      WHERE t.recipientId = ${viewerId} AND l.revokedAt IS NULL AND (l.expiresAt IS NULL OR l.expiresAt > ${now})
        ${wanted}
    `;
    await this.verifyAuthors(authors.map(author => author.ownerId), { cached: !fresh, bestEffort: true });
  }

  private async upstreamProofs(targets: ShareTarget[], scope?: UpstreamScope) {
    if (!kanameEnabled()) return [];
    const ids = await upstreamAuthorIds(this.db, targets, new Date(Date.now()), scope);
    return this.verifyAuthors(ids, { bestEffort: true });
  }

  private async managedProofs(ownerId: string, id?: string) {
    if (!kanameEnabled()) return [];
    const playlists = await this.db.shareLink.findMany({
      where: { ownerId, id, kind: "playlist" }, distinct: ["targetId"],
      select: { ownerId: true, kind: true, targetId: true },
    });
    return this.upstreamProofs(playlists, { publishedOnly: id === undefined });
  }

  private async authorizeLink(ref: { token: string } | { viewerId: string; id: string }, delegation?: { itemId?: string }) {
    if (!kanameEnabled()) return [];
    const select = { ownerId: true, kind: true, targetId: true, revokedAt: true, expiresAt: true } as const;
    const link = "token" in ref
      ? await this.db.shareLink.findUnique({ where: { token: ref.token }, select })
      : (await this.db.savedSharedPlaylist.findFirst({
          where: { id: ref.id, recipientId: ref.viewerId }, select: { link: { select } },
        }))?.link;
    if (!link || linkStatus(link, new Date(Date.now())) !== "active") return [];
    const proofs = await this.verifyAuthors([link.ownerId]);
    if (proofs.length && delegation) proofs.push(...await this.upstreamProofs([link], { ...delegation, requireReshare: true }));
    return proofs;
  }

  async authorizeCopy(viewerId: string, itemId: string): Promise<AuthorProof | null> {
    if (!kanameEnabled()) return null;
    const now = new Date(Date.now());
    const track = await this.db.sharedTrack.findFirst({
      where: {
        recipientItemId: itemId, recipientId: viewerId, item: { ownerId: viewerId },
        grants: { some: { link: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } } },
      },
      select: { originOwnerId: true },
    });
    if (!track) return null;
    return (await this.verifyAuthors([track.originOwnerId]))[0] ?? null;
  }

  private async authorizeMedia(viewerId: string, ref: SharedMediaRef) {
    if (ref.kind === "link") return this.authorizeLink({ token: ref.token }, { itemId: ref.itemId });
    if (ref.kind === "playlist") return this.authorizeLink({ viewerId, id: ref.id }, { itemId: ref.itemId });
    const proof = await this.authorizeCopy(viewerId, ref.id);
    return proof ? [proof] : [];
  }

  async create(ownerId: string, kind: ShareKind, targetId: string, expiresAt?: string | Date | null, allowReshare = false) {
    return this.withViewer(ownerId, async lookup => {
      const expiry = parseExpiry(expiresAt, lookup.now);
      const target = await lookup.target(kind, ownerId, targetId);
      invariant(target, 404, "share_target_not_found", "Объект не найден");
      const link = await lookup.tx.shareLink.create({ data: {
        id: randomUUID(), ownerId, kind, targetId, title: target.title,
        token: randomBytes(32).toString("base64url"), expiresAt: expiry, allowReshare,
      } });
      return this.linkDto(lookup, link, target, true);
    }, await this.upstreamProofs([{ kind, ownerId, targetId }]));
  }

  async list(ownerId: string) {
    return this.withViewer(ownerId, async lookup => {
      const links = await lookup.tx.shareLink.findMany({
        where: { ownerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return Promise.all(links.map(async link => this.linkDto(
        lookup, link, await lookup.target(link.kind as ShareKind, ownerId, link.targetId),
      )));
    }, await this.managedProofs(ownerId));
  }

  async get(ownerId: string, id: string) {
    return this.withViewer(ownerId, async lookup => {
      const link = await this.managedLink(lookup, ownerId, id);
      return this.linkDto(lookup, link, await lookup.target(link.kind as ShareKind, ownerId, link.targetId), true);
    }, await this.managedProofs(ownerId, id));
  }

  setExpiry(ownerId: string, id: string, expiresAt: string | Date | null) {
    return this.updateLink(ownerId, id, { expiresAt });
  }

  async updateLink(ownerId: string, id: string, settings: { expiresAt?: string | Date | null; allowReshare?: boolean }) {
    return this.withViewer(ownerId, async lookup => {
      const link = await this.managedLink(lookup, ownerId, id);
      const target = await lookup.target(link.kind as ShareKind, ownerId, link.targetId);
      invariant(target && linkStatus(link, lookup.now) === "active",
        409, "share_closed", "Закрытую ссылку нельзя изменить");
      const expiresAt = settings.expiresAt === undefined ? undefined : parseExpiry(settings.expiresAt, lookup.now);
      const updated = await lookup.tx.shareLink.update({ where: { id }, data: { expiresAt, allowReshare: settings.allowReshare } });
      return this.linkDto(lookup, updated, target, true);
    }, await this.managedProofs(ownerId, id));
  }

  async revoke(ownerId: string, id: string) {
    await this.withViewer(ownerId, async lookup => {
      const link = await this.managedLink(lookup, ownerId, id);
      if (linkStatus(link, lookup.now) === "active")
        await lookup.tx.shareLink.update({ where: { id }, data: { revokedAt: lookup.now } });
    });
  }

  private async managedLink(lookup: ShareLookup, ownerId: string, id: string) {
    const link = await lookup.tx.shareLink.findFirst({ where: { id, ownerId } });
    invariant(link, 404, "share_not_found", "Ссылка не найдена");
    return link;
  }

  private async linkDto(lookup: ShareLookup, link: ShareLink, target: LinkTarget | null, eager = false): Promise<ShareLinkDto> {
    const status = linkStatus(link, lookup.now);
    const kind = link.kind as ShareKind;
    const base = process.env.KANAME_SITE_URL ?? process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8790}`;
    return {
      id: link.id, kind, targetId: link.targetId, title: target?.title ?? link.title,
      createdAt: link.createdAt.toISOString(), expiresAt: link.expiresAt?.toISOString() ?? null,
      status: status === "active" && !target ? "unavailable" : status,
      url: status === "active" && target ? new URL(`/share/${link.token}`, base).href : undefined,
      allowReshare: link.allowReshare,
      ...(target ? await lookup.publishedCounts(link, eager) : unknownCounts),
    };
  }

  private async byToken(lookup: ShareLookup, token: string) {
    return requireShared(await lookup.valid(await lookup.tx.shareLink.findUnique({ where: { token } })));
  }

  private async saved(lookup: ShareLookup, viewerId: string, id: string) {
    return requireShared(await lookup.tx.savedSharedPlaylist.findFirst({
      where: { id, recipientId: viewerId }, include: { link: true },
    }));
  }

  async open(viewerId: string, token: string) {
    return this.withViewer(viewerId, async lookup => {
      const valid = await this.byToken(lookup, token);
      const { link } = valid;
      const savedId = link.kind === "playlist"
        ? (await lookup.tx.savedSharedPlaylist.findUnique({
            where: { recipientId_shareLinkId: { recipientId: viewerId, shareLinkId: link.id } },
            select: { id: true },
          }))?.id
        : viewerId === link.ownerId ? link.targetId : (await lookup.tx.sharedTrack.findFirst({
            where: { recipientId: viewerId, originItemId: link.targetId, grants: { some: { shareLinkId: link.id } } },
            select: { recipientItemId: true },
          }))?.recipientItemId;
      return this.view(lookup, valid, itemId => ({ kind: "link", token, itemId }), savedId);
    }, await this.authorizeLink({ token }, {}));
  }

  private async view(
    lookup: ShareLookup, valid: ValidLink, ref: (itemId: string) => SharedMediaRef, savedId?: string,
  ): Promise<SharedViewDto> {
    const { link, target, sharedBy } = valid;
    const kind = link.kind as ShareKind;
    const ids = kind === "item" ? [link.targetId] : [...requireShared(await lookup.members(link))];
    const slots = await lookup.positions(link, ids, sharedBy);
    const sharedAt = link.createdAt.toISOString();
    const items: ItemDto[] = [];
    const positions = slots.map(slot => {
      if (!("origin" in slot)) return null;
      items.push(projectedItem(slot, ref(slot.id), sharedAt));
      return slot.id;
    });
    return { kind, title: target.title, sharedBy, items, positions, totalCount: positions.length, trackCount: items.length, savedId };
  }

  async save(viewerId: string, token: string, itemId?: string): Promise<SaveResult> {
    const access = await ownerAccess(this.db, viewerId);
    return this.withViewer(viewerId, async lookup => {
      const valid = await this.byToken(lookup, token);
      const { link, target, sharedBy } = valid;
      if (link.kind === "playlist" && itemId === undefined) {
        const row = await lookup.tx.savedSharedPlaylist.upsert({
          where: { recipientId_shareLinkId: { recipientId: viewerId, shareLinkId: link.id } },
          create: { id: randomUUID(), recipientId: viewerId, shareLinkId: link.id, title: target.title, sharedBy },
          update: {},
        });
        return { id: row.id, kind: "playlist" };
      }
      return this.saveTrack(lookup, viewerId, valid, itemId ?? link.targetId, access);
    }, await this.authorizeLink({ token }));
  }

  private async saveTrack(
    lookup: ShareLookup, viewerId: string, valid: ValidLink, itemId: string,
    access: Awaited<ReturnType<typeof ownerAccess>>,
  ): Promise<SaveResult> {
    const { link, sharedBy } = valid;
    const origin = requireShared(await lookup.origin(itemId));
    requireShared(await lookup.includes(link, origin));
    if (viewerId === origin.ownerId) return { id: origin.id, kind: "item" };
    const where = { recipientId_originItemId: { recipientId: viewerId, originItemId: origin.id } };
    let track = await lookup.tx.sharedTrack.findUnique({ where });
    if (!track) {
      await checkItems(lookup.tx, viewerId, 1, access);
      track = await lookup.tx.sharedTrack.create({ data: {
        recipientId: viewerId, originItemId: origin.id, originOwnerId: origin.ownerId, sharedBy,
        item: { create: {
          id: randomUUID(), ownerId: viewerId, title: origin.title, originalTitle: origin.title,
          kind: origin.kind, duration: origin.duration,
        } },
      } });
    }
    const grant = { recipientItemId: track.recipientItemId, shareLinkId: link.id };
    await lookup.tx.sharedTrackGrant.upsert({
      where: { recipientItemId_shareLinkId: grant }, create: grant, update: {},
    });
    return { id: track.recipientItemId, kind: "item" };
  }

  async listSaved(viewerId: string): Promise<SavedSharedPlaylistDto[]> {
    const links = kanameEnabled() ? await this.db.savedSharedPlaylist.findMany({
      where: { recipientId: viewerId, link: {
        revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(Date.now()) } }],
      } },
      select: { link: { select: { ownerId: true, kind: true, targetId: true } } },
    }) : [];
    const targets = links.flatMap(row => row.link ? [row.link] : []);
    const upstream = await upstreamAuthorIds(this.db, targets, new Date(Date.now()), { publishedOnly: true });
    const proofs = await this.verifyAuthors([...targets.map(row => row.ownerId), ...upstream], {
      bestEffort: true, cached: upstream.length === 0,
    });
    return this.withViewer(viewerId, async lookup => {
      const rows = await lookup.tx.savedSharedPlaylist.findMany({
        where: { recipientId: viewerId }, include: { link: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return Promise.all(rows.map(async ({ id, title, sharedBy, link }) => {
        const valid = await lookup.valid(link);
        const status = link ? linkStatus(link, lookup.now) : "unavailable";
        const { trackCount, totalCount } = valid ? await lookup.publishedCounts(valid.link) : unknownCounts;
        return {
          id, title: valid?.target.title ?? title, sharedBy: valid?.sharedBy ?? sharedBy,
          status: !valid && status === "active" ? "unavailable" : status,
          trackCount, totalCount,
        };
      }));
    }, proofs);
  }

  async openSaved(viewerId: string, id: string) {
    return this.withViewer(viewerId, async lookup => {
      const { link } = await this.saved(lookup, viewerId, id);
      const valid = requireShared(await lookup.valid(link));
      return this.view(lookup, valid, itemId => ({ kind: "playlist", id, itemId }), id);
    }, await this.authorizeLink({ viewerId, id }, {}));
  }

  async saveFromSaved(viewerId: string, id: string, itemId: string) {
    const access = await ownerAccess(this.db, viewerId);
    return this.withViewer(viewerId, async lookup => {
      const { link } = await this.saved(lookup, viewerId, id);
      return this.saveTrack(lookup, viewerId, requireShared(await lookup.valid(link)), itemId, access);
    }, await this.authorizeLink({ viewerId, id }));
  }

  async removeSaved(viewerId: string, id: string) {
    await this.withViewer(viewerId, async lookup => {
      const deleted = await lookup.tx.savedSharedPlaylist.deleteMany({ where: { id, recipientId: viewerId } });
      requireShared(deleted.count > 0);
    });
  }

  private async received(lookup: ShareLookup, viewerId: string, id: string) {
    const track = requireShared(await lookup.tx.sharedTrack.findFirst({
      where: { recipientItemId: id, recipientId: viewerId, item: { ownerId: viewerId } },
      include: includeGrants,
    }));
    return requireShared(await lookup.receivedOrigin(track)).origin;
  }

  private async mediaOrigin(lookup: ShareLookup, viewerId: string, ref: SharedMediaRef) {
    if (ref.kind === "item") return this.received(lookup, viewerId, ref.id);
    const { link, sharedBy } = ref.kind === "link" ? await this.byToken(lookup, ref.token)
      : requireShared(await lookup.valid((await this.saved(lookup, viewerId, ref.id)).link));
    requireShared(link.kind === "item" ? link.targetId === ref.itemId : (await lookup.members(link))?.has(ref.itemId));
    const [slot] = await lookup.positions(link, [ref.itemId], sharedBy);
    return requireShared("origin" in slot && slot.origin);
  }

  async file(viewerId: string, ref: SharedMediaRef, key: string) {
    return this.withViewer(viewerId, async lookup => {
      const origin = await this.mediaOrigin(lookup, viewerId, ref);
      const source = ownedSources(origin).find(row =>
        row.provider === "local" && row.status !== "unavailable" && sourceKey(row.id) === key);
      const file = requireShared(source?.file);
      return { path: file.path, mime: file.mime, id: file.id, hash: file.hash };
    }, await this.authorizeMedia(viewerId, ref));
  }

  async artworkOrigin(viewerId: string, ref: SharedMediaRef) {
    return this.withViewer(viewerId, async lookup => {
      const origin = await this.mediaOrigin(lookup, viewerId, ref);
      return { ownerId: origin.ownerId, itemId: origin.id };
    }, await this.authorizeMedia(viewerId, ref));
  }

  async copySource(viewerId: string, itemId: string, tx?: Tx, proof?: AuthorProof | null): Promise<CopySource> {
    const select = async (lookup: ShareLookup): Promise<CopySource> => {
      const item = await this.received(lookup, viewerId, itemId);
      const sources = ownedSources(item).filter(source => source.status !== "unavailable");
      sources.sort((a, b) => Number(b.id === item.preferredSourceId) - Number(a.id === item.preferredSourceId));
      for (const source of sources) {
        if (source.provider === "local" && source.file && !source.file.path.startsWith("missing/"))
          return { provider: "local", path: source.file.path, sourceId: source.id };
      }
      for (const source of sources) {
        const externalId = source.provider === "youtube" && youtubeId(source);
        if (externalId) return { provider: "youtube", externalId, sourceId: source.id };
      }
      throw new HttpError(409, "share_copy_unavailable", "Нет доступного источника для копирования");
    };
    const approval = tx ? proof : await this.authorizeCopy(viewerId, itemId);
    const proofs = approval ? [approval] : [];
    if (!tx) return this.withViewer(viewerId, select, proofs);
    const lookup = new ShareLookup(tx, this.library, proofs);
    await lookup.viewer(viewerId);
    return select(lookup);
  }
}
