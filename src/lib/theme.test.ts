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

describe("neutral grounds (#528)", () => {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  // A trace of warmth is fine; a visible green, brown or teal cast is not.
  const tint = (hex: string) => {
    const [r, g, b] = channels(hex);
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  const GROUND_KEYS = ["--store-bg", "--store-surface", "--store-raised", "--store-line", "--store-soft"] as const;

  it.each(VALID_PRESETS)("%s grounds carry no more than a trace of tint in light and dark", (preset) => {
    for (const mode of ["light", "dark"] as const) {
      const vars = resolveStoreTheme(preset, null)[mode];
      for (const key of GROUND_KEYS) expect(tint(vars[key]), `${mode} ${key} ${vars[key]}`).toBeLessThanOrEqual(12);
      expect(tint(vars["--store-photo-well"]), `${mode} photo-well`).toBeLessThanOrEqual(12);
    }
    const dark = resolveStoreTheme(preset, null).dark;
    expect(tint(dark["--store-line-strong"])).toBeLessThanOrEqual(12);
  });

  it.each(VALID_PRESETS)("%s light grounds are warm white and dark grounds are charcoal", (preset) => {
    const { light, dark } = resolveStoreTheme(preset, null);
    expect(contrastRatio(light["--store-bg"], "#FFFFFF")).toBeLessThan(1.08);
    expect(contrastRatio(dark["--store-bg"], "#000000")).toBeLessThan(1.25);
  });

  it("keeps the brand colour on primary and the grounds neutral", () => {
    const { light } = resolveStoreTheme("palm-and-shea", "#3BAA5C");
    expect(light["--store-primary"]).not.toBe("#3BAA5C");
    expect(tint(light["--store-bg"])).toBeLessThanOrEqual(12);
  });
});

describe("text on every ground (#528)", () => {
  const LIGHT_GROUNDS = ["--store-bg", "--store-surface", "--store-raised", "--store-soft"] as const;

  it.each(VALID_PRESETS)("%s ink and muted pass AA on every ground", (preset) => {
    for (const mode of ["light", "dark"] as const) {
      const vars = resolveStoreTheme(preset, null)[mode];
      for (const ground of LIGHT_GROUNDS) {
        expect(contrastRatio(vars["--store-ink"], vars[ground]), `${mode} ink on ${ground}`).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(vars["--store-muted"], vars[ground]), `${mode} muted on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(VALID_PRESETS)("%s deal and success read as text on bg and surface", (preset) => {
    for (const mode of ["light", "dark"] as const) {
      const vars = resolveStoreTheme(preset, null)[mode];
      for (const ground of ["--store-bg", "--store-surface"] as const) {
        expect(contrastRatio(vars["--store-deal"], vars[ground]), `${mode} deal`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(vars["--store-success"], vars[ground]), `${mode} success`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(VALID_PRESETS)("%s fills carry readable text", (preset) => {
    for (const mode of ["light", "dark"] as const) {
      const vars = resolveStoreTheme(preset, null)[mode];
      expect(contrastRatio(vars["--store-on-primary"], vars["--store-primary"])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(vars["--store-on-primary-deep"], vars["--store-primary-deep"])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(vars["--store-on-accent"], vars["--store-accent"])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(VALID_PRESETS)("%s dark layers stay apart and line-strong edges controls at 3:1", (preset) => {
    const dark = resolveStoreTheme(preset, null).dark;
    expect(contrastRatio(dark["--store-surface"], dark["--store-bg"])).toBeGreaterThanOrEqual(1.15);
    expect(contrastRatio(dark["--store-raised"], dark["--store-surface"])).toBeGreaterThanOrEqual(1.15);
    expect(contrastRatio(dark["--store-raised"], dark["--store-bg"])).toBeGreaterThanOrEqual(1.4);
    for (const ground of ["--store-bg", "--store-surface", "--store-raised"] as const) {
      expect(contrastRatio(dark["--store-line-strong"], dark[ground])).toBeGreaterThanOrEqual(3);
    }
  });
});
