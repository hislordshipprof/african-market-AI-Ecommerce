import { describe, expect, it } from "vitest";
import { NO_SERVICE_FEE } from "./platform-fee";
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
});
