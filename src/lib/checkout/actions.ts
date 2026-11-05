"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "../auth";
import { getStore } from "../get-store";
import { resolveShopperCart } from "../cart/actions";
import { checkCheckoutReady } from "../stripe/checkout-gate";
import {
  quoteCheckout,
  createPaymentIntent,
  placeOrder,
  resumeOrderedCart,
  SavedCardUnavailableError,
  BasketAlreadyOrderedError,
  BasketChangedError,
} from "./service";
import type { CheckoutQuote, Contact, Fulfillment } from "../customer-flow/contracts";
import { parseInput } from "../security/parse-input";
import { takeRateLimit } from "../rate-limit/app-limiter";

const contactSchema = z.strictObject({
  name: z.string().max(200),
  phone: z.string().max(40),
  email: z.string().max(320),
});
const fulfillmentSchema = z.enum(["pickup", "store-delivery", "courier"]);
const PAYMENT_LIMIT = 30;
const PAYMENT_WINDOW_MS = 60 * 60 * 1000;

function readCheckout(
  contact: unknown,
  fulfillment: unknown,
): { ok: true; contact: Contact; fulfillment: Fulfillment } | { ok: false; error: string } {
  const parsedContact = parseInput(contactSchema, contact);
  const parsedFulfillment = parseInput(fulfillmentSchema, fulfillment);
  if (!parsedContact.ok || !parsedFulfillment.ok) {
    return { ok: false, error: "Name, email, and a valid phone number are required." };
  }
  return { ok: true, contact: parsedContact.data, fulfillment: parsedFulfillment.data };
}

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
): Promise<
  | { ok: true; quote: CheckoutQuote; orderedToken?: string }
  | { ok: false; error: string; code?: "basket_already_ordered" }
> {
  const input = readCheckout(contact, fulfillment);
  if (!input.ok) return input;
  try {
    const store = await getStore();
    const resolved = await resolveShopperCart();
    if (!resolved) return { ok: false, error: "No cart found" };
    const cartId = resolved.cartId;
    const actorUserId = await signedInUserId();
    const resume = await resumeOrderedCart(store.id, cartId, actorUserId);
    if (resume?.kind === "unproved") {
      return { ok: false, error: "This order was already placed", code: "basket_already_ordered" };
    }
    const quote = await quoteCheckout(
      store.id,
      store.minimumOrderCents,
      resolved.cartId,
      input.contact,
      input.fulfillment,
    );
    if (resume?.kind === "order") return { ok: true, quote, orderedToken: resume.token };
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
  | { ok: true; orderedToken: string }
  | { ok: true; clientSecret: string; paymentIntentId: string; holdCents: number; attemptToken?: string }
  | { ok: false; error: string; code?: "saved_card_unavailable" | "basket_already_ordered" | "RATE_LIMITED" }
> {
  const input = readCheckout(contact, fulfillment);
  if (!input.ok) return input;
  try {
    const store = await getStore();
    const gate = checkCheckoutReady(store.stripeOnboardingStatus);
    if (!gate.enabled) {
      return { ok: false, error: gate.message ?? "Checkout is not available" };
    }
    const resolved = await resolveShopperCart();
    if (!resolved) return { ok: false, error: "No cart found" };
    const cartId = resolved.cartId;
    const actorUserId = await signedInUserId();
    const resume = await resumeOrderedCart(store.id, cartId, actorUserId);
    if (resume?.kind === "order") return { ok: true, orderedToken: resume.token };
    if (resume?.kind === "unproved") {
      return { ok: false, error: "This order was already placed", code: "basket_already_ordered" };
    }
    const limit = await takeRateLimit(`payment:${cartId}`, PAYMENT_LIMIT, PAYMENT_WINDOW_MS);
    if (!limit.ok) {
      return {
        ok: false,
        error: "Too many payment attempts. Please wait and try again.",
        code: "RATE_LIMITED",
      };
    }
    const quote = await quoteCheckout(
      store.id,
      store.minimumOrderCents,
      cartId,
      input.contact,
      input.fulfillment,
    );
    if (quote.problems.length) {
      return { ok: false, error: quote.problems.map((p) => p.message).join(" ") };
    }
    if (quote.holdCents < 50) {
      return { ok: false, error: "Order total is too low" };
    }
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
  const input = readCheckout(contact, fulfillment);
  if (!input.ok) return input;
  const payment = parseInput(z.string().min(1).max(200), paymentIntentId);
  const note = parseInput(z.string().max(2000), notes);
  const when = parseInput(z.string().max(80), slot);
  if (!payment.ok || !note.ok || !when.ok) return { ok: false, error: "Could not place order" };
  try {
    const store = await getStore();
    const resolved = await resolveShopperCart();
    if (!resolved) return { ok: false, error: "No cart found" };
    const result = await placeOrder(
      store.id,
      store.minimumOrderCents,
      resolved.cartId,
      input.contact,
      input.fulfillment,
      note.data || null,
      when.data !== "asap" ? when.data : null,
      payment.data,
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
