import { expect, it, vi } from "vitest";
import { watchArtwork } from "./artwork-requests";

it("leaves capacity for navigation and media, skips detached covers and admits the next visible image on completion", async () => {
  let intersect!: (entries: {target: HTMLImageElement; isIntersecting: boolean}[]) => void;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: typeof intersect) { intersect = cb; }
    observe() {} unobserve() {}
  });
  const images = Array.from({length: 5}, () => Object.assign(new EventTarget(), {src: ""}) as HTMLImageElement);
  const clean = images.map((img, i) => watchArtwork(img, `/image/${i}`));
  try {
    intersect(images.map(target => ({target, isIntersecting: true})));
    expect(images.map(img => img.src)).toEqual(["/image/0", "/image/1", "", "", ""]);
    clean[2]!();
    intersect([{target: images[3]!, isIntersecting: false}]);
    images[1]!.dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(images.map(img => img.src)).toEqual(["/image/0", "/image/1", "", "", "/image/4"]);
    images[4]!.dispatchEvent(new Event("error"));
    intersect([{target: images[3]!, isIntersecting: true}]);
    expect(images[3]!.src).toBe("/image/3");
  } finally { clean.forEach(stop => stop()); vi.unstubAllGlobals(); }
});
