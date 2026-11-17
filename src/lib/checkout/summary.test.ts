import { describe, expect, it } from "vitest";
import type { CheckoutQuote } from "../customer-flow/contracts";
import { basketQuoteView, checkoutQuoteKey, orderSummary } from "./summary";

function quote(overrides: Partial<CheckoutQuote> = {}): CheckoutQuote {
  return {
    id: "q1",
    subtotalCents: 4194,
    deliveryFeeCents: 0,
    courierFeeCents: 0,
    serviceFeeCents: 126,
    taxCents: 0,
    tipCents: 0,
    discountCents: 0,
    totalCents: 4320,
    bufferCents: 419,
    holdCents: 4739,
    expiresAt: "2026-11-09T12:00:00.000Z",
    problems: [],
    ...overrides,
  };
}

const labels = (view: ReturnType<typeof orderSummary>) =>
  view.lines.map((line) => line.label);

describe("orderSummary", () => {
  it("shows the server quote's money for a pickup basket, with its service fee and no invented tax or tip", () => {
    const view = orderSummary(quote(), "pickup");
    expect(view.lines.map((line) => [line.label, line.cents])).toEqual([
      ["Subtotal", 4194],
      ["Service fee", 126],
      ["Estimated tax", 0],
    ]);
    expect(view.totalCents).toBe(4320);
    expect(view.holdCents).toBe(4739);
    expect(view.bufferCents).toBe(419);
  });

  it("shows the store delivery fee and tip choice on a store-delivery order", () => {
    const view = orderSummary(
      quote({ deliveryFeeCents: 499, totalCents: 4693, holdCents: 5112 }),
      "store-delivery",
    );
    expect(view.lines.map((line) => [line.label, line.cents])).toEqual([
      ["Subtotal", 4194],
      ["Service fee", 126],
      ["Store delivery", 499],
      ["Estimated tax", 0],
      ["Tip", 0],
    ]);
    expect(labels(view)).not.toContain("Courier");
    expect(view.totalCents).toBe(4693);
  });

  it("names the courier provider on a courier order and shows promo savings as negative", () => {
    const view = orderSummary(
      quote({ courierFeeCents: 699, courierProvider: "Uber Direct", discountCents: 300 }),
      "courier",
    );
    expect(view.lines).toContainEqual({ key: "courier", label: "Uber Direct", cents: 699 });
    expect(view.lines).toContainEqual({ key: "discount", label: "Promo savings", cents: -300 });
    expect(labels(view)).not.toContain("Store delivery");
  });

  it("#557: shows the store coupon by its code right under the subtotal, before the fee charged on discounted goods", () => {
    const view = orderSummary(quote({ discountCents: 1000, coupon: { code: "SAVE20", discountCents: 1000 } }), "pickup");
    expect(view.lines.slice(0, 2)).toEqual([
      { key: "subtotal", label: "Subtotal", cents: expect.any(Number) },
      { key: "discount", label: "Promo SAVE20", cents: -1000 },
    ]);
  });

  it("still shows a tip the shopper chose on pickup", () => {
    const view = orderSummary(quote({ tipCents: 200 }), "pickup");
    expect(view.lines).toContainEqual({ key: "tip", label: "Tip", cents: 200 });
  });
});

describe("basketQuoteView", () => {
  const key = "a:1";

  it("shows the quote when it answers the current basket and matches its subtotal", () => {
    expect(basketQuoteView({ key, outcome: "ok", quote: quote() }, key, 4194)).toEqual({
      kind: "quote",
      quote: quote(),
    });
  });

  it("waits while no answer has arrived for the current basket", () => {
    expect(basketQuoteView(null, key, 4194)).toEqual({ kind: "pending" });
    expect(basketQuoteView({ key: "a:2", outcome: "ok", quote: quote() }, key, 4194)).toEqual({ kind: "pending" });
  });

  it("settles to the checkout fallback when the server prices the basket differently", () => {
    expect(basketQuoteView({ key, outcome: "ok", quote: quote() }, key, 3999)).toEqual({ kind: "fallback" });
  });

  it("settles to the checkout fallback on an error or a timeout", () => {
    expect(basketQuoteView({ key, outcome: "error" }, key, 4194)).toEqual({ kind: "fallback" });
    expect(basketQuoteView({ key, outcome: "timeout" }, key, 4194)).toEqual({ kind: "fallback" });
  });
});

describe("checkoutQuoteKey (#708 P1)", () => {
  const contact = { name: "Ada", phone: "2025550199", email: "ada@example.com" };
  const garri = { listingId: "garri", variantId: "1kg", name: "Garri", price: 4000, quantity: 1 };
  const yam = { listingId: "yam", variantId: undefined, name: "Yam", price: 900, quantity: 2 };
  const key = (lines: { listingId: string; variantId?: string; quantity: number }[]) =>
    checkoutQuoteKey({ contact, fulfillment: "pickup", delivery: undefined, couponRev: 0, lines });

  it("a basket changed in checkout makes the held quote stale, so it is asked again", () => {
    const held = key([garri]);
    expect(key([{ ...garri, quantity: 2 }])).not.toBe(held);
    expect(key([garri, yam])).not.toBe(held);
    expect(key([])).not.toBe(held);
  });

  it("the same basket and form keep the quote current", () => {
    expect(key([garri, yam])).toBe(key([{ ...garri }, { ...yam }]));
  });

  it("the form still counts: a new fulfillment is a new quote", () => {
    const pickup = key([garri]);
    const ship = checkoutQuoteKey({ contact, fulfillment: "ship", delivery: undefined, couponRev: 0, lines: [garri] });
    expect(ship).not.toBe(pickup);
  });
});
