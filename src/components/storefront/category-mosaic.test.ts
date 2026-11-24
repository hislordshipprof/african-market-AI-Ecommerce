import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CategoryMosaic } from "./category-mosaic";

const aisle = (slug: string, name: string) => ({ id: `cat_${slug}`, slug, name, localName: null, imageUrl: null });

// #782 AC2: the home mosaic shows the store's stocked aisles, whichever they are.
describe("CategoryMosaic on the home page", () => {
  it("shows stocked aisles outside the old fixed six, up to six tiles", () => {
    const stocked = [
      aisle("oils-and-butters", "Oils & Butters"), aisle("drinks", "Drinks"), aisle("beauty", "Beauty"),
      aisle("fruits", "Fruits"), aisle("household", "Household"), aisle("frozen", "Frozen"), aisle("pantry-staples", "Pantry Staples"),
    ];
    const html = renderToStaticMarkup(createElement(CategoryMosaic, { categories: stocked }));
    const hrefs = [...html.matchAll(/href="(\/categories\/[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(stocked.slice(0, 6).map((c) => `/categories/${c.slug}`));
  });
});
