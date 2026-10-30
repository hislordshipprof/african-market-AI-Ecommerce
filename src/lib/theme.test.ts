import { describe, it, expect } from "vitest";
import { nudgeForContrast, readableFillColor } from "./theme";

function luminance(hex: string): number {
  const rgb = [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ].map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = luminance(hex1);
  const l2 = luminance(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const LIGHT_BACKGROUNDS = ["#F3F4EF", "#FFFFFF", "#EFEDE8", "#F1F3F2"];
const DARK_BACKGROUNDS = ["#0F1712", "#0C1619", "#151210"];

const PROBLEM_COLORS = [
  "#ffffee",
  "#ffff00",
  "#eeeeee",
  "#f0f0f0",
  "#ffffcc",
  "#cccc00",
  "#999999",
  "#888888",
  "#aabb00",
  "#ffcc00",
  "#ff9999",
  "#99ff99",
  "#00ffff",
];

const NORMAL_COLORS = [
  "#1F5A43",
  "#0F4A57",
  "#0E3B2A",
  "#B42335",
  "#2E7D4F",
  "#333333",
  "#000080",
];

describe("nudgeForContrast", () => {
  describe("always reaches WCAG AA (4.5:1) against background", () => {
    for (const bg of LIGHT_BACKGROUNDS) {
      for (const brand of [...PROBLEM_COLORS, ...NORMAL_COLORS]) {
        it(`${brand} on light bg ${bg}`, () => {
          const { color } = nudgeForContrast(brand, bg);
          const ratio = contrastRatio(color, bg);
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    for (const bg of DARK_BACKGROUNDS) {
      for (const brand of [...PROBLEM_COLORS, ...NORMAL_COLORS]) {
        it(`${brand} on dark bg ${bg}`, () => {
          const { color } = nudgeForContrast(brand, bg);
          const ratio = contrastRatio(color, bg);
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });

  describe("always reaches 4.5:1 against its own text color", () => {
    for (const bg of LIGHT_BACKGROUNDS) {
      for (const brand of [...PROBLEM_COLORS, ...NORMAL_COLORS]) {
        it(`text on ${brand} (light bg ${bg})`, () => {
          const { color } = nudgeForContrast(brand, bg);
          const textColor = readableFillColor(color);
          const ratio = contrastRatio(color, textColor);
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    for (const bg of DARK_BACKGROUNDS) {
      for (const brand of [...PROBLEM_COLORS, ...NORMAL_COLORS]) {
        it(`text on ${brand} (dark bg ${bg})`, () => {
          const { color } = nudgeForContrast(brand, bg);
          const textColor = readableFillColor(color);
          const ratio = contrastRatio(color, textColor);
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });

  it("does not nudge a color that already passes", () => {
    const { color, nudged } = nudgeForContrast("#1F5A43", "#F3F4EF");
    expect(nudged).toBe(false);
    expect(color).toBe("#1F5A43");
  });

  it("nudges #ffffee on #F3F4EF past the old 20-iteration cap", () => {
    const { color, nudged } = nudgeForContrast("#ffffee", "#F3F4EF");
    expect(nudged).toBe(true);
    const ratio = contrastRatio(color, "#F3F4EF");
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
