import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductImage } from "./product-image";

describe("designed image fallback", () => {
  it("renders a category glyph and initial without claiming a network failure", () => {
    const html = renderToStaticMarkup(createElement(ProductImage, { name: "New flour", category: "grains-and-flours" }));
    expect(html).toContain('data-testid="designed-image-fallback"');
    expect(html).toContain("lucide-wheat");
    expect(html).toContain(">N</span>");
    expect(html).not.toContain("Photo unavailable");
    expect(html).not.toContain("Photo coming soon");
  });
  it("does not request a retired Wikimedia original regardless of case", () => {
    for (const src of ["https://upload.wikimedia.org/old.jpg", "https://upload.Wikimedia.org/old.jpg"]) {
      const html = renderToStaticMarkup(createElement(ProductImage, { name: "Plantain", src }));
      expect(html).toContain('data-testid="designed-image-fallback"');
      expect(html).not.toContain("<img");
      expect(html).not.toContain("Photo unavailable");
    }
  });
  it("treats an empty source as a designed illustration, not a failed photo", () => {
    const html = renderToStaticMarkup(createElement(ProductImage, { name: "Yam", src: "" }));
    expect(html).toContain('data-testid="designed-image-fallback"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Photo unavailable");
  });
  it("renders the photo with its alt text and no fallback when the source loads", () => {
    const html = renderToStaticMarkup(createElement(ProductImage, {
      src: "https://r2.example.com/catalog/egusi.webp", name: "Egusi", category: "grains-and-flours",
    }));
    expect(html).toContain("<img");
    expect(html).toContain('alt="Egusi"');
    expect(html).toContain('data-image-kind="photo"');
    expect(html).not.toContain('data-testid="designed-image-fallback"');
    expect(html).not.toContain("Photo unavailable");
  });
});
