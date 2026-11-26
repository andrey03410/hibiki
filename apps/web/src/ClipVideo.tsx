import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type MouseEventHandler } from "react";
import { attachVideoStream, type VideoFile } from "./video-stream";
import { clipBufferAhead, clipPlaybackRate, clipSyncTarget } from "./clip-clock";

export function ClipVideo({ url, audio, running, onClick, file, loop = true, onFailure, holdSound }: {
  url: string; audio: RefObject<HTMLMediaElement | null>; running: boolean;
  file?: VideoFile; loop?: boolean; onFailure?: () => void;
  holdSound?: (element: HTMLMediaElement, hold: boolean) => void;
  onClick: MouseEventHandler<HTMLVideoElement>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const [direct, setDirect] = useState(false);
  const [denied, setDenied] = useState(false);
  const notifyFailure = useRef(onFailure);
  notifyFailure.current = onFailure;
  const gate = useRef(holdSound);
  gate.current = holdSound;
  const wantsPlayback = useRef(running);
  wantsPlayback.current = running;
  const syncNow = useRef<() => void>(undefined);
  const stream = file && !direct && !denied ? file : undefined;
  useLayoutEffect(() => {
    const element = video.current;
    if (!element || denied) return;
    if (!stream) {
      element.src = url;
      // A detached, paused native video can keep its HTTP Range open.
      return () => { element.removeAttribute("src"); element.load(); };
    }
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
  }, [stream, url, denied, retry]);
  useEffect(() => {
    const picture = video.current, leader = audio.current;
    if (!picture || !leader || denied) return;
    let active = true, blocked = false;
    let lastSeek = -Infinity;
    const opened = performance.now();
    let held = false, presented = false, waitingForData = false;
    let heldAt = 0;
    let bufferStartedAt: number | undefined;
    function hold(value: boolean) {
      if (!leader || !gate.current || value === held) return;
      held = value;
      bufferStartedAt = undefined;
      if (held) { heldAt = performance.now(); setState("loading"); }
      gate.current(leader, value);
    }
    function abandon() {
      blocked = true;
      hold(false);
      picture?.pause();
      setState("error");
      notifyFailure.current?.();
    }
    const failed = () => {
      if (!active || blocked) return;
      if (stream) { blocked = true; hold(false); setDirect(true); }
      else abandon();
    };
    // A cold seek can take hundreds of milliseconds. Let the decoder present
    // frames while catching up instead of issuing another seek from 'seeked'.
    function sync(align = false) {
      if (!active || !picture || !leader || blocked || picture.error) return;
      if (document.hidden) { hold(false); picture.pause(); return; }
      const duration = picture.duration;
      const now = performance.now();
      const intended = wantsPlayback.current && !leader.ended &&
        (loop || !Number.isFinite(duration) || leader.currentTime < duration);
      const canShow = picture.readyState >= 3 && !picture.seeking;
      if (held && now - heldAt >= 8000) {
        // The original can still arrive after a slow or stalled HTTP request.
        // Keep it loading, with sound free to play until the decoder progresses.
        waitingForData = true;
        hold(false);
      }
      const offset = leader.currentTime - picture.currentTime;
      // Let a quick handoff keep its sound. Stop both clocks on a real stall.
      if (!intended) hold(false);
      else if (gate.current && !held && !waitingForData && !leader.paused &&
        (leader.seeking || ((presented || now - opened >= 400) && (!canShow || Math.abs(offset) > .35)))) hold(true);
      let buffering = false;
      if (held && canShow && !leader.seeking) {
        if (Math.abs(offset) <= .12) {
          // Native preload keeps reading while paused. Leave enough frames for
          // a sustained restart; the managed range loader pumps while playing.
          const span = Math.min(1.5, Math.max(0, duration - picture.currentTime - .05));
          // Network time before the first aligned frame cannot fill the buffer.
          bufferStartedAt ??= now;
          buffering = !stream && now - bufferStartedAt < 4500 && clipBufferAhead(picture.buffered, picture.currentTime) < span;
          if (!buffering) hold(false);
        } else if (offset < -.12 || offset > .6) align = true;
      }
      const play = intended && !buffering && (held || (!leader.paused && !leader.seeking && leader.readyState >= 3));
      if (picture.readyState >= 1 && Number.isFinite(duration) && duration > 0) {
        const target = clipSyncTarget(leader.currentTime, picture, loop, align, now - lastSeek);
        if (target !== undefined) {
          lastSeek = now;
          bufferStartedAt = undefined;
          picture.currentTime = target;
        }
        const rate = clipPlaybackRate(leader.currentTime, picture.currentTime, duration, loop, leader.playbackRate);
        if (picture.playbackRate !== rate) picture.playbackRate = rate;
      }
      if (!held && !waitingForData && !picture.seeking && picture.readyState >= 2) {
        presented = true;
        setState("ready");
      }
      if (!play) picture.pause();
      else if (picture.paused) void picture.play().catch((e: Error) => {
        if (e.name !== "AbortError") failed();
      });
    }
    const follow = () => sync();
    const align = () => sync(true);
    const ready = () => {
      if (!picture.seeking && picture.readyState >= 3) waitingForData = false;
      follow();
    };
    const userSeek = () => { waitingForData = false; bufferStartedAt = undefined; align(); };
    const pause = () => sync(!held);
    const loading = () => { if (!picture.error) { setState("loading"); follow(); } };
    for (const name of ["canplay", "loadeddata", "seeked", "playing"]) picture.addEventListener(name, ready);
    picture.addEventListener("loadedmetadata", align);
    picture.addEventListener("waiting", loading);
    picture.addEventListener("error", failed);
    leader.addEventListener("pause", pause);
    leader.addEventListener("seeking", userSeek);
    leader.addEventListener("ended", align);
    for (const name of ["seeked", "playing", "ratechange"]) leader.addEventListener(name, follow);
    document.addEventListener("visibilitychange", align);
    const timer = window.setInterval(follow, 200);
    syncNow.current = follow;
    if (picture.error) failed();
    else align();
    return () => {
      active = false;
      hold(false);
      syncNow.current = undefined;
      clearInterval(timer);
      for (const name of ["canplay", "loadeddata", "seeked", "playing"]) picture.removeEventListener(name, ready);
      picture.removeEventListener("loadedmetadata", align);
      picture.removeEventListener("waiting", loading);
      picture.removeEventListener("error", failed);
      leader.removeEventListener("pause", pause);
      leader.removeEventListener("seeking", userSeek);
      leader.removeEventListener("ended", align);
      for (const name of ["seeked", "playing", "ratechange"]) leader.removeEventListener(name, follow);
      document.removeEventListener("visibilitychange", align);
      picture.pause();
    };
  }, [audio, url, retry, stream, loop, denied]);
  useEffect(() => { syncNow.current?.(); }, [running]);
  return <>
    <video key={retry + (stream ? ":stream" : ":native")} ref={video} loop={loop} muted playsInline preload="auto" className="composition-clip"
      style={{visibility: state === "ready" ? "visible" : "hidden"}} aria-label={loop ? "Видеоряд композиции" : "Исходное видео"} onClick={onClick} />
    {state !== "ready" && <div className="clip-status" role="status">
      {state === "error" ? <>Видеоряд недоступен <button type="button" className="button subtle compact"
        onClick={() => { setDenied(false); setDirect(false); setState("loading"); setRetry(value => value + 1); }}>Повторить</button></> : "Загружаем видеоряд…"}
    </div>}
  </>;
}
