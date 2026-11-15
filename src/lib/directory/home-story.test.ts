import { describe, expect, it } from "vitest";
import { directoryCounts, ownerQuotes } from "./home-story";

const placed = (slug: string, city: string | null, state: string | null) => ({ slug, city, state });

describe("directoryCounts", () => {
  it("counts markets, cities and states, a city name in two states being two cities", () => {
    expect(directoryCounts([
      placed("a", "Houston", "TX"),
      placed("b", "houston ", "TX"),
      placed("c", "Portland", "OR"),
      placed("d", "Portland", "ME"),
      placed("e", null, "TX"),
    ])).toEqual({ markets: 5, cities: 3, states: 3 });
    expect(directoryCounts([])).toEqual({ markets: 0, cities: 0, states: 0 });
  });
});

const story = (slug: string, ownerStory: string | null, ownerName: string | null = null) =>
  ({ slug, name: `Store ${slug}`, ownerName, ownerStory, ownerPhotoUrl: null });

describe("ownerQuotes", () => {
  it("takes up to three stores with a story, in order, skipping blank stories", () => {
    const quotes = ownerQuotes([
      story("a", "We opened in 2009."),
      story("b", "   "),
      story("c", null),
      story("d", "Fresh fish every Friday.", "Ama Mensah"),
      story("e", "Third."),
      story("f", "Fourth."),
    ]);
    expect(quotes.map((q) => [q.slug, q.ownerName])).toEqual([["a", null], ["d", "Ama Mensah"], ["e", null]]);
    expect(ownerQuotes([story("x", null)])).toEqual([]);
  });

  it("keeps a quote short: the first sentence, or the first words of one long sentence", () => {
    const [first] = ownerQuotes([story("a", "We came from Accra in 1998. Our first shop was a single shelf.")]);
    expect(first.quote).toBe("We came from Accra in 1998.");
    const [long] = ownerQuotes([story("b", `${"word ".repeat(60)}end`)]);
    expect(long.quote.length).toBeLessThanOrEqual(181);
    expect(long.quote.endsWith("…")).toBe(true);
    expect(long.quote).not.toMatch(/\s…$/);
  });
});
