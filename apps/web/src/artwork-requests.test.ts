import { expect, it, vi } from "vitest";
import { watchArtwork } from "./artwork-requests";

it("leaves capacity for navigation and media, skips detached covers and admits the next visible image on completion", async () => {
  let intersect!: (entries: {target: Element | EventTarget; isIntersecting: boolean}[]) => void;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: typeof intersect) { intersect = cb; }
    observe() {} unobserve() {}
  });
  class FakeImage extends EventTarget {
    src = "";
    complete = false;
    hasAttribute() { return !!this.src; }
    removeAttribute() { this.src = ""; }
    finish(event: string) { this.complete = true; this.dispatchEvent(new Event(event)); }
  }
  const images = Array.from({length: 5}, () => new FakeImage());
  const clean = images.map((img, i) => watchArtwork(img as unknown as HTMLImageElement, `/image/${i}`));
  try {
    intersect(images.map(target => ({target, isIntersecting: true})));
    expect(images.map(img => img.src)).toEqual(["/image/0", "/image/1", "", "", ""]);
    clean[2]!();
    intersect([{target: images[3]!, isIntersecting: false}]);
    images[1]!.finish("load");
    await Promise.resolve();
    expect(images.map(img => img.src)).toEqual(["/image/0", "/image/1", "", "", "/image/4"]);
    images[4]!.finish("error");
    intersect([{target: images[3]!, isIntersecting: true}]);
    expect(images[3]!.src).toBe("/image/3");
    intersect([{target: images[0]!, isIntersecting: false}]);
    expect(images[0]!.src).toBe("");
    images[0]!.dispatchEvent(new Event("error"));
    intersect([{target: images[0]!, isIntersecting: true}]);
    expect(images[0]!.src).toBe("/image/0");
  } finally { clean.forEach(stop => stop()); vi.unstubAllGlobals(); }
});
