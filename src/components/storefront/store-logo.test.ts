import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreLogo, isSvgLogo } from "./store-logo";

describe("StoreLogo", () => {
  it("detects svg urls case-insensitively, ignoring query and hash", () => {
    expect(isSvgLogo("/logos/a.svg")).toBe(true);
    expect(isSvgLogo("/logos/a.SVG?v=2")).toBe(true);
    expect(isSvgLogo("https://x.test/a.svg#f")).toBe(true);
    expect(isSvgLogo("/logos/a.png")).toBe(false);
  });
  it("renders SVG with a plain img that bypasses the optimizer", () => {
    const html = renderToStaticMarkup(createElement(StoreLogo, { src: "/logos/a.svg", name: "Mama" }));
    expect(html).toContain('src="/logos/a.svg"');
    expect(html).not.toContain("/_next/image");
  });
  it("routes raster logos through the optimizer", () => {
    const html = renderToStaticMarkup(createElement(StoreLogo, { src: "/logos/a.png", name: "Mama" }));
    expect(html).toContain("/_next/image");
  });
});
