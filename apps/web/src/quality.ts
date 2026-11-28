import type { AudioClass, AudioQualityDto, ItemAudioQualityDto, MediaQualityDto, VideoQualityDto } from "@hibiki/contracts";

export const qualityClasses: readonly AudioClass[] = ["hires", "lossless", "lossy"];
export const qualityClassLabels: Record<AudioClass, string> = { hires: "Hi-Res", lossless: "Без потерь", lossy: "С потерями" };
export const qualityClassHints: Record<AudioClass, string> = {
  hires: "Без потерь, больше 16 бит или 48 кГц",
  lossless: "FLAC, ALAC, WAV и другие форматы без потерь",
  lossy: "AAC, MP3, Opus, Vorbis и другие форматы со сжатием с потерями",
};
const formatLabels: Record<string, string> = {
  flac: "FLAC", alac: "ALAC", pcm: "WAV / PCM", wavpack: "WavPack", ape: "APE", tta: "TTA", truehd: "TrueHD", mlp: "MLP",
  wmalossless: "WMA Lossless", aac: "AAC", mp3: "MP3", mp2: "MP2", opus: "Opus", vorbis: "Vorbis", adpcm: "ADPCM",
  wma: "WMA", ac3: "AC-3", dts: "DTS", speex: "Speex", other: "Другие",
};

export function formatLabel(format: string) {
  return formatLabels[format] ?? format.toUpperCase();
}

const number = (value: number, digits = 2) => value.toLocaleString("ru", { maximumFractionDigits: digits });
const layouts: Record<string, string> = { mono: "моно", stereo: "стерео" };

function channelsLabel(audio: Pick<AudioQualityDto, "channels" | "layout">) {
  if (audio.layout && layouts[audio.layout]) return layouts[audio.layout];
  if (audio.layout && /^\d\.\d/.test(audio.layout)) return audio.layout;
  if (audio.channels === 1 || audio.channels === 2) return audio.channels === 1 ? "моно" : "стерео";
  return audio.channels ? `${audio.channels} кан.` : undefined;
}

/** "AAC LC · 128 kb/s · 44,1 кГц · стерео". */
export function audioSummary(audio: AudioQualityDto) {
  const name = audio.profile && !audio.name.includes(audio.profile) ? `${audio.name} ${audio.profile}` : audio.name;
  return [name, audio.bitrate && `${audio.bitrate} kb/s`, audio.sampleRate && `${number(audio.sampleRate / 1000)} кГц`,
    audio.bitDepth && `${audio.bitDepth} бит${audio.float ? " float" : ""}`, channelsLabel(audio)].filter(Boolean).join(" · ");
}

/** "H.264 High · 1920×1080 · 29,97 fps · 2500 kb/s". */
export function videoSummary(video: VideoQualityDto) {
  return [video.profile ? `${video.name} ${video.profile}` : video.name, video.width && video.height && `${video.width}×${video.height}`,
    video.fps && `${number(video.fps)} fps`, video.bitrate && `${video.bitrate} kb/s`].filter(Boolean).join(" · ");
}

export function qualityTitle(quality: ItemAudioQualityDto) {
  return [qualityClassLabels[quality.class], audioSummary(quality), quality.prepared && "оригинал, играет подготовленная копия"]
    .filter(Boolean).join(" · ");
}

export type QualityRow = { label: string; value: string };
/** Rows of the quality block in the item panel. */
export function qualityRows(quality: MediaQualityDto, bytes?: number): QualityRow[] {
  const rows: QualityRow[] = [];
  const audio = quality.audio;
  // A prepared copy keeps the quality of its original, so its own class is not shown.
  if (audio) rows.push(quality.origin ? { label: "Копия", value: audioSummary(audio) }
    : { label: "Звук", value: `${qualityClassLabels[audio.class]} · ${audioSummary(audio)}` });
  if (quality.video) rows.push({ label: "Видео", value: videoSummary(quality.video) });
  rows.push({ label: "Файл", value: [quality.container, quality.bitrate && `${quality.bitrate} kb/s`,
    bytes && `${number(bytes / 1024 / 1024, 1)} МБ`].filter(Boolean).join(" · ") });
  if (quality.origin) {
    const origin = quality.origin.audio;
    rows.push({ label: "Оригинал", value: [quality.origin.container, origin && `${qualityClassLabels[origin.class]} · ${audioSummary(origin)}`]
      .filter(Boolean).join(" · ") });
  }
  return rows;
}

export function qualityFilterLabel(value: string) {
  const [first, format] = value.split(".");
  if ((qualityClasses as readonly string[]).includes(first!))
    return format ? `${qualityClassLabels[first as AudioClass]} · ${formatLabel(format)}` : qualityClassLabels[first as AudioClass];
  return formatLabel(value);
}

export type QualityFacetGroup = {
  value: AudioClass; label: string; count: number;
  formats: { value: string; format: string; label: string; count: number }[];
};
/** Classes with records or a selection, each with its formats by count. */
export function qualityFacetGroups(counts: Record<string, number> | undefined, selected: readonly string[]): QualityFacetGroup[] {
  return qualityClasses.flatMap(value => {
    const formats = new Map<string, number>();
    for (const [key, count] of Object.entries(counts ?? {}))
      if (key.startsWith(value + ".")) formats.set(key.slice(value.length + 1), count);
    for (const key of selected)
      if (key.startsWith(value + ".") && !formats.has(key.slice(value.length + 1))) formats.set(key.slice(value.length + 1), 0);
    const count = counts?.[value] ?? 0;
    if (!count && !formats.size && !selected.includes(value)) return [];
    return [{ value, label: qualityClassLabels[value], count,
      formats: [...formats].sort((a, b) => b[1] - a[1] || formatLabel(a[0]).localeCompare(formatLabel(b[0])))
        .map(([format, n]) => ({ value: `${value}.${format}`, format, label: formatLabel(format), count: n })) }];
  });
}

/**
 * Toggle a class or a `class.format` value. A chosen class covers all its formats;
 * unchecking one of them keeps the remaining formats of that class.
 */
export function toggleQuality(selected: readonly string[], value: string, group: QualityFacetGroup): string[] {
  const next = new Set(selected);
  if (value === group.value) {
    const on = next.has(value);
    for (const format of group.formats) next.delete(format.value);
    if (on) next.delete(value); else next.add(value);
  } else if (next.has(group.value)) {
    next.delete(group.value);
    for (const format of group.formats) if (format.value !== value) next.add(format.value);
  } else if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
    if (group.formats.every(format => next.has(format.value))) {
      for (const format of group.formats) next.delete(format.value);
      next.add(group.value);
    }
  }
  return [...next];
}

export function qualityChecked(selected: readonly string[], value: string) {
  return selected.includes(value) || selected.includes(value.split(".")[0]!);
}
