import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidateTag: () => {}, revalidatePath: () => {} }));

import { createPaymentIntentAction, placeOrderAction, quoteCheckoutAction } from "./actions";

describe("checkout input", () => {
  it("bad contact, note or payment intent input returns the existing error with no order or PaymentIntent", async () => {
    const badContact = { name: 1, phone: "555", email: "a@b.test" };
    const quote = await quoteCheckoutAction(badContact as never, "pickup");
    expect(quote).toEqual({ ok: false, error: "Name, email, and a valid phone number are required." });

    const payment = await createPaymentIntentAction(badContact as never, "pickup");
    expect(payment.ok).toBe(false);
    if (!payment.ok) expect(payment.error).toBe("Name, email, and a valid phone number are required.");

    const contact = { name: "Ada", phone: "555", email: "a@b.test" };
    const note = await placeOrderAction("pi_123", contact, "pickup", "n".repeat(5000), "asap");
    expect(note).toEqual({ ok: false, error: "Could not place order" });

    const intent = await placeOrderAction("p".repeat(201), contact, "pickup", "", "asap");
    expect(intent).toEqual({ ok: false, error: "Could not place order" });
  });
});
