import { describe, expect, it } from "vitest";
import { allocateLineDiscounts, couponTerms, goodsDiscountCents, lineDiscountShareCents } from "./discount";

const PERCENT_15 = { kind: "percent" as const, percentOff: 15, amountOffCents: null };
const FIXED_5 = { kind: "fixed" as const, percentOff: null, amountOffCents: 500 };

describe("goodsDiscountCents", () => {
  it("takes a percent of goods, rounding half up", () => {
    // 15% of $33.33 = 499.95 → 500
    expect(goodsDiscountCents(3333, PERCENT_15)).toBe(500);
    // 15% of $0.03 = 0.45 → 0
    expect(goodsDiscountCents(3, PERCENT_15)).toBe(0);
  });

  it("caps a fixed amount at the goods", () => {
    expect(goodsDiscountCents(2000, FIXED_5)).toBe(500);
    expect(goodsDiscountCents(320, FIXED_5)).toBe(320);
    expect(goodsDiscountCents(0, FIXED_5)).toBe(0);
  });

  it("a stored kind that is neither percent nor fixed is an error, never a fixed discount", () => {
    expect(() => couponTerms({ kind: "precent", percentOff: 15, amountOffCents: null })).toThrow("Unknown coupon kind");
  });
});

describe("allocateLineDiscounts", () => {
  it("splits the discount by line charge and the shares add up to the total", () => {
    // 100 off 300 / 300 / 400: 30 / 30 / 40.
    expect(allocateLineDiscounts([300, 300, 400], 100)).toEqual([30, 30, 40]);
    // 100 off three equal lines: 33.33 each; the leftover cent goes to the first largest remainder.
    expect(allocateLineDiscounts([500, 500, 500], 100)).toEqual([34, 33, 33]);
  });

  it("gives a line with no charge no discount", () => {
    expect(allocateLineDiscounts([0, 1000], 250)).toEqual([0, 250]);
    expect(allocateLineDiscounts([0, 0], 0)).toEqual([0, 0]);
  });
});

describe("lineDiscountShareCents", () => {
  it("is the line's discount in proportion to the goods refunded from it", () => {
    // Line charged $12.00 with $1.80 off; refund 1 of 3 units at $4.00 → 60¢.
    expect(lineDiscountShareCents({ discountCents: 180, chargeCents: 1200 }, 400)).toBe(60);
    // The whole line returns the whole share.
    expect(lineDiscountShareCents({ discountCents: 180, chargeCents: 1200 }, 1200)).toBe(180);
    expect(lineDiscountShareCents({ discountCents: 0, chargeCents: 1200 }, 400)).toBe(0);
  });
});
