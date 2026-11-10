export type ThemePreset =
  | "palm-and-shea"
  | "cocoa-and-bottle-green"
  | "lagoon-and-coral";

interface ThemeTokens {
  bg: string;
  surface: string;
  raised: string;
  ink: string;
  muted: string;
  line: string;
  primary: string;
  "primary-deep": string;
  accent: string;
  soft: string;
  deal: string;
  success: string;
  /** Neutral ground behind product photos and cut-outs; never the store green. */
  "photo-well": string;
}

/** Dark themes add a strong edge for inputs, chips and outlined buttons (>= 3:1 on bg, surface and raised). */
interface DarkThemeTokens extends ThemeTokens {
  "line-strong": string;
}

const presets: Record<ThemePreset, { light: ThemeTokens; dark: DarkThemeTokens }> = {
  "palm-and-shea": {
    light: {
      bg: "#F3F4EF",
      surface: "#FFFFFF",
      raised: "#E7E9E2",
      ink: "#15201A",
      muted: "#55625A",
      line: "#DCDFD6",
      primary: "#1F5A43",
      "primary-deep": "#123726",
      accent: "#A8DDB5",
      soft: "#E1EEE3",
      deal: "#B42335",
      success: "#2E7D4F",
      "photo-well": "#EBF3EC",
    },
    dark: {
      bg: "#0D1410",
      surface: "#1E2C23",
      raised: "#2B3F33",
      ink: "#EEF2EC",
      muted: "#A3B1A7",
      line: "#35463B",
      "line-strong": "#71907D",
      primary: "#6CC08F",
      "primary-deep": "#1D3A2B",
      accent: "#A8DDB5",
      soft: "#21412E",
      deal: "#F28793",
      success: "#6CC08F",
      "photo-well": "#ECEBE5",
    },
  },
  "cocoa-and-bottle-green": {
    light: {
      bg: "#EFEDE8",
      surface: "#FBFAF7",
      raised: "#E4E1DA",
      ink: "#2A1D17",
      muted: "#6A5C53",
      line: "#DAD5CC",
      primary: "#0E3B2A",
      "primary-deep": "#072419",
      accent: "#E6C8BF",
      soft: "#E9E3DA",
      deal: "#A1302A",
      success: "#2F6B45",
      "photo-well": "#EFEAE3",
    },
    dark: {
      bg: "#120F0D",
      surface: "#2D2621",
      raised: "#403730",
      ink: "#F1ECE5",
      muted: "#B3A69A",
      line: "#48403A",
      "line-strong": "#91847A",
      primary: "#66B791",
      "primary-deep": "#1E3A2D",
      accent: "#E6C8BF",
      soft: "#493526",
      deal: "#F0867D",
      success: "#66B791",
      "photo-well": "#EEEAE3",
    },
  },
  "lagoon-and-coral": {
    light: {
      bg: "#F1F3F2",
      surface: "#FFFFFF",
      raised: "#E4E8E7",
      ink: "#13252A",
      muted: "#51666C",
      line: "#D6DCDB",
      primary: "#0F4A57",
      "primary-deep": "#082F38",
      accent: "#C23B52",
      soft: "#E0ECEC",
      deal: "#C23B52",
      success: "#0F6B3A",
      "photo-well": "#EAF2F2",
    },
    dark: {
      bg: "#0C1314",
      surface: "#1C2C2F",
      raised: "#283E42",
      ink: "#E7F0F1",
      muted: "#9BB0B4",
      line: "#32464A",
      "line-strong": "#6D8F95",
      primary: "#6FC2CF",
      "primary-deep": "#103540",
      accent: "#F07F92",
      soft: "#253E48",
      deal: "#F18799",
      success: "#6FC79A",
      "photo-well": "#EBEBE6",
    },
  },
};

function luminance(hex: string): number {
  const rgb = [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ].map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = luminance(hex1);
  const l2 = luminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, color)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function passesAA(color: string, bgColor: string): boolean {
  return (
    contrastRatio(color, bgColor) >= 4.5 &&
    contrastRatio(color, readableFillColor(color)) >= 4.5
  );
}

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpHex(hex1: string, hex2: string, t: number): string {
  const r = lerpChannel(
    parseInt(hex1.slice(1, 3), 16),
    parseInt(hex2.slice(1, 3), 16),
    t,
  );
  const g = lerpChannel(
    parseInt(hex1.slice(3, 5), 16),
    parseInt(hex2.slice(3, 5), 16),
    t,
  );
  const b = lerpChannel(
    parseInt(hex1.slice(5, 7), 16),
    parseInt(hex2.slice(5, 7), 16),
    t,
  );
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function nudgeForContrast(
  brandColor: string,
  bgColor: string,
): { color: string; nudged: boolean } {
  if (passesAA(brandColor, bgColor)) {
    return { color: brandColor, nudged: false };
  }

  const bgLum = luminance(bgColor);
  const isLightBg = bgLum > 0.5;

  let color = brandColor;
  for (;;) {
    const [h, s, l] = hexToHsl(color);
    const newL = isLightBg ? l - 0.03 : l + 0.03;
    if (newL <= 0 || newL >= 1) break;
    color = hslToHex(h, s, newL);
    if (passesAA(color, bgColor)) return { color, nudged: true };
  }

  const fallback = isLightBg ? "#000000" : "#ffffff";
  for (let step = 1; step <= 100; step++) {
    const c = lerpHex(brandColor, fallback, step / 100);
    if (passesAA(c, bgColor)) return { color: c, nudged: true };
  }

  return { color: fallback, nudged: true };
}

export function readableFillColor(fillColor: string): string {
  const white = "#FFFFFF";
  const black = "#0B0B0B";
  return contrastRatio(fillColor, white) >= contrastRatio(fillColor, black)
    ? white
    : black;
}

export function deriveDeep(primary: string): string {
  const [h, s, l] = hexToHsl(primary);
  return hslToHex(h, s, Math.max(0, l * 0.6));
}

export function getThemeTokens(
  preset: ThemePreset,
  mode: "light" | "dark" = "light",
): ThemeTokens {
  return presets[preset][mode];
}

/**
 * Primary as text (links, eyebrows, chip labels): the fill stays the brand colour, the text
 * moves away from the grounds until it clears `target` on every one of them.
 */
function primaryText(tokens: ThemeTokens, target: number): string {
  const grounds = [tokens.bg, tokens.surface, tokens.raised, tokens.soft];
  const passes = (c: string) => grounds.every((g) => contrastRatio(c, g) >= target);
  if (passes(tokens.primary)) return tokens.primary;
  const dark = luminance(tokens.bg) < 0.5;
  const [h, s, l] = hexToHsl(tokens.primary);
  for (let step = 1; step <= 100; step++) {
    const c = hslToHex(h, s, dark ? Math.min(1, l + step * 0.01) : Math.max(0, l - step * 0.01));
    if (passes(c)) return c;
  }
  return tokens.ink;
}

function buildCssVars(tokens: ThemeTokens): Record<string, string> {
  const cssVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    cssVars[`--store-${key}`] = value;
  }
  const dark = luminance(tokens.bg) < 0.5;
  // Dark tiles and hover tints sit a step lighter than raised, so dark text keeps headroom.
  cssVars["--store-primary-text"] = primaryText(tokens, dark ? 5.5 : 4.5);
  cssVars["--store-on-primary"] = readableFillColor(tokens.primary);
  cssVars["--store-on-primary-deep"] = readableFillColor(tokens["primary-deep"]);
  cssVars["--store-on-accent"] = readableFillColor(tokens.accent);
  // Ink when it holds 7:1 on the well (light themes), else near-black (the light well in dark themes).
  cssVars["--store-on-photo-well"] =
    contrastRatio(tokens.ink, tokens["photo-well"]) >= 7 ? tokens.ink : readableFillColor(tokens["photo-well"]);
  return cssVars;
}

export interface ResolvedTheme {
  light: Record<string, string>;
  dark: Record<string, string>;
}

export function resolveStoreTheme(
  preset: ThemePreset,
  brandColor: string | null,
): ResolvedTheme {
  const lightTokens = { ...presets[preset].light };
  const darkTokens = { ...presets[preset].dark };

  if (brandColor) {
    const { color: nudgedLight } = nudgeForContrast(brandColor, lightTokens.bg);
    lightTokens.primary = nudgedLight;
    lightTokens["primary-deep"] = deriveDeep(lightTokens.primary);

    // Dark primary is also link text on raised cards, the lightest dark layer.
    const { color: nudgedDark } = nudgeForContrast(brandColor, darkTokens.raised);
    darkTokens.primary = nudgedDark;
    darkTokens["primary-deep"] = deriveDeep(darkTokens.primary);
  }

  return {
    light: buildCssVars(lightTokens),
    dark: buildCssVars(darkTokens),
  };
}

/** Light primary for a preset. Unknown presets use Palm and Shea. */
export function presetPrimary(preset: string): string {
  if ((VALID_PRESETS as readonly string[]).includes(preset)) {
    return presets[preset as ThemePreset].light.primary;
  }
  return presets["palm-and-shea"].light.primary;
}

export const VALID_PRESETS: readonly ThemePreset[] = [
  "palm-and-shea",
  "cocoa-and-bottle-green",
  "lagoon-and-coral",
];
