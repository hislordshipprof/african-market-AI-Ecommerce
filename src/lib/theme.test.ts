import { describe, expect, it } from "vitest";
import { contrastRatio, resolveStoreTheme, VALID_PRESETS } from "./theme";

const GROUNDS = ["--store-bg", "--store-surface", "--store-raised", "--store-soft"] as const;

function worstTextContrast(vars: Record<string, string>): number {
  return Math.min(...GROUNDS.map((ground) => contrastRatio(vars["--store-primary-text"], vars[ground])));
}

describe("primary text token", () => {
  it.each(VALID_PRESETS)("reads at AA on every %s surface in light and dark", (preset) => {
    const theme = resolveStoreTheme(preset, null);
    expect(worstTextContrast(theme.light)).toBeGreaterThanOrEqual(4.5);
    expect(worstTextContrast(theme.dark)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["#1F5A43", "#3BAA5C", "#0F4A57", "#E04F2F"])("reads at AA for brand colour %s", (brand) => {
    const theme = resolveStoreTheme("palm-and-shea", brand);
    expect(worstTextContrast(theme.light)).toBeGreaterThanOrEqual(4.5);
    expect(worstTextContrast(theme.dark)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps headroom in dark so small links on tinted tiles stay AA", () => {
    // Tinted tiles sit a step lighter than raised; 5.5:1 on raised keeps them above 4.5:1.
    for (const preset of VALID_PRESETS) {
      const dark = resolveStoreTheme(preset, "#1F5A43").dark;
      expect(contrastRatio(dark["--store-primary-text"], dark["--store-raised"])).toBeGreaterThanOrEqual(5.5);
    }
  });

  it("leaves a light primary that already passes as it is", () => {
    const light = resolveStoreTheme("palm-and-shea", null).light;
    expect(light["--store-primary-text"]).toBe(light["--store-primary"]);
  });
});

describe("photo well token", () => {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  it.each(VALID_PRESETS)("is a soft neutral off-white in %s dark, never pure white or store green", (preset) => {
    const dark = resolveStoreTheme(preset, "#1F5A43").dark;
    const well = dark["--store-photo-well"];
    const [r, g, b] = channels(well);
    expect(well.toUpperCase()).not.toBe("#FFFFFF");
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(12);
    // Light enough that brown cut-outs keep their edges against it.
    expect(contrastRatio(well, "#6B4A2B")).toBeGreaterThanOrEqual(5);
    expect(contrastRatio(well, "#FFFFFF")).toBeGreaterThan(1.1);
  });

  it.each(VALID_PRESETS)("carries readable text for the no-photo tile in %s", (preset) => {
    for (const mode of ["light", "dark"] as const) {
      const vars = resolveStoreTheme(preset, null)[mode];
      expect(contrastRatio(vars["--store-on-photo-well"], vars["--store-photo-well"])).toBeGreaterThanOrEqual(7);
    }
  });
});
