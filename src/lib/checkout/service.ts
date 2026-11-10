import { Prisma } from "@prisma/client";
import { storeScopedTransaction, lockStoreRow, lockCart, lockListingRows, getNextOrderNumber, storeScoped, orderExistsForPaymentIntent, platform, readStoreHours, markOrphanHoldChecked } from "../db";
import { assessRadius } from "../address/geo";
import { lookupConfirmed } from "../address/confirm";
import { getCartWithLines, type CartLineView } from "../cart/service";
import { getStripeClient } from "../stripe/provider";
import { checkoutPaymentsUseFake, getCheckoutPayments, holdAuthorizedAt, type NormalizedPaymentIntent } from "../stripe/checkout-payments";
import { sendOrderAuthorized } from "../inngest/send";
import { scheduleOrderNotification } from "../inngest/notify";
import { newTrackingToken, recordOrderNotification } from "../notifications/record";
import { scheduleAfterResponse } from "../schedule-after-response";
import { checkoutTestHooks } from "./test-hooks";
import { cartPaymentIdempotencyKey } from "../customer-account/consent";
import { guestPaymentIntentParams, nextAttemptToken, paymentIntentProvenanceOk } from "./payment-intent-params";
import { bindSavedCardConsent, prepareSignedInPaymentIntent } from "./saved-card-payment";
import { platformFeeCentsForCapture } from "../order/platform-fee";
import { reserveOrderStock } from "../order/stock-ledger";
import { validPhone } from "../customer-account/phone";
import { assertLiveModeAllowed } from "./live-mode";
import { StoreNotTakingOrdersError, storeAvailability } from "../order/store-queue";
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
  const pi = await getStripeClient().paymentIntents.retrieve(id, { expand: ["latest_charge"] });
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
    authorized_at: holdAuthorizedAt(pi),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export interface StoreDeliveryQuote {
  enabled: boolean;
  feeCents: number;
  radiusMi: number;
  hasCoordinates: boolean;
  /** Null until Census has confirmed the address. Distance is not stored here. */
  confirmed: { withinRadius: boolean } | null;
  leaveAtDoor: boolean;
}

export function computeQuote(
  minimumOrderCents: number,
  cartLines: ReadonlyArray<{ price: number; qty: number; maxPerOrder: number | null; frozen?: boolean }>,
  contact: Contact,
  fulfillment: Fulfillment,
  delivery?: StoreDeliveryQuote | null,
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

  let deliveryFeeCents = 0;
  if (fulfillment === "courier") {
    problems.push({
      code: "ineligible",
      message: "Only pickup is available for this store.",
    });
  } else if (fulfillment === "store-delivery") {
    // The fee stays in the hold when delivery is switched off or the radius
    // shrinks, so those refusals are visible as problems rather than a new total.
    deliveryFeeCents = Math.max(0, delivery?.feeCents ?? 0);
    if (!delivery || !delivery.enabled || !delivery.hasCoordinates || delivery.radiusMi <= 0) {
      problems.push({
        code: "ineligible",
        message: "Only pickup is available for this store.",
      });
    } else if (!delivery.confirmed) {
      problems.push({
        code: "ineligible",
        message: "We couldn't find that address",
      });
    } else if (!delivery.confirmed.withinRadius) {
      problems.push({
        code: "outside-radius",
        message: "That address is outside the delivery area",
      });
    }
    if (delivery?.leaveAtDoor && cartLines.some((line) => line.frozen)) {
      problems.push({
        code: "ineligible",
        message: "Frozen items require handoff.",
      });
    }
  }

  const tipCents = 0;
  const totalCents = subtotalCents + tipCents + deliveryFeeCents;
  const bufferCents = Math.min(Math.round(subtotalCents * 0.1), 2000);
  const holdCents = totalCents + bufferCents;

  return {
    id: crypto.randomUUID(),
    subtotalCents,
    deliveryFeeCents,
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

export interface DeliveryRequest {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
  leaveAtDoor: boolean;
}

interface DeliveryStoreRow {
  storeDeliveryEnabled: boolean;
  storeDeliveryFeeCents: number;
  deliveryRadiusMi: unknown;
  lat: number | null;
  lng: number | null;
}

function deliveryQuoteInput(
  store: DeliveryStoreRow,
  point: { lat: number; lng: number } | null,
  leaveAtDoor: boolean,
): StoreDeliveryQuote {
  const radiusMi = Number(store.deliveryRadiusMi);
  const hasCoordinates = store.lat != null && store.lng != null;
  const confirmed = point && hasCoordinates
    ? { withinRadius: assessRadius(point, { lat: store.lat as number, lng: store.lng as number, radiusMi }).withinRadius }
    : null;
  return {
    enabled: store.storeDeliveryEnabled,
    feeCents: store.storeDeliveryFeeCents,
    radiusMi,
    hasCoordinates,
    confirmed,
    leaveAtDoor,
  };
}

export async function quoteCheckout(
  storeId: string,
  minimumOrderCents: number,
  cartId: string,
  contact: Contact,
  fulfillment: Fulfillment,
  request?: DeliveryRequest | null,
): Promise<CheckoutQuote> {
  const [cart, store] = await Promise.all([
    getCartWithLines(storeId, cartId),
    platform.store.findUnique({ where: { id: storeId } }),
  ]);
  if (!store) throw new Error("Store not found");
  const serverLines = (cart?.lines ?? []).map((line) => ({
    price: line.variant.price,
    qty: line.qty,
    maxPerOrder: line.variant.listing.maxPerOrder,
    frozen: line.variant.listing.frozen,
  }));
  if (fulfillment !== "store-delivery") {
    return computeQuote(minimumOrderCents, serverLines, contact, fulfillment);
  }
  let point: { lat: number; lng: number } | null = null;
  if (request && store.lat != null && store.lng != null) {
    const cached = await lookupConfirmed(
      { line1: request.line1, city: request.city, state: request.state, zip: request.zip },
      { lat: store.lat, lng: store.lng, radiusMi: Number(store.deliveryRadiusMi) },
    );
    if (cached?.ok) point = { lat: cached.match.lat, lng: cached.match.lng };
  }
  return computeQuote(
    minimumOrderCents,
    serverLines,
    contact,
    fulfillment,
    deliveryQuoteInput(store, point, request?.leaveAtDoor === true),
  );
}

export { checkoutTestHooks } from "./test-hooks";
export { SavedCardUnavailableError } from "./saved-card-payment";
export { LiveModeBlockedError } from "./live-mode";
export { StoreNotTakingOrdersError } from "../order/store-queue";

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
  assertLiveModeAllowed();
  const store = await getStripeStore(storeId);
  // Refuse before any Stripe call. placeOrder re-checks under the store lock.
  if (storeAvailability(store.hours, store.timezone, new Date()).kind === "unavailable") {
    throw new StoreNotTakingOrdersError();
  }
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
        await tx.cart.update({ where: { id: cartId }, data: { orphanCheckedAt: null } });
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

export interface DeliverySnapshot {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lng: number;
  leaveAtDoor: boolean;
}

/** Writes the confirmed address onto the cart, or clears it for pickup. */
export async function saveDeliverySnapshot(
  storeId: string,
  cartId: string,
  snapshot: DeliverySnapshot | null,
): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await lockCart(tx, cartId);
    await tx.cart.update({
      where: { id: cartId },
      data: snapshot
        ? {
            deliveryLine1: snapshot.line1,
            deliveryLine2: snapshot.line2,
            deliveryCity: snapshot.city,
            deliveryState: snapshot.state,
            deliveryZip: snapshot.zip,
            deliveryLat: snapshot.lat,
            deliveryLng: snapshot.lng,
            leaveAtDoor: snapshot.leaveAtDoor,
          }
        : {
            deliveryLine1: null,
            deliveryLine2: null,
            deliveryCity: null,
            deliveryState: null,
            deliveryZip: null,
            deliveryLat: null,
            deliveryLng: null,
            leaveAtDoor: false,
          },
    });
  });
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
  /** Direct place calls can set this even when the cart snapshot does not. */
  leaveAtDoor?: boolean;
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
): Promise<{ orderId: string; created: boolean; trackingToken: string | null }> {
  try {
    const recorded = await storeScopedTransaction(storeId, async (tx) => {
      const lockedStore = await lockStoreRow(tx, storeId);

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
        return { orderId: existing.id, created: false as const, notify: false, trackingToken: existing.trackingToken };
      }

      // Under the store lock, after the replay branch: hours saved mid-checkout
      // either refuse here with no write, or wait for this order to commit.
      const now = new Date();
      const hours = await readStoreHours(tx, storeId);
      const availability = hours
        ? storeAvailability(hours.hours, hours.timezone, now)
        : ({ kind: "unavailable" } as const);
      if (availability.kind === "unavailable") throw new StoreNotTakingOrdersError();

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
        frozen: line.variant.listing.frozen,
      }));
      if (!sameBasket(current, input.lines)) throw new BasketChangedError();
      const point = cart.deliveryLat != null && cart.deliveryLng != null
        ? { lat: cart.deliveryLat, lng: cart.deliveryLng }
        : null;
      const delivery = input.fulfillment === "store-delivery"
        ? deliveryQuoteInput(lockedStore, point, cart.leaveAtDoor || input.leaveAtDoor === true)
        : null;
      const currentQuote = computeQuote(
        input.minimumOrderCents ?? 0,
        current,
        input.contact,
        input.fulfillment,
        delivery,
      );
      if (
        currentQuote.problems.length > 0
        || currentQuote.holdCents !== (input.paymentAmount ?? input.quote.holdCents)
      ) {
        throw new BasketChangedError();
      }
      const delivering = input.fulfillment === "store-delivery" && point != null;
      const distanceMi = delivering && lockedStore.lat != null && lockedStore.lng != null
        ? assessRadius(point, {
            lat: lockedStore.lat,
            lng: lockedStore.lng,
            radiusMi: lockedStore.deliveryRadiusMi,
          }).roundedMi
        : null;

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

      // Before any insert that references these rows. Stock is read under this lock,
      // not from the rows above, which were read before it.
      const lockedStock = await lockListingRows(tx, [...new Set(owned.map((variant) => variant.listingId))]);

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
          subtotalCents: currentQuote.subtotalCents,
          tipCents: currentQuote.tipCents,
          bufferCents: currentQuote.bufferCents,
          totalAuthorizedCents: currentQuote.holdCents,
          deliveryFeeCents: currentQuote.deliveryFeeCents,
          totalCents: currentQuote.totalCents,
          paymentIntentId: input.paymentIntentId,
          sourceCartId: input.cartId,
          platformFeeCents: platformFeeCentsForCapture(currentQuote.totalCents),
          notes: input.notes || null,
          deliveryLine1: delivering ? cart.deliveryLine1 : null,
          deliveryLine2: delivering ? cart.deliveryLine2 : null,
          deliveryCity: delivering ? cart.deliveryCity : null,
          deliveryState: delivering ? cart.deliveryState : null,
          deliveryZip: delivering ? cart.deliveryZip : null,
          deliveryLat: delivering ? cart.deliveryLat : null,
          deliveryLng: delivering ? cart.deliveryLng : null,
          deliveryDistanceMi: distanceMi,
          leaveAtDoor: delivering ? cart.leaveAtDoor : false,
          trackingToken: newTrackingToken(),
          acceptanceClockStartsAt: availability.clockStartsAt,
        },
      });
      const orderLines = await tx.orderLine.createManyAndReturn({
        data: input.lines.map((line) => ({
          storeId,
          orderId: order.id,
          listingVariantId: line.variantId,
          substituteVariantId: line.substituteVariantId,
          qtyOrdered: line.qty,
          unitPriceCents: line.price,
          swapRule: line.swapRule,
        })),
        select: { id: true, listingVariantId: true, qtyOrdered: true },
      });
      await reserveOrderStock(
        tx,
        storeId,
        orderLines.map((line) => ({
          id: line.id,
          listingId: ownedById.get(line.listingVariantId)!.listingId,
          qtyOrdered: line.qtyOrdered,
        })),
        lockedStock,
      );
      await tx.cartLine.deleteMany({ where: { cartId: input.cartId } });
      await tx.cart.update({
        where: { id: input.cartId },
        data: {
          paymentIntentId: null,
          paymentAttemptToken: null,
          purchaseEpoch: { increment: 1 },
        },
      });
      const notify = await recordOrderNotification(tx, storeId, order.id, "placed");
      return { orderId: order.id, created: true as const, notify, trackingToken: order.trackingToken };
    }, { timeout: 40_000, maxWait: 8_000 });
    if (recorded.notify) scheduleOrderNotification(storeId, recorded.orderId, "placed");
    return { orderId: recorded.orderId, created: recorded.created, trackingToken: recorded.trackingToken };
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
  frozen: boolean;
}> {
  return cart.lines.map((l) => ({
    variantId: l.variantId,
    listingId: l.variant.listing.id,
    qty: l.qty,
    price: l.variant.price,
    swapRule: l.swapRule,
    substituteVariantId: l.substituteVariantId,
    maxPerOrder: l.variant.listing.maxPerOrder,
    frozen: l.variant.listing.frozen,
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
  cancellationReason?: "abandoned",
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
      cancellationReason ? { cancellation_reason: cancellationReason } : undefined,
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

/** An unused card hold is released this long after authorization (owner decision, #422). */
const ORPHAN_HOLD_GRACE_MS = 60 * 60_000;
/** A cart whose intent never got a card is cancelled once untouched this long. */
const DEAD_CART_MS = 24 * 60 * 60_000;
const UNPAID_PAYMENT = new Set(["requires_payment_method", "requires_confirmation"]);

/**
 * Releases card holds that never became an order: the intent is still
 * `requires_capture` and was authorized more than the grace ago. Also cancels
 * intents that never got a card within a day, so they leave the sweep; a returning
 * shopper gets a fresh intent. releaseLosingHold re-checks for an order under the
 * store and cart locks and writes the tombstone, so a placeOrder that wins the
 * race keeps its hold and a later one is refused.
 */
export async function releaseOrphanHolds(
  carts: ReadonlyArray<{ storeId: string; cartId: string; paymentIntentId: string; updatedAt: Date }>,
): Promise<void> {
  for (const cart of carts) {
    try {
      const pi = await retrieveCheckoutIntent(cart.paymentIntentId);
      if (pi.status === "requires_capture" && pi.authorized_at != null) {
        if (Date.now() - pi.authorized_at < ORPHAN_HOLD_GRACE_MS) continue;
        await releaseLosingHold(cart.storeId, cart.cartId, cart.paymentIntentId, "abandoned");
        continue;
      }
      if (UNPAID_PAYMENT.has(pi.status) && Date.now() - cart.updatedAt.getTime() > DEAD_CART_MS) {
        await releaseLosingHold(cart.storeId, cart.cartId, cart.paymentIntentId, "abandoned");
        continue;
      }
      if (pi.status === "requires_capture") {
        console.error(JSON.stringify({ event: "orphan_hold_without_authorization_time", paymentIntentId: pi.id }));
      }
      await markOrphanHoldChecked(cart.storeId, cart.cartId, cart.paymentIntentId);
    } catch (error) {
      console.error(JSON.stringify({
        event: "orphan_hold_release_failed",
        paymentIntentId: cart.paymentIntentId,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
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
  | { kind: "order"; result: PlacedOrder }
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
  return { kind: "order", result: { token: order.id, trackingToken: order.trackingToken, quote } };
}

/** An emptied cart that already has an order for this actor. Pay uses this before quoting a new charge. */
export async function resumeOrderedCart(
  storeId: string,
  cartId: string,
  actorUserId: string | null,
): Promise<{ kind: "order"; token: string; trackingToken: string | null } | { kind: "unproved" } | null> {
  const scoped = storeScoped(storeId);
  const cart = await scoped.cart.findUnique({
    where: { id: cartId },
    include: { lines: { select: { id: true }, take: 1 } },
  });
  if (!cart || cart.lines.length > 0) return null;
  const order = await scoped.order.findFirst({
    where: { sourceCartId: cartId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, trackingToken: true },
  });
  if (!order) return null;
  if (cart.userId !== actorUserId) return { kind: "unproved" };
  return { kind: "order", token: order.id, trackingToken: order.trackingToken };
}

/** `token` is the order id; `trackingToken` is the id for the shopper's link, null for an order made before tokens. */
export type PlacedOrder = { token: string; trackingToken: string | null; quote: CheckoutQuote };

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
  leaveAtDoor = false,
): Promise<PlacedOrder> {
  assertLiveModeAllowed();
  const store = await getStripeStore(storeId);

  if (fulfillment === "courier") {
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
    return { token: existingOrder.id, trackingToken: existingOrder.trackingToken, quote };
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
    return { token: replay.id, trackingToken: replay.trackingToken, quote };
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
    frozen: l.frozen,
  }));
  const storeRow = await platform.store.findUnique({ where: { id: storeId } });
  if (!storeRow) throw new Error("Store not found");
  const point = cart.delivery.lat != null && cart.delivery.lng != null
    ? { lat: cart.delivery.lat, lng: cart.delivery.lng }
    : null;
  const delivery = fulfillment === "store-delivery"
    ? deliveryQuoteInput(storeRow, point, cart.delivery.leaveAtDoor || leaveAtDoor)
    : null;
  const quote = computeQuote(minimumOrderCents, serverLines, contact, fulfillment, delivery);

  const contactOnly = quote.problems.length > 0
    && quote.problems.every((problem) => problem.code === "invalid-contact");
  if (contactOnly) {
    throw new Error(quote.problems.map((problem) => problem.message).join(" "));
  }
  if (quote.problems.length > 0 || pi.amount !== quote.holdCents) {
    await releaseLosingHold(storeId, cartId, paymentIntentId);
    throw new BasketChangedError();
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

  let recorded: { orderId: string; created: boolean; trackingToken: string | null };
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
      leaveAtDoor,
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
    if (error instanceof BasketChangedError || error instanceof StoreNotTakingOrdersError) {
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

  return { token: recorded.orderId, trackingToken: recorded.trackingToken, quote };
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
