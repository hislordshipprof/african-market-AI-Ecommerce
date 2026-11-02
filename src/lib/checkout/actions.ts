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
  holdCents: number,
): Promise<
  | { ok: true; clientSecret: string; paymentIntentId: string }
  | { ok: false; error: string }
> {
  try {
    if (!Number.isSafeInteger(holdCents) || holdCents < 50) {
      return { ok: false, error: "Invalid amount" };
    }
    const store = await getStore();
    const gate = checkCheckoutReady(store.stripeOnboardingStatus);
    if (!gate.enabled) {
      return { ok: false, error: gate.message ?? "Checkout is not available" };
    }
    const result = await createPaymentIntent(store.id, holdCents);
    return { ok: true, ...result };
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
  quote: CheckoutQuote,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  try {
    const store = await getStore();
    const result = await placeOrder(
      store.id,
      input,
      quote,
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
