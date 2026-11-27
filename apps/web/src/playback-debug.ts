// Opt-in timing marks for playback. Enable with
// localStorage.hibikiPlaybackDebug = "1" and read window.hibikiPlayback() in the console.
type Entry = { at: number; name: string; detail?: Record<string, unknown> };
const entries: Entry[] = [];

function enabled() {
  try { return globalThis.localStorage?.getItem("hibikiPlaybackDebug") === "1"; } catch { return false; }
}

export function playbackMark(name: string, detail?: Record<string, unknown>) {
  if (!enabled()) return;
  const at = Math.round(performance.now());
  entries.push({ at, name, detail });
  if (entries.length > 500) entries.splice(0, entries.length - 500);
  console.debug(`[hibiki] ${at} ${name}`, detail ?? "");
}

if (typeof window !== "undefined") {
  (window as unknown as { hibikiPlayback: () => Entry[] }).hibikiPlayback = () => {
    console.table(entries.map(({ at, name, detail }) => ({ at, name, detail: detail && JSON.stringify(detail) })));
    return entries.slice();
  };
}
