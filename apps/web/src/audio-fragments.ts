import { updateSourceBuffer } from "./media-source-buffer";
import type { AudioFile } from "./audio-delivery";

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

// Chromium's progressive demuxer can read over a megabyte before playing long M4A
// tracks. Give MSE small fragments containing exactly the indexed AAC packets.
export async function playAudioFragments(element: HTMLMediaElement, media: MediaSource,
  file: AudioFile, read: (range: string) => Response, signal: AbortSignal) {
  const prefixEnd = Math.min(file.size, file.audioStart! + 32 * 1024);
  const [{ createFile, MP4BoxBuffer }, prefix] = await Promise.all([
    import("mp4box"), read(`bytes=0-${prefixEnd - 1}`).arrayBuffer(),
  ]);
  signal.throwIfAborted();
  const parser = createFile(true);
  const pending: ArrayBuffer[] = [];
  let buffer: SourceBuffer | undefined;
  parser.onReady = movie => {
    const track = movie.audioTracks[0];
    if (movie.isFragmented || movie.tracks.length !== 1 || !track?.codec.startsWith("mp4a.")) throw new Error("Unsupported audio track");
    const mime = `audio/mp4; codecs="${track.codec}"`;
    if (!MediaSource.isTypeSupported(mime)) throw new Error("Unsupported AAC codec");
    buffer = media.addSourceBuffer(mime);
    parser.setSegmentOptions(track.id, null, {nbSamples: 64, rapAlignement: false});
    for (const init of parser.initializeSegmentation("per-track")) pending.push(init.buffer);
    media.duration = movie.duration / movie.timescale;
    parser.start();
  };
  parser.onSegment = (id, _user, data, next) => {
    pending.push(data);
    parser.releaseUsedSamples(id, next);
  };
  parser.appendBuffer(MP4BoxBuffer.fromArrayBuffer(prefix, 0));
  const target = buffer;
  if (!target) throw new Error("Missing audio index");
  const appendPending = async () => {
    for (const data of pending.splice(0)) {
      await updateSourceBuffer(target, signal, () => target.appendBuffer(data));
    }
  };
  await appendPending();
  if (prefixEnd < file.size) {
    const reader = read(`bytes=${prefixEnd}-`).body!.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, {once:true});
    let position = prefixEnd, trimmedBefore = 0;
    try {
      while (position < file.size) {
        signal.throwIfAborted();
        const ranges = target.buffered;
        const end = ranges.length ? ranges.end(ranges.length - 1) : 0;
        if (end > element.currentTime + 90) await waitForPlayhead(element, end - 45, signal);
        const trim = element.currentTime - 15;
        if (trim > trimmedBefore + 30 && ranges.length) {
          await updateSourceBuffer(target, signal, () => target.remove(0, trim));
          trimmedBefore = trim;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Incomplete audio representation");
        parser.appendBuffer(MP4BoxBuffer.fromArrayBuffer(chunk.value.buffer as ArrayBuffer, position));
        position += chunk.value.length;
        await appendPending();
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
      reader.releaseLock();
    }
  }
  signal.throwIfAborted();
  parser.flush();
  await appendPending();
  media.endOfStream();
}
