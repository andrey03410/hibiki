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
    loading.add(image);
    image.src = url;
  }
  function release() {
    if (loading.delete(image)) queueMicrotask(admit);
  }
  function finish() {
    // A cancelled request can deliver a late event after scrolling back.
    if (image.hasAttribute("src") && image.complete) {
      near.delete(image);
      observer!.unobserve(image);
      release();
    }
  }
  function leave() {
    waiting.delete(start);
    if (!loading.has(image)) return;
    if (image.complete) { finish(); return; }
    image.removeAttribute("src");
    release();
  }
  near.set(image, visible => {
    if (!visible) leave();
    else if (!loading.has(image)) waiting.add(start);
  });
  image.addEventListener("load", finish);
  image.addEventListener("error", finish);
  observer.observe(image);
  return () => {
    near.delete(image);
    observer!.unobserve(image);
    image.removeEventListener("load", finish);
    image.removeEventListener("error", finish);
    leave();
  };
}
