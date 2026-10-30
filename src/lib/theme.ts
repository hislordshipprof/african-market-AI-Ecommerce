export type ThemePreset = "palm-and-shea" | "cocoa-and-bottle-green" | "lagoon-and-coral";

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
}

const presets: Record<ThemePreset, { light: ThemeTokens; dark: ThemeTokens }> = {
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
    },
    dark: {
      bg: "#0F1712",
      surface: "#16211A",
      raised: "#1F2C24",
      ink: "#EEF2EC",
      muted: "#A3B1A7",
      line: "#2A3A30",
      primary: "#6CC08F",
      "primary-deep": "#1D3A2B",
      accent: "#A8DDB5",
      soft: "#1B2E23",
      deal: "#F0707E",
      success: "#6CC08F",
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
    },
    dark: {
      bg: "#151210",
      surface: "#1F1A17",
      raised: "#2A241F",
      ink: "#F1ECE5",
      muted: "#B3A69A",
      line: "#38302A",
      primary: "#5FB08A",
      "primary-deep": "#1E3A2D",
      accent: "#E6C8BF",
      soft: "#2C2520",
      deal: "#EF7B72",
      success: "#5FB08A",
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
    },
    dark: {
      bg: "#0C1619",
      surface: "#122024",
      raised: "#1B2C31",
      ink: "#E7F0F1",
      muted: "#9BB0B4",
      line: "#24383D",
      primary: "#6FC2CF",
      "primary-deep": "#103540",
      accent: "#F07F92",
      soft: "#16303A",
      deal: "#F07F92",
      success: "#6FC79A",
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

function contrastRatio(hex1: string, hex2: string): number {
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

export function nudgeForContrast(brandColor: string, bgColor: string): string {
  const MIN_RATIO = 4.5;
  let color = brandColor;
  const bgLum = luminance(bgColor);

  for (let i = 0; i < 20; i++) {
    if (contrastRatio(color, bgColor) >= MIN_RATIO) break;
    const [h, s, l] = hexToHsl(color);
    if (bgLum > 0.5) {
      color = hslToHex(h, s, Math.max(0, l - 0.03));
    } else {
      color = hslToHex(h, s, Math.min(1, l + 0.03));
    }
  }
  return color;
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

export function getThemeTokens(preset: ThemePreset): ThemeTokens {
  return presets[preset].light;
}

export function resolveStoreTheme(
  preset: ThemePreset,
  brandColor: string | null,
): Record<string, string> {
  const tokens = { ...presets[preset].light };

  if (brandColor) {
    tokens.primary = nudgeForContrast(brandColor, tokens.bg);
    tokens["primary-deep"] = deriveDeep(tokens.primary);
  }

  const onPrimary = readableFillColor(tokens.primary);

  const cssVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    cssVars[`--store-${key}`] = value;
  }
  cssVars["--store-on-primary"] = onPrimary;
  cssVars["--store-on-accent"] = readableFillColor(tokens.accent);

  return cssVars;
}

export const VALID_PRESETS: ThemePreset[] = [
  "palm-and-shea",
  "cocoa-and-bottle-green",
  "lagoon-and-coral",
];
