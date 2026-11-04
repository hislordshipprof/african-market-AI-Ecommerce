import { describe, expect, it, vi } from "vitest";
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn }));
import { projectStorefrontListing } from "./service";

const listingBase = {
  id: "listing-1",
  customName: "Probe",
  price: 9999,
  confidence: 1,
  stockMode: "counted",
  qty: 4,
  status: null,
  frozen: false,
  perishable: false,
  masterProduct: null,
};

describe("projectStorefrontListing", () => {
  it("orders every shuffled input without mutating it", () => {
    const packs = [
      { id: "b-pack", label: "b", price: 500, weightG: 20 },
      { id: "z-low", label: "low", price: 100, weightG: 10 },
      { id: "A.pack", label: "A", price: 500, weightG: 20 },
      { id: "a_pack", label: "a", price: 500, weightG: 20 },
      { id: "B-pack", label: "B", price: 500, weightG: 20 },
    ];
    const permutations = [
      packs,
      [...packs].reverse(),
      [packs[3], packs[0], packs[4], packs[1], packs[2]],
      [packs[4], packs[2], packs[0], packs[3], packs[1]],
    ];
    for (const variants of permutations) {
      const snapshot = variants.map((pack) => ({ ...pack }));
      const projected = projectStorefrontListing({ ...listingBase, variants });
      expect(variants).toEqual(snapshot);
      expect(projected.packOptions?.map((pack) => pack.id)).toEqual([
        "z-low",
        "A.pack",
        "B-pack",
        "a_pack",
        "b-pack",
      ]);
      expect(projected.variantId).toBe("z-low");
      expect(projected.packLabel).toBe("low");
      expect(projected.startingPrice).toBe(100);
      expect(projected.weightG).toBe(10);
      expect(projected.packLabels).toEqual(["low", "A", "B", "a", "b"]);
    }
  });

  it("orders supplementary-plane ids by UTF-8 bytes, not UTF-16 code units", () => {
    const variants = [
      { id: "\u{10000}", label: "later", price: 10, weightG: 1 },
      { id: "\uFFFF", label: "earlier", price: 10, weightG: 1 },
    ];
    const projected = projectStorefrontListing({ ...listingBase, variants });
    expect(projected.packOptions?.map((pack) => pack.id)).toEqual(["\uFFFF", "\u{10000}"]);
    expect(projected.variantId).toBe("\uFFFF");
  });

  it("keeps a zero price as the cheapest pack", () => {
    const projected = projectStorefrontListing({
      ...listingBase,
      variants: [
        { id: "paid", label: "Paid", price: 200, weightG: 1 },
        { id: "free", label: "Free", price: 0, weightG: 1 },
      ],
    });
    expect(projected.variantId).toBe("free");
    expect(projected.startingPrice).toBe(0);
    expect(projected.packOptions?.[0]).toMatchObject({ id: "free", price: 0 });
  });
});
