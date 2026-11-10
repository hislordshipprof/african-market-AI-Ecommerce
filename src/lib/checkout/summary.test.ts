import { describe, expect, it } from "vitest";
import type { CheckoutQuote } from "../customer-flow/contracts";
import { basketQuoteView, orderSummary } from "./summary";

function quote(overrides: Partial<CheckoutQuote> = {}): CheckoutQuote {
  return {
    id: "q1",
    subtotalCents: 4194,
    deliveryFeeCents: 0,
    courierFeeCents: 0,
    taxCents: 0,
    tipCents: 0,
    discountCents: 0,
    totalCents: 4194,
    bufferCents: 419,
    holdCents: 4613,
    expiresAt: "2026-11-09T12:00:00.000Z",
    problems: [],
    ...overrides,
  };
}

const labels = (view: ReturnType<typeof orderSummary>) =>
  view.lines.map((line) => line.label);

describe("orderSummary", () => {
  it("shows the server quote's money for a pickup basket, with no invented tax or tip", () => {
    const view = orderSummary(quote(), "pickup");
    expect(view.lines.map((line) => [line.label, line.cents])).toEqual([
      ["Subtotal", 4194],
      ["Estimated tax", 0],
    ]);
    expect(view.totalCents).toBe(4194);
    expect(view.holdCents).toBe(4613);
    expect(view.bufferCents).toBe(419);
  });

  it("shows the store delivery fee and tip choice on a store-delivery order", () => {
    const view = orderSummary(
      quote({ deliveryFeeCents: 499, totalCents: 4693, holdCents: 5112 }),
      "store-delivery",
    );
    expect(view.lines.map((line) => [line.label, line.cents])).toEqual([
      ["Subtotal", 4194],
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
