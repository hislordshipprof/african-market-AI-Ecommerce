import { describe, expect, it } from "vitest";
import { isSvgLogo } from "./store-logo";

describe("StoreLogo", () => {
  it("detects svg urls case-insensitively, ignoring query and hash", () => {
    expect(isSvgLogo("/logos/a.svg")).toBe(true);
    expect(isSvgLogo("/logos/a.SVG?v=2")).toBe(true);
    expect(isSvgLogo("https://x.test/a.svg#f")).toBe(true);
    expect(isSvgLogo("/logos/a.png")).toBe(false);
  });
});
