import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { presetPrimary, readableFillColor } from "../theme";

export type PwaApp = "storefront" | "store-admin";

type ManifestStore = {
  name: string;
  logoUrl: string | null;
  validBrandColor: string | null;
  validPreset: string;
};

type IconSpec = { size: number; maskable: boolean };

/** The icons a manifest lists, by file name under /pwa-icons/. PNG only: an SVG is never served as an icon (#124). */
export const PWA_ICONS: Record<string, IconSpec> = {
  "icon-192.png": { size: 192, maskable: false },
  "icon-512.png": { size: 512, maskable: false },
  "maskable-512.png": { size: 512, maskable: true },
  "apple-touch-icon.png": { size: 180, maskable: true },
};

const PLATE = "#FFFFFF";
const PUBLIC_DIR = path.join(process.cwd(), "public");
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function themeColor(store: ManifestStore): string {
  return store.validBrandColor ?? presetPrimary(store.validPreset);
}

/** Home-screen labels truncate past about 12 characters: whole words while they fit. */
export function shortName(name: string, max = 12): string {
  if (name.length <= max) return name;
  let out = "";
  for (const word of name.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return out || name.slice(0, max).trim();
}

/** Changes when the logo or colour changes, so an installed app picks up the new icon. */
function iconVersion(store: ManifestStore): string {
  return createHash("sha256").update(`${store.logoUrl}|${themeColor(store)}`).digest("hex").slice(0, 10);
}

export function iconHref(store: ManifestStore, file: keyof typeof PWA_ICONS): string {
  return `/pwa-icons/${file}?v=${iconVersion(store)}`;
}

/** Head tags for an installable page. iOS reads its app name and icon from these, not the manifest. */
export function pwaMetadata(store: ManifestStore, app: PwaApp) {
  const manifest = buildManifest(store, app);
  return {
    manifest: app === "storefront" ? "/manifest.webmanifest" : "/store-admin/manifest.webmanifest",
    appleWebApp: { capable: true, title: manifest.short_name, statusBarStyle: "default" as const },
    icons: { apple: iconHref(store, "apple-touch-icon.png") },
  };
}

export function buildManifest(store: ManifestStore, app: PwaApp) {
  const root = app === "storefront" ? "/" : "/store-admin";
  const icon = (file: string) => ({
    src: iconHref(store, file),
    sizes: `${PWA_ICONS[file].size}x${PWA_ICONS[file].size}`,
    type: "image/png",
    purpose: PWA_ICONS[file].maskable ? "maskable" : "any",
  });
  return {
    id: root,
    name: app === "storefront" ? store.name : `${store.name} Admin`,
    short_name: app === "storefront" ? shortName(store.name) : shortName(`${shortName(store.name, 6)} Admin`),
    start_url: root,
    scope: root,
    display: "standalone",
    background_color: PLATE,
    theme_color: themeColor(store),
    icons: [icon("icon-192.png"), icon("icon-512.png"), icon("maskable-512.png")],
  };
}

/** A local file under public/, or an https host in LOGO_HOSTS. Anything else is no logo. */
async function logoBytes(logoUrl: string | null, env: Record<string, string | undefined>): Promise<Buffer | null> {
  if (!logoUrl) return null;
  try {
    if (logoUrl.startsWith("/") && !logoUrl.startsWith("//")) {
      const file = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(logoUrl.split(/[?#]/)[0])}`);
      if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
      return await readFile(file);
    }
    const url = new URL(logoUrl);
    const hosts = (env.LOGO_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    if (url.protocol !== "https:" || !hosts.includes(url.hostname)) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) return null;
    const body = Buffer.from(await response.arrayBuffer());
    return body.length <= MAX_LOGO_BYTES ? body : null;
  } catch {
    return null;
  }
}

function monogram(store: ManifestStore, size: number): Buffer {
  const fill = themeColor(store);
  const letter = (store.name.trim()[0] ?? "S").toUpperCase().replace(/[^A-Z0-9]/, "S");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="${fill}"/>` +
      `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${Math.round(size * 0.5)}" fill="${readableFillColor(fill)}">${letter}</text></svg>`,
  );
}

/**
 * The store's logo centred on a white plate, as PNG. An SVG logo is rasterised here and never
 * served (#124). A maskable icon keeps the logo inside the 80% safe zone.
 */
export async function renderStoreIcon(
  store: ManifestStore,
  spec: IconSpec,
  env: Record<string, string | undefined> = process.env,
): Promise<Buffer> {
  const { size, maskable } = spec;
  const logo = await logoBytes(store.logoUrl, env);
  if (logo) {
    try {
      const inner = Math.round(size * (maskable ? 0.6 : 0.82));
      const art = await sharp(logo, { limitInputPixels: 4096 * 4096, density: 300 })
        .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      return await sharp({ create: { width: size, height: size, channels: 4, background: PLATE } })
        .composite([{ input: art, gravity: "centre" }])
        .png()
        .toBuffer();
    } catch {
      // Not an image sharp can read: the monogram below.
    }
  }
  return sharp(monogram(store, size)).png().toBuffer();
}
