import { Prisma } from "@prisma/client";
import { storeScopedTransaction, lockStoreRow, lockCart, getNextOrderNumber, storeScoped, orderExistsForPaymentIntent } from "../db";
import { getCartWithLines, type CartLineView } from "../cart/service";
import { getStripeClient } from "../stripe/provider";
import { checkoutPaymentsUseFake, getCheckoutPayments, type NormalizedPaymentIntent } from "../stripe/checkout-payments";
import { sendOrderAuthorized } from "../inngest/send";
import { scheduleAfterResponse } from "../schedule-after-response";
import { checkoutTestHooks } from "./test-hooks";
import { cartPaymentIdempotencyKey } from "../customer-account/consent";
import { guestPaymentIntentParams, nextAttemptToken, paymentIntentProvenanceOk } from "./payment-intent-params";
import { bindSavedCardConsent, prepareSignedInPaymentIntent } from "./saved-card-payment";
import { platformFeeCentsForCapture } from "../order/platform-fee";
import { validPhone } from "../customer-account/phone";
import type {
  CheckoutQuote,
  Contact,
  FlowProblem,
  Fulfillment,
} from "../customer-flow/contracts";

async function getStripeStore(storeId: string) {
  const store = await (await import("../db")).platform.store.findUnique({ where: { id: storeId } });
  if (!store?.stripeAccountId) {
    throw new Error("Store is not connected to Stripe");
  }
  return store as typeof store & { stripeAccountId: string };
}

const SETTLED_PAYMENT = new Set(["requires_capture", "processing", "succeeded"]);
const OPENABLE_PAYMENT = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);

export class BasketAlreadyOrderedError extends Error {
  readonly code = "basket_already_ordered" as const;
  constructor() {
    super("This order was already placed");
    this.name = "BasketAlreadyOrderedError";
  }
}

export class BasketChangedError extends Error {
  readonly code = "basket_changed" as const;
  constructor() {
    super("Your basket changed. Your card was not charged.");
    this.name = "BasketChangedError";
  }
}

function epochStamp(metadata: Record<string, string> | null | undefined): {
  present: boolean;
  epoch: number | null;
} {
  if (!metadata || metadata.purchase_epoch == null) return { present: false, epoch: null };
  const raw = metadata.purchase_epoch;
  if (!/^\d+$/.test(raw)) return { present: true, epoch: null };
  return { present: true, epoch: Number(raw) };
}

function sameBasket(
  current: AuthorizedOrderLine[],
  requested: AuthorizedOrderLine[],
): boolean {
  if (current.length !== requested.length) return false;
  const key = (line: AuthorizedOrderLine) =>
    [line.variantId, line.qty, line.price, line.swapRule, line.substituteVariantId ?? ""].join(":");
  const left = current.map(key).sort();
  const right = requested.map(key).sort();
  return left.every((value, index) => value === right[index]);
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  if ("deleted" in value && (value as { deleted?: boolean }).deleted) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function fakeIntent(id: string | null | undefined): boolean {
  return checkoutPaymentsUseFake() && Boolean(id?.startsWith("pi_fake_"));
}

async function retrieveCheckoutIntent(id: string): Promise<NormalizedPaymentIntent> {
  if (fakeIntent(id)) return getCheckoutPayments().retrievePaymentIntent(id);
  const pi = await getStripeClient().paymentIntents.retrieve(id);
  const destination = pi.transfer_data?.destination;
  return {
    id: pi.id,
    status: pi.status,
    amount: pi.amount,
    currency: pi.currency,
    customer: idOf(pi.customer),
    setup_future_usage: pi.setup_future_usage,
    payment_method: idOf(pi.payment_method),
    client_secret: pi.client_secret,
    on_behalf_of: idOf(pi.on_behalf_of),
    transfer_data: pi.transfer_data
      ? { destination: typeof destination === "string" ? destination : destination?.id ?? null }
      : null,
    metadata: pi.metadata ?? {},
    capture_method: pi.capture_method,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function computeQuote(
  minimumOrderCents: number,
  cartLines: ReadonlyArray<{ price: number; qty: number; maxPerOrder: number | null }>,
  contact: Contact,
  fulfillment: Fulfillment,
): CheckoutQuote {
  const problems: FlowProblem[] = [];
  let subtotalCents = 0;

  for (const line of cartLines) {
    if (
      !Number.isInteger(line.qty) ||
      line.qty < 1
    ) {
      problems.push({ code: "max-quantity", message: "Check item quantity." });
      continue;
    }
    if (line.maxPerOrder !== null && line.qty > line.maxPerOrder) {
      problems.push({
        code: "max-quantity",
        message: `Maximum ${line.maxPerOrder} per order for this item.`,
      });
    }
    subtotalCents += line.price * line.qty;
  }

  if (!cartLines.length || subtotalCents < minimumOrderCents) {
    problems.push({
      code: "minimum-order",
      message: `Minimum order is $${(minimumOrderCents / 100).toFixed(2)}.`,
    });
  }

  if (
    !contact.name.trim() ||
    !validEmail(contact.email) ||
    !validPhone(contact.phone)
  ) {
    problems.push({
      code: "invalid-contact",
      message: "Name, email, and a valid phone number are required.",
    });
  }

  if (fulfillment !== "pickup") {
    problems.push({
      code: "ineligible",
      message: "Only pickup is available for this store.",
    });
  }

  const tipCents = 0;
  const totalCents = subtotalCents + tipCents;
  const bufferCents = Math.min(Math.round(subtotalCents * 0.1), 2000);
  const holdCents = totalCents + bufferCents;

  return {
    id: crypto.randomUUID(),
    subtotalCents,
    deliveryFeeCents: 0,
    courierFeeCents: 0,
    taxCents: 0,
    tipCents,
    discountCents: 0,
    totalCents,
    bufferCents,
    holdCents,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    problems,
  };
}

export async function quoteCheckout(
  storeId: string,
  minimumOrderCents: number,
  cartId: string,
  contact: Contact,
  fulfillment: Fulfillment,
): Promise<CheckoutQuote> {
  const cart = await getCartWithLines(storeId, cartId);
  if (!cart || !cart.lines.length) {
    return computeQuote(minimumOrderCents, [], contact, fulfillment);
  }
  const serverLines = cart.lines.map((l) => ({
    price: l.variant.price,
    qty: l.qty,
    maxPerOrder: l.variant.listing.maxPerOrder,
  }));
  return computeQuote(minimumOrderCents, serverLines, contact, fulfillment);
}

export { checkoutTestHooks } from "./test-hooks";
export { SavedCardUnavailableError } from "./saved-card-payment";

export interface CreatePaymentIntentOptions {
  actorUserId?: string | null;
  saveCard?: boolean;
  savedCardId?: string | null;
  attemptToken?: string | null;
}

export async function createPaymentIntent(
  storeId: string,
  cartId: string,
  holdCents: number,
  options?: CreatePaymentIntentOptions,
): Promise<{ clientSecret: string; paymentIntentId: string; attemptToken?: string }> {
  const store = await getStripeStore(storeId);
  if (options?.actorUserId) {
    return prepareSignedInPaymentIntent(storeId, cartId, holdCents, {
      actorUserId: options.actorUserId,
      saveCard: options.saveCard === true,
      savedCardId: options.savedCardId ?? null,
      attemptToken: options.attemptToken ?? null,
    }, store.stripeAccountId);
  }
  const reserved = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await lockCart(tx, cartId);
    const cart = await tx.cart.findUnique({ where: { id: cartId } });
    if (!cart) throw new Error("Cart not found");

    if (cart.paymentIntentId) {
      const existing = await retrieveCheckoutIntent(cart.paymentIntentId);
      const provenanceOk = paymentIntentProvenanceOk(existing, {
        storeId,
        cartId,
        storeAccountId: store.stripeAccountId,
      });
      if (provenanceOk && SETTLED_PAYMENT.has(existing.status)) {
        throw new Error("Payment already confirmed for this cart");
      }
      if (provenanceOk && OPENABLE_PAYMENT.has(existing.status)) {
        if (!existing.client_secret) throw new Error("Stripe did not return a client secret");
        return {
          kind: "reuse" as const,
          clientSecret: existing.client_secret,
          paymentIntentId: existing.id,
          amount: existing.amount,
          purchaseEpoch: cart.purchaseEpoch,
        };
      }
    }

    const generation = nextAttemptToken({
      paymentIntentId: cart.paymentIntentId,
      storedToken: cart.paymentAttemptToken,
      fingerprint: `guest:${holdCents}`,
      forceNew: false,
    });
    await tx.cart.update({
      where: { id: cartId },
      data: { paymentAttemptToken: generation, paymentIntentId: null },
    });
    return { kind: "create" as const, generation, purchaseEpoch: cart.purchaseEpoch };
  }, { timeout: 20_000, maxWait: 8_000 });

  if (reserved.kind === "reuse") {
    if (reserved.amount !== holdCents) {
      const patch = {
        amount: holdCents,
        metadata: { purchase_epoch: String(reserved.purchaseEpoch) },
      };
      if (fakeIntent(reserved.paymentIntentId)) {
        await getCheckoutPayments().updatePaymentIntent(reserved.paymentIntentId, patch);
      } else {
        await getStripeClient().paymentIntents.update(reserved.paymentIntentId, patch);
      }
    }
    return { clientSecret: reserved.clientSecret, paymentIntentId: reserved.paymentIntentId };
  }

  const guestBase = guestPaymentIntentParams({
    holdCents,
    storeAccountId: store.stripeAccountId,
    storeId,
    cartId,
  });
  const guestParams = {
    ...guestBase,
    metadata: { ...guestBase.metadata, purchase_epoch: String(reserved.purchaseEpoch) },
  };
  const guestKey = cartPaymentIdempotencyKey(cartId, reserved.generation);
  const pi = checkoutPaymentsUseFake()
    ? await getCheckoutPayments().createPaymentIntent(guestParams as unknown as Record<string, unknown>, guestKey)
    : await getStripeClient().paymentIntents.create(guestParams, { idempotencyKey: guestKey });

  if (process.env.NODE_ENV === "test" && checkoutTestHooks.beforePersistCartPaymentIntent) {
    await checkoutTestHooks.beforePersistCartPaymentIntent();
  }

  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await lockCart(tx, cartId);
    const current = await tx.cart.findUnique({ where: { id: cartId } });
    if (!current || current.paymentAttemptToken !== reserved.generation) return;
    await tx.cart.update({
      where: { id: cartId },
      data: { paymentIntentId: pi.id, paymentAttemptToken: reserved.generation },
    });
  });

  if (!pi.client_secret) {
    throw new Error("Stripe did not return a client secret");
  }

  return { clientSecret: pi.client_secret, paymentIntentId: pi.id };
}

function runTestHook(hook: (() => Promise<void>) | null): Promise<void> {
  if (process.env.NODE_ENV === "test" && hook) return hook();
  return Promise.resolve();
}

export interface AuthorizedOrderLine {
  variantId: string;
  qty: number;
  price: number;
  swapRule: string;
  substituteVariantId: string | null;
}

export interface RecordAuthorizedOrderInput {
  cartId: string;
  contact: Contact;
  fulfillment: Fulfillment;
  pickupSlot: string | null;
  notes: string | null;
  paymentIntentId: string;
  quote: CheckoutQuote;
  lines: AuthorizedOrderLine[];
  /** When set, including null for a guest, the locked cart must still belong to this actor. */
  actorUserId?: string | null;
  paymentAmount?: number;
  /** Null when the intent was created before purchase epochs were stamped. */
  purchaseEpoch?: number | null;
  /** True when metadata includes purchase_epoch, including a value that is not a number. */
  epochPresent?: boolean;
  minimumOrderCents?: number;
}

function paymentIntentTaken(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  const target = err.meta?.target;
  const text = `${err.message} ${JSON.stringify(target ?? "")}`;
  return text.includes("payment_intent") || text.includes("paymentIntentId");
}

/**
 * Trusted persistence for an already-verified PaymentIntent. Does not call
 * Stripe and does not look up another store's order. The caller has checked
 * the PaymentIntent's status, destination, on_behalf_of, store metadata and
 * amount. A cart or variant this store cannot see is rejected before any write.
 */
export async function recordAuthorizedOrder(
  storeId: string,
  input: RecordAuthorizedOrderInput,
): Promise<{ orderId: string; created: boolean }> {
  try {
    return await storeScopedTransaction(storeId, async (tx) => {
      await lockStoreRow(tx, storeId);

      const existing = await tx.order.findUnique({
        where: { paymentIntentId: input.paymentIntentId },
      });
      if (existing) {
        if (existing.sourceCartId && existing.sourceCartId !== input.cartId) {
          throw new Error("PaymentIntent is already recorded");
        }
        if (input.actorUserId !== undefined) {
          const ownerCart = await tx.cart.findUnique({ where: { id: input.cartId } });
          if (!ownerCart || ownerCart.userId !== input.actorUserId) {
            throw new Error("Cart not found");
          }
        }
        return { orderId: existing.id, created: false };
      }

      if (input.lines.length === 0) {
        throw new Error("Order lines are required");
      }

      await lockCart(tx, input.cartId);
      const released = await tx.paymentIntentRelease.findUnique({
        where: { paymentIntentId: input.paymentIntentId },
      });
      if (released) throw new BasketChangedError();
      const cart = await tx.cart.findUnique({ where: { id: input.cartId } });
      if (!cart || cart.storeId !== storeId) {
        throw new Error("Cart not found");
      }
      if (input.actorUserId !== undefined && cart.userId !== input.actorUserId) {
        throw new Error("Cart not found");
      }
      if (input.epochPresent === true && input.purchaseEpoch !== cart.purchaseEpoch) {
        throw new BasketAlreadyOrderedError();
      }
      if (input.epochPresent === false && cart.purchaseEpoch > 0) {
        throw new BasketAlreadyOrderedError();
      }

      const currentLines = await tx.cartLine.findMany({
        where: { cartId: input.cartId },
        include: { variant: { include: { listing: true } } },
      });
      if (currentLines.length === 0) throw new BasketAlreadyOrderedError();
      const current = currentLines.map((line) => ({
        variantId: line.variantId,
        qty: line.qty,
        price: line.variant.price,
        swapRule: line.swapRule,
        substituteVariantId: line.substituteVariantId,
        maxPerOrder: line.variant.listing.maxPerOrder,
      }));
      if (!sameBasket(current, input.lines)) throw new BasketChangedError();
      const currentQuote = computeQuote(
        input.minimumOrderCents ?? 0,
        current,
        input.contact,
        input.fulfillment,
      );
      if (currentQuote.holdCents !== (input.paymentAmount ?? input.quote.holdCents)) {
        throw new BasketChangedError();
      }

      const variantIds = [
        ...new Set(
          input.lines.flatMap((line) =>
            line.substituteVariantId
              ? [line.variantId, line.substituteVariantId]
              : [line.variantId],
          ),
        ),
      ];
      const owned = await tx.listingVariant.findMany({
        where: { id: { in: variantIds } },
        include: { listing: true },
      });
      const ownedById = new Map(owned.map((variant) => [variant.id, variant]));
      for (const line of input.lines) {
        const variant = ownedById.get(line.variantId);
        if (!variant || variant.listing.storeId !== storeId) {
          throw new Error(`Variant ${line.variantId} does not belong to this store`);
        }
        if (line.substituteVariantId) {
          const substitute = ownedById.get(line.substituteVariantId);
          if (!substitute || substitute.listing.storeId !== storeId) {
            throw new Error(
              `Substitute variant ${line.substituteVariantId} does not belong to this store`,
            );
          }
        }
      }

      const customer = await tx.customer.create({
        data: {
          storeId,
          name: input.contact.name.trim(),
          email: input.contact.email.trim().toLowerCase(),
          phone: input.contact.phone.trim(),
        },
      });
      const nextNumber = await getNextOrderNumber(tx, storeId);
      const order = await tx.order.create({
        data: {
          storeId,
          number: nextNumber,
          customerId: customer.id,
          status: "AUTHORIZED",
          fulfillment: input.fulfillment,
          pickupSlot: input.pickupSlot !== "asap" ? input.pickupSlot : null,
          subtotalCents: input.quote.subtotalCents,
          tipCents: input.quote.tipCents,
          bufferCents: input.quote.bufferCents,
          totalAuthorizedCents: input.quote.holdCents,
          paymentIntentId: input.paymentIntentId,
          sourceCartId: input.cartId,
          platformFeeCents: platformFeeCentsForCapture(input.quote.totalCents),
          notes: input.notes || null,
        },
      });
      await tx.orderLine.createMany({
        data: input.lines.map((line) => ({
          storeId,
          orderId: order.id,
          listingVariantId: line.variantId,
          substituteVariantId: line.substituteVariantId,
          qtyOrdered: line.qty,
          unitPriceCents: line.price,
          swapRule: line.swapRule,
        })),
      });
      await tx.cartLine.deleteMany({ where: { cartId: input.cartId } });
      await tx.cart.update({
        where: { id: input.cartId },
        data: {
          paymentIntentId: null,
          paymentAttemptToken: null,
          purchaseEpoch: { increment: 1 },
        },
      });
      return { orderId: order.id, created: true };
    }, { timeout: 40_000, maxWait: 8_000 });
  } catch (err) {
    if (paymentIntentTaken(err)) {
      throw new Error("PaymentIntent is already recorded");
    }
    throw err;
  }
}

function cartLinesToOrderLines(
  cart: { lines: CartLineView[] },
): Array<{
  variantId: string;
  listingId: string;
  qty: number;
  price: number;
  swapRule: string;
  substituteVariantId: string | null;
  maxPerOrder: number | null;
}> {
  return cart.lines.map((l) => ({
    variantId: l.variantId,
    listingId: l.variant.listing.id,
    qty: l.qty,
    price: l.variant.price,
    swapRule: l.swapRule,
    substituteVariantId: l.substituteVariantId,
    maxPerOrder: l.variant.listing.maxPerOrder,
  }));
}

function stripeAlreadyCanceled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /status of canceled/i.test(message)
    || /already canceled/i.test(message)
    || /status canceled/i.test(message);
}

/**
 * Reserves this intent for release under the same locks placement takes, then
 * tells Stripe. An order that commits first is left capturable. A reservation
 * that commits first makes a later place refuse.
 */
export async function releaseLosingHold(
  storeId: string,
  cartId: string,
  paymentIntentId: string,
): Promise<void> {
  const reserved = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await lockCart(tx, cartId);
    if (await orderExistsForPaymentIntent(tx, paymentIntentId)) return false;
    await tx.paymentIntentRelease.upsert({
      where: { paymentIntentId },
      create: { paymentIntentId, storeId },
      update: {},
    });
    const cart = await tx.cart.findUnique({
      where: { id: cartId },
      select: { paymentIntentId: true },
    });
    if (cart?.paymentIntentId === paymentIntentId) {
      await tx.cart.update({
        where: { id: cartId },
        data: { paymentIntentId: null, paymentAttemptToken: null },
      });
    }
    return true;
  });
  if (!reserved) return;
  if (process.env.NODE_ENV === "test" && checkoutTestHooks.beforeReleaseLosingHold) {
    await checkoutTestHooks.beforeReleaseLosingHold();
  }
  try {
    const key = `release-${paymentIntentId}`;
    if (fakeIntent(paymentIntentId)) {
      await getCheckoutPayments().cancelPaymentIntent(paymentIntentId, key);
      return;
    }
    await getStripeClient().paymentIntents.cancel(
      paymentIntentId,
      undefined,
      { idempotencyKey: key },
    );
  } catch (error) {
    if (stripeAlreadyCanceled(error)) return;
    console.error(JSON.stringify({
      event: "losing_hold_release_failed",
      paymentIntentId,
      message: "Platform alerted. The authorization expires on its own.",
    }));
  }
}

async function settleConsumedBasket(input: {
  storeId: string;
  cartId: string;
  actorUserId: string | null;
  paymentIntentId: string;
  minimumOrderCents: number;
  contact: Contact;
  fulfillment: Fulfillment;
}): Promise<
  | { kind: "order"; result: { token: string; quote: CheckoutQuote } }
  | { kind: "unproved" }
  | { kind: "none"; lines: number }
> {
  const scoped = storeScoped(input.storeId);
  const [cart, order] = await Promise.all([
    scoped.cart.findUnique({ where: { id: input.cartId } }),
    scoped.order.findFirst({
      where: { sourceCartId: input.cartId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { lines: true },
    }),
  ]);
  if (!order) {
    const lines = await scoped.cartLine.count({ where: { cartId: input.cartId } });
    return { kind: "none", lines };
  }
  await releaseLosingHold(input.storeId, input.cartId, input.paymentIntentId);
  if (!cart || cart.userId !== input.actorUserId) return { kind: "unproved" };
  const quote = computeQuote(
    input.minimumOrderCents,
    order.lines.map((line) => ({
      price: line.unitPriceCents,
      qty: line.qtyOrdered,
      maxPerOrder: null,
    })),
    input.contact,
    input.fulfillment,
  );
  return { kind: "order", result: { token: order.id, quote } };
}

/** An emptied cart that already has an order for this actor. Pay uses this before quoting a new charge. */
export async function resumeOrderedCart(
  storeId: string,
  cartId: string,
  actorUserId: string | null,
): Promise<{ kind: "order"; token: string } | { kind: "unproved" } | null> {
  const scoped = storeScoped(storeId);
  const cart = await scoped.cart.findUnique({
    where: { id: cartId },
    include: { lines: { select: { id: true }, take: 1 } },
  });
  if (!cart || cart.lines.length > 0) return null;
  const order = await scoped.order.findFirst({
    where: { sourceCartId: cartId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (!order) return null;
  if (cart.userId !== actorUserId) return { kind: "unproved" };
  return { kind: "order", token: order.id };
}

export async function placeOrder(
  storeId: string,
  minimumOrderCents: number,
  cartId: string,
  contact: Contact,
  fulfillment: Fulfillment,
  notes: string | null,
  pickupSlot: string | null,
  paymentIntentId: string,
  actorUserId: string | null = null,
): Promise<{ token: string; quote: CheckoutQuote }> {
  const store = await getStripeStore(storeId);

  if (fulfillment !== "pickup") {
    throw new Error("Only pickup fulfillment is supported");
  }

  const pi = await retrieveCheckoutIntent(paymentIntentId);

  if (pi.status === "canceled") {
    const canceledOrder = await storeScoped(storeId).order.findUnique({
      where: { paymentIntentId },
    });
    if (!canceledOrder) throw new BasketChangedError();
  }

  if (pi.status !== "requires_capture") {
    throw new Error(
      `PaymentIntent is in status "${pi.status}", expected "requires_capture"`,
    );
  }

  if (pi.transfer_data?.destination !== store.stripeAccountId) {
    throw new Error("PaymentIntent destination does not match store");
  }
  if (pi.on_behalf_of !== store.stripeAccountId) {
    throw new Error("PaymentIntent on_behalf_of does not match store");
  }
  if (pi.metadata?.store_id !== storeId) {
    throw new Error("PaymentIntent store_id metadata does not match");
  }
  if (pi.currency && pi.currency !== "usd") {
    throw new Error("PaymentIntent currency does not match");
  }
  if (pi.customer) {
    if (!actorUserId || pi.metadata?.user_id !== actorUserId) {
      throw new Error("PaymentIntent customer does not match this account");
    }
    if (pi.metadata?.cart_id !== cartId) {
      throw new Error("PaymentIntent does not belong to this cart");
    }
  } else if (pi.metadata?.cart_id && pi.metadata.cart_id !== cartId) {
    throw new Error("PaymentIntent does not belong to this cart");
  }

  const existingOrder = await storeScoped(storeId).order.findUnique({
    where: { paymentIntentId },
  });
  if (existingOrder) {
    if (existingOrder.sourceCartId && existingOrder.sourceCartId !== cartId) {
      throw new Error("PaymentIntent is already recorded");
    }
    const quote = await quoteFromCart(storeId, minimumOrderCents, cartId, contact, fulfillment);
    // Idempotent replay — don't re-send the Inngest event or touch the cart.
    await recoverSavedCardConsent(actorUserId, paymentIntentId, pi.payment_method);
    return { token: existingOrder.id, quote };
  }

  await runTestHook(checkoutTestHooks.afterMissedOrderLookup);

  const readCart = () => getCartWithLines(storeId, cartId);
  const cart = process.env.NODE_ENV === "test" && checkoutTestHooks.aroundCartRead
    ? await checkoutTestHooks.aroundCartRead(readCart)
    : await readCart();

  // After the cart read, under Read Committed, a committed winner is visible.
  // A lookup before the read can miss an order the customer refills onto.
  const replay = await storeScoped(storeId).order.findUnique({
    where: { paymentIntentId },
  });
  if (replay) {
    if (replay.sourceCartId && replay.sourceCartId !== cartId) {
      throw new Error("PaymentIntent is already recorded");
    }
    const quote = await quoteFromCart(storeId, minimumOrderCents, cartId, contact, fulfillment);
    await recoverSavedCardConsent(actorUserId, paymentIntentId, pi.payment_method);
    return { token: replay.id, quote };
  }

  await runTestHook(checkoutTestHooks.afterPostReadLookupMiss);

  if (!cart) throw new Error("Cart is empty");
  if (!cart.lines.length) {
    const settled = await settleConsumedBasket({
      storeId,
      cartId,
      actorUserId,
      paymentIntentId,
      minimumOrderCents,
      contact,
      fulfillment,
    });
    if (settled.kind === "order") return settled.result;
    if (settled.kind === "unproved") throw new BasketAlreadyOrderedError();
    await releaseLosingHold(storeId, cartId, paymentIntentId);
    throw new Error("Cart is empty");
  }

  const orderLineData = cartLinesToOrderLines(cart);
  const serverLines = orderLineData.map((l) => ({
    price: l.price,
    qty: l.qty,
    maxPerOrder: l.maxPerOrder,
  }));
  const quote = computeQuote(minimumOrderCents, serverLines, contact, fulfillment);

  if (pi.amount !== quote.holdCents) {
    await releaseLosingHold(storeId, cartId, paymentIntentId);
    throw new BasketChangedError();
  }

  if (quote.problems.length) {
    throw new Error(quote.problems.map((p) => p.message).join(" "));
  }

  for (const line of orderLineData) {
    const variant = await storeScoped(storeId).listingVariant.findUnique({
      where: { id: line.variantId },
      include: { listing: true },
    });
    if (!variant || variant.listing.storeId !== storeId) {
      throw new Error(`Variant ${line.variantId} does not belong to this store`);
    }
    if (line.substituteVariantId) {
      const sub = await storeScoped(storeId).listingVariant.findUnique({
        where: { id: line.substituteVariantId },
        include: { listing: true },
      });
      if (!sub || sub.listing.storeId !== storeId) {
        throw new Error(`Substitute variant ${line.substituteVariantId} does not belong to this store`);
      }
    }
  }

  let recorded: { orderId: string; created: boolean };
  try {
    recorded = await recordAuthorizedOrder(storeId, {
      cartId,
      contact,
      fulfillment,
      pickupSlot,
      notes,
      paymentIntentId,
      quote,
      actorUserId,
      paymentAmount: pi.amount,
      purchaseEpoch: epochStamp(pi.metadata).epoch,
      epochPresent: epochStamp(pi.metadata).present,
      minimumOrderCents,
      lines: orderLineData.map((line) => ({
        variantId: line.variantId,
        qty: line.qty,
        price: line.price,
        swapRule: line.swapRule,
        substituteVariantId: line.substituteVariantId,
      })),
    });
  } catch (error) {
    if (error instanceof BasketAlreadyOrderedError) {
      const settled = await settleConsumedBasket({
        storeId,
        cartId,
        actorUserId,
        paymentIntentId,
        minimumOrderCents,
        contact,
        fulfillment,
      });
      if (settled.kind === "order") return settled.result;
      if (settled.kind === "unproved") throw error;
      if (settled.lines > 0) {
        await releaseLosingHold(storeId, cartId, paymentIntentId);
        throw new BasketChangedError();
      }
      await releaseLosingHold(storeId, cartId, paymentIntentId);
      throw new Error("Cart is empty");
    }
    if (error instanceof BasketChangedError) {
      await releaseLosingHold(storeId, cartId, paymentIntentId);
      throw error;
    }
    throw error;
  }

  if (recorded.created) {
    scheduleAfterResponse(
      () => sendOrderAuthorized(storeId, recorded.orderId),
      "inngest_send_failed",
    );
  }
  await recoverSavedCardConsent(actorUserId, paymentIntentId, pi.payment_method);

  return { token: recorded.orderId, quote };
}

async function recoverSavedCardConsent(
  actorUserId: string | null,
  paymentIntentId: string,
  paymentMethodId: string | null,
): Promise<void> {
  if (!actorUserId || !paymentMethodId) return;
  try {
    await bindSavedCardConsent(actorUserId, paymentIntentId, paymentMethodId);
  } catch {
    // The order is already committed. The next replay binds the card.
  }
}

async function quoteFromCart(
  storeId: string,
  minimumOrderCents: number,
  cartId: string,
  contact: Contact,
  fulfillment: Fulfillment,
): Promise<CheckoutQuote> {
  const cart = await getCartWithLines(storeId, cartId);
  const serverLines = cart
    ? cart.lines.map((line) => ({
        price: line.variant.price,
        qty: line.qty,
        maxPerOrder: line.variant.listing.maxPerOrder,
      }))
    : [];
  return computeQuote(minimumOrderCents, serverLines, contact, fulfillment);
}
