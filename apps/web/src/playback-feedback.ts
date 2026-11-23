type Phase = "idle" | "waiting" | "playing" | "loading" | "buffering";

// One instance per mounted source. Only phase changes notify React. Engine samples
// and animation frames share a visual clock independent of history and persistence.
export class PlaybackFeedback {
  private phase: Phase = "idle";
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private seconds = 0;
  private sampledAt = 0;
  private rate = 1;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.phase;
  get label() {
    if (this.phase === "loading") return "Загрузка…";
    if (this.phase === "buffering") return "Буферизация…";
    return "";
  }
  private change(phase: Phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.listeners.forEach(listener => listener());
  }
  sample(seconds: number, rate = this.rate) {
    if (!Number.isFinite(seconds)) return;
    this.seconds = Math.max(0, seconds);
    this.sampledAt = performance.now();
    this.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  }
  position() {
    const elapsed = this.phase === "playing" ? (performance.now() - this.sampledAt) * this.rate / 1000 : 0;
    return this.seconds + elapsed;
  }
  play(seconds: number, rate = 1) {
    clearTimeout(this.timer);
    this.started = true;
    this.sample(seconds, rate);
    this.change("playing");
  }
  wait() {
    if (this.phase !== "playing" && this.phase !== "idle") return;
    this.sample(this.position());
    this.change("waiting");
    this.timer = setTimeout(() => this.change(this.started ? "buffering" : "loading"), 300);
  }
  pause() {
    clearTimeout(this.timer);
    this.sample(this.position());
    this.change("idle");
  }
  reset() {
    this.pause();
    this.started = false;
    this.sample(0, 1);
  }
}

export function animatePlayback(draw: () => void, refresh: () => void) {
  let frame: number;
  function tick() {
    draw();
    frame = requestAnimationFrame(tick);
  }
  function visibilityChanged() {
    cancelAnimationFrame(frame);
    if (document.hidden) return;
    refresh();
    tick();
  }
  if (!document.hidden) tick();
  document.addEventListener("visibilitychange", visibilityChanged);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", visibilityChanged);
  };
}
