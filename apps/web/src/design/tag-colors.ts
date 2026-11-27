import type { TagDto } from "@hibiki/contracts";

export type ColorGroup = NonNullable<TagDto["group"]> | "performance";

/** Group colours mirror the `--g-*` tokens in design.css. */
export const groupColors: Record<ColorGroup, string> = {
  source: "#b9a4ff",
  artist: "#f4a8c3",
  genre: "#7fd6b9",
  mood: "#f2c66d",
  extra: "#8fb5ff",
  performance: "#cfc8e6",
};

/** Colour every tag gets unless its owner picked another one. */
export const DEFAULT_TAG_COLOR = "#b8a5ff";

const moodColors: Record<string, string> = {
  "спокойная": "#7cc6f2",
  "эпичная": "#ff9a62",
  "радостная": "#ffd36b",
  "быстрая": "#ff6f9b",
  "мрачная": "#9a8cc2",
  "драматичная": "#ef6b7d",
  "лиричная": "#f6add0",
  "загадочная": "#a493ff",
  "меланхоличная": "#7f9fcf",
  "агрессивная": "#e5574a",
  "грустная": "#7f9fcf",
  "романтичная": "#f6add0",
  "напряжённая": "#ef6b7d",
  "напряженная": "#ef6b7d",
};

const moodFallback = ["#7cc6f2", "#ff9a62", "#ffd36b", "#ff6f9b", "#a493ff", "#7fd6b9", "#f6add0", "#8fb5ff"];

function hash(value: string) {
  let h = 0;
  for (const ch of value) h = (h * 31 + ch.codePointAt(0)!) | 0;
  return Math.abs(h);
}

/**
 * Display colour of a tag: an explicit owner colour wins, moods get their own
 * hue by name, every other tag uses its group colour.
 */
export function tagColor(tag: Pick<TagDto, "name" | "color" | "group">): string {
  const own = tag.color?.toLowerCase();
  if (own && /^#[0-9a-f]{6}$/.test(own) && own !== DEFAULT_TAG_COLOR) return own;
  const group = tag.group ?? "extra";
  if (group !== "mood") return groupColors[group];
  const key = tag.name.trim().toLocaleLowerCase("ru");
  return moodColors[key] ?? moodFallback[hash(key) % moodFallback.length]!;
}

/** Deterministic two-stop gradient for covers without artwork. */
export function generativeCover(seed: string): { background: string; monogram: string } {
  const h = hash(seed);
  const a = h % 360, b = (a + 40 + (h >> 8) % 80) % 360;
  const words = seed.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const monogram = (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "♪").slice(0, 2)).toLocaleUpperCase("ru");
  return {
    background: `linear-gradient(135deg, hsl(${a} 55% 46%), hsl(${b} 60% 28%))`,
    monogram,
  };
}
