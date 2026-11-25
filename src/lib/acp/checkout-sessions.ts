import { createHash, timingSafeEqual } from "node:crypto";
import type { AcpCheckoutSession } from "@prisma/client";
import { applyAddLine, getCartWithLines } from "../cart/service";
import { lockCart, storeScoped, storeScopedTransaction } from "../db";
import { AGENT_REF } from "../directory/attribution";
import { guestPaymentIntentParams } from "../checkout/payment-intent-params";
import { BasketChangedError, placeOrder, quoteCheckout, releaseLosingHold, StoreNotTakingOrdersError } from "../checkout/service";
import { CheckoutProviderError, checkoutPaymentsUseFake, getCheckoutPayments } from "../stripe/checkout-payments";
import { checkCheckoutReady } from "../stripe/checkout-gate";
import type { CheckoutQuote, Contact } from "../customer-flow/contracts";
import type { ValidatedStore } from "../get-store";

/** A session stuck mid-complete (a crashed request) may be completed again after this long. */
const STALE_COMPLETE_MS = 2 * 60_000;

export interface AcpItem {
  id: string;
  quantity: number;
}

export interface AcpBuyer {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
}

export interface AcpMessage {
  type: "info" | "error";
  code?: string;
  content_type: "plain";
  content: string;
}

export type AcpResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number; body: { type: "invalid_request" | "processing_error"; code: string; message: string; param?: string } };

class Refused extends Error {
  constructor(readonly code: string, message: string, readonly param?: string) {
    super(message);
  }
}

const refuse = (status: number, code: string, message: string, param?: string): AcpResult => ({
  ok: false,
  status,
  body: { type: "invalid_request", code, message, ...(param ? { param } : {}) },
});
const NOT_FOUND = refuse(404, "not_found", "No checkout session with that id at this store.");

/**
 * ACP checkout runs only behind its flag, and only where the checkout's Stripe fake is in use (#574):
 * no live agent payment until the owner decides to take one.
 */
export function acpCheckoutEnabled(): boolean {
  return process.env.ACP_CHECKOUT_ENABLED === "1" && checkoutPaymentsUseFake();
}

/** The agent platform's bearer key, compared in constant time. No key set means no caller is authorized. */
export function acpAuthorized(authorization: string | null): boolean {
  const key = process.env.ACP_API_KEY;
  if (!key || !authorization?.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(authorization.slice("Bearer ".length)), digest(key));
}

/** The store the host serves, if it takes ACP checkout: open, opted in to AI assistants, and able to take payment. */
export function acpStoreOpen(store: ValidatedStore | null): store is ValidatedStore {
  if (!store || store.status !== "active" || !store.aiCatalogReadable) return false;
  return checkCheckoutReady({ status: store.status, stripeOnboardingStatus: store.stripeOnboardingStatus }).enabled;
}

function contactOf(session: Pick<AcpCheckoutSession, "buyerName" | "buyerEmail" | "buyerPhone">): Contact {
  return { name: session.buyerName ?? "", email: session.buyerEmail ?? "", phone: session.buyerPhone ?? "" };
}

function buyerFields(buyer: AcpBuyer | undefined) {
  if (!buyer) return {};
  const name = [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim();
  return {
    ...(name ? { buyerName: name } : {}),
    ...(buyer.email ? { buyerEmail: buyer.email } : {}),
    ...(buyer.phone_number ? { buyerPhone: buyer.phone_number } : {}),
  };
}

/** Puts exactly these items in the cart, all or nothing, at the store's own prices. */
async function fillCart(storeId: string, cartId: string, items: AcpItem[], replace: boolean): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockCart(tx, cartId);
    if (replace) await tx.cartLine.deleteMany({ where: { cartId } });
    for (const [index, item] of items.entries()) {
      const applied = await applyAddLine(tx, storeId, cartId, item.id, item.quantity, { requireActive: true });
      if (!applied.ok && applied.code === "max_per_order") {
        const why = applied.stockLeft !== undefined
          ? `Only ${applied.stockLeft} of item ${item.id} left.`
          : `At most ${applied.maxPerOrder} of item ${item.id} per order.`;
        throw new Refused("invalid_quantity", why, `$.line_items[${index}].quantity`);
      }
      if (!applied.ok) {
        throw new Refused("invalid_item_id", `The item ID '${item.id}' does not exist at this store.`, `$.line_items[${index}].id`);
      }
    }
  });
}

async function quoteFor(store: ValidatedStore, session: AcpCheckoutSession): Promise<CheckoutQuote> {
  return quoteCheckout(store.id, store.minimumOrderCents, session.cartId, contactOf(session), "pickup");
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The session as ACP shows it. Every amount comes from the checkout quote; nothing the agent sent is echoed back as a price. */
async function view(store: ValidatedStore, session: AcpCheckoutSession, origin: string, extra: AcpMessage[] = []): Promise<Record<string, unknown>> {
  const [cart, quote, order] = await Promise.all([
    getCartWithLines(store.id, session.cartId),
    quoteFor(store, session),
    session.orderId ? storeScoped(store.id).order.findUnique({ where: { id: session.orderId }, select: { id: true, trackingToken: true } }) : null,
  ]);
  const lines = cart?.lines ?? [];
  const messages: AcpMessage[] = [...extra, ...quote.problems.map((problem) => ({ type: "error" as const, code: problem.code, content_type: "plain" as const, content: problem.message }))];
  if (lines.length === 0) messages.push({ type: "error", code: "empty", content_type: "plain", content: "Add at least one item." });
  const ready = quote.problems.length === 0 && lines.length > 0;
  if (ready && session.status === "open") {
    messages.push({
      type: "info",
      code: "authorization_hold",
      content_type: "plain",
      content: `The card is held for up to ${dollars(quote.holdCents)} and charged the final amount after the store picks the order. Grant a payment token for at least that much.`,
    });
  }
  const status = session.status === "open" ? (ready ? "ready_for_payment" : "not_ready_for_payment") : session.status;
  const total = (type: string, display_text: string, amount: number) => ({ type, display_text, amount });
  return {
    id: session.id,
    status,
    currency: "usd",
    ...(session.buyerName || session.buyerEmail || session.buyerPhone
      ? { buyer: { first_name: session.buyerName ?? "", email: session.buyerEmail ?? "", phone_number: session.buyerPhone ?? "" } }
      : {}),
    line_items: lines.map((line) => ({
      id: line.id,
      item: { id: line.variant.id },
      quantity: line.qty,
      name: line.variant.listing.customName ?? line.variant.listing.masterProduct?.name ?? line.variant.label,
      unit_amount: line.variant.price,
      totals: [total("subtotal", "Subtotal", line.variant.price * line.qty)],
    })),
    fulfillment_options: [{
      type: "pickup",
      id: "pickup",
      title: "Pickup at the store",
      location: { name: store.name },
      pickup_type: "in_store",
    }],
    selected_fulfillment_options: [{ type: "pickup", option_id: "pickup", item_ids: lines.map((line) => line.variant.id) }],
    totals: [
      total("subtotal", "Subtotal", quote.subtotalCents),
      ...(quote.discountCents ? [total("discount", "Discount", quote.discountCents)] : []),
      total("tax", "Tax", quote.taxCents),
      total("fee", "Service fee", quote.serviceFeeCents),
      total("total", "Total", quote.totalCents),
    ],
    messages,
    links: [],
    ...(order ? { order: { id: order.id, checkout_session_id: session.id, permalink_url: `${origin}/order/${order.trackingToken ?? order.id}` } } : {}),
  };
}

async function findSession(storeId: string, id: string): Promise<AcpCheckoutSession | null> {
  return storeScoped(storeId).acpCheckoutSession.findFirst({ where: { id, storeId } });
}

/** A new guest cart (source agent) with these items, and the session that holds it. */
export async function createCheckoutSession(store: ValidatedStore, origin: string, input: { items: AcpItem[]; buyer?: AcpBuyer }): Promise<AcpResult> {
  const cart = await storeScoped(store.id).cart.create({ data: { storeId: store.id, userId: null, customerId: null, source: AGENT_REF } });
  try {
    await fillCart(store.id, cart.id, input.items, false);
  } catch (error) {
    await storeScoped(store.id).cart.delete({ where: { id: cart.id } });
    if (error instanceof Refused) return refuse(400, error.code, error.message, error.param);
    throw error;
  }
  const session = await storeScoped(store.id).acpCheckoutSession.create({
    data: { storeId: store.id, cartId: cart.id, ...buyerFields(input.buyer) },
  });
  return { ok: true, status: 201, body: await view(store, session, origin) };
}

export async function getCheckoutSession(store: ValidatedStore, origin: string, id: string): Promise<AcpResult> {
  const session = await findSession(store.id, id);
  if (!session) return NOT_FOUND;
  return { ok: true, status: 200, body: await view(store, session, origin) };
}

export async function updateCheckoutSession(store: ValidatedStore, origin: string, id: string, input: { items?: AcpItem[]; buyer?: AcpBuyer }): Promise<AcpResult> {
  const session = await findSession(store.id, id);
  if (!session) return NOT_FOUND;
  if (session.status !== "open") return refuse(409, "session_not_open", `This checkout session is ${session.status}.`);
  if (input.items) {
    try {
      await fillCart(store.id, session.cartId, input.items, true);
    } catch (error) {
      if (error instanceof Refused) return refuse(400, error.code, error.message, error.param);
      throw error;
    }
  }
  const updated = await storeScoped(store.id).acpCheckoutSession.update({ where: { id }, data: buyerFields(input.buyer) });
  return { ok: true, status: 200, body: await view(store, updated, origin) };
}

export async function cancelCheckoutSession(store: ValidatedStore, origin: string, id: string): Promise<AcpResult> {
  const canceled = await storeScoped(store.id).acpCheckoutSession.updateMany({ where: { id, storeId: store.id, status: "open" }, data: { status: "canceled" } });
  const session = await findSession(store.id, id);
  if (!session) return NOT_FOUND;
  if (canceled.count === 0 && session.status !== "canceled") return refuse(409, "session_not_open", `This checkout session is ${session.status}.`);
  if (canceled.count > 0) await releaseSessionHolds(store.id, session);
  return { ok: true, status: 200, body: await view(store, session, origin) };
}

/**
 * Pays with the agent's delegated token and places the order (#574). The PaymentIntent is the checkout's own
 * manual-capture destination charge for the quote's hold; `placeOrder` then checks it like any other.
 * One complete per session: the first claims it, a concurrent one is told it is in flight, a later one gets the same order.
 */
export async function completeCheckoutSession(
  store: ValidatedStore,
  origin: string,
  id: string,
  input: { token: string; buyer?: AcpBuyer },
): Promise<AcpResult> {
  const scoped = storeScoped(store.id);
  let session = await findSession(store.id, id);
  if (!session) return NOT_FOUND;
  if (session.status === "completed") return { ok: true, status: 200, body: await view(store, session, origin) };
  if (session.status === "canceled") return refuse(409, "session_not_open", "This checkout session is canceled.");
  if (session.status === "open" && input.buyer) {
    await scoped.acpCheckoutSession.updateMany({ where: { id, status: "open" }, data: buyerFields(input.buyer) });
    session = (await findSession(store.id, id))!;
  }

  const claimed = await scoped.acpCheckoutSession.updateMany({
    where: {
      id,
      storeId: store.id,
      OR: [{ status: "open" }, { status: "complete_in_progress", updatedAt: { lt: new Date(Date.now() - STALE_COMPLETE_MS) } }],
    },
    data: { status: "complete_in_progress" },
  });
  if (claimed.count === 0) {
    const now = await findSession(store.id, id);
    if (now?.status === "completed") return { ok: true, status: 200, body: await view(store, now, origin) };
    return refuse(409, "idempotency_in_flight", "This checkout session is being completed.");
  }

  const reopen = (data: { paymentIntentId?: string } = {}) =>
    scoped.acpCheckoutSession.update({ where: { id }, data: { status: "open", ...data } });
  const contact = contactOf(session);
  const quote = await quoteFor(store, session);
  const cart = await scoped.cart.findUnique({ where: { id: session.cartId }, select: { purchaseEpoch: true, lines: { select: { id: true } } } });
  if (!cart || cart.lines.length === 0 || quote.problems.length > 0) {
    await reopen();
    const reason = quote.problems.map((problem) => problem.message).join(" ") || "Add at least one item.";
    return refuse(400, "not_ready_for_payment", reason);
  }

  let paymentIntentId: string;
  try {
    paymentIntentId = await authorizeWithToken(store, session, quote.holdCents, cart.purchaseEpoch, input.token);
  } catch (error) {
    await reopen();
    if (error instanceof CheckoutProviderError) return refuse(402, "payment_declined", error.message, "$.payment_data");
    throw error;
  }

  try {
    const placed = await placeOrder(store.id, store.minimumOrderCents, session.cartId, contact, "pickup", null, null, paymentIntentId, null, false, false, AGENT_REF);
    const completed = await scoped.acpCheckoutSession.update({ where: { id }, data: { status: "completed", paymentIntentId, orderId: placed.token } });
    return { ok: true, status: 200, body: await view(store, completed, origin) };
  } catch (error) {
    await reopen({ paymentIntentId });
    if (error instanceof BasketChangedError) return refuse(409, "basket_changed", "The prices or items changed. The card hold was released; read the session again and pay with a new token.");
    if (error instanceof StoreNotTakingOrdersError) return refuse(409, "store_closed", error.message);
    throw error;
  }
}

/** Releases any hold this session authorized that did not become its order, except `keep`. */
async function releaseSessionHolds(storeId: string, session: AcpCheckoutSession, keep?: string): Promise<void> {
  const cart = await storeScoped(storeId).cart.findUnique({ where: { id: session.cartId }, select: { paymentIntentId: true } });
  const held = new Set([session.paymentIntentId, cart?.paymentIntentId].filter((id): id is string => !!id && id !== keep));
  for (const id of held) await releaseLosingHold(storeId, session.cartId, id);
}

/** The checkout's guest PaymentIntent, paid by the shared payment token and confirmed at once. Fake only (see acpCheckoutEnabled). */
async function authorizeWithToken(store: ValidatedStore, session: AcpCheckoutSession, holdCents: number, purchaseEpoch: number, token: string): Promise<string> {
  if (!checkoutPaymentsUseFake()) throw new Error("ACP payments run only on the Stripe fake");
  if (!store.stripeAccountId) throw new Error("Store is not connected to Stripe");
  const base = guestPaymentIntentParams({ holdCents, storeAccountId: store.stripeAccountId, storeId: store.id, cartId: session.cartId });
  const params = {
    ...base,
    metadata: { ...base.metadata, purchase_epoch: String(purchaseEpoch) },
    payment_method_data: { shared_payment_granted_token: token },
    confirm: true,
  };
  // The same session and token always make the same intent, so a retried complete never authorizes twice.
  const key = `acp:${session.id}:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  const pi = await getCheckoutPayments().createPaymentIntent(params as unknown as Record<string, unknown>, key);
  // A new token after a failed placement makes a new hold; the earlier one must not stay on the card.
  await releaseSessionHolds(store.id, session, pi.id);
  await storeScoped(store.id).cart.update({ where: { id: session.cartId }, data: { paymentIntentId: pi.id } });
  return pi.id;
}
