function position(audio: number, duration: number, loop: boolean) {
  return loop ? Math.max(0, audio) % duration : Math.min(duration, Math.max(0, audio));
}

// Signed distance along the shortest path over the loop boundary.
function drift(target: number, video: number, duration: number, loop: boolean) {
  if (!loop) return target - video;
  const delta = target - video % duration;
  return delta - Math.round(delta / duration) * duration;
}

export function clipSeekTime(audio: number, video: number, duration: number, loop = true, tolerance = 0.075) {
  if (!Number.isFinite(audio) || !Number.isFinite(duration) || duration <= 0) return;
  const target = position(audio, duration, loop);
  if (Math.abs(drift(target, video, duration, loop)) > tolerance) return target;
}

export function clipPlaybackRate(audio: number, video: number, duration: number, loop: boolean, rate: number) {
  if (!Number.isFinite(duration) || duration <= 0) return rate;
  const delta = drift(position(audio, duration, loop), video, duration, loop);
  if (Math.abs(delta) < 0.04) return rate;
  // Only the muted image changes speed. A slow initial decode can leave it
  // over a second behind even though the available range now plays smoothly.
  return rate * (1 + Math.max(-0.2, Math.min(0.5, delta)));
}

export function clipBufferAhead(buffer: TimeRanges, time: number) {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer.start(i) <= time + .03 && buffer.end(i) > time) return buffer.end(i) - time;
  }
  return 0;
}

export function clipSyncTarget(audio: number, picture: Pick<HTMLMediaElement, "currentTime" | "duration" | "seeking" | "buffered">,
  loop: boolean, align: boolean, sinceSeekMs: number) {
  const target = clipSeekTime(audio, picture.currentTime, picture.duration, loop, align ? .075 : .45);
  if (align || target === undefined) return target;
  if (picture.seeking || sinceSeekMs < 1200) return;

  // An implicit correction must already have a playable second at its destination.
  // Otherwise the range loader would discard its buffer and start a fresh network seek.
  if (clipBufferAhead(picture.buffered, target) >= 1.1) return target;
}
