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
