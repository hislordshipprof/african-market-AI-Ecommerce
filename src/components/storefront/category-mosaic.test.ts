import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CategoryMosaic } from "./category-mosaic";
import { AisleMenuProvider } from "./aisle-menu";

const aisle = (slug: string, name: string) => ({ id: `cat_${slug}`, slug, name, localName: null, imageUrl: null });

// #782 AC2, #862 AC5: home shows the store's stocked aisles as cards, eleven at most, then "All N aisles".
describe("CategoryMosaic on the home page", () => {
  it("shows the first eleven stocked aisles and a card for all of them", () => {
    const stocked = Array.from({ length: 13 }, (_, i) => aisle(`aisle-${i}`, `Aisle ${i}`));
    const html = renderToStaticMarkup(
      createElement(AisleMenuProvider, { aisles: [], children: createElement(CategoryMosaic, { categories: stocked }) }),
    );
    const hrefs = [...html.matchAll(/href="(\/categories\/[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(stocked.slice(0, 11).map((c) => `/categories/${c.slug}`));
    expect(html).toContain("All 13 aisles");
  });
});
