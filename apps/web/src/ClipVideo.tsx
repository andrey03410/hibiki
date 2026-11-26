import { useEffect, useRef, useState, type RefObject, type MouseEventHandler } from "react";
import { clipSeekTime } from "./clip-clock";

export function ClipVideo({ url, audio, running, onClick }: {
  url: string; audio: RefObject<HTMLMediaElement | null>; running: boolean;
  onClick: MouseEventHandler<HTMLVideoElement>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const picture = video.current, leader = audio.current;
    if (!picture || !leader) return;
    let active = true, blocked = false;
    const failed = () => { blocked = true; if (active) setState("error"); };
    function sync() {
      if (!picture || !leader || blocked || picture.error) return;
      if (document.hidden) { picture.pause(); return; }
      if (picture.readyState >= 1 && !picture.seeking) {
        if (!Number.isFinite(picture.duration) || picture.duration <= 0) { failed(); return; }
        const target = clipSeekTime(leader.currentTime, picture.currentTime, picture.duration);
        if (target !== undefined) picture.currentTime = target;
      }
      picture.playbackRate = leader.playbackRate;
      if (!running || leader.paused || leader.ended || leader.seeking) picture.pause();
      else if (picture.paused && picture.readyState >= 2) void picture.play().catch((e: Error) => {
        if (e.name !== "AbortError") failed();
      });
    }
    const ready = () => { sync(); if (!blocked && !picture.error && picture.readyState >= 2 && !picture.seeking) setState("ready"); };
    const loading = () => { if (!picture.error) setState("loading"); };
    for (const name of ["canplay", "loadeddata", "seeked", "playing"]) picture.addEventListener(name, ready);
    picture.addEventListener("loadedmetadata", sync);
    picture.addEventListener("waiting", loading);
    picture.addEventListener("error", failed);
    for (const name of ["seeking", "seeked", "pause", "playing", "ratechange", "ended"]) leader.addEventListener(name, sync);
    document.addEventListener("visibilitychange", sync);
    const timer = window.setInterval(sync, 90);
    if (picture.error) failed();
    else ready();
    return () => {
      active = false;
      clearInterval(timer);
      for (const name of ["canplay", "loadeddata", "seeked", "playing"]) picture.removeEventListener(name, ready);
      picture.removeEventListener("loadedmetadata", sync);
      picture.removeEventListener("waiting", loading);
      picture.removeEventListener("error", failed);
      for (const name of ["seeking", "seeked", "pause", "playing", "ratechange", "ended"]) leader.removeEventListener(name, sync);
      document.removeEventListener("visibilitychange", sync);
      picture.pause();
    };
  }, [audio, running, url, retry]);
  return <>
    <video key={retry} ref={video} src={url} loop muted playsInline preload="auto" className="composition-clip"
      style={{visibility: state === "ready" ? "visible" : "hidden"}} aria-label="Видеоряд композиции" onClick={onClick} />
    {state !== "ready" && <div className="clip-status" role="status">
      {state === "error" ? <>Видеоряд недоступен <button type="button" className="button subtle compact"
        onClick={() => { setState("loading"); setRetry(value => value + 1); }}>Повторить</button></> : "Загружаем видеоряд…"}
    </div>}
  </>;
}
