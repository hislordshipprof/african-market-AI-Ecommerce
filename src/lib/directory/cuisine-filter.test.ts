import { describe, expect, it } from "vitest";
import { cuisineChips, withCuisine } from "./cuisine-filter";

const store = (slug: string, cuisineTags: string[]) => ({ slug, cuisineTags });

const STORES = [
  store("lagos-pantry", ["west-african", "halal-butcher"]),
  store("addis-market", ["ethiopian-eritrean"]),
  store("kingston-corner", ["caribbean", "west-african"]),
  store("no-tags", []),
  store("retired-tag", ["pan-african"]),
];

describe("cuisine filter", () => {
  it("offers a chip only for tags a listed store has, in the fixed list's order, without retired tags", () => {
    expect(cuisineChips(STORES)).toEqual([
      { value: "west-african", label: "West African" },
      { value: "ethiopian-eritrean", label: "Ethiopian and Eritrean" },
      { value: "caribbean", label: "Caribbean" },
      { value: "halal-butcher", label: "Halal butcher" },
    ]);
    expect(cuisineChips([store("plain", [])])).toEqual([]);
  });

  it("keeps the stores with the chosen tag in their order, and every store when no tag is chosen", () => {
    expect(withCuisine(STORES, "west-african").map((s) => s.slug)).toEqual(["lagos-pantry", "kingston-corner"]);
    expect(withCuisine(STORES, "ethiopian-eritrean").map((s) => s.slug)).toEqual(["addis-market"]);
    expect(withCuisine(STORES, null)).toEqual(STORES);
  });
});
