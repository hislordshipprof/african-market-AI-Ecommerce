import { describe, expect, it } from "vitest";
import { hasLocalMatch } from "next/dist/shared/lib/match-local-pattern";
import { hasRemoteMatch } from "next/dist/shared/lib/match-remote-pattern";
import nextConfig from "../../../next.config";
import { productImageRetrySrc } from "./product-image";

const patterns = nextConfig.images?.localPatterns;

describe("storefront local image patterns", () => {
  it("uses Next's hasLocalMatch", () => {
    expect(typeof hasLocalMatch).toBe("function");
  });

  it("allows a queryless local path and the two retry prefixes, and nothing else", () => {
    const allowed = [
      "/images/products/garri-yellow.webp",
      "/api/catalog-image/catalog/yam.jpg",
      "/favicon.ico",
      "/images/market-bodija.webp",
      "/images/products/garri-yellow.webp?retry=1",
      "/api/catalog-image/catalog/yam.jpg?retry=1",
      "/api/catalog-image/catalog/" + "k".repeat(200) + ".jpg?retry=1",
    ];
    const denied = [
      "/api/catalog-image/catalog/x.jpg?retry=2",
      "/api/catalog-image/catalog/x.jpg?foo=1",
      "/api/catalog-image/catalog/x.jpg?retry=1&x=1",
      "/api/catalog-image/catalog/x.jpg?retry=01",
      "/api/catalog-image/catalog/x.jpg?Retry=1",
      "/api/catalog-image/catalog/x.jpg?retry=1&",
      "/images/products/garri-yellow.webp?v=1",
      "/images/market-spices-poster.jpg?retry=1",
      "/images/market-bodija.webp?retry=1",
      "/favicon.ico?retry=1",
    ];
    for (const path of allowed) expect(hasLocalMatch(patterns, path), path).toBe(true);
    for (const path of denied) expect(hasLocalMatch(patterns, path), path).toBe(false);
  });

  it("accepts every local retry URL ProductImage can build", () => {
    const locals = [
      "/images/products/a.webp",
      "/api/catalog-image/catalog/a.jpg",
      "/api/catalog-image/catalog/" + "k".repeat(200) + ".jpg",
      "/images/products/a.webp?v=1",
      "/images/market-bodija.webp",
    ];
    for (const src of locals) {
      const retry = productImageRetrySrc(src);
      if (retry?.startsWith("/")) expect(hasLocalMatch(patterns, retry), retry).toBe(true);
    }
    expect(productImageRetrySrc("/images/products/a.webp?v=1")).toBeNull();
  });

  it("allows a remote retry with or without an existing query", () => {
    const patterns = nextConfig.images?.remotePatterns ?? [];
    for (const src of [
      "https://images.unsplash.com/photo.jpg",
      "https://images.unsplash.com/photo.jpg?v=2",
    ]) {
      const retry = productImageRetrySrc(src);
      expect(retry).toBe(src.includes("?") ? src + "&retry=1" : src + "?retry=1");
      expect(hasRemoteMatch([], patterns, new URL(retry!))).toBe(true);
    }
  });
});
