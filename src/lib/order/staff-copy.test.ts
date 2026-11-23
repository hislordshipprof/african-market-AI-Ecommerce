import { describe, expect, it } from "vitest";
import { showCapturedLine, storeOrderBreakdown } from "./staff-copy";

describe("captured line", () => {
  it("shows Captured only after the money is captured", () => {
    expect(showCapturedLine("CAPTURING", 1200)).toBe(false);
    expect(showCapturedLine("PICKING", 1200)).toBe(false);
    expect(showCapturedLine("CANCELLING", 1200)).toBe(false);
    expect(showCapturedLine("CANCELLED", 1200)).toBe(false);
    expect(showCapturedLine("READY", 1200)).toBe(true);
    expect(showCapturedLine("AWAITING_PICKUP", 1200)).toBe(true);
    expect(showCapturedLine("COMPLETED", 1200)).toBe(true);
    expect(showCapturedLine("OUT_FOR_DELIVERY", 1200)).toBe(true);
    expect(showCapturedLine("DELIVERED", 1200)).toBe(true);
    expect(showCapturedLine("REFUND_FAILED", 1200)).toBe(true);
    expect(showCapturedLine("REFUND_FAILED", 0)).toBe(false);
  });
});

describe("storeOrderBreakdown", () => {
  const base = { subtotalCents: 4194, discountCents: 0, serviceFeeCents: 126, tipCents: 0, deliveryFeeCents: 0, taxCents: 0, coupon: null };
  const sum = (lines: { cents: number }[]) => lines.reduce((total, line) => total + line.cents, 0);

  it("shows the delivery fee, so a store-delivery order's lines add up to its total (#1007)", () => {
    const lines = storeOrderBreakdown({ ...base, fulfillment: "store-delivery", deliveryFeeCents: 499 });
    expect(lines).toContainEqual(expect.objectContaining({ label: "Delivery fee", cents: 499 }));
    expect(sum(lines)).toBe(4819);
  });

  it("adds every stored part of the total: promo, tax, courier fee and tip", () => {
    const lines = storeOrderBreakdown({
      ...base,
      fulfillment: "courier",
      discountCents: 300,
      coupon: { code: "SAVE3" },
      taxCents: 210,
      deliveryFeeCents: 799,
      tipCents: 500,
    });
    expect(lines.map((line) => line.label)).toEqual(
      expect.arrayContaining(["Courier fee", "Tax", "Tip"]),
    );
    expect(sum(lines)).toBe(4194 - 300 + 126 + 210 + 799 + 500);
  });

  it("calls a shipped order's fee shipping and leaves out zero lines on pickup", () => {
    expect(storeOrderBreakdown({ ...base, fulfillment: "ship", deliveryFeeCents: 1250 })).toContainEqual(
      expect.objectContaining({ label: "Shipping", cents: 1250 }),
    );
    expect(storeOrderBreakdown({ ...base, fulfillment: "pickup" }).map((line) => line.label)).toEqual([
      "Subtotal",
      "Service fee (platform)",
    ]);
  });
});
