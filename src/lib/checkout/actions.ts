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
  saveDeliverySnapshot,
  resumeOrderedCart,
  SavedCardUnavailableError,
  BasketAlreadyOrderedError,
  BasketChangedError,
  type DeliveryRequest,
} from "./service";
import type { CheckoutQuote, Contact, Fulfillment } from "../customer-flow/contracts";
import { parseInput } from "../security/parse-input";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { clientIp } from "../assistant/client-ip";
import { confirmDeliveryAddress, lookupConfirmed } from "../address/confirm";
import { platform } from "../db";

const contactSchema = z.strictObject({
  name: z.string().max(200),
  phone: z.string().max(40),
  email: z.string().max(320),
});
const fulfillmentSchema = z.enum(["pickup", "store-delivery", "courier"]);
const selectionSchema = z.strictObject({
  saveCard: z.boolean().optional(),
  savedCardId: z.string().min(1).max(200).nullable().optional(),
  attemptToken: z.string().min(1).max(200).nullable().optional(),
}).optional();
const deliverySchema = z.strictObject({
  line1: z.string().max(80),
  line2: z.string().max(60).nullable().optional(),
  city: z.string().max(40),
  state: z.string().max(40),
  zip: z.string().max(10),
  leaveAtDoor: z.boolean(),
});
const PAYMENT_LIMIT = 30;
const PAYMENT_WINDOW_MS = 60 * 60 * 1000;

function readDelivery(
  fulfillment: Fulfillment,
  delivery: unknown,
): DeliveryRequest | null | { error: string } {
  if (fulfillment !== "store-delivery") return null;
  const parsed = parseInput(deliverySchema, delivery);
  if (!parsed.ok) return { error: "We couldn't find that address" };
  return {
    line1: parsed.data.line1,
    line2: parsed.data.line2 ?? null,
    city: parsed.data.city,
    state: parsed.data.state,
    zip: parsed.data.zip,
    leaveAtDoor: parsed.data.leaveAtDoor,
  };
}

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
  delivery?: unknown,
): Promise<
  | { ok: true; quote: CheckoutQuote; orderedToken?: string }
  | { ok: false; error: string; code?: "basket_already_ordered" }
> {
  const input = readCheckout(contact, fulfillment);
  if (!input.ok) return input;
  // A store-delivery visit with no confirmed address is still a quote: the fee
  // stays visible and Pay can ask the shopper to confirm. Payment and placement
  // keep refusing that payload.
  const request = input.fulfillment === "store-delivery" && delivery == null
    ? null
    : readDelivery(input.fulfillment, delivery);
  if (request && "error" in request) return { ok: false, error: request.error };
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
      request,
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
  delivery?: unknown,
): Promise<
  | { ok: true; orderedToken: string }
  | { ok: true; clientSecret: string; paymentIntentId: string; holdCents: number; attemptToken?: string }
  | { ok: false; error: string; code?: "saved_card_unavailable" | "basket_already_ordered" | "RATE_LIMITED" }
> {
  const input = readCheckout(contact, fulfillment);
  if (!input.ok) return input;
  const request = readDelivery(input.fulfillment, delivery);
  if (request && "error" in request) return { ok: false, error: request.error };
  const selectionParsed = parseInput(selectionSchema, selection);
  if (!selectionParsed.ok) return { ok: false, error: "Payment setup failed" };
  const chosen = selectionParsed.data;
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
      request,
    );
    if (quote.problems.length) {
      return { ok: false, error: quote.problems.map((p) => p.message).join(" ") };
    }
    if (quote.holdCents < 50) {
      return { ok: false, error: "Order total is too low" };
    }
    const fresh = await platform.store.findUnique({ where: { id: store.id } });
    if (!fresh) return { ok: false, error: "Payment setup failed" };
    let snapshot: {
      line1: string;
      line2: string | null;
      city: string;
      state: string;
      zip: string;
      lat: number;
      lng: number;
      leaveAtDoor: boolean;
    } | null = null;
    if (request) {
      if (fresh.lat == null || fresh.lng == null) {
        return { ok: false, error: "Only pickup is available for this store." };
      }
      const cached = await lookupConfirmed(
        { line1: request.line1, city: request.city, state: request.state, zip: request.zip },
        { lat: fresh.lat, lng: fresh.lng, radiusMi: Number(fresh.deliveryRadiusMi) },
      );
      if (!cached) return { ok: false, error: "We couldn't find that address" };
      if (!cached.ok) return { ok: false, error: cached.message };
      if (!cached.withinRadius) {
        return { ok: false, error: "That address is outside the delivery area" };
      }
      snapshot = {
        line1: cached.match.line1,
        line2: request.line2 ?? null,
        city: cached.match.city,
        state: cached.match.state,
        zip: cached.match.zip,
        lat: cached.match.lat,
        lng: cached.match.lng,
        leaveAtDoor: request.leaveAtDoor,
      };
    }
    const result = await createPaymentIntent(store.id, cartId, quote.holdCents, actorUserId
      ? {
          actorUserId,
          saveCard: chosen?.saveCard === true,
          savedCardId: chosen?.savedCardId ?? null,
          attemptToken: chosen?.attemptToken ?? null,
        }
      : undefined);
    await saveDeliverySnapshot(store.id, cartId, input.fulfillment === "pickup" ? null : snapshot);
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
  delivery?: unknown,
): Promise<
  | { ok: true; token: string }
  | { ok: false; error: string; code?: "basket_already_ordered" | "basket_changed" }
> {
  const input = readCheckout(contact, fulfillment);
  if (!input.ok) return input;
  const request = readDelivery(input.fulfillment, delivery);
  if (request && "error" in request) return { ok: false, error: request.error };
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
      request?.leaveAtDoor ?? false,
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

export async function confirmAddressAction(delivery: unknown): Promise<
  | {
      ok: true;
      formatted: string;
      line1: string;
      city: string;
      state: string;
      zip: string;
      withinRadius: boolean;
      distanceMi: number;
      message: string | null;
    }
  | { ok: false; error: string }
> {
  const parsed = parseInput(deliverySchema, delivery);
  if (!parsed.ok) return { ok: false, error: "We couldn't find that address" };
  try {
    const store = await getStore();
    if (store.lat == null || store.lng == null || Number(store.deliveryRadiusMi) <= 0) {
      return { ok: false, error: "Only pickup is available for this store." };
    }
    const decision = await confirmDeliveryAddress(
      {
        line1: parsed.data.line1,
        city: parsed.data.city,
        state: parsed.data.state,
        zip: parsed.data.zip,
      },
      { lat: store.lat, lng: store.lng, radiusMi: Number(store.deliveryRadiusMi) },
      { limit: true, ip: clientIp(await headers()) },
    );
    if (!decision.ok) return { ok: false, error: decision.message };
    return {
      ok: true,
      formatted: decision.match.formattedAddress,
      line1: decision.match.line1,
      city: decision.match.city,
      state: decision.match.state,
      zip: decision.match.zip,
      withinRadius: decision.withinRadius,
      distanceMi: decision.roundedMi,
      message: decision.withinRadius ? null : "That address is outside the delivery area",
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "We couldn't check that address right now. Try again." };
  }
}
