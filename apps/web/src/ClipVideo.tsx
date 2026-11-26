import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type MouseEventHandler } from "react";
import { attachVideoStream, type VideoFile } from "./video-stream";
import { clipSeekTime } from "./clip-clock";

export function ClipVideo({ url, audio, running, onClick, file, loop = true, onFailure }: {
  url: string; audio: RefObject<HTMLMediaElement | null>; running: boolean;
  file?: VideoFile; loop?: boolean; onFailure?: () => void;
  onClick: MouseEventHandler<HTMLVideoElement>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const [direct, setDirect] = useState(false);
  const [denied, setDenied] = useState(false);
  const notifyFailure = useRef(onFailure);
  notifyFailure.current = onFailure;
  const stream = file && !direct && !denied ? file : undefined;
  useLayoutEffect(() => {
    const element = video.current;
    if (!stream || !element) return;
    try {
      return attachVideoStream(element, stream, forbidden => {
        if (forbidden) {
          element.pause();
          setDenied(true);
          setState("error");
          notifyFailure.current?.();
        } else setDirect(true);
      });
    } catch { setDirect(true); }
  }, [stream, retry]);
  useEffect(() => {
    const picture = video.current, leader = audio.current;
    if (!picture || !leader || denied) return;
    let active = true, blocked = false;
    const failed = () => {
      blocked = true;
      if (!active) return;
      if (stream) setDirect(true);
      else { setState("error"); notifyFailure.current?.(); }
    };
    function sync() {
      if (!picture || !leader || blocked || picture.error) return;
      if (document.hidden) { picture.pause(); return; }
      if (picture.readyState >= 1 && !picture.seeking) {
        if (!Number.isFinite(picture.duration) || picture.duration <= 0) { failed(); return; }
        const target = clipSeekTime(leader.currentTime, picture.currentTime, picture.duration, loop);
        if (target !== undefined) picture.currentTime = target;
      }
      picture.playbackRate = leader.playbackRate;
      if (!running || leader.paused || leader.ended || leader.seeking || (!loop && leader.currentTime >= picture.duration)) picture.pause();
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
  }, [audio, running, url, retry, stream, loop, denied]);
  return <>
    <video key={retry + (stream ? ":stream" : ":native")} ref={video} src={stream || denied ? undefined : url} loop={loop} muted playsInline preload="auto" className="composition-clip"
      style={{visibility: state === "ready" ? "visible" : "hidden"}} aria-label={loop ? "Видеоряд композиции" : "Исходное видео"} onClick={onClick} />
    {state !== "ready" && <div className="clip-status" role="status">
      {state === "error" ? <>Видеоряд недоступен <button type="button" className="button subtle compact"
        onClick={() => { setDenied(false); setDirect(false); setState("loading"); setRetry(value => value + 1); }}>Повторить</button></> : "Загружаем видеоряд…"}
    </div>}
  </>;
}
