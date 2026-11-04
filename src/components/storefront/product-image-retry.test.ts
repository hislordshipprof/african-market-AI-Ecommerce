import { describe, expect, it } from "vitest";
import { productImageRetrySrc } from "./product-image";

describe("product image retry URL", () => {
  it("retries a cutout that has no query exactly once as ?retry=1", () => {
    expect(productImageRetrySrc("/images/products/a.webp")).toBe("/images/products/a.webp?retry=1");
  });

  it("retries a catalog route photo that has no query exactly once as ?retry=1", () => {
    expect(productImageRetrySrc("/api/catalog-image/catalog/a.jpg")).toBe("/api/catalog-image/catalog/a.jpg?retry=1");
  });

  it("does not build a retry for a local cutout that already has a query", () => {
    expect(productImageRetrySrc("/images/products/a.webp?v=1")).toBeNull();
  });

  it("does not build a retry for a local catalog photo that already has a query", () => {
    expect(productImageRetrySrc("/api/catalog-image/catalog/a.jpg?x=1")).toBeNull();
  });

  it("does not build a retry for a local path outside the two prefixes", () => {
    expect(productImageRetrySrc("/images/market-spices-poster.jpg")).toBeNull();
    expect(productImageRetrySrc("/images/market-bodija.webp")).toBeNull();
    expect(productImageRetrySrc("/favicon.ico")).toBeNull();
  });

  it("retries a remote photo with ?retry=1, or &retry=1 when it already has a query", () => {
    expect(productImageRetrySrc("https://r2.example.com/catalog/a.webp")).toBe(
      "https://r2.example.com/catalog/a.webp?retry=1",
    );
    expect(productImageRetrySrc("https://r2.example.com/catalog/a.webp?v=2")).toBe(
      "https://r2.example.com/catalog/a.webp?v=2&retry=1",
    );
  });

  it("is not called for an empty source", () => {
    expect(productImageRetrySrc("")).toBeNull();
    expect(productImageRetrySrc(undefined)).toBeNull();
  });
});
