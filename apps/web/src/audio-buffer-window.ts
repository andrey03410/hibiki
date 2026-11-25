import type { AudioFile } from "./audio-delivery";
import { updateSourceBuffer } from "./media-source-buffer";

// The original continues filling in AudioDelivery while the decoder retains only the
// next minute or so of packets. A seek beyond the decoder's window returns to Range.
function waitForPlayhead(element: HTMLMediaElement, time: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const clear = () => {
      element.removeEventListener("timeupdate", check);
      signal.removeEventListener("abort", abort);
    };
    const check = () => { if (element.currentTime >= time) { clear(); resolve(); } };
    const abort = () => { clear(); reject(signal.reason); };
    element.addEventListener("timeupdate", check);
    signal.addEventListener("abort", abort, {once:true});
    check();
  });
}

export function audioBufferWindow(element: HTMLMediaElement, buffer: SourceBuffer, file: AudioFile, signal: AbortSignal) {
  // Dense lossless audio needs a shorter time window to stay below the native quota.
  const seconds = file.duration && Number.isFinite(file.duration) && file.duration > 0
    ? Math.min(90, 4 * 1024 ** 2 * file.duration / file.size) : 90;
  let trimmedBefore = 0;
  return async () => {
    signal.throwIfAborted();
    const ranges = buffer.buffered;
    const end = ranges.length ? ranges.end(ranges.length - 1) : 0;
    if (end > element.currentTime + seconds) await waitForPlayhead(element, end - seconds / 2, signal);
    const trim = element.currentTime - seconds / 6;
    if (trim > trimmedBefore + seconds / 3 && ranges.length) {
      await updateSourceBuffer(buffer, signal, () => buffer.remove(0, trim));
      trimmedBefore = trim;
    }
  };
}
