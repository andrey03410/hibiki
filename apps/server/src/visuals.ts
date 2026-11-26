import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { ItemVisual, Prisma } from "@prisma/client";
import type { ItemDto } from "@hibiki/contracts";
import ffmpeg from "ffmpeg-static";
import type { Db } from "./db";
import { HttpError, invariant } from "./errors";
import { hashFile, inspectFile, localContainerInput, storagePath, type MediaInspection } from "./media";
import { readOnlyMediaFlags } from "./media-playback";
import { buildAudioView, buildVideoView, readAudioRange } from "./mp4-audio";
import { inspectVisualPath, selectVideoStream } from "./visual-media";
import {
  finishHeavyStorage,
  ownerAccess,
  recheckStorage,
  requireHeavy,
  reserve,
  reserveOutput,
  startHeavyStorage,
} from "./kaname";
import { discardReservation, lockStorage, recoverWriters } from "./storage-writer";

type Tx = Prisma.TransactionClient;
type Input = { expectedRevision: number; operationId?: string };
type SetInput = Input & {
  visualSourceId?: string;
  uploadPath?: string;
  videoStreamIndex?: number;
  soundSourceId?: string;
};
type Hooks = {
  signal?: AbortSignal;
  validateAccess?: (tx: Tx) => Promise<void>;
  onPublished?: (tx: Tx, result: Result) => Promise<void>;
};
type Result = { itemId: string; title?: string; revision: number; visual?: ItemDto["visual"] };
const execute = promisify(execFile);

function operation(item: string, input: Input, parts: unknown[]) {
  const request = JSON.stringify([input.expectedRevision, ...parts]);
  const key =
    input.operationId ??
    createHash("sha256")
      .update(item + request)
      .digest("hex");
  return { request, key };
}
async function checkOperation(
  tx: Tx,
  ownerId: string,
  itemId: string,
  expected: number,
  op: ReturnType<typeof operation>,
) {
  const item = await tx.item.findFirst({ where: { id: itemId, ownerId }, select: { visualRevision: true } });
  invariant(item, 404, "item_not_found", "Запись не найдена");
  const saved = await tx.visualOperation.findUnique({ where: { itemId_key: { itemId, key: op.key } } });
  if (saved) {
    invariant(
      saved.request === op.request,
      409,
      "visual_operation_conflict",
      "Идентификатор уже использован для другой операции",
    );
    return JSON.parse(saved.result) as Result;
  }
  invariant(
    item.visualRevision === expected,
    409,
    "visual_revision_conflict",
    "Видеоряд изменился. Текущая ревизия " + item.visualRevision,
  );
}
async function remember(tx: Tx, op: ReturnType<typeof operation>, result: Result) {
  await tx.visualOperation.create({ data: { ...op, itemId: result.itemId, result: JSON.stringify(result) } });
  return result;
}

export async function cleanupPreviousVisual(tx: Tx, ownerId: string, old: ItemVisual | null) {
  if (!old) return;
  const track = await tx.visualTrack.findFirst({
    where: { id: old.visualTrackId, ownerId, assignments: { none: {} } },
  });
  if (track) await tx.visualTrack.delete({ where: { id: track.id } });
  const ids = [track?.fileId, old.soundFileId].filter((id): id is string => !!id);
  const files = await tx.mediaFile.findMany({
    where: {
      id: { in: ids },
      ownerId,
      sources: { none: {} },
      visualTracks: { none: {} },
      visualSounds: { none: {} },
    },
  });
  for (const file of files) {
    await tx.mediaFile.delete({ where: { id: file.id } });
    await tx.kanameStorage.create({
      data: {
        id: randomUUID(),
        ownerId,
        bytes: file.bytes,
        expiresAt: new Date(),
        writer: "abandoned",
        workPaths: JSON.stringify([file.path]),
      },
    });
  }
}
export async function detachForReplacement(tx: Tx, ownerId: string, itemId: string, revision?: number) {
  const old = await tx.itemVisual.findUnique({ where: { itemId } });
  if (!old && revision === undefined) return;
  invariant(
    revision !== undefined,
    409,
    "visual_attached",
    "У записи есть видеоряд. Для снятия и замены укажите clearVisualRevision с текущей ревизией.",
  );
  const item = await tx.item.findFirst({
    where: { id: itemId, ownerId, visualRevision: revision },
    select: { id: true },
  });
  invariant(item, 409, "visual_revision_conflict", "Видеоряд изменился. Откройте запись снова.");
  if (old) {
    await tx.item.update({ where: { id: itemId }, data: { visualRevision: { increment: 1 } } });
    await tx.itemVisual.delete({ where: { itemId } });
    await cleanupPreviousVisual(tx, ownerId, old);
  }
}
export async function clearVisual(db: Db, _root: string, ownerId: string, itemId: string, input: Input) {
  await ownerAccess(db, ownerId);
  const op = operation(itemId, input, ["clear"]);
  const result = await db.$transaction(async (tx) => {
    await lockStorage(tx);
    const replay = await checkOperation(tx, ownerId, itemId, input.expectedRevision, op);
    if (replay) return replay;
    const old = await tx.itemVisual.findUnique({ where: { itemId } });
    const revision = input.expectedRevision + Number(!!old);
    if (old) {
      await tx.itemVisual.delete({ where: { itemId } });
      await tx.item.update({ where: { id: itemId }, data: { visualRevision: revision } });
      await cleanupPreviousVisual(tx, ownerId, old);
    }
    return remember(tx, op, { itemId, revision });
  });
  await recoverWriters(db, ownerId);
  return result;
}

async function soundSource(tx: Tx, ownerId: string, itemId: string, soundId?: string) {
  const item = await tx.item.findFirst({ where: { id: itemId, ownerId }, select: { preferredSourceId: true } });
  invariant(item, 404, "item_not_found", "Запись не найдена");
  const sources = await tx.source.findMany({
    where: {
      ownerId,
      itemId,
      provider: "local",
      status: "available",
      file: { ownerId, NOT: { path: { startsWith: "missing/" } } },
    },
    include: { file: true },
  });
  const candidates = sources.filter((s) => s.file && s.file.hasAudio !== false);
  const sound = soundId
    ? candidates.find((s) => s.id === soundId)
    : (candidates.find((s) => s.id === item.preferredSourceId) ??
      (candidates.length === 1 ? candidates[0] : undefined));
  invariant(
    sound?.file,
    409,
    "visual_sound_required",
    candidates.length
      ? "Выберите soundSourceId: " + candidates.map((s) => s.id).join(", ")
      : "Нужен собственный локальный источник с аудиодорожкой",
  );
  return { id: sound.id, file: sound.file };
}

async function ownedDonor(tx: Tx, ownerId: string, id: string) {
  const source = await tx.source.findFirst({
    where: { id, ownerId, provider: "local", item: { ownerId }, file: { ownerId } },
    select: { file: true },
  });
  invariant(
    source?.file && !source.file.path.startsWith("missing/"),
    404,
    "visual_source_missing",
    "Источник видеоряда не найден",
  );
  return source.file;
}

type StagedFile = { full: string; path: string; info: MediaInspection };
async function publishFile(tx: Tx, root: string, ownerId: string, staged: StagedFile) {
  const info = staged.info;
  const where = { ownerId_hash: { ownerId, hash: info.hash } };
  const known = await tx.mediaFile.findUnique({ where });
  if (
    known &&
    !known.path.startsWith("missing/") &&
    (await lstat(storagePath(root, known.path)).catch(() => null))?.size === info.bytes
  )
    return known;
  const path = staged.path;
  await mkdir(dirname(storagePath(root, path)), { recursive: true });
  await rename(staged.full, storagePath(root, path));
  const properties = {
    path,
    mime: info.mime,
    bytes: info.bytes,
    kind: info.kind,
    duration: info.duration,
    hasAudio: info.hasAudio,
    ...info.playback,
  };
  return tx.mediaFile.upsert({
    where,
    create: { id: randomUUID(), ownerId, hash: info.hash, ...properties },
    update: properties,
  });
}
async function runExtraction(
  path: string,
  args: string[],
  target: string,
  signal?: AbortSignal,
  maxBytes?: number,
) {
  try {
    const command = [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      ...localContainerInput,
      "-i",
      path,
      ...args,
      "-map_metadata",
      "-1",
      "-map_metadata:s",
      "-1",
      "-map_chapters",
      "-1",
      "-y",
      target,
    ];
    if (maxBytes === undefined) await execute(String(ffmpeg), command, { timeout: 600_000, signal });
    else {
      // Python and FFmpeg ship together in the server image. An OS-level file size
      // limit also covers the MP4 trailer, which FFmpeg's -fs option can exceed.
      const wrapper =
        "import os,resource,sys; n=int(sys.argv[1]); resource.setrlimit(resource.RLIMIT_FSIZE,(n,n)); os.execv(sys.argv[2],sys.argv[2:])";
      await execute("python3", ["-c", wrapper, String(maxBytes), String(ffmpeg), ...command], {
        timeout: 600_000,
        signal,
      });
      invariant(
        (await lstat(target)).size < maxBytes,
        413,
        "kaname_storage_quota",
        "Недостаточно места для полной дорожки",
      );
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof HttpError) throw error;
    if (maxBytes !== undefined && (await lstat(target).catch(() => null))?.size === maxBytes)
      throw new HttpError(413, "kaname_storage_quota", "Недостаточно места для полной дорожки");
    throw new HttpError(422, "visual_extract_failed", "Не удалось подготовить выбранную дорожку");
  }
}

export async function setVisual(
  db: Db,
  root: string,
  ownerId: string,
  itemId: string,
  input: SetInput,
  hooks: Hooks = {},
) {
  const { signal } = hooks;
  invariant(
    !!input.visualSourceId !== !!input.uploadPath,
    400,
    "visual_input",
    "Укажите источник или файл видеоряда",
  );
  let access = await ownerAccess(db, ownerId);
  const hash = input.uploadPath && (await hashFile(input.uploadPath, signal));
  const op = operation(itemId, input, [
    "set",
    input.visualSourceId,
    hash,
    input.videoStreamIndex,
    input.soundSourceId,
  ]);
  const replay = await db.$transaction(async (tx) => {
    await hooks.validateAccess?.(tx);
    const saved = await checkOperation(tx, ownerId, itemId, input.expectedRevision, op);
    if (saved) await hooks.onPublished?.(tx, saved);
    return saved;
  });
  if (replay) return replay;
  const sound = await soundSource(db, ownerId, itemId, input.soundSourceId);
  const donor = input.visualSourceId
    ? await ownedDonor(db, ownerId, input.visualSourceId)
    : await db.mediaFile.findFirst({ where: { ownerId, hash: hash!, NOT: { path: { startsWith: "missing/" } } } });
  const disk = donor && storagePath(root, donor.path);
  const source = input.uploadPath ?? disk!;
  const stream = await selectVideoStream(source, input.videoStreamIndex, signal);
  const preparation = { ownerId, fileHash: donor?.hash ?? hash!, streamIndex: stream.index, profile: 1 };
  const known = await db.visualPreparation.findUnique({
    where: { ownerId_fileHash_streamIndex_profile: preparation },
    select: { visualTrack: { select: { signature: true, duration: true } } },
  });
  const hold = randomUUID(),
    work = join(root, "tmp", "visuals", hold);
  let heavy = false;
  async function prepareDirectory() {
    await reserve(db, ownerId, 0, access, hold, work);
    await mkdir(work, { recursive: true });
  }
  async function externalExtraction(path: string, args: string[], full: string, transcode: boolean) {
    if (!transcode) {
      await prepareDirectory();
      const bytes = (await lstat(path)).size;
      const reserved = await reserveOutput(db, ownerId, Math.ceil(bytes * 1.25) + 1024 * 1024, access, hold);
      await runExtraction(path, args, full, signal, reserved);
      const used = (await lstat(full)).size;
      await db.kanameStorage.update({
        where: { id: hold, ownerId },
        data: { bytes: { decrement: BigInt(reserved - used) } },
      });
      return;
    }
    requireHeavy(access);
    heavy = true;
    await startHeavyStorage(db, ownerId, access, hold, work);
    await mkdir(work, { recursive: true });
    await runExtraction(path, args, full, signal);
    await finishHeavyStorage(db, ownerId, hold, work);
  }
  async function stage(full: string) {
    const info = await inspectFile(full, { signal });
    const path = join("media", ownerId, info.hash + info.ext);
    await reserve(db, ownerId, 0, access, hold, storagePath(root, path));
    return { full, path, info };
  }
  try {
    let visual = known
      ? null
      : await inspectVisualPath(source, stream.index, signal).catch((error) => {
          if (error instanceof HttpError && error.code === "visual_prepare_required") return null;
          throw error;
        });
    let video: StagedFile | undefined, audio: StagedFile | undefined;
    let file = donor;
    if (file && !(await lstat(disk!).catch(() => null))?.isFile()) file = null;
    if (!known && !visual) {
      const path = join(work, "picture.mp4");
      const codec = stream.compatible
        ? ["-c:v", "copy"]
        : [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "scale=ceil(iw/2)*2:ceil(ih/2)*2",
          ];
      await externalExtraction(
        source,
        ["-map", "0:" + stream.index, "-an", "-sn", "-dn", ...codec, "-movflags", "+faststart"],
        path,
        !stream.compatible,
      );
      visual = await inspectVisualPath(path, 0, signal);
      file = null;
      video = await stage(path);
    } else if (
      visual &&
      !file &&
      !(await db.visualTrack.findUnique({
        where: { ownerId_signature: { ownerId, signature: visual.signature } },
      }))
    ) {
      await prepareDirectory();
      await reserve(db, ownerId, visual.view.bytes, access, hold);
      const path = join(work, "picture.mp4"),
        handle = await open(source, readOnlyMediaFlags);
      try {
        await pipeline(
          readAudioRange(handle, visual.view, 0, visual.view.bytes - 1),
          createWriteStream(path, { flags: "wx" }),
          { signal },
        );
      } finally {
        await handle.close();
      }
      video = await stage(path);
    }
    const soundPath = storagePath(root, sound.file.path);
    const stat = await lstat(soundPath).catch(() => null);
    invariant(
      stat?.isFile() && BigInt(stat.size) === sound.file.bytes,
      409,
      "visual_sound_missing",
      "Звуковой файл недоступен",
    );
    if (sound.file.kind !== "audio" && !sound.file.audioViewBytes) {
      const media = await inspectFile(soundPath, { signal });
      invariant(media.audioStream, 409, "visual_sound_missing", "Нет звуковой дорожки");
      const extensions: Record<string, string> = {
        aac: ".m4a",
        mp3: ".mp3",
        flac: ".flac",
        opus: ".ogg",
        vorbis: ".ogg",
        pcm_f32le: ".wav",
      };
      const ext = extensions[media.audioCodec!] ?? (media.float32Audio ? ".wav" : ".flac");
      invariant(
        extensions[media.audioCodec!] || media.float32Audio || (media.audioBits ?? 64) <= 32,
        415,
        "unsupported_precision",
        "Невозможно сохранить исходную разрядность звука",
      );
      const codec = extensions[media.audioCodec!] ? "copy" : media.float32Audio ? "pcm_f32le" : "flac";
      const path = join(work, "sound" + ext);
      await externalExtraction(
        soundPath,
        ["-map", media.audioStream, "-vn", "-sn", "-dn", "-c:a", codec],
        path,
        codec !== "copy",
      );
      audio = await stage(path);
    }
    access = await ownerAccess(db, ownerId);
    if (heavy) requireHeavy(access);
    signal?.throwIfAborted();
    const { signature, duration } = visual ?? known!.visualTrack;
    const streamIndex = visual?.streamIndex ?? stream.index;
    return await db.$transaction(
      async (tx) => {
        await lockStorage(tx);
        await hooks.validateAccess?.(tx);
        const replay = await checkOperation(tx, ownerId, itemId, input.expectedRevision, op);
        if (replay) {
          await hooks.onPublished?.(tx, replay);
          return replay;
        }
        const currentSound = await soundSource(tx, ownerId, itemId, input.soundSourceId);
        invariant(
          currentSound.id === sound.id && currentSound.file.id === sound.file.id,
          409,
          "visual_sound_changed",
          "Звуковой источник изменился",
        );
        if (input.visualSourceId)
          invariant(
            (await ownedDonor(tx, ownerId, input.visualSourceId)).id === donor?.id,
            409,
            "visual_source_changed",
            "Источник видеоряда изменился",
          );
        await recheckStorage(tx, ownerId, access);
        let track = await tx.visualTrack.findUnique({ where: { ownerId_signature: { ownerId, signature } } });
        if (!track) {
          invariant(!known, 409, "visual_source_changed", "Подготовленный видеоряд удалён. Повторите назначение");
          const base = file && (await tx.mediaFile.findFirst({ where: { id: file.id, ownerId } }));
          invariant(base || video, 409, "visual_source_changed", "Видеоряд изменился. Повторите назначение");
          const media = base ?? (await publishFile(tx, root, ownerId, video!));
          track = await tx.visualTrack.create({
            data: {
              id: randomUUID(),
              ownerId,
              signature,
              duration,
              fileId: media.id,
              streamIndex: base ? streamIndex : null,
            },
          });
        }
        await tx.visualPreparation.upsert({
          where: { ownerId_fileHash_streamIndex_profile: preparation },
          create: { ...preparation, visualTrackId: track.id },
          update: { visualTrackId: track.id },
        });
        const soundFileId = audio ? (await publishFile(tx, root, ownerId, audio)).id : null;
        const old = await tx.itemVisual.findUnique({ where: { itemId } });
        const pair = { soundSourceId: sound.id, visualTrackId: track.id, soundFileId };
        await tx.itemVisual.upsert({ where: { itemId }, create: { itemId, ...pair }, update: pair });
        const revision = input.expectedRevision + 1;
        const updated = await tx.item.update({ where: { id: itemId }, data: { visualRevision: revision }, select: {title:true} });
        await cleanupPreviousVisual(tx, ownerId, old);
        signal?.throwIfAborted();
        const result = await remember(tx, op, {
          itemId, title:updated.title,
          revision,
          visual: {
            revision,
            soundSourceId: sound.id,
            duration: track.duration,
            streamUrl: "/api/items/" + itemId + "/visual/" + revision,
          },
        });
        await hooks.onPublished?.(tx, result);
        return result;
      },
      { timeout: 120_000 },
    );
  } finally {
    await discardReservation(db, ownerId, hold);
    await recoverWriters(db, ownerId);
  }
}

export async function roleFile(
  tx: Tx,
  ownerId: string,
  itemId: string,
  revision: number,
  role: "sound" | "visual",
) {
  const item = await tx.item.findFirst({
    where: { id: itemId, ownerId, visualRevision: revision },
    select: {
      visual: {
        include: {
          visualTrack: { include: { file: true } },
          soundSource: { include: { file: true } },
          soundFile: true,
        },
      },
    },
  });
  const assignment = item?.visual;
  invariant(
    assignment &&
      assignment.visualTrack.ownerId === ownerId &&
      assignment.soundSource.ownerId === ownerId &&
      assignment.soundSource.itemId === itemId &&
      assignment.soundSource.status === "available" &&
      assignment.soundSource.file?.ownerId === ownerId,
    404,
    "visual_unavailable",
    "Дорожка недоступна",
  );
  invariant(
    role !== "visual" || !assignment.visualTrack.signature.startsWith("pending:"),
    404,
    "visual_unavailable",
    "Видеоряд ожидает файла",
  );
  const file =
    role === "visual" ? assignment.visualTrack.file : (assignment.soundFile ?? assignment.soundSource.file);
  invariant(
    file.ownerId === ownerId && !file.path.startsWith("missing/"),
    404,
    "visual_unavailable",
    "Дорожка недоступна",
  );
  const view = role === "visual" ? (assignment.visualTrack.streamIndex ?? false) : file.kind === "video";
  return { file, view };
}

export interface SharedComposition {
  sound: Awaited<ReturnType<typeof roleFile>>;
  visual: Awaited<ReturnType<typeof roleFile>>;
  signature: string;
  duration: number;
  revision: number;
}

// Copy exactly the two authorized roles. Both files, the recipient's local sound
// source and the assignment become visible together after the final access check.
export async function copyComposition(
  db: Db,
  root: string,
  ownerId: string,
  itemId: string,
  composition: SharedComposition,
  operationId: string,
  signal: AbortSignal,
  prepareValidateAccess: () => Promise<(tx: Tx) => Promise<void>>,
) {
  const access = await ownerAccess(db, ownerId);
  const target = await db.item.findFirstOrThrow({
    where: { id: itemId, ownerId },
    select: { visualRevision: true },
  });
  const hold = randomUUID(),
    work = join(root, "tmp", "visuals", hold);
  const op = operation(itemId, { expectedRevision: 0, operationId }, [
    "copy",
    composition.revision,
    composition.signature,
  ]);
  async function stage(role: "sound" | "visual") {
    const { file, view } = composition[role];
    const handle = await open(storagePath(root, file.path), readOnlyMediaFlags);
    try {
      const size = (await handle.stat()).size;
      const index =
        typeof view === "number"
          ? await buildVideoView(handle, size, view)
          : view
            ? await buildAudioView(handle, size)
            : null;
      invariant(view === false || index, 409, "visual_unavailable", "Дорожка недоступна");
      const ext = index ? (role === "sound" ? ".m4a" : ".mp4") : extname(file.path);
      const full = join(work, role + ext);
      const bytes = index?.bytes ?? size;
      await reserve(db, ownerId, bytes, access, hold, work);
      await mkdir(work, { recursive: true });
      const chunks = index
        ? readAudioRange(handle, index, 0, bytes - 1)
        : handle.createReadStream({ autoClose: false });
      await pipeline(chunks, createWriteStream(full, { flags: "wx" }), { signal });
      const info = await inspectFile(full, { signal });
      invariant(
        info.bytes === bytes &&
          (role === "sound" ? info.kind === "audio" : !info.hasAudio && info.kind === "video"),
        409,
        "visual_source_changed",
        "Состав дорожек изменился",
      );
      const path = join("media", ownerId, info.hash + ext);
      await reserve(db, ownerId, 0, access, hold, storagePath(root, path));
      return { full, info, path };
    } finally {
      await handle.close();
    }
  }
  try {
    const audio = await stage("sound"),
      video = await stage("visual");
    const validate = await prepareValidateAccess();
    const currentAccess = await ownerAccess(db, ownerId);
    return await db.$transaction(
      async (tx) => {
        await lockStorage(tx);
        await validate(tx);
        const replay = await checkOperation(tx, ownerId, itemId, target.visualRevision, op);
        if (replay) return { itemId, reused: true };
        await recheckStorage(tx, ownerId, currentAccess);
        const sound = await publishFile(tx, root, ownerId, audio);
        const existing = await tx.source.findFirst({ where: { ownerId, itemId, fileId: sound.id } });
        const source =
          existing ??
          (await tx.source.create({
            data: {
              id: randomUUID(),
              ownerId,
              itemId,
              provider: "local",
              key: "local:" + sound.hash + ":" + itemId,
              fileId: sound.id,
              status: "available",
            },
          }));
        const where = { ownerId_signature: { ownerId, signature: composition.signature } };
        let track = await tx.visualTrack.findUnique({ where });
        if (!track) {
          const picture = await publishFile(tx, root, ownerId, video);
          track = await tx.visualTrack.create({
            data: {
              id: randomUUID(),
              ownerId,
              signature: composition.signature,
              fileId: picture.id,
              streamIndex: null,
              duration: composition.duration,
            },
          });
        }
        const old = await tx.itemVisual.findUnique({ where: { itemId } });
        const pair = { soundSourceId: source.id, soundFileId: null, visualTrackId: track.id };
        await tx.itemVisual.upsert({ where: { itemId }, create: { itemId, ...pair }, update: pair });
        const revision = target.visualRevision + 1;
        await tx.item.update({
          where: { id: itemId },
          data: { visualRevision: revision, preferredSourceId: source.id, duration: sound.duration },
        });
        await cleanupPreviousVisual(tx, ownerId, old);
        await remember(tx, op, { itemId, revision });
        signal.throwIfAborted();
        return { itemId, reused: !!existing };
      },
      { timeout: 120_000 },
    );
  } finally {
    await discardReservation(db, ownerId, hold);
  }
}
