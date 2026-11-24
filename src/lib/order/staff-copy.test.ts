import { describe, expect, it } from "vitest";
import { fulfillmentHeadline, fulfillmentLine, showCapturedLine, storeOrderBreakdown, storePayoutLines } from "./staff-copy";

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

describe("fulfillmentLine", () => {
  const TZ = "America/Chicago";
  const NOW = new Date("2026-11-23T22:00:00.000Z"); // 4:00 PM CST
  const order = {
    fulfillment: "store-delivery",
    pickupSlot: null as string | null,
    deliveryLine1: "7500 Bellfort St" as string | null,
    deliveryLine2: null as string | null,
    deliveryCity: "Houston" as string | null,
    deliveryState: "TX" as string | null,
    deliveryZip: "77061" as string | null,
    leaveAtDoor: false,
    shippingCarrier: null,
    shippingService: null,
  };
  const text = (line: { before: string; address: string | null; after: string }) => `${line.before}${line.address ?? ""}${line.after}`;

  it("joins only the parts of a partial address that are there (#751)", () => {
    const line = fulfillmentLine({ ...order, deliveryState: null, deliveryZip: null }, TZ, NOW);
    expect(text(line)).toBe("Store delivery to 7500 Bellfort St, Houston");
    expect(line.address).toBe("7500 Bellfort St, Houston");
    expect(text(fulfillmentLine({ ...order, deliveryCity: null }, TZ, NOW))).toBe("Store delivery to 7500 Bellfort St, TX 77061");
  });

  it("says the address is missing instead of ending in 'to' (#751)", () => {
    const empty = { ...order, deliveryLine1: null, deliveryCity: null, deliveryState: null, deliveryZip: null };
    const line = fulfillmentLine(empty, TZ, NOW);
    expect(text(line)).toBe("Store delivery · address missing");
    expect(line.address).toBeNull();
  });

  it("never prints null in a courier or shipping address", () => {
    expect(text(fulfillmentLine({ ...order, fulfillment: "courier", deliveryState: null }, TZ, NOW))).toBe("Courier delivery to Houston, 77061");
    expect(text(fulfillmentLine({ ...order, fulfillment: "ship", deliveryZip: null }, TZ, NOW))).toBe("Shipping to 7500 Bellfort St, Houston, TX");
  });

  it("shows a scheduled slot in the store's zone; ASAP and no slot read as before (#751)", () => {
    const slot = "2026-11-24T01:30:00.000Z"; // 7:30 PM CST on the 23rd
    const pickup = { ...order, fulfillment: "pickup", pickupSlot: slot };
    expect(text(fulfillmentLine(pickup, TZ, NOW))).toBe("Pickup Today 7:30 PM CST");
    expect(text(fulfillmentLine({ ...order, pickupSlot: slot }, TZ, NOW))).toBe("Store delivery Today 7:30 PM CST to 7500 Bellfort St, Houston, TX 77061");
    expect(text(fulfillmentLine({ ...pickup, pickupSlot: "asap" }, TZ, NOW))).toBe("Pickup at the store");
    expect(text(fulfillmentLine({ ...pickup, pickupSlot: null }, TZ, NOW))).toBe("Pickup at the store");
  });
});

describe("fulfillmentHeadline", () => {
  const TZ = "America/Chicago";
  const NOW = new Date("2026-11-23T22:00:00.000Z");

  it("names the fulfilment on every card and adds the due time when scheduled (#751)", () => {
    expect(fulfillmentHeadline({ fulfillment: "pickup", pickupSlot: "2026-11-24T01:30:00.000Z" }, TZ, NOW)).toBe("Pickup Today 7:30 PM CST");
    expect(fulfillmentHeadline({ fulfillment: "store-delivery", pickupSlot: "2026-11-25T16:00:00.000Z" }, TZ, NOW)).toBe("Store delivery Nov 25, 2026 10:00 AM CST");
    expect(fulfillmentHeadline({ fulfillment: "pickup", pickupSlot: null }, TZ, NOW)).toBe("Pickup");
    expect(fulfillmentHeadline({ fulfillment: "courier", pickupSlot: null }, TZ, NOW)).toBe("Courier delivery");
    expect(fulfillmentHeadline({ fulfillment: "ship", pickupSlot: null }, TZ, NOW)).toBe("Shipping");
  });
});

describe("storePayoutLines", () => {
  const order1007 = {
    fulfillment: "store-delivery",
    capturedAmountCents: 5331,
    platformFeeCents: 319,
    serviceFeeCents: 138,
    deliveryFeeCents: 599,
    shippingPostageCents: null,
    taxCents: 0,
    taxLiableParty: "platform",
  };
  const amounts = (lines: { key: string; cents: number }[]) => Object.fromEntries(lines.map((line) => [line.key, line.cents]));

  it("takes the card fee and the platform service fee off the capture, so #1007's lines add up (#751)", () => {
    const lines = storePayoutLines(order1007);
    expect(amounts(lines)).toEqual({ captured: 5331, "card-fee": -181, "service-fee": -138, payout: 5012 });
    expect(lines.slice(0, -1).reduce((sum, line) => sum + line.cents, 0)).toBe(5012);
  });

  it("also takes off the courier fee and the tax the platform remits, and still adds up", () => {
    const lines = storePayoutLines({ ...order1007, fulfillment: "courier", platformFeeCents: null, deliveryFeeCents: 799, taxCents: 250 });
    const { payout, ...parts } = amounts(lines);
    expect(parts["courier-fee"]).toBe(-799);
    expect(parts.tax).toBe(-250);
    expect(Object.values(parts).reduce((sum, cents) => sum + cents, 0)).toBe(payout);
  });
  const walkthrough = {
    fulfillment: "pickup",
    capturedAmountCents: 4012,
    platformFeeCents: 260,
    serviceFeeCents: 117,
    deliveryFeeCents: 0,
    shippingPostageCents: null,
    taxCents: 0,
    taxLiableParty: "platform",
  };
  const refund = (id: string, amountCents: number, at: string) => ({
    id, amountCents, createdAt: new Date(at), refundApplicationFee: true, feeRefundId: null, serviceFeeShareCents: 0, platformTaxShareCents: 0,
  });

  it("takes a refund off and gives back Stripe's platform fee share, so the payout matches the sales CSV (#757)", () => {
    const lines = storePayoutLines({ ...walkthrough, refundRequests: [refund("r1", 1132, "2026-11-02T18:00:00Z")] });
    expect(amounts(lines)).toEqual({ captured: 4012, "card-fee": -143, "service-fee": -117, refunds: -1132, "fee-returned": 73, payout: 2693 });
    expect(lines.slice(0, -1).reduce((sum, line) => sum + line.cents, 0)).toBe(2693);
  });

  it("never returns more platform fee than Stripe took across partial refunds", () => {
    const lines = storePayoutLines({ ...walkthrough, refundRequests: [refund("r2", 2880, "2026-11-03T00:00:00Z"), refund("r1", 1132, "2026-11-02T00:00:00Z")] });
    expect(amounts(lines)).toMatchObject({ refunds: -4012, "fee-returned": 260, payout: 0 });
  });

  it("returns a courier refund's service fee share only once that fee refund is made", () => {
    const courier = { ...refund("r1", 1000, "2026-11-04T00:00:00Z"), refundApplicationFee: false, serviceFeeShareCents: 38 };
    const before = amounts(storePayoutLines({ ...walkthrough, refundRequests: [courier] }));
    expect(before).not.toHaveProperty("fee-returned");
    expect(before.payout).toBe(2752);
    expect(amounts(storePayoutLines({ ...walkthrough, refundRequests: [{ ...courier, feeRefundId: "fr_1" }] }))).toMatchObject({ "fee-returned": 38, payout: 2790 });
  });

  it("reads exactly as before when the order has no refunds", () => {
    expect(storePayoutLines({ ...order1007, refundRequests: [] })).toEqual(storePayoutLines(order1007));
  });
});
