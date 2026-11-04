"use server";

import { getStore } from "../get-store";
import { resolveShopperCart } from "../cart/actions";
import { checkCheckoutReady } from "../stripe/checkout-gate";
import { quoteCheckout, createPaymentIntent, placeOrder } from "./service";
import type { CheckoutQuote, Contact, Fulfillment } from "../customer-flow/contracts";

export async function quoteCheckoutAction(
  contact: Contact,
  fulfillment: Fulfillment,
): Promise<{ ok: true; quote: CheckoutQuote } | { ok: false; error: string }> {
  try {
    const store = await getStore();
    const resolved = await resolveShopperCart();
    if (!resolved) return { ok: false, error: "No cart found" };
    const cartId = resolved.cartId;
    const quote = await quoteCheckout(
      store.id,
      store.minimumOrderCents,
      cartId,
      contact,
      fulfillment,
    );
    return { ok: true, quote };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Quote failed" };
  }
}

export async function createPaymentIntentAction(
  contact: Contact,
  fulfillment: Fulfillment,
): Promise<
  | { ok: true; clientSecret: string; paymentIntentId: string; holdCents: number }
  | { ok: false; error: string }
> {
  try {
    const store = await getStore();
    const gate = checkCheckoutReady(store.stripeOnboardingStatus);
    if (!gate.enabled) {
      return { ok: false, error: gate.message ?? "Checkout is not available" };
    }
    const resolved = await resolveShopperCart();
    if (!resolved) return { ok: false, error: "No cart found" };
    const cartId = resolved.cartId;
    const quote = await quoteCheckout(
      store.id,
      store.minimumOrderCents,
      cartId,
      contact,
      fulfillment,
    );
    if (quote.problems.length) {
      return { ok: false, error: quote.problems.map((p) => p.message).join(" ") };
    }
    if (quote.holdCents < 50) {
      return { ok: false, error: "Order total is too low" };
    }
    const result = await createPaymentIntent(store.id, cartId, quote.holdCents);
    return { ok: true, ...result, holdCents: quote.holdCents };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Payment setup failed",
    };
  }
}

export async function placeOrderAction(
  paymentIntentId: string,
  contact: Contact,
  fulfillment: Fulfillment,
  notes: string,
  slot: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  try {
    const store = await getStore();
    const resolved = await resolveShopperCart();
    if (!resolved) return { ok: false, error: "No cart found" };
    const cartId = resolved.cartId;
    const result = await placeOrder(
      store.id,
      store.minimumOrderCents,
      cartId,
      contact,
      fulfillment,
      notes || null,
      slot !== "asap" ? slot : null,
      paymentIntentId,
      resolved.userId,
    );
    return { ok: true, token: result.token };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not place order",
    };
  }
}
