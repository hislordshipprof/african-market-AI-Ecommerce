import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HeroCarousel } from "./hero-carousel";
import { heroPhotos } from "@/lib/storefront/editorial";

const banner = { id: "b1", title: "A little closer to home.", subtitle: "From your store to your kitchen.", ctaText: "Shop", ctaHref: "/categories", imageUrl: "/images/editorial/market.jpg" };

describe("HeroCarousel swap copy (#727)", () => {
  // A swap prompt that times out accepts the store's proposed swap (substitution.ts resolveInTx),
  // so the hero may promise that we ask, never that nothing is swapped without a reply.
  it("promises we ask before a swap, not that nothing is swapped without the shopper's say", () => {
    const html = renderToStaticMarkup(createElement(HeroCarousel, { banners: [banner] }));
    expect(html).not.toMatch(/without your (say|approval)/i);
    expect(html).toContain("We ask before any swap");
  });
});

describe("HeroCarousel photographs (#836)", () => {
  it("replaces a retired SVG banner with a grocery photograph, framed on its focal point", () => {
    const html = renderToStaticMarkup(createElement(HeroCarousel, { banners: [{ ...banner, imageUrl: "/images/banners/mama-ngozi-yams.svg" }] }));
    expect(html).toContain(encodeURIComponent(heroPhotos.mamaNgoziYams.src));
    expect(html).toContain(`object-position:${heroPhotos.mamaNgoziYams.focus}`);
  });
});
