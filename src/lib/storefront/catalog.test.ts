import { describe, expect, it } from "vitest";
import { catalogFor } from "./catalog";
import catalog from "./catalog-media.json";
describe("product imagery lookup", () => {
  it("uses master names when a listing custom name has no photo mapping", () => {
    expect(catalogFor("Family soup bundle", "Egusi (Melon Seeds)")?.imageUrl).toBeTruthy();
    expect(catalogFor(" White Garri ")?.imageUrl).toBe(catalogFor("garri")?.imageUrl);
    expect(catalogFor("Coconut Oil")?.imageUrl).toBeTruthy();
    expect(catalogFor("Oxtail")?.imageUrl).toBeTruthy();
    expect(catalogFor("Ground Crayfish")?.imageUrl).toBeTruthy();
  });
  it("never substitutes a cooked dish for flour, raw rice or seasoning", () => {
    for (const key of ["semovita", "pounded yam flour", "ofada rice", "suya spice", "puff puff mix", "cow foot"]) {
      const image = catalogFor(key)?.imageUrl;
      expect(image).toBeTruthy();
      expect(image).not.toMatch(/Swallow|Ofada_Rice|Suya_with|Nkwobi|puff-puff-recipe|Pounded_yam/i);
    }
    for (const entry of Object.values(catalog).filter(e => e.imageUrl)) {
      expect(entry.source).toMatch(/^https:\/\/commons.wikimedia.org\//);
      expect(entry.author.length).toBeGreaterThan(0);
      expect(entry.license.length).toBeGreaterThan(0);
    }
    expect(catalogFor("A truly new product")).toBeUndefined();
  });
});
