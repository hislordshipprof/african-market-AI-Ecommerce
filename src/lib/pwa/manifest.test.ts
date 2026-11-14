import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { buildManifest, renderStoreIcon, PWA_ICONS } from "./manifest";

const store = {
  name: "Mama Ngozi African Market",
  logoUrl: "/logos/mama-ngozi-logo.svg",
  validBrandColor: "#1F5A43",
  validPreset: "palm-and-shea" as const,
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("store web app manifest (#563)", () => {
  it("names the app after the store, standalone, with raster icons only", () => {
    const manifest = buildManifest(store, "storefront");
    expect(manifest).toMatchObject({
      name: "Mama Ngozi African Market",
      display: "standalone",
      start_url: "/",
      scope: "/",
      theme_color: "#1F5A43",
    });
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(manifest)).not.toMatch(/platform/i);
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(icon.src).not.toMatch(/\.svg/i);
    }
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });

  it("the store-admin app is scoped to /store-admin", () => {
    const manifest = buildManifest(store, "store-admin");
    expect(manifest).toMatchObject({ id: "/store-admin", start_url: "/store-admin", scope: "/store-admin", display: "standalone" });
    expect(manifest.name).toContain("Mama Ngozi African Market");
  });

  it("renders the store's SVG logo to a PNG of the asked size, never passing SVG through", async () => {
    const png = await renderStoreIcon(store, PWA_ICONS["icon-512.png"]);
    expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    const meta = await sharp(png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 512, 512]);
  });

  it("a logo path outside public/ or a host not in LOGO_HOSTS falls back to a monogram, never reading the file", async () => {
    for (const logoUrl of ["/../.env.local", "/logos/../../.env.local", "https://evil.example/logo.png", "/logos/missing.png"]) {
      const png = await renderStoreIcon({ ...store, logoUrl }, PWA_ICONS["icon-192.png"], {});
      expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    }
  });
});
