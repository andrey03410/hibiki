// Compare phases on a circle so neighboring frames on opposite sides of a loop never trigger a long seek.
export function clipSeekTime(audioTime: number, videoTime: number, duration: number) {
  if (!Number.isFinite(audioTime) || !Number.isFinite(duration) || duration <= 0) return;
  const target = Math.max(0, audioTime) % duration;
  const distance = Math.abs(target - videoTime % duration);
  if (Math.min(distance, duration - distance) > 0.075) return target;
}
