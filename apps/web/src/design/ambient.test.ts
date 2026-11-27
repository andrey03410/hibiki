import { describe, expect, it } from "vitest";
import { averageColor } from "./ambient";

const pixels = (...rgba: number[][]) => rgba.flat();

describe("averageColor", () => {
  it("returns nothing for transparent images", () => {
    expect(averageColor(pixels([0, 0, 0, 0]))).toBeUndefined();
  });
  it("leans to saturated pixels and keeps the hue", () => {
    const color = averageColor(pixels([200, 30, 30, 255], [20, 20, 20, 255], [20, 20, 20, 255]));
    expect(color).toMatch(/^hsl\((\d+) /);
    const hue = Number(color!.match(/^hsl\((\d+)/)![1]);
    expect(hue === 0 || hue > 340).toBe(true);
  });
  it("keeps greys grey but readable", () => {
    expect(averageColor(pixels([10, 10, 10, 255]))).toBe("hsl(0 0% 52%)");
  });
});
