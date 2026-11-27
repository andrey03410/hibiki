import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type MouseEventHandler } from "react";
import { clipPlaybackRate, clipSyncTarget } from "./clip-clock";
import { playbackMark } from "./playback-debug";

// Silent picture that follows the leading sound clock. Sound never waits for it:
// until the first frame the cover stays in place, and a seek keeps the last frame.
export function ClipVideo({ url, fallbackUrl, poster, audio, running, onClick, loop = true, onFailure }: {
  url: string; fallbackUrl?: string; poster?: string; audio: RefObject<HTMLMediaElement | null>; running: boolean;
  loop?: boolean; onFailure?: () => void;
  onClick: MouseEventHandler<HTMLVideoElement>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [slow, setSlow] = useState(false);
  const [retry, setRetry] = useState(0);
  const [direct, setDirect] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const notifyFailure = useRef(onFailure);
  notifyFailure.current = onFailure;
  const wantsPlayback = useRef(running);
  wantsPlayback.current = running;
  const syncNow = useRef<() => void>(undefined);
  const relayed = !!fallbackUrl && fallbackUrl !== url && !direct;
  const source = relayed ? url : fallbackUrl ?? url;
  useLayoutEffect(() => {
    const element = video.current;
    if (!element) return;
    // Start the decoder at the sound position instead of reading the file start first.
    const at = audio.current?.currentTime ?? 0;
    const duration = element.duration;
    const start = loop && Number.isFinite(duration) && duration > 0 ? at % duration : at;
    element.src = source + (start > .5 ? `#t=${start.toFixed(2)}` : "");
    playbackMark("video-attach", { relayed, at: start });
    // A detached, paused native video can keep its HTTP Range open.
    return () => { element.removeAttribute("src"); element.load(); };
  }, [source, retry]);
  useEffect(() => {
    const picture = video.current, leader = audio.current;
    if (!picture || !leader) return;
    let active = true, blocked = false, presented = false;
    let lastSeek = -Infinity;
    let missingSince: number | undefined = performance.now();
    function failed() {
      if (!active || blocked) return;
      blocked = true;
      if (relayed) { playbackMark("video-relay-failed"); setDirect(true); return; }
      picture?.pause();
      setState("error");
      notifyFailure.current?.();
    }
    function sync(align = false) {
      if (!active || !picture || !leader || blocked || picture.error) return;
      if (document.hidden) { picture.pause(); return; }
      const duration = picture.duration;
      const now = performance.now();
      const intended = wantsPlayback.current && !leader.ended &&
        (loop || !Number.isFinite(duration) || leader.currentTime < duration);
      if (picture.readyState >= 2 && !picture.seeking) {
        if (!presented) {
          presented = true;
          playbackMark("video-first-frame", { at: picture.currentTime });
          setState("ready");
        }
        missingSince = undefined;
        setSlow(false);
      } else {
        missingSince ??= now;
        if (now - missingSince >= 1500) setSlow(true);
      }
      if (picture.readyState >= 1 && Number.isFinite(duration) && duration > 0) {
        const target = clipSyncTarget(leader.currentTime, picture, loop, align, now - lastSeek);
        if (target !== undefined) {
          lastSeek = now;
          picture.currentTime = target;
        }
        const rate = clipPlaybackRate(leader.currentTime, picture.currentTime, duration, loop, leader.playbackRate);
        if (picture.playbackRate !== rate) picture.playbackRate = rate;
      }
      const play = intended && !leader.paused && !leader.seeking;
      if (!play) picture.pause();
      else if (picture.paused) void picture.play().catch((e: Error) => {
        if (e.name !== "AbortError") failed();
      });
    }
    const follow = () => sync();
    const align = () => sync(true);
    const seeking = () => { playbackMark("video-seek", { to: leader.currentTime }); align(); };
    const pause = () => sync(true);
    for (const name of ["canplay", "loadeddata", "seeked", "playing", "waiting"]) picture.addEventListener(name, follow);
    picture.addEventListener("loadedmetadata", align);
    picture.addEventListener("error", failed);
    leader.addEventListener("pause", pause);
    leader.addEventListener("seeking", seeking);
    leader.addEventListener("ended", align);
    for (const name of ["seeked", "playing", "ratechange"]) leader.addEventListener(name, follow);
    document.addEventListener("visibilitychange", align);
    const timer = window.setInterval(follow, 200);
    syncNow.current = follow;
    if (picture.error) failed();
    else align();
    return () => {
      active = false;
      syncNow.current = undefined;
      clearInterval(timer);
      for (const name of ["canplay", "loadeddata", "seeked", "playing", "waiting"]) picture.removeEventListener(name, follow);
      picture.removeEventListener("loadedmetadata", align);
      picture.removeEventListener("error", failed);
      leader.removeEventListener("pause", pause);
      leader.removeEventListener("seeking", seeking);
      leader.removeEventListener("ended", align);
      for (const name of ["seeked", "playing", "ratechange"]) leader.removeEventListener(name, follow);
      document.removeEventListener("visibilitychange", align);
      picture.pause();
    };
  }, [audio, source, retry, loop]);
  useEffect(() => { syncNow.current?.(); }, [running]);
  const ready = state === "ready";
  return <>
    {poster && !posterFailed && !ready && <img className="clip-poster" src={poster} alt="" onError={() => setPosterFailed(true)} />}
    <video key={retry + source} ref={video} loop={loop} muted playsInline preload="auto"
      className={"composition-clip" + (ready ? " shown" : "")} aria-label={loop ? "Видеоряд композиции" : "Исходное видео"} onClick={onClick} />
    {(state === "error" || slow) && <div className="clip-status" role="status">
      {state === "error" ? <>Видеоряд недоступен <button type="button" className="button subtle compact"
        onClick={() => { setDirect(false); setState("loading"); setSlow(false); setRetry(value => value + 1); }}>Повторить</button></> : "Загружаем видеоряд…"}
    </div>}
  </>;
}
