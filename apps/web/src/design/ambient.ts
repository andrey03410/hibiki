import { useEffect, useState } from "react";

/**
 * Ambient colour of the current track: the average colour of a small copy of
 * its artwork, softened so text stays readable. Results are cached per URL.
 */
const cache = new Map<string, Promise<string | undefined>>();

export const NEUTRAL_AMBIENT = "#8d74e8";

/** Average RGBA pixels (alpha-weighted) and lift the result into a pleasant accent. */
export function averageColor(data: ArrayLike<number>): string | undefined {
  let r = 0, g = 0, b = 0, weight = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    const max = Math.max(data[i]!, data[i + 1]!, data[i + 2]!), min = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
    // Saturated pixels describe the artwork better than greys and black bars.
    const w = a * (0.15 + (max - min) / 255);
    r += data[i]! * w; g += data[i + 1]! * w; b += data[i + 2]! * w; weight += w;
  }
  if (!weight) return;
  return liftColor(r / weight, g / weight, b / weight);
}

function liftColor(r: number, g: number, b: number) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  let h = 0;
  const l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const sat = Math.min(0.72, Math.max(s, s < 0.08 ? s : 0.38));
  const light = Math.min(0.68, Math.max(0.52, l));
  return `hsl(${Math.round(h)} ${Math.round(sat * 100)}% ${Math.round(light * 100)}%)`;
}

export function ambientColor(url: string | undefined): Promise<string | undefined> {
  if (!url || typeof document === "undefined") return Promise.resolve(undefined);
  let pending = cache.get(url);
  if (!pending) {
    pending = new Promise(resolve => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 16;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return resolve(undefined);
          context.drawImage(image, 0, 0, 16, 16);
          resolve(averageColor(context.getImageData(0, 0, 16, 16).data));
        } catch {
          resolve(undefined);
        }
      };
      image.onerror = () => resolve(undefined);
      image.src = url;
    });
    cache.set(url, pending);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return pending;
}

/** Smoothly retints the whole interface (see `--amb` in design.css). */
export function applyAmbient(color: string | undefined) {
  document.documentElement.style.setProperty("--amb", color ?? NEUTRAL_AMBIENT);
}

/** Tint of a cover for local accents (playlist hero); undefined until known. */
export function useCoverTint(url: string | undefined) {
  const [tint, setTint] = useState<string>();
  useEffect(() => {
    let live = true;
    void ambientColor(url).then(color => { if (live) setTint(color); });
    return () => { live = false; };
  }, [url]);
  return tint;
}
