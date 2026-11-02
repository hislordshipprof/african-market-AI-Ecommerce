import { describe, it, expect } from "vitest";
import { quoteCheckout } from "./service";
import type { CheckoutInput } from "../customer-flow/contracts";

function baseInput(overrides?: Partial<CheckoutInput>): CheckoutInput {
  return {
    lines: [
      {
        listingId: "listing-1",
        variantId: "variant-1",
        name: "Egusi Seeds 500g",
        price: 1200,
        quantity: 2,
      },
    ],
    fulfillment: "pickup",
    contact: { name: "Jane Doe", phone: "+15551234567", email: "jane@test.com" },
    notes: "",
    leaveAtDoor: false,
    slot: "asap",
    promoCode: "",
    tipCents: 0,
    ...overrides,
  };
}

describe("quoteCheckout", () => {
  it("calculates subtotal and 10% buffer", async () => {
    const q = await quoteCheckout("store-1", 0, baseInput());
    expect(q.subtotalCents).toBe(2400);
    expect(q.bufferCents).toBe(240);
    expect(q.holdCents).toBe(2640);
    expect(q.totalCents).toBe(2400);
    expect(q.problems).toHaveLength(0);
  });

  it("caps buffer at $20 (2000 cents)", async () => {
    const input = baseInput({
      lines: [
        { listingId: "l-1", variantId: "v-1", name: "Bulk item", price: 25000, quantity: 1 },
      ],
    });
    const q = await quoteCheckout("store-1", 0, input);
    expect(q.subtotalCents).toBe(25000);
    expect(q.bufferCents).toBe(2000);
    expect(q.holdCents).toBe(27000);
  });

  it("includes tip in holdCents but not bufferCents", async () => {
    const q = await quoteCheckout("store-1", 0, baseInput({ tipCents: 500 }));
    expect(q.tipCents).toBe(500);
    expect(q.totalCents).toBe(2900);
    expect(q.bufferCents).toBe(240);
    expect(q.holdCents).toBe(3140);
  });

  it("flags minimum order violation", async () => {
    const q = await quoteCheckout("store-1", 5000, baseInput());
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "minimum-order" }),
      ]),
    );
  });

  it("flags empty cart", async () => {
    const q = await quoteCheckout("store-1", 0, baseInput({ lines: [] }));
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "minimum-order" }),
      ]),
    );
  });

  it("flags missing contact name", async () => {
    const q = await quoteCheckout(
      "store-1",
      0,
      baseInput({ contact: { name: "", phone: "+15551234567", email: "a@b.com" } }),
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags missing email", async () => {
    const q = await quoteCheckout(
      "store-1",
      0,
      baseInput({ contact: { name: "Jane", phone: "+15551234567", email: "" } }),
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags invalid phone (too short)", async () => {
    const q = await quoteCheckout(
      "store-1",
      0,
      baseInput({ contact: { name: "Jane", phone: "123", email: "a@b.com" } }),
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags bad quantity (zero)", async () => {
    const input = baseInput({
      lines: [
        { listingId: "l-1", variantId: "v-1", name: "Item", price: 500, quantity: 0 },
      ],
    });
    const q = await quoteCheckout("store-1", 0, input);
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "max-quantity" }),
      ]),
    );
  });

  it("sanitizes negative tipCents", async () => {
    const q = await quoteCheckout("store-1", 0, baseInput({ tipCents: -100 }));
    expect(q.tipCents).toBe(0);
  });

  it("returns a valid expiration ~15 minutes out", async () => {
    const before = Date.now();
    const q = await quoteCheckout("store-1", 0, baseInput());
    const expires = new Date(q.expiresAt).getTime();
    expect(expires).toBeGreaterThan(before + 14 * 60_000);
    expect(expires).toBeLessThanOrEqual(before + 16 * 60_000);
  });

  it("returns unique quote ids", async () => {
    const q1 = await quoteCheckout("store-1", 0, baseInput());
    const q2 = await quoteCheckout("store-1", 0, baseInput());
    expect(q1.id).not.toBe(q2.id);
  });
});
