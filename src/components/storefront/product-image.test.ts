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
});
