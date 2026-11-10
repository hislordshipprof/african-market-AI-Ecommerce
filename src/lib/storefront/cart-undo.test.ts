import { describe, expect, it } from "vitest";
import { removedLine, restoreSteps } from "./cart-undo";
import type { CartLine } from "./cart-store";

const garri: CartLine = {
  listingId: "l1",
  variantId: "v1",
  name: "Yellow Garri",
  price: 699,
  packLabel: "1 lb",
  quantity: 4,
  serverLineId: "line-1",
  swapRule: "store_suggests",
  substituteVariantId: null,
};

describe("cart undo", () => {
  it("restores the removed quantity and the swap choice", () => {
    const removed = removedLine(garri)!;
    expect(restoreSteps(removed, undefined)).toEqual({
      quantity: 4,
      swap: { swapRule: "store_suggests", substituteVariantId: null },
    });
  });

  it("keeps a named substitute with its variant", () => {
    const removed = removedLine({ ...garri, swapRule: "named_substitute", substituteVariantId: "v9" })!;
    expect(restoreSteps(removed, undefined).swap).toEqual({
      swapRule: "named_substitute",
      substituteVariantId: "v9",
    });
  });

  it("needs no swap change for the default exact-item rule", () => {
    expect(restoreSteps(removedLine({ ...garri, swapRule: "exact_only" })!, undefined).swap).toBeNull();
    expect(restoreSteps(removedLine({ ...garri, swapRule: undefined })!, undefined).swap).toBeNull();
  });

  it("does not lower a line the shopper added back before tapping Undo", () => {
    const removed = removedLine(garri)!;
    expect(restoreSteps(removed, { ...garri, quantity: 1, swapRule: undefined }).quantity).toBe(4);
    expect(restoreSteps(removed, { ...garri, quantity: 6, swapRule: undefined }).quantity).toBe(6);
  });

  it("skips the swap call when the line already carries that choice", () => {
    const removed = removedLine(garri)!;
    expect(restoreSteps(removed, { ...garri, quantity: 4 }).swap).toBeNull();
  });

  it("has nothing to undo for an empty line", () => {
    expect(removedLine({ ...garri, quantity: 0 })).toBeNull();
  });
});
