import type { AudioClass, AudioQualityDto, ItemAudioQualityDto, MediaQualityDto, MediaStreamsQualityDto, VideoQualityDto } from "@hibiki/contracts";

/** Bump to re-analyze every stored file in the background. */
export const QUALITY_VERSION = 1;

const LOSSLESS = /^(?:flac|alac|pcm_\w+|wavpack|ape|tta|truehd|mlp|wmalossless|s302m)$/;
const AUDIO_NAMES: Record<string, string> = {
  aac: "AAC", mp3: "MP3", mp2: "MP2", opus: "Opus", vorbis: "Vorbis", flac: "FLAC", alac: "ALAC",
  wavpack: "WavPack", ape: "APE", tta: "TTA", truehd: "TrueHD", mlp: "MLP", ac3: "AC-3", eac3: "E-AC-3",
  dts: "DTS", wmav1: "WMA", wmav2: "WMA", wmapro: "WMA Pro", wmalossless: "WMA Lossless", speex: "Speex",
};
const VIDEO_NAMES: Record<string, string> = {
  h264: "H.264", hevc: "HEVC", vp8: "VP8", vp9: "VP9", av1: "AV1", mpeg4: "MPEG-4", mpeg2video: "MPEG-2",
  prores: "ProRes", theora: "Theora", mjpeg: "MJPEG",
};
const AAC_PROFILES = new Set(["LC", "HE-AAC", "HE-AACv2", "LTP", "Main", "SSR", "LD", "ELD"]);
const LAYOUTS: Record<string, number> = { mono: 1, stereo: 2, quad: 4, hexagonal: 6, octagonal: 8, downmix: 2 };

function audioFormat(codec: string) {
  if (codec.startsWith("pcm_")) return "pcm";
  if (codec.startsWith("adpcm_")) return "adpcm";
  if (codec.startsWith("wma")) return codec === "wmalossless" ? "wmalossless" : "wma";
  if (codec === "eac3") return "ac3";
  return /^[a-z0-9]{1,24}$/.test(codec) ? codec : "other";
}

function audioName(codec: string, profile: string | undefined, ext: string) {
  if (codec === "aac" && profile?.startsWith("HE-AAC")) return profile === "HE-AACv2" ? "HE-AAC v2" : "HE-AAC";
  if (codec.startsWith("pcm_")) return ext === ".wav" ? "WAV" : ext === ".aiff" || ext === ".aif" ? "AIFF" : "PCM";
  if (codec.startsWith("adpcm_")) return "ADPCM";
  return AUDIO_NAMES[codec] ?? codec.toUpperCase();
}

/** "44.1", "48", "88.2", "96", "22.05". */
export function kilohertz(rate: number) {
  return String(Math.round(rate / 10) / 100);
}

function groups(details: string) {
  return [...details.matchAll(/\(([^()]*)\)/g)].map(match => match[1]!.trim());
}

function channelCount(layout: string) {
  const explicit = /^(\d+) channels?$/.exec(layout);
  if (explicit) return Number(explicit[1]);
  const surround = /^(\d+)\.(\d+)/.exec(layout);
  if (surround) return Number(surround[1]) + Number(surround[2]);
  return LAYOUTS[layout];
}

function kbps(text: string) {
  const found = /(\d+(?:\.\d+)?) kb\/s/.exec(text);
  return found ? Math.round(Number(found[1])) : undefined;
}

function parseAudio(codec: string, details: string, ext: string, fallbackBitrate?: number): AudioQualityDto {
  // Fields after the codec: "(profile) (tag / 0x…), 44100 Hz, stereo, fltp, 128 kb/s (default)".
  const [head = "", ...fields] = details.split(",").map(part => part.trim());
  const profile = codec === "aac" ? groups(head).find(group => AAC_PROFILES.has(group)) : undefined;
  const sampleRate = Number(/^(\d+) Hz$/.exec(fields.find(field => / Hz$/.test(field)) ?? "")?.[1]) || undefined;
  const rateIndex = fields.findIndex(field => / Hz$/.test(field));
  const layout = rateIndex >= 0 ? fields[rateIndex + 1]?.replace(/\s*\(.*$/, "") : undefined;
  const channels = layout ? channelCount(layout) : undefined;
  const sampleFormat = rateIndex >= 0 ? fields[rateIndex + 2] ?? "" : "";
  const lossless = LOSSLESS.test(codec);
  let bitDepth: number | undefined;
  let float: true | undefined;
  if (lossless) {
    const declared = /\((\d+) bit\)/.exec(sampleFormat)?.[1];
    const format = /^(u8|s16|s24|s32|s64|flt|dbl)p?\b/.exec(sampleFormat)?.[1];
    bitDepth = Number(declared) || ({ u8: 8, s16: 16, s24: 24, s32: 32, s64: 64, flt: 32, dbl: 64 } as Record<string, number>)[format ?? ""];
    if (format === "flt" || format === "dbl" || /^pcm_f/.test(codec)) float = true;
    if (!bitDepth) bitDepth = Number(/^pcm_[suf](\d+)/.exec(codec)?.[1]) || undefined;
  }
  const bitrate = kbps(fields.slice(rateIndex + 1).join(",")) ?? fallbackBitrate;
  const hires = lossless && ((bitDepth ?? 0) > 16 || (sampleRate ?? 0) > 48_000);
  const qualityClass: AudioClass = hires ? "hires" : lossless ? "lossless" : "lossy";
  const name = audioName(codec, profile, ext);
  const label = lossless
    ? (bitDepth && sampleRate ? `${name} ${bitDepth}/${kilohertz(sampleRate)}` : name)
    : (bitrate ? `${name} ${bitrate}` : name);
  return {
    codec, format: audioFormat(codec), class: qualityClass, name, label,
    ...(profile && { profile }), ...(bitrate && { bitrate }), ...(sampleRate && { sampleRate }),
    ...(bitDepth && { bitDepth }), ...(float && { float }), ...(channels && { channels }), ...(layout && { layout }),
  };
}

function parseVideo(codec: string, details: string): VideoQualityDto {
  const [head = ""] = details.split(",");
  // The last parenthesized group that is neither a codec tag nor a decoder name.
  const profile = groups(head).filter(group => !group.includes("/") && /^[A-Z]/.test(group)).at(-1);
  const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(details);
  const fps = Number(/(\d+(?:\.\d+)?) fps/.exec(details)?.[1]) || undefined;
  const bitrate = kbps(details);
  const name = VIDEO_NAMES[codec] ?? codec.toUpperCase();
  const height = size ? Number(size[2]) : undefined;
  return {
    codec, name, label: height ? `${name} ${height}p` : name,
    ...(profile && { profile }), ...(size && { width: Number(size[1]), height }), ...(fps && { fps }), ...(bitrate && { bitrate }),
  };
}

/** Parse the stream summary that `ffmpeg -i` prints to stderr. */
export function parseMediaQuality(output: string, ext: string): MediaStreamsQualityDto {
  const streams = [...output.matchAll(/^ *Stream #\d+:\d+[^:\r\n]*:\s*(Audio|Video):\s*(\w+)([^\r\n]*)/gm)]
    .map(match => ({ type: match[1]!, codec: match[2]!, details: match[3]! }));
  const video = streams.find(stream => stream.type === "Video" && !stream.details.includes("(attached pic)"));
  const audioTracks = streams.filter(stream => stream.type === "Audio");
  const audio = audioTracks.find(stream => stream.details.includes("(default)")) ?? audioTracks[0];
  const bitrate = kbps(/Duration:[^\r\n]*bitrate: ([^\r\n]+)/.exec(output)?.[1] ?? "");
  return {
    container: ext.replace(/^\./, "").toUpperCase(),
    ...(bitrate && { bitrate }),
    ...(audio && { audio: parseAudio(audio.codec, audio.details, ext, video ? undefined : bitrate) }),
    ...(video && { video: parseVideo(video.codec, video.details) }),
  };
}

const CLASS_RANK: Record<AudioClass, number> = { hires: 3, lossless: 2, lossy: 1 };

/** Columns used by library filters and sorting. A prepared copy is described by its original. */
export function qualityColumns(quality: MediaQualityDto | null | undefined) {
  const audio = (quality?.origin ?? quality)?.audio;
  if (!audio) return { audioClass: null, audioFormat: null, audioScore: null };
  const inner = audio.class === "lossy"
    ? Math.min(audio.bitrate ?? 0, 999_999)
    : Math.min((audio.bitDepth ?? 0) * 1000 + Math.round((audio.sampleRate ?? 0) / 1000), 999_999);
  return { audioClass: audio.class, audioFormat: audio.format, audioScore: CLASS_RANK[audio.class] * 1_000_000 + inner };
}

export function withOrigin(own: MediaStreamsQualityDto, origin?: MediaQualityDto | null): MediaQualityDto {
  if (!origin) return own;
  const { origin: _, ...streams } = origin;
  return { ...own, origin: streams };
}

export function parseStoredQuality(json: string | null | undefined): MediaQualityDto | undefined {
  if (!json) return undefined;
  try { return JSON.parse(json) as MediaQualityDto; } catch { return undefined; }
}

/** Prisma fields for a measured file. */
export function qualityData(quality: MediaQualityDto | null, originFileId: string | null = null) {
  return { quality: quality ? JSON.stringify(quality) : null, ...qualityColumns(quality), qualityVersion: QUALITY_VERSION, originFileId };
}

type QualitySource = { id: string; provider: string; status: string; fileId?: string; shared?: true; streamUrl?: string; quality?: MediaQualityDto };
/**
 * The quality that represents a recording. Mirrors `qualityFileSql`: the sound of an
 * assigned visual, the preferred source, then the first available local file.
 */
export function itemAudioQuality(
  sources: QualitySource[], preferredSourceId?: string | null, soundSourceId?: string | null,
): ItemAudioQualityDto | undefined {
  const local = sources.filter(source => source.provider === "local" && source.status === "available" &&
    (source.shared ? !!source.streamUrl : !!source.fileId));
  const chosen = local.find(source => source.id === soundSourceId) ?? local.find(source => source.id === preferredSourceId) ?? local[0];
  const audio = (chosen?.quality?.origin ?? chosen?.quality)?.audio;
  if (!chosen || !audio) return undefined;
  return { ...audio, sourceId: chosen.id, ...(chosen.quality?.origin && { prepared: true as const }) };
}
