import { describe, expect, it } from "vitest";
import { orderReceipt, type ReceiptOrder } from "./receipt";

// Order #1007 from the 2026-11-23 walkthrough: 6 × Yellow Garri at $6.99, store delivery.
function order(overrides: Partial<ReceiptOrder> = {}): ReceiptOrder {
  return {
    status: "AUTHORIZED",
    fulfillment: "store-delivery",
    subtotalCents: 4194,
    discountCents: 0,
    couponCode: null,
    deliveryFeeCents: 499,
    serviceFeeCents: 126,
    tipCents: 0,
    taxCents: 0,
    totalAuthorizedCents: 5238,
    captureCents: null,
    refundedCents: 0,
    lines: [{ id: "l1", status: "pending", qtyOrdered: 6, qtyPicked: 0, unitPriceCents: 699, substitutedUnitPriceCents: null }],
    ...overrides,
  };
}

const rows = (view: ReturnType<typeof orderReceipt>) => view.lines.map((line) => [line.label, line.cents]);
const sum = (view: ReturnType<typeof orderReceipt>) => view.lines.reduce((total, line) => total + line.cents, 0);

describe("orderReceipt", () => {
  it("lists the delivery fee on a store-delivery order and adds up to the total (#1007)", () => {
    const view = orderReceipt(order());
    expect(rows(view)).toEqual([
      ["Subtotal", 4194],
      ["Store delivery", 499],
      ["Service fee", 126],
      ["Tax", 0],
    ]);
    expect(view.total).toEqual({ label: "Total", cents: 4819 });
    expect(sum(view)).toBe(view.total.cents);
  });

  it("lists promo, courier fee, tip and tax on a courier order, and they add up", () => {
    const view = orderReceipt(order({
      fulfillment: "courier",
      subtotalCents: 5000,
      discountCents: 500,
      couponCode: "WELCOME5",
      deliveryFeeCents: 899,
      serviceFeeCents: 135,
      tipCents: 300,
      taxCents: 41,
    }));
    expect(rows(view)).toEqual([
      ["Subtotal", 5000],
      ["Promo WELCOME5", -500],
      ["Courier delivery", 899],
      ["Service fee", 135],
      ["Tip", 300],
      ["Tax", 41],
    ]);
    expect(view.total.cents).toBe(5875);
  });

  it("leaves out a delivery fee and tip a pickup order does not have", () => {
    const labels = orderReceipt(order({ fulfillment: "pickup", deliveryFeeCents: 0 })).lines.map((line) => line.label);
    expect(labels).toEqual(["Subtotal", "Service fee", "Tax"]);
  });

  it("shows the card hold until the payment is captured", () => {
    expect(orderReceipt(order()).holdCents).toBe(5238);
  });

  it("keeps the hold wording while capture is still in flight", () => {
    const view = orderReceipt(order({ status: "CAPTURING" }));
    expect(view.total.label).toBe("Total");
    expect(view.holdCents).toBe(5238);
  });

  it("shows the captured amount as Charged, with no hold, once captured", () => {
    const view = orderReceipt(order({
      status: "READY",
      captureCents: 4819,
      lines: [{ id: "l1", status: "picked", qtyOrdered: 6, qtyPicked: 6, unitPriceCents: 699, substitutedUnitPriceCents: null }],
    }));
    expect(view.total).toEqual({ label: "Charged", cents: 4819 });
    expect(view.holdCents).toBeNull();
    expect(sum(view)).toBe(4819);
  });

  it("prices a short line at what was found once captured, so the lines still add up to the charge", () => {
    // 4 of 6 found: goods 2796; service fee, tax recalculated at capture on those goods.
    const view = orderReceipt(order({
      status: "READY",
      serviceFeeCents: 84,
      taxCents: 12,
      captureCents: 3391,
      lines: [{ id: "l1", status: "picked", qtyOrdered: 6, qtyPicked: 4, unitPriceCents: 699, substitutedUnitPriceCents: null }],
    }));
    expect(view.items).toEqual([{ id: "l1", cents: 2796, note: "4 of 6 found" }]);
    expect(rows(view)[0]).toEqual(["Subtotal", 2796]);
    expect(sum(view)).toBe(3391);
    expect(view.total).toEqual({ label: "Charged", cents: 3391 });
  });

  it("still shows what was charged after a refund clears the live capture", () => {
    const view = orderReceipt(order({ status: "REFUNDED", captureCents: 4819 }));
    expect(view.total).toEqual({ label: "Charged", cents: 4819 });
    expect(view.holdCents).toBeNull();
  });

  it("shows a partial refund under the charge, and the net charged, which still add up (#753)", () => {
    // Pickup from the 2026-11-23 walkthrough: $40.12 charged, $11.32 refunded for a reported item.
    const view = orderReceipt(order({
      status: "PARTIALLY_REFUNDED",
      fulfillment: "pickup",
      subtotalCents: 3895,
      deliveryFeeCents: 0,
      serviceFeeCents: 117,
      captureCents: 4012,
      refundedCents: 1132,
      lines: [{ id: "l1", status: "picked", qtyOrdered: 1, qtyPicked: 1, unitPriceCents: 3895, substitutedUnitPriceCents: null }],
    }));
    expect(sum(view)).toBe(view.total.cents);
    expect(view.total).toEqual({ label: "Charged", cents: 4012 });
    expect(view.refund).toEqual({ key: "refund", label: "Refunded", cents: -1132 });
    expect(view.net).toEqual({ label: "Net charged", cents: 2880 });
    expect(view.total.cents + view.refund!.cents).toBe(view.net!.cents);
  });

  it("nets a full refund to nothing charged", () => {
    const view = orderReceipt(order({ status: "REFUNDED", captureCents: 4819, refundedCents: 4819 }));
    expect(view.refund?.cents).toBe(-4819);
    expect(view.net).toEqual({ label: "Net charged", cents: 0 });
  });

  it("shows no refund line without a succeeded refund, or before capture", () => {
    expect(orderReceipt(order({ status: "READY", captureCents: 4819 })).refund).toBeNull();
    const uncaptured = orderReceipt(order({ refundedCents: 500 }));
    expect(uncaptured.refund).toBeNull();
    expect(uncaptured.net).toBeNull();
  });
});
