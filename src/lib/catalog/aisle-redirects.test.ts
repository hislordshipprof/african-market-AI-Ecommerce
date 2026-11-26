import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { AISLES } from "./category-tree";

describe("old aisle links (#861)", () => {
  it("send every retired or renamed aisle slug to its new aisle with a 301", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    const aisles = (from: string) => redirects.find((rule) => rule.source === `/categories/${from}`);
    for (const [from, to] of [
      ["vegetables", "fresh-produce"], ["fruits", "fresh-produce"], ["grains-and-flours", "fufu-flours-and-swallow"],
      ["beans-and-legumes", "rice-grains-and-beans"], ["seasonings-and-sauces", "spices-and-seasonings"],
      ["oils-and-butters", "oils-sauces-and-condiments"], ["pantry-staples", "canned-and-packaged"], ["snacks", "snacks-and-sweets"],
      ["beauty", "beauty-and-personal-care"], ["household", "household-and-kitchen"], ["tubers", "tubers-and-roots"],
    ]) {
      expect(aisles(from)).toEqual({ source: `/categories/${from}`, destination: `/categories/${to}`, statusCode: 301 });
    }
    for (const aisle of AISLES) expect(aisles(aisle.slug)).toBeUndefined();
  });
});
