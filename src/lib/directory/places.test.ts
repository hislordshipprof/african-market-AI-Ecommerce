import { describe, expect, it } from "vitest";
import { cityPage, placeSlug, statePage, statePages } from "./places";

const store = (slug: string, city: string | null, state: string | null) => ({ slug, name: slug, city, state });

const STORES = [
  store("a", "Houston", "TX"),
  store("b", "houston ", "TX"),
  store("c", "Dallas", "TX"),
  store("d", "Silver Spring", "MD"),
  store("e", null, "TX"),
  store("f", "Nowhere", "ZZ"),
];

describe("placeSlug", () => {
  it("lowercases, drops accents and joins words with hyphens", () => {
    expect(placeSlug("Silver Spring")).toBe("silver-spring");
    expect(placeSlug("  Coeur d'Alène ")).toBe("coeur-d-alene");
    expect(placeSlug("St. Paul")).toBe("st-paul");
  });
});

describe("statePage", () => {
  it("finds the state by its full-name slug, with its cities A to Z", () => {
    const page = statePage(STORES, "texas");
    expect(page?.name).toBe("Texas");
    expect(page?.stores.map((s) => s.slug)).toEqual(["a", "b", "c", "e"]);
    expect(page?.cities.map((c) => [c.slug, c.stores.length])).toEqual([["dallas", 1], ["houston", 2]]);
  });

  it("is null for a state with no listed store, a postal code or an unknown slug", () => {
    expect(statePage(STORES, "ohio")).toBeNull();
    expect(statePage(STORES, "tx")).toBeNull();
    expect(statePage(STORES, "TEXAS")).toBeNull();
    expect(statePage(STORES, "constructor")).toBeNull();
  });
});

describe("cityPage", () => {
  it("collects the city's stores across spellings of its name", () => {
    const page = cityPage(STORES, "texas", "houston");
    expect(page?.city).toBe("Houston");
    expect(page?.state.name).toBe("Texas");
    expect(page?.stores.map((s) => s.slug)).toEqual(["a", "b"]);
  });

  it("is null for a city with no listed store, so the page 404s", () => {
    expect(cityPage(STORES, "texas", "austin")).toBeNull();
    expect(cityPage(STORES, "maryland", "houston")).toBeNull();
    expect(cityPage(STORES, "texas", "hous")).toBeNull();
  });
});

describe("statePages", () => {
  it("lists every state and city that has a listed store, for the sitemap", () => {
    expect(statePages(STORES).map((s) => [s.slug, s.cities.map((c) => c.slug)])).toEqual([
      ["maryland", ["silver-spring"]],
      ["texas", ["dallas", "houston"]],
    ]);
  });
});
