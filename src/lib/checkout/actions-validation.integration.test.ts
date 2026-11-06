import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidateTag: () => {}, revalidatePath: () => {} }));

import { createPaymentIntentAction, placeOrderAction, quoteCheckoutAction } from "./actions";
import * as checkoutService from "./service";

describe("checkout input", () => {
  it("bad contact, note or payment intent input returns the existing error with no order or PaymentIntent", async () => {
    const db = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const ordersBefore = await db.order.count();
    const cartsBefore = await db.cart.count();
    const quoteSpy = vi.spyOn(checkoutService, "quoteCheckout");
    const intentSpy = vi.spyOn(checkoutService, "createPaymentIntent");
    const placeSpy = vi.spyOn(checkoutService, "placeOrder");
    try {
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

      expect(quoteSpy).not.toHaveBeenCalled();
      expect(intentSpy).not.toHaveBeenCalled();
      expect(placeSpy).not.toHaveBeenCalled();
      expect(await db.order.count()).toBe(ordersBefore);
      expect(await db.cart.count()).toBe(cartsBefore);
    } finally {
      quoteSpy.mockRestore();
      intentSpy.mockRestore();
      placeSpy.mockRestore();
      await db.$disconnect();
    }
  });
});
