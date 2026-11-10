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
  it("rejects white lettering with no background of its own on a white plate", () => {
    expect(logoReadableOn(pixels([200, CLEAR], [40, WHITE]), "#FFFFFF")).toBe(false);
  });

  it("accepts dark lettering on a transparent background", () => {
    expect(logoReadableOn(pixels([200, CLEAR], [40, INK]), "#FFFFFF")).toBe(true);
  });

  it("accepts a logo that brings its own dark panel behind white lettering", () => {
    expect(logoReadableOn(pixels([180, TEAL], [40, WHITE]), "#FFFFFF")).toBe(true);
  });

  it("accepts an opaque white logo background with a little dark lettering", () => {
    expect(logoReadableOn(pixels([90, WHITE], [10, INK]), "#FFFFFF")).toBe(true);
  });

  it("rejects a fully transparent image", () => {
    expect(logoReadableOn(pixels([100, CLEAR]), "#FFFFFF")).toBe(false);
  });

  it("rejects pale lettering that barely differs from the plate", () => {
    expect(logoReadableOn(pixels([90, WHITE], [10, [230, 236, 232, 255]]), "#FFFFFF")).toBe(false);
  });
});
