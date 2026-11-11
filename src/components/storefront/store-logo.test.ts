import { describe, expect, it } from "vitest";
import { isSvgLogo, logoReadableOn } from "./store-logo";

/** RGBA pixels: `count` copies of one colour. */
function pixels(...runs: Array<[count: number, rgba: [number, number, number, number]]>) {
  const out: number[] = [];
  for (const [count, rgba] of runs) for (let i = 0; i < count; i++) out.push(...rgba);
  return new Uint8ClampedArray(out);
}
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];
const TEAL: [number, number, number, number] = [15, 74, 87, 255];
const INK: [number, number, number, number] = [21, 32, 26, 255];

describe("StoreLogo", () => {
  it("detects svg urls case-insensitively, ignoring query and hash", () => {
    expect(isSvgLogo("/logos/a.svg")).toBe(true);
    expect(isSvgLogo("/logos/a.SVG?v=2")).toBe(true);
    expect(isSvgLogo("https://x.test/a.svg#f")).toBe(true);
    expect(isSvgLogo("/logos/a.png")).toBe(false);
  });
});

describe("logoReadableOn", () => {
  it("keeps a logo whose lettering stands out from its own panel or the plate, else falls back", () => {
    const readable = (px: Uint8ClampedArray) => logoReadableOn(px, "#FFFFFF");
    // Transparent logos are measured against the plate.
    expect(readable(pixels([200, CLEAR], [40, INK]))).toBe(true);
    expect(readable(pixels([200, CLEAR], [40, WHITE]))).toBe(false);
    expect(readable(pixels([100, CLEAR]))).toBe(false);
    // Opaque logos bring their own panel: lettering is measured against it (#419).
    for (const panel of [WHITE, TEAL, [245, 239, 224, 255], [238, 238, 238, 255], [255, 213, 79, 255], [220, 235, 250, 255]] as const) {
      expect(readable(pixels([90, [...panel]], [10, panel === TEAL ? WHITE : INK]))).toBe(true);
    }
    expect(readable(pixels([90, WHITE], [10, [230, 236, 232, 255]]))).toBe(false);
  });
});
