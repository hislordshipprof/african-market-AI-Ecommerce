"use server";

import { getStore } from "../get-store";
import { checkCheckoutReady } from "../stripe/checkout-gate";
import { quoteCheckout, createPaymentIntent, placeOrder } from "./service";
import type { CheckoutInput, CheckoutQuote } from "../customer-flow/contracts";

export async function quoteCheckoutAction(
  input: CheckoutInput,
): Promise<{ ok: true; quote: CheckoutQuote } | { ok: false; error: string }> {
  try {
    const store = await getStore();
    const quote = await quoteCheckout(
      store.id,
      store.minimumOrderCents,
      input,
    );
    return { ok: true, quote };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Quote failed" };
  }
}

export async function createPaymentIntentAction(
  input: CheckoutInput,
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
    const quote = await quoteCheckout(store.id, store.minimumOrderCents, input);
    if (quote.problems.length) {
      return { ok: false, error: quote.problems.map((p) => p.message).join(" ") };
    }
    if (quote.holdCents < 50) {
      return { ok: false, error: "Order total is too low" };
    }
    const result = await createPaymentIntent(store.id, quote.holdCents);
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
  input: CheckoutInput,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  try {
    const store = await getStore();
    const result = await placeOrder(
      store.id,
      store.minimumOrderCents,
      input,
      paymentIntentId,
    );
    return { ok: true, token: result.token };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not place order",
    };
  }
}
