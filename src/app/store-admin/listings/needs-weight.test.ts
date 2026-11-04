import { describe, expect, it } from "vitest";
import { serializeVariants } from "./variant-form";
import { editWeightField, listingNeedsWeight, needsWeightSentence } from "./needs-weight";

describe("needs weight", () => {
  it("a listing needs a weight when any variant is a placeholder", () => {
    expect(listingNeedsWeight({
      active: false,
      variants: [
        { weightPlaceholder: false },
        { weightPlaceholder: true },
      ],
    })).toBe(true);
    expect(listingNeedsWeight({
      active: true,
      variants: [{ weightPlaceholder: false }, { weightPlaceholder: false }],
    })).toBe(false);
    expect(listingNeedsWeight({ active: true, variants: [] })).toBe(false);
  });

  it("edit rows start empty with the Needs weight placeholder only for placeholder variants", () => {
    expect(editWeightField({ weightG: 100, weightPlaceholder: true })).toEqual({
      value: "",
      placeholder: "Needs weight",
    });
    expect(editWeightField({ weightG: 100, weightPlaceholder: false })).toEqual({
      value: "100",
      placeholder: "Weight (g)",
    });
    expect(editWeightField({ weightG: 22680, weightPlaceholder: false })).toEqual({
      value: "22680",
      placeholder: "Weight (g)",
    });
  });

  it("success copy is singular, plural, or absent at 0", () => {
    expect(needsWeightSentence(0)).toBeNull();
    expect(needsWeightSentence(1)).toBe("1 listing needs a weight.");
    expect(needsWeightSentence(2)).toBe("2 listings need a weight.");
  });

  it("a blank label is dropped so an only-blank form sends no variants", () => {
    expect(JSON.parse(serializeVariants([
      { id: "v1", label: "   ", price: "9.00", weightG: "" },
    ]))).toEqual([]);
    expect(JSON.parse(serializeVariants([
      { id: "v1", label: "   ", price: "9.00", weightG: "" },
      { id: "v2", label: "1 lb", price: "4.00", weightG: "454" },
    ]))).toEqual([
      { id: "v2", label: "1 lb", price: 400, weightG: 454, sku: null, barcode: null },
    ]);
  });
});
