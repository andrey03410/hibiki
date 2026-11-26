const near = new WeakMap<Element, (visible: boolean) => void>();
const waiting = new Set<() => void>();
const loading = new Set<HTMLImageElement>();
let observer: IntersectionObserver | undefined;

function admit() {
  for (const start of waiting) {
    if (loading.size >= 2) break;
    waiting.delete(start);
    start();
  }
}

// The catalogue, list and mini-player share the same origin as the media.
// Bound concurrent image requests even when an entire grid enters the viewport.
export function watchArtwork(image: HTMLImageElement, url: string) {
  observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) near.get(entry.target)?.(entry.isIntersecting);
    admit();
  }, { rootMargin: "96px" });
  function start() {
    observer!.unobserve(image);
    near.delete(image);
    loading.add(image);
    image.src = url;
  }
  function release() {
    if (loading.delete(image)) queueMicrotask(admit);
  }
  near.set(image, visible => { if (visible) waiting.add(start); else waiting.delete(start); });
  image.addEventListener("load", release);
  image.addEventListener("error", release);
  observer.observe(image);
  return () => {
    near.delete(image);
    waiting.delete(start);
    observer!.unobserve(image);
    image.removeEventListener("load", release);
    image.removeEventListener("error", release);
    if (loading.has(image) && image.complete === false) image.removeAttribute("src");
    release();
  };
}
