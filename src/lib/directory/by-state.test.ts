import { describe, expect, it } from "vitest";
import { groupByState } from "./by-state";

const store = (slug: string, state: string | null) => ({ slug, name: slug, city: "X", state, href: `https://${slug}.example/` });

describe("groupByState", () => {
  it("groups stores under the state's full name, states A to Z, skipping unknown states", () => {
    const groups = groupByState([store("b", "TX"), store("a", "GA"), store("c", "TX"), store("d", null), store("e", "ZZ")]);
    expect(groups.map((g) => [g.name, g.stores.map((s) => s.slug)])).toEqual([
      ["Georgia", ["a"]],
      ["Texas", ["b", "c"]],
    ]);
  });
});
