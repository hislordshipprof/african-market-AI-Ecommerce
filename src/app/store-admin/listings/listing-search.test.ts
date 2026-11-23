import { describe, expect, it } from "vitest";
import { searchListings } from "./listing-search";

const listing = (customName: string | null, masterProductName: string | null, active = true) => ({
  customName,
  masterProductName,
  active,
});

describe("listing search", () => {
  const listings = [
    listing("Yellow Garri (Ijebu)", null),
    listing(null, "White Garri"),
    listing("Palm Oil", null),
    listing("Garri (Seasonal)", null, false),
    listing("Shea Butter", null, false),
  ];

  it("an empty or blank query keeps every listing, split by active", () => {
    const result = searchListings(listings, "  ");
    expect(result.active).toHaveLength(3);
    expect(result.inactive).toHaveLength(2);
  });

  it("matches the shown name case-insensitively, catalog name included, in both lists", () => {
    const result = searchListings(listings, " garri ");
    expect(result.active.map((l) => l.customName ?? l.masterProductName)).toEqual([
      "Yellow Garri (Ijebu)",
      "White Garri",
    ]);
    expect(result.inactive.map((l) => l.customName)).toEqual(["Garri (Seasonal)"]);
  });

  it("a query nothing matches leaves both lists empty", () => {
    const result = searchListings(listings, "yam");
    expect(result.active).toEqual([]);
    expect(result.inactive).toEqual([]);
  });
});
