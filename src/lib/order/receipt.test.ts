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
    refunds: [],
    coupon: null,
    serviceFeeBps: 300,
    serviceFeeMinCents: 99,
    serviceFeeMaxCents: 299,
    lines: [{ id: "l1", status: "pending", qtyOrdered: 6, qtyPicked: 0, unitPriceCents: 699, substitutedUnitPriceCents: null, substitutedName: null }],
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
      lines: [{ id: "l1", status: "pending", qtyOrdered: 2, qtyPicked: 0, unitPriceCents: 2500, substitutedUnitPriceCents: null, substitutedName: null }],
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
      lines: [{ id: "l1", status: "picked", qtyOrdered: 6, qtyPicked: 6, unitPriceCents: 699, substitutedUnitPriceCents: null, substitutedName: null }],
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
      lines: [{ id: "l1", status: "picked", qtyOrdered: 6, qtyPicked: 4, unitPriceCents: 699, substitutedUnitPriceCents: null, substitutedName: null }],
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
      refunds: [{ amountCents: 1132, lines: [] }],
      lines: [{ id: "l1", status: "picked", qtyOrdered: 1, qtyPicked: 1, unitPriceCents: 3895, substitutedUnitPriceCents: null, substitutedName: null }],
    }));
    expect(sum(view)).toBe(view.total.cents);
    expect(view.total).toEqual({ label: "Charged", cents: 4012 });
    expect(view.refunds).toEqual([{ key: "refund", label: "Refunded", cents: -1132 }]);
    expect(view.net).toEqual({ label: "Net charged", cents: 2880 });
    expect(view.total.cents + view.refunds[0].cents).toBe(view.net!.cents);
  });

  it("names each refunded item with its quantity and amount, and a refund without lines on its own row (#798)", () => {
    const line = (id: string, name: string, qty: number, unitPriceCents: number) =>
      ({ id, name, status: "picked", qtyOrdered: qty, qtyPicked: qty, unitPriceCents, substitutedUnitPriceCents: null, substitutedName: null });
    const view = orderReceipt(order({
      status: "PARTIALLY_REFUNDED",
      fulfillment: "pickup",
      subtotalCents: 2500,
      deliveryFeeCents: 0,
      serviceFeeCents: 150,
      captureCents: 2650,
      lines: [line("yam", "Yam", 2, 1000), line("oil", "Palm oil", 1, 500)],
      refunds: [
        { amountCents: 1060, lines: [{ lineId: "yam", qty: 1, amountCents: 1060 }] },
        { amountCents: 1590, lines: [{ lineId: "oil", qty: 1, amountCents: 530 }, { lineId: "yam", qty: 1, amountCents: 1060 }] },
        { amountCents: 0, lines: [] },
      ],
    }));
    expect(view.refunds).toEqual([
      { key: "refund-yam", label: "Refunded 2 × Yam", cents: -2120 },
      { key: "refund-oil", label: "Refunded 1 × Palm oil", cents: -530 },
    ]);
    expect(view.net).toEqual({ label: "Net charged", cents: 0 });
  });

  it("nets a full refund to nothing charged", () => {
    const view = orderReceipt(order({ status: "REFUNDED", captureCents: 4819, refunds: [{ amountCents: 4819, lines: [] }] }));
    expect(view.refunds.map((row) => row.cents)).toEqual([-4819]);
    expect(view.net).toEqual({ label: "Net charged", cents: 0 });
  });

  it("shows no refund line without a succeeded refund, or before capture", () => {
    expect(orderReceipt(order({ status: "READY", captureCents: 4819 })).refunds).toEqual([]);
    const uncaptured = orderReceipt(order({ refunds: [{ amountCents: 500, lines: [] }] }));
    expect(uncaptured.refunds).toEqual([]);
    expect(uncaptured.net).toBeNull();
  });

  // #1006 from walkthrough 3, pickup with WALK10: Plantain Chips refunded, Suya Spice swapped for Cameroon Pepper.
  const swapped = {
    fulfillment: "pickup",
    deliveryFeeCents: 0,
    subtotalCents: 1338,
    discountCents: 134,
    couponCode: "WALK10",
    coupon: { kind: "percent" as const, percentOff: 10, amountOffCents: null },
    serviceFeeCents: 99,
    totalAuthorizedCents: 1500,
    lines: [
      { id: "a", status: "refunded", qtyOrdered: 1, qtyPicked: 0, unitPriceCents: 399, substitutedUnitPriceCents: null, substitutedName: null },
      { id: "b", status: "picked", qtyOrdered: 1, qtyPicked: 1, unitPriceCents: 440, substitutedUnitPriceCents: null, substitutedName: null },
      { id: "c", status: "substituted", qtyOrdered: 1, qtyPicked: 0, unitPriceCents: 499, substitutedUnitPriceCents: 599, substitutedName: "Cameroon Pepper 4 oz" },
    ],
  };

  it("names the replacement on a swapped line (#762)", () => {
    const view = orderReceipt(order({ ...swapped, status: "READY", discountCents: 104, captureCents: 1034 }));
    expect(view.items.map((item) => item.note)).toEqual(["0 of 1 found", null, "Swapped for Cameroon Pepper 4 oz"]);
  });

  it("before capture, shows the answered swaps and refunds and the expected new total (#762)", () => {
    // Goods now 4.40 + 5.99 = 10.39; 10% off is 1.04; the fee stays at its 0.99 minimum.
    const view = orderReceipt(order({ ...swapped, status: "PICKING" }));
    expect(view.items.map((item) => [item.cents, item.note])).toEqual([[0, "0 of 1 found"], [440, null], [599, "Swapped for Cameroon Pepper 4 oz"]]);
    expect(rows(view)).toEqual([["Subtotal", 1039], ["Promo WALK10", -104], ["Service fee", 99], ["Tax", 0]]);
    expect(view.total).toEqual({ label: "Expected total", cents: 1034 });
    expect(view.holdCents).toBe(1500);
  });

  it("before any short is answered, keeps the order's stored total", () => {
    const view = orderReceipt(order({ ...swapped, status: "PICKING", lines: swapped.lines.map((line) => ({ ...line, status: "pending" })) }));
    expect(view.items.map((item) => item.note)).toEqual([null, null, null]);
    expect(view.total).toEqual({ label: "Total", cents: 1338 - 134 + 99 });
  });
});
