"use server";

import { headers } from "next/headers";
import { auth } from "../auth";
import { getStore } from "../get-store";
import { resolveShopperCart } from "../cart/actions";
import { checkCheckoutReady } from "../stripe/checkout-gate";
import {
  quoteCheckout,
  createPaymentIntent,
  placeOrder,
  SavedCardUnavailableError,
  BasketAlreadyOrderedError,
  BasketChangedError,
} from "./service";
import type { CheckoutQuote, Contact, Fulfillment } from "../customer-flow/contracts";

async function signedInUserId(): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
  return session?.user?.id ?? null;
}

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
  selection?: { saveCard?: boolean; savedCardId?: string | null; attemptToken?: string | null },
): Promise<
  | { ok: true; clientSecret: string; paymentIntentId: string; holdCents: number; attemptToken?: string }
  | { ok: false; error: string; code?: "saved_card_unavailable" }
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
    const actorUserId = await signedInUserId();
    const result = await createPaymentIntent(store.id, cartId, quote.holdCents, actorUserId
      ? {
          actorUserId,
          saveCard: selection?.saveCard === true,
          savedCardId: selection?.savedCardId ?? null,
          attemptToken: selection?.attemptToken ?? null,
        }
      : undefined);
    return { ok: true, ...result, holdCents: quote.holdCents };
  } catch (e) {
    if (e instanceof SavedCardUnavailableError) {
      return { ok: false, error: e.message, code: "saved_card_unavailable" };
    }
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
): Promise<
  | { ok: true; token: string }
  | { ok: false; error: string; code?: "basket_already_ordered" | "basket_changed" }
> {
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
    if (e instanceof BasketAlreadyOrderedError) {
      return { ok: false, error: e.message, code: e.code };
    }
    if (e instanceof BasketChangedError) {
      return { ok: false, error: e.message, code: e.code };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not place order",
    };
  }
}
