import { describe, expect, it } from "vitest";
import { ADR_0021_SERVICE_FEE, NO_SERVICE_FEE } from "./platform-fee";
import { canOfferSwap, captureCharge } from "./substitution-pricing";

describe("canOfferSwap", () => {
  it("offers a swap that stays within the card hold, and never one that exceeds it", () => {
    expect(canOfferSwap(5500, 5000, 400)).toBe(true);
    expect(canOfferSwap(5500, 5000, 0)).toBe(true);
    expect(canOfferSwap(5500, 5400, 200)).toBe(false);
  });
});

describe("captureCharge", () => {
  const line = (status: string, qtyOrdered: number, qtyPicked: number, unitPriceCents: number, substitutedUnitPriceCents: number | null = null) =>
    ({ status, qtyOrdered, qtyPicked, unitPriceCents, substitutedUnitPriceCents });
  const fees = { tipCents: 0, deliveryFeeCents: 0, serviceFee: NO_SERVICE_FEE };

  it("charges picked lines in full and adds tip and delivery fee", () => {
    expect(captureCharge([line("picked", 2, 2, 1000)], { tipCents: 200, deliveryFeeCents: 500, serviceFee: NO_SERVICE_FEE }).amountCents).toBe(2700);
  });

  it("AC4: a $50 order with an $8 line refunded and a line swapped up $4 captures $46", () => {
    const lines = [
      line("refunded", 1, 0, 800),
      line("substituted", 1, 0, 1000, 1400),
      line("picked", 2, 2, 1600),
    ];
    expect(captureCharge(lines, fees).amountCents).toBe(4600);
  });

  it("charges found units of a short line plus the swap for the rest, up or down", () => {
    expect(captureCharge([line("substituted", 3, 1, 1000, 900)], fees).amountCents).toBe(1000 + 2 * 900);
    expect(captureCharge([line("refunded", 3, 1, 1000)], fees).amountCents).toBe(1000);
  });

  it("captures nothing, not even tip or fee, when no line is charged", () => {
    expect(captureCharge([line("refunded", 2, 0, 1000)], { tipCents: 300, deliveryFeeCents: 500, serviceFee: NO_SERVICE_FEE }).amountCents).toBe(0);
  });

  describe("with a store coupon (#557)", () => {
    const percent20 = { kind: "percent", percentOff: 20, amountOffCents: null };
    const fixed10 = { kind: "fixed", percentOff: null, amountOffCents: 1000 };

    it("recomputes a percent discount on the goods picked, stores each line's share, and charges the fee on discounted goods", () => {
      // Ordered $50.00; one unit of the $10 line found: goods $40.00, 20% = $8.00 split 600 / 200.
      // Fee 3% of $32.00 = 96¢, raised to the 99¢ minimum. Capture 3200 + 99 = 3299.
      const charge = captureCharge(
        [line("picked", 2, 2, 1500), line("refunded", 2, 1, 1000)],
        { tipCents: 0, deliveryFeeCents: 0, serviceFee: ADR_0021_SERVICE_FEE, coupon: percent20 },
      );
      expect(charge).toEqual({ amountCents: 3299, serviceFeeCents: 99, discountCents: 800, lineDiscountsCents: [600, 200] });
    });

    it("caps a fixed discount at the goods picked and never takes it off delivery or tip, even below the code's minimum", () => {
      // $10 off, but only $8.00 of goods found: $8.00 off, goods 0, no fee; delivery $5 and tip $2 still charged.
      const charge = captureCharge(
        [line("refunded", 3, 1, 800)],
        { tipCents: 200, deliveryFeeCents: 500, serviceFee: ADR_0021_SERVICE_FEE, coupon: fixed10 },
      );
      expect(charge).toEqual({ amountCents: 700, serviceFeeCents: 0, discountCents: 800, lineDiscountsCents: [800] });
    });

    it("gives no discount and no line shares without a coupon", () => {
      expect(captureCharge([line("picked", 1, 1, 1000)], fees)).toEqual({ amountCents: 1000, serviceFeeCents: 0, discountCents: 0, lineDiscountsCents: [0] });
    });
  });
});
