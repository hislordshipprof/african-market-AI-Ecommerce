import { describe, it, expect } from "vitest";
import { computeQuote } from "./service";
import type { Contact } from "../customer-flow/contracts";

const validContact: Contact = {
  name: "Jane Doe",
  phone: "+15551234567",
  email: "jane@test.com",
};

function baseLines(
  overrides?: Array<{ price: number; qty: number; maxPerOrder: number | null }>,
) {
  return (
    overrides ?? [{ price: 1200, qty: 2, maxPerOrder: null }]
  );
}

describe("computeQuote", () => {
  it("calculates subtotal and 10% buffer", () => {
    const q = computeQuote(0, baseLines(), validContact, "pickup");
    expect(q.subtotalCents).toBe(2400);
    expect(q.bufferCents).toBe(240);
    expect(q.holdCents).toBe(2640);
    expect(q.totalCents).toBe(2400);
    expect(q.problems).toHaveLength(0);
  });

  it("caps buffer at $20 (2000 cents)", () => {
    const q = computeQuote(
      0,
      [{ price: 25000, qty: 1, maxPerOrder: null }],
      validContact,
      "pickup",
    );
    expect(q.subtotalCents).toBe(25000);
    expect(q.bufferCents).toBe(2000);
    expect(q.holdCents).toBe(27000);
  });

  it("forces tip to 0 for pickup", () => {
    const q = computeQuote(0, baseLines(), validContact, "pickup");
    expect(q.tipCents).toBe(0);
    expect(q.totalCents).toBe(2400);
    expect(q.bufferCents).toBe(240);
    expect(q.holdCents).toBe(2640);
  });

  it("flags minimum order violation", () => {
    const q = computeQuote(5000, baseLines(), validContact, "pickup");
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "minimum-order" }),
      ]),
    );
  });

  it("flags empty cart", () => {
    const q = computeQuote(0, [], validContact, "pickup");
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "minimum-order" }),
      ]),
    );
  });

  it("flags missing contact name", () => {
    const q = computeQuote(
      0,
      baseLines(),
      { name: "", phone: "+15551234567", email: "a@b.com" },
      "pickup",
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags missing email", () => {
    const q = computeQuote(
      0,
      baseLines(),
      { name: "Jane", phone: "+15551234567", email: "" },
      "pickup",
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags invalid email format (no @ sign)", () => {
    const q = computeQuote(
      0,
      baseLines(),
      { name: "Jane", phone: "+15551234567", email: "notanemail" },
      "pickup",
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags invalid phone (too short)", () => {
    const q = computeQuote(
      0,
      baseLines(),
      { name: "Jane", phone: "123", email: "a@b.com" },
      "pickup",
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-contact" }),
      ]),
    );
  });

  it("flags bad quantity (zero)", () => {
    const q = computeQuote(
      0,
      [{ price: 500, qty: 0, maxPerOrder: null }],
      validContact,
      "pickup",
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "max-quantity" }),
      ]),
    );
  });

  it("flags non-pickup fulfillment", () => {
    const q = computeQuote(0, baseLines(), validContact, "store-delivery");
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ineligible" }),
      ]),
    );
  });

  it("returns a valid expiration ~15 minutes out", () => {
    const before = Date.now();
    const q = computeQuote(0, baseLines(), validContact, "pickup");
    const expires = new Date(q.expiresAt).getTime();
    expect(expires).toBeGreaterThan(before + 14 * 60_000);
    expect(expires).toBeLessThanOrEqual(before + 16 * 60_000);
  });

  it("returns unique quote ids", () => {
    const q1 = computeQuote(0, baseLines(), validContact, "pickup");
    const q2 = computeQuote(0, baseLines(), validContact, "pickup");
    expect(q1.id).not.toBe(q2.id);
  });

  it("enforces maxPerOrder limit", () => {
    const q = computeQuote(
      0,
      [{ price: 1000, qty: 5, maxPerOrder: 3 }],
      validContact,
      "pickup",
    );
    expect(q.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "max-quantity" }),
      ]),
    );
  });

  it("client-supplied price has no effect on server-derived amount", () => {
    const serverLines = [{ price: 1200, qty: 2, maxPerOrder: null }];
    const q = computeQuote(0, serverLines, validContact, "pickup");
    expect(q.subtotalCents).toBe(2400);
    expect(q.holdCents).toBe(2640);
  });
});
