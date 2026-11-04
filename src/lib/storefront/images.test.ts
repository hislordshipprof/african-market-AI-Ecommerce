import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { catalogKeyFromUrl, listingImage, storefrontPhoto } from "./images";
import catalog from "./catalog-media.json";

afterEach(() => vi.unstubAllEnvs());

describe("storefront image precedence", () => {
  const masterProduct = { name: "Yam", imageUrl: "/api/catalog-image/catalog/yam.jpg" };
  it("uses a listing-owned image before the master image", () => {
    expect(listingImage({ imageUrl: "/images/own-photo.jpg", masterProduct })).toBe("/images/own-photo.jpg");
  });
  it("serves master R2 imagery through the allowlisted route without a public host", () => {
    vi.stubEnv("R2_PUBLIC_URL", "");
    expect(listingImage({ masterProduct })).toBe("/api/catalog-image/catalog/yam.jpg");
    expect(storefrontPhoto("catalog/yam.jpg")).toBe("/api/catalog-image/catalog/yam.jpg");
  });
  it("resolves stored keys, route URLs and old public URLs through the configured host", () => {
    vi.stubEnv("R2_PUBLIC_URL", "https://media.example.com/");
    for (const imageUrl of ["catalog/yam.jpg", "/api/catalog-image/catalog/yam.jpg", "https://old.example.com/catalog/yam.jpg"]) {
      expect(listingImage({ masterProduct: { ...masterProduct, imageUrl } })).toBe("https://media.example.com/catalog/yam.jpg");
    }
  });
  it("uses an accepted cutout only after both owned images are absent", () => {
    expect(listingImage({ masterProduct: { name: "Yam" } })).toBe("/images/products/yam-white-puna.webp");
  });
  it("leaves missing and rejected originals to the designed fallback", () => {
    expect(listingImage({ customName: "Never photographed" })).toBeUndefined();
    expect(listingImage({ customName: "Plantain" })).toBeUndefined();
    expect(storefrontPhoto("https://upload.wikimedia.org/wikipedia/commons/a/a1/old.jpg")).toBeUndefined();
    expect(listingImage({ imageUrl: "/images/product-placeholder.svg" })).toBeUndefined();
  });
  it("every local catalog cutout exists and passed the recorded visual review", () => {
    const report = JSON.parse(readFileSync("scripts/images/processing-report.json", "utf8"));
    for (const entry of Object.values(catalog).filter(item => item.imageUrl.startsWith("/images/products/"))) {
      expect(existsSync("public" + entry.imageUrl)).toBe(true);
      const slug = entry.imageUrl.split("/").pop()!.replace(".webp", "");
      expect(report.results.find((item: { slug: string }) => item.slug === slug)?.visual_review).toBe("accepted");
    }
  });
});

describe("catalog key extraction preserves raw storefront behavior", () => {
  it("leaves whitespace, queries, fragments and retirement rules unchanged", () => {
    expect(storefrontPhoto("   ")).toBe("   ");
    expect(storefrontPhoto(" catalog/yam.jpg")).toBe(" catalog/yam.jpg");
    expect(storefrontPhoto("catalog/logo.svg")).toBeUndefined();
    expect(storefrontPhoto("catalog/logo.SVG")).toBe("catalog/logo.SVG");
    expect(storefrontPhoto("catalog/logo.svg?retry=1")).toBe("catalog/logo.svg?retry=1");
    expect(storefrontPhoto("https://upload.wikimedia.org/wikipedia/commons/a.jpg")).toBeUndefined();
    expect(storefrontPhoto("https://cdn.example/Wikimedia.ORG/a.webp")).toBeUndefined();
    expect(catalogKeyFromUrl("/api/catalog-image/catalog/yam.jpg?retry=1")).toBeUndefined();
    expect(catalogKeyFromUrl("https://old.example.com/catalog/yam.webp?x=1")).toBeUndefined();
    expect(catalogKeyFromUrl("https://old.example.com/catalog/yam.webp#frag")).toBeUndefined();
    expect(catalogKeyFromUrl("catalog/yam%20white.webp")).toBeUndefined();
    expect(catalogKeyFromUrl("https://old.example.com/catalog/yam.webp")).toBe("catalog/yam.webp");
    expect(catalogKeyFromUrl("/api/catalog-image/catalog/yam.jpg")).toBe("catalog/yam.jpg");
    expect(storefrontPhoto("/api/catalog-image/catalog/yam.jpg?retry=1")).toBe("/api/catalog-image/catalog/yam.jpg?retry=1");
    expect(storefrontPhoto("https://old.example.com/catalog/yam.webp?x=1")).toBe("https://old.example.com/catalog/yam.webp?x=1");
  });
});
