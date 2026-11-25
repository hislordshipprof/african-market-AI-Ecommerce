import { describe, expect, it } from "vitest";
import { stepperLimit, stepCartQuantity } from "./cart-quantity";

describe("stepCartQuantity", () => {
  it("adds and removes one from the latest quantity", () => {
    expect(stepCartQuantity(1, 1)).toBe(2);
    expect(stepCartQuantity(2, 1)).toBe(3);
    expect(stepCartQuantity(3, -1)).toBe(2);
    expect(stepCartQuantity(2, -1)).toBe(1);
  });

  it("stops at the smaller of 99 and the listing max", () => {
    expect(stepCartQuantity(3, 1, 3)).toBeNull();
    expect(stepCartQuantity(2, 1, 3)).toBe(3);
    expect(stepCartQuantity(98, 1, 99)).toBe(99);
    expect(stepCartQuantity(99, 1)).toBeNull();
    expect(stepCartQuantity(99, 1, 3)).toBeNull();
  });

  it("does nothing at zero and with max 0 only allows going down", () => {
    expect(stepCartQuantity(0, -1)).toBeNull();
    expect(stepCartQuantity(0, 1)).toBe(1);
    expect(stepCartQuantity(0, 1, 0)).toBeNull();
    expect(stepCartQuantity(3, 1, 0)).toBeNull();
    expect(stepCartQuantity(3, -1, 0)).toBe(2);
    expect(stepCartQuantity(1, -1, 0)).toBe(0);
  });

  it("treats a max above 99 as 99", () => {
    expect(stepCartQuantity(98, 1, 150)).toBe(99);
    expect(stepCartQuantity(99, 1, 150)).toBeNull();
    expect(stepCartQuantity(99, 1, 1000)).toBeNull();
  });

  it("decrements by one when current exceeds max, including max zero", () => {
    expect(stepCartQuantity(5, -1, 3)).toBe(4);
    expect(stepCartQuantity(3, -1, 0)).toBe(2);
    expect(stepCartQuantity(5, 1, 3)).toBeNull();
  });
});

describe("stepperLimit: what the stepper allows, and why (#708 P1, #717 AC1)", () => {
  it("stops only the increase at the real ceiling, with the limit as the reason", () => {
    expect(stepperLimit({ qty: 2, max: 2, available: true, variantId: "v1" })).toEqual({
      canAdd: false,
      canIncrease: false,
      reason: "Limit 2 per order",
    });
  });

  it("allows more below the ceiling and gives no reason", () => {
    expect(stepperLimit({ qty: 1, max: 2, available: true, variantId: "v1" })).toEqual({ canAdd: true, canIncrease: true });
  });

  it("says the item is no longer sold when the server marks it unavailable", () => {
    expect(stepperLimit({ qty: 1, max: 5, available: false, variantId: "v1" }).reason).toBe("No longer available");
    expect(stepperLimit({ qty: 0, max: 0, available: undefined, variantId: "v1" }).canAdd).toBe(false);
  });

  it("cannot add a listing that has no pack to order", () => {
    expect(stepperLimit({ qty: 0, max: undefined, available: true, variantId: undefined })).toEqual({
      canAdd: false,
      canIncrease: false,
      reason: "Not sold online yet",
    });
  });
});

describe("catering minimum and counted stock on the stepper (#808)", () => {
  it("first plus on a catering item jumps to its minimum, and minus at the minimum removes it", () => {
    expect(stepCartQuantity(0, 1, 99, 4)).toBe(4);
    expect(stepCartQuantity(4, 1, 99, 4)).toBe(5);
    expect(stepCartQuantity(5, -1, 99, 4)).toBe(4);
    expect(stepCartQuantity(4, -1, 99, 4)).toBe(0);
  });

  it("stops at the counted stock with how many are left as the reason", () => {
    expect(stepperLimit({ qty: 4, max: 10, stockLeft: 4, available: true, variantId: "v1" })).toEqual({
      canAdd: false,
      canIncrease: false,
      reason: "Only 4 left",
    });
    expect(stepperLimit({ qty: 3, max: 3, stockLeft: 4, available: true, variantId: "v1" }).reason).toBe("Limit 3 per order");
    expect(stepperLimit({ qty: 3, max: 10, stockLeft: 4, available: true, variantId: "v1" }).canIncrease).toBe(true);
  });
});

describe("a catering minimum above the stock left (#808)", () => {
  it("cannot be added, and says how many are left", () => {
    expect(stepperLimit({ qty: 0, max: 99, stockLeft: 3, minQty: 4, available: true, variantId: "v1" })).toEqual({
      canAdd: false,
      canIncrease: false,
      reason: "Only 3 left",
    });
  });
});
