export function updateSourceBuffer(buffer: SourceBuffer, signal: AbortSignal, update: () => void) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => {
      buffer.removeEventListener("updateend", complete);
      buffer.removeEventListener("error", fail);
      signal.removeEventListener("abort", fail);
    };
    const complete = () => { finish(); resolve(); };
    const fail = () => { finish(); reject(new Error("Media buffer stopped")); };
    buffer.addEventListener("updateend", complete, { once: true });
    buffer.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", fail, { once: true });
    try { update(); } catch (error) { finish(); reject(error); }
  });
}
