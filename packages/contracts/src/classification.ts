import type { MissingGroup, Performance, TagDto, Voice } from "./index";

export function missingClassification(
  tags: TagDto[],
  performance: Performance = "unknown",
  voices: readonly Voice[] = [],
): MissingGroup[] {
  const groups = new Set(tags.filter((tag) => !tag.archived).map((tag) => tag.group));
  const missing: MissingGroup[] = (["source", "artist", "genre", "mood"] as const).filter(
    (group) => !groups.has(group),
  );
  if (performance === "unknown") missing.push("performance");
  if (performance === "vocal" && !voices.length) missing.push("voice");
  return missing;
}
