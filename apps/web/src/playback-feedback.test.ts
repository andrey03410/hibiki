import { afterEach, expect, it, vi } from "vitest";
import { PlaybackFeedback, animatePlayback } from "./playback-feedback";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("delays initial and repeated buffering feedback from the first wait, and cancels it on pause", () => {
  vi.useFakeTimers();
  const source = new PlaybackFeedback();
  source.wait();
  vi.advanceTimersByTime(299);
  expect(source.label).toBe("");
  source.wait();
  vi.advanceTimersByTime(1);
  expect(source.label).toBe("Загрузка…");
  source.play(0, 1);
  expect(source.label).toBe("");
  source.wait();
  vi.advanceTimersByTime(300);
  expect(source.label).toBe("Буферизация…");
  source.pause();
  expect(source.label).toBe("");
  source.wait();
  vi.advanceTimersByTime(240);
  source.pause();
  vi.advanceTimersByTime(1000);
  expect(source.label).toBe("");
});

it("extrapolates iframe samples at the current rate, freezes when waiting, and rebases after seeking", () => {
  vi.useFakeTimers();
  const source = new PlaybackFeedback();
  source.play(10, 1.5);
  vi.advanceTimersByTime(200);
  expect(source.position()).toBeCloseTo(10.3);
  source.sample(10.1, 2);
  vi.advanceTimersByTime(200);
  expect(source.position()).toBeCloseTo(10.5);
  source.wait();
  vi.advanceTimersByTime(3000);
  expect(source.position()).toBeCloseTo(10.5);
  source.sample(2, 1);
  expect(source.position()).toBe(2);
  source.play(2, 1);
  vi.advanceTimersByTime(200);
  source.pause();
  vi.advanceTimersByTime(3000);
  expect(source.position()).toBeCloseTo(2.2);
});

it("cancels the drawn frame on tab hide and unmount, refreshing the engine clock immediately on return", () => {
  vi.useFakeTimers();
  const page = Object.assign(new EventTarget(), {hidden: false});
  vi.stubGlobal("document", page);
  const frames = new Set<FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {frames.add(fn); return fn;});
  vi.stubGlobal("cancelAnimationFrame", (fn: FrameRequestCallback) => frames.delete(fn));
  let frame = 0, sampled = 0;
  const dispose = animatePlayback(() => {frame++;}, () => {sampled++;});
  expect(frames.size).toBe(1);
  page.hidden = true;
  page.dispatchEvent(new Event("visibilitychange"));
  expect(frames.size).toBe(0);
  const previous = frame;
  page.hidden = false;
  page.dispatchEvent(new Event("visibilitychange"));
  expect(sampled).toBeGreaterThan(0);
  expect(frame).toBe(previous + 1);
  expect(frames.size).toBe(1);
  dispose();
  expect(frames.size).toBe(0);
  page.dispatchEvent(new Event("visibilitychange"));
  expect(frames.size).toBe(0);
});
