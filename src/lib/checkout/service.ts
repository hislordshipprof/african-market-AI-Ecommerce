import { Prisma } from "@prisma/client";
import { storeMayUse } from "../billing/plan";
import type { AcquisitionSource } from "../directory/attribution";
import { storeScopedTransaction, lockStoreRow, lockCart, lockListingRows, getNextOrderNumber, storeScoped, orderExistsForPaymentIntent, platform, readStoreHours, markOrphanHoldChecked, ORPHAN_HOLD_GRACE_MS, storeHasWhatsAppNumber } from "../db";
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
import { captureSplit, orderServiceFeeSettings } from "../order/platform-fee";
import { readServiceFeeSettings } from "../order/service-fee-settings";
import { reserveOrderStock } from "../order/stock-ledger";
import { assertLiveModeAllowed } from "./live-mode";
import { StoreNotTakingOrdersError, storeAvailability } from "../order/store-queue";
import { pinnedCheckoutTax, quoteCheckoutTax, TaxLocationError, TaxUnavailableError, type CheckoutTax, type DeliveryAddressFields } from "../tax/checkout-tax";
import { appliedCouponId, COURIER_NOT_OFFERED, computeQuote, withTax, type CourierQuoteInput, type QuoteCouponInput, type ShippingQuoteInput, type StoreDeliveryQuote } from "./quote";
import { cheapestRate, ShippingProviderError, type ShippingProvider } from "../shipping/provider";
import { lineShips, orderWeightG, shipRefusal, type ShipLine } from "../shipping/eligibility";
import { readShippingStates, shippingProvider } from "../shipping/settings";
import { couponCustomerKey, CouponRefusedError, customerRefusal, readCartCoupon, removeCartCoupon } from "../coupon/checkout";
import { buildCourierRequest, courierProviders, quoteCourier } from "../delivery/dispatch";
import { checkCourierEligibility } from "../delivery/eligibility";
import { anyCourierEnabled, readCourierSettings, type CourierSettings } from "../delivery/courier-settings";
import { courierOffered } from "../delivery/courier-offered";
import type { DeliveryProvider } from "../delivery/provider";
import { validPhone } from "../customer-account/phone";
import { assertSlotOffered, SlotUnavailableError } from "./slots";
import type {
  CheckoutQuote,
  Contact,
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

export interface QuoteCheckoutOptions {
  /** Defaults to Uber Direct and DoorDash Drive. */
  couriers?: DeliveryProvider[];
  /** Pay: ask the couriers again, and report a fee that differs from the one last shown (#527 AC2). */
  recheckCourier?: boolean;
  /** Defaults to the platform's courier settings (#535). */
  courierSettings?: CourierSettings;
  /** The signed-in shopper, whose account a coupon's per-customer limit counts against (#557). */
  actorUserId?: string | null;
  /** Defaults to Shippo, or its fake where allowed (#567). */
  shipping?: ShippingProvider | null;
}

/**
 * The cart's coupon code checked now, or null when the cart has none (#557). `email` is null for a
 * quote, so a typed email is never checked against the store's orders; placement passes the contact's.
 */
async function cartCoupon(storeId: string, cartId: string, email: string | null, actorUserId: string | null): Promise<QuoteCouponInput | null> {
  const scoped = storeScoped(storeId);
  const cart = await scoped.cart.findUnique({ where: { id: cartId }, select: { couponCode: true } });
  if (!cart?.couponCode) return null;
  return readCartCoupon(scoped, storeId, cart.couponCode, { email, userId: actorUserId, now: new Date() });
}

export async function quoteCheckout(
  storeId: string,
  minimumOrderCents: number,
  cartId: string,
  contact: Contact,
  fulfillment: Fulfillment,
  request?: DeliveryRequest | null,
  options: QuoteCheckoutOptions = {},
): Promise<CheckoutQuote> {
  const quote = await untaxedQuote(storeId, minimumOrderCents, cartId, contact, fulfillment, request, options);
  const cart = await getCartWithLines(storeId, cartId);
  const lines = (cart?.lines ?? []).map((line) => ({ variantId: line.variant.id, qty: line.qty, price: line.variant.price }));
  if (!cart || lines.length === 0) return quote;
  try {
    const delivery = await confirmedDeliveryAddress(storeId, fulfillment, request ?? null);
    const tax = await quoteCheckoutTax(storeId, cartId, lines, quote.discountCents, fulfillment, delivery);
    return withTax(quote, tax.taxCents);
  } catch (error) {
    if (error instanceof TaxLocationError || error instanceof TaxUnavailableError) {
      if (error instanceof TaxLocationError) console.error(JSON.stringify({ event: "tax_location_invalid", storeId }));
      return { ...quote, problems: [...quote.problems, { code: "ineligible", message: error.message }] };
    }
    throw error;
  }
}

/** The request's address as the payment step saves it on the cart: the confirmed match, with the shopper's line 2. */
async function confirmedDeliveryAddress(
  storeId: string,
  fulfillment: Fulfillment,
  request: DeliveryRequest | null,
): Promise<DeliveryAddressFields | null> {
  if (fulfillment === "pickup" || !request) return null;
  const store = await platform.store.findUnique({ where: { id: storeId }, select: { lat: true, lng: true, deliveryRadiusMi: true } });
  if (store?.lat == null || store.lng == null) return null;
  const confirmed = await lookupConfirmed(
    { line1: request.line1, city: request.city, state: request.state, zip: request.zip },
    { lat: store.lat, lng: store.lng, radiusMi: Number(store.deliveryRadiusMi) },
  );
  if (!confirmed?.ok) return null;
  return {
    deliveryLine1: confirmed.match.line1,
    deliveryLine2: request.line2 ?? null,
    deliveryCity: confirmed.match.city,
    deliveryState: confirmed.match.state,
    deliveryZip: confirmed.match.zip,
  };
}

async function untaxedQuote(
  storeId: string,
  minimumOrderCents: number,
  cartId: string,
  contact: Contact,
  fulfillment: Fulfillment,
  request?: DeliveryRequest | null,
  options: QuoteCheckoutOptions = {},
): Promise<CheckoutQuote> {
  const [cart, store, serviceFee, coupon] = await Promise.all([
    getCartWithLines(storeId, cartId),
    platform.store.findUnique({ where: { id: storeId } }),
    readServiceFeeSettings(),
    cartCoupon(storeId, cartId, null, options.actorUserId ?? null),
  ]);
  if (!store) throw new Error("Store not found");
  const serverLines = (cart?.lines ?? []).map((line) => ({
    price: line.variant.price,
    qty: line.qty,
    maxPerOrder: line.variant.listing.maxPerOrder,
    frozen: line.variant.listing.frozen,
    perishable: line.variant.listing.perishable,
    hot: line.variant.listing.prepared === "hot",
    minQty: line.variant.listing.cateringMinQty,
  }));
  if (fulfillment === "courier" && !(await storeMayUse(storeId, "courier-delivery"))) {
    const quote = computeQuote(minimumOrderCents, serverLines, contact, "pickup", serviceFee, null, null, coupon);
    return { ...quote, problems: [...quote.problems, { code: "ineligible", message: COURIER_NOT_OFFERED }] };
  }
  if (fulfillment === "courier") {
    const courierSettings = options.courierSettings ?? (await readCourierSettings());
    if (!anyCourierEnabled(courierSettings, cartId)) {
      const quote = computeQuote(minimumOrderCents, serverLines, contact, "pickup", serviceFee);
      return { ...quote, problems: [...quote.problems, { code: "ineligible", message: COURIER_NOT_OFFERED }] };
    }
    const courier = cart
      ? await courierQuoteFor(store, cart, contact, request ?? null, options, courierSettings)
      : null;
    return computeQuote(minimumOrderCents, serverLines, contact, fulfillment, serviceFee, null, courier, coupon);
  }
  if (fulfillment === "ship") {
    const shipping = cart ? await shippingQuoteFor(store, cart, contact, request ?? null, options) : null;
    return computeQuote(minimumOrderCents, serverLines, contact, fulfillment, serviceFee, null, null, coupon, 0, shipping);
  }
  if (fulfillment !== "store-delivery") {
    return computeQuote(minimumOrderCents, serverLines, contact, fulfillment, serviceFee, null, null, coupon);
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
    serviceFee,
    deliveryQuoteInput(store, point, request?.leaveAtDoor === true),
    null,
    coupon,
  );
}

type CourierStoreRow = NonNullable<Awaited<ReturnType<typeof platform.store.findUnique>>>;

/** Spec D4 and §11.3: a registered store, the weight limit, a confirmed address within the radius, then the #140 quote. */
async function courierQuoteFor(
  store: CourierStoreRow,
  cart: NonNullable<Awaited<ReturnType<typeof getCartWithLines>>>,
  contact: Contact,
  request: DeliveryRequest | null,
  options: QuoteCheckoutOptions,
  settings: CourierSettings,
): Promise<CourierQuoteInput> {
  const unavailable = (message: string, code: "ineligible" | "outside-radius" = "ineligible"): CourierQuoteInput => ({ ok: false, problem: { code, message } });
  if (!courierOffered(store)) return unavailable("This store isn't set up for courier delivery yet.");
  const eligibility = checkCourierEligibility(cart.lines.map((line) => ({ weightG: line.variant.weightG, quantity: line.qty })), { courierWeightLimitLb: settings.weightLimitLb });
  if (!eligibility.eligible) {
    const what = eligibility.reason === "item_over_limit" ? "An item in your basket is" : "This order is";
    return unavailable(`${what} over the ${settings.weightLimitLb} lb courier limit. Choose pickup or store delivery.`);
  }
  if (!request) return unavailable("Confirm your delivery address to see the courier fee.");
  const confirmed = await lookupConfirmed(
    { line1: request.line1, city: request.city, state: request.state, zip: request.zip },
    { lat: store.lat as number, lng: store.lng as number, radiusMi: Number(store.deliveryRadiusMi) },
  );
  if (!confirmed?.ok) return unavailable("We couldn't find that address");
  if (!confirmed.withinRadius) return unavailable("That address is outside the delivery area", "outside-radius");
  if (!validPhone(contact.phone)) return unavailable("Add your phone number to see the courier fee.");

  const address = { line1: confirmed.match.line1, line2: request.line2 ?? null, city: confirmed.match.city, state: confirmed.match.state, zip: confirmed.match.zip };
  const key = JSON.stringify({ address, subtotalCents: cart.subtotalCents });
  const leaveAtDoor = request.leaveAtDoor;
  const saved = await storeScoped(store.id).cart.findUnique({
    where: { id: cart.id },
    select: { courierFeeCents: true, courierProvider: true, courierQuoteKey: true, courierQuoteExpiresAt: true },
  });
  const shown = saved?.courierQuoteKey === key && saved.courierFeeCents != null ? saved.courierFeeCents : null;
  if (!options.recheckCourier && shown != null && saved?.courierQuoteExpiresAt && saved.courierQuoteExpiresAt > new Date()) {
    return { ok: true, feeCents: shown, provider: saved.courierProvider as "Uber Direct" | "DoorDash Drive", leaveAtDoor };
  }

  const { request: courierRequest, registrations } = buildCourierRequest(store.id, store, {
    address,
    phone: contact.phone.trim(),
    name: contact.name,
    contactless: leaveAtDoor,
  }, {
    orderValueCents: cart.subtotalCents,
    tipCents: 0,
    hasFrozenLine: cart.lines.some((line) => line.variant.listing.frozen),
  });
  const quoted = await quoteCourier({ referenceId: cart.id, request: courierRequest, registrations }, options.couriers ?? courierProviders(), settings);
  await storeScoped(store.id).cart.update({
    where: { id: cart.id },
    data: {
      courierFeeCents: quoted?.feeCents ?? null,
      courierProvider: quoted?.courierProvider ?? null,
      courierQuoteKey: quoted ? key : null,
      courierQuoteExpiresAt: quoted?.expiresAt ?? null,
    },
  });
  if (!quoted) return unavailable("No courier can take this order right now. Choose pickup or store delivery.");
  const changed = options.recheckCourier === true && quoted.feeCents !== shown;
  return { ok: true, feeCents: quoted.feeCents, provider: quoted.courierProvider, leaveAtDoor, changed };
}

const SHIP_ADDRESS_NEEDED = "Enter your shipping address to see the shipping rate.";

/** The rate depends on where the box goes and what it weighs; the key ties a saved rate to both. */
function shippingKey(state: string, zip: string, weightG: number): string {
  return JSON.stringify({ state, zip, weightG });
}

function shipLines(lines: ReadonlyArray<{ qty: number; variant: { weightG: number; ships: boolean } }>): ShipLine[] {
  return lines.map((line) => ({ ships: line.variant.ships, weightG: line.variant.weightG, qty: line.qty }));
}

/** ADR-0023: every line ships, the store ships, the state is allowed, at most 50 lb; then the cheapest Shippo rate, kept until it expires. */
async function shippingQuoteFor(
  store: CourierStoreRow,
  cart: NonNullable<Awaited<ReturnType<typeof getCartWithLines>>>,
  contact: Contact,
  request: DeliveryRequest | null,
  options: QuoteCheckoutOptions,
): Promise<ShippingQuoteInput> {
  const unavailable = (message: string): ShippingQuoteInput => ({ ok: false, problem: { code: "ineligible", message } });
  const lines = shipLines(cart.lines);
  const allowedStates = await readShippingStates();
  const refusal = shipRefusal({ lines, handlingDays: store.shippingHandlingDays, state: null, allowedStates });
  if (refusal) return unavailable(refusal);
  if (!request) return unavailable(SHIP_ADDRESS_NEEDED);
  if (!store.addressLine1 || !store.city || !store.state || !store.zip || store.lat == null || store.lng == null) {
    return unavailable("This store isn't set up for shipping yet.");
  }
  const confirmed = await lookupConfirmed(
    { line1: request.line1, city: request.city, state: request.state, zip: request.zip },
    { lat: store.lat, lng: store.lng, radiusMi: Number(store.deliveryRadiusMi) },
  );
  if (!confirmed?.ok) return unavailable("We couldn't find that address");
  const stateRefusal = shipRefusal({ lines, handlingDays: store.shippingHandlingDays, state: confirmed.match.state, allowedStates });
  if (stateRefusal) return unavailable(stateRefusal);
  if (!contact.name.trim()) return unavailable("Add your name to see the shipping rate.");

  const handlingDays = store.shippingHandlingDays as number;
  const weightG = orderWeightG(lines);
  const key = shippingKey(confirmed.match.state, confirmed.match.zip, weightG);
  const scoped = storeScoped(store.id);
  const saved = await scoped.cart.findUnique({
    where: { id: cart.id },
    select: { shippingFeeCents: true, shippingCarrier: true, shippingService: true, shippingDays: true, shippingQuoteKey: true, shippingQuoteExpiresAt: true },
  });
  const shown = saved?.shippingQuoteKey === key && saved.shippingFeeCents != null ? saved.shippingFeeCents : null;
  if (shown != null && saved?.shippingQuoteExpiresAt && saved.shippingQuoteExpiresAt > new Date()) {
    return { ok: true, feeCents: shown, carrier: saved.shippingCarrier ?? "", service: saved.shippingService ?? "", days: saved.shippingDays, handlingDays };
  }

  const provider = options.shipping === undefined ? shippingProvider() : options.shipping;
  if (!provider) return unavailable("Shipping isn't available right now. Choose pickup or delivery.");
  let rate = null;
  try {
    rate = cheapestRate(await provider.rates({
      from: { name: store.name, line1: store.addressLine1, line2: store.addressLine2, city: store.city, state: store.state, zip: store.zip, phone: store.phone },
      to: { name: contact.name.trim(), line1: confirmed.match.line1, line2: request.line2 ?? null, city: confirmed.match.city, state: confirmed.match.state, zip: confirmed.match.zip, phone: contact.phone.trim() || null },
      weightG,
    }));
  } catch (error) {
    if (!(error instanceof ShippingProviderError)) throw error;
    console.error(JSON.stringify({ event: "shipping_rates_failed", storeId: store.id, status: error.status }));
  }
  await scoped.cart.update({
    where: { id: cart.id },
    data: {
      shippingFeeCents: rate?.feeCents ?? null,
      shippingRateId: rate?.rateId ?? null,
      shippingCarrier: rate?.carrier ?? null,
      shippingService: rate?.service ?? null,
      shippingDays: rate?.days ?? null,
      shippingQuoteKey: rate ? key : null,
      shippingQuoteExpiresAt: rate?.expiresAt ?? null,
    },
  });
  if (!rate) return unavailable("No carrier can ship this order right now. Choose pickup or delivery.");
  // An expired rate that came back different is shown before the shopper pays it.
  return { ok: true, feeCents: rate.feeCents, carrier: rate.carrier, service: rate.service, days: rate.days, handlingDays, changed: shown != null && rate.feeCents !== shown };
}

/** Placement charges the rate the shopper last saw, while it is still for this basket, address and state, and unexpired. */
function shownShipping(
  cart: {
    shippingFeeCents: number | null;
    shippingCarrier: string | null;
    shippingService: string | null;
    shippingDays: number | null;
    shippingQuoteKey: string | null;
    shippingQuoteExpiresAt: Date | null;
    deliveryLine1: string | null;
    deliveryState: string | null;
    deliveryZip: string | null;
  },
  lines: ShipLine[],
  handlingDays: number | null,
  allowedStates: readonly string[],
  now: Date,
): ShippingQuoteInput {
  const refusal = shipRefusal({ lines, handlingDays, state: cart.deliveryState, allowedStates });
  if (refusal) return { ok: false, problem: { code: "ineligible", message: refusal } };
  if (cart.shippingFeeCents == null || !cart.deliveryLine1 || !cart.deliveryState || !cart.deliveryZip) {
    return { ok: false, problem: { code: "ineligible", message: SHIP_ADDRESS_NEEDED } };
  }
  if (cart.shippingQuoteKey !== shippingKey(cart.deliveryState, cart.deliveryZip, orderWeightG(lines))
    || !cart.shippingQuoteExpiresAt || cart.shippingQuoteExpiresAt <= now) {
    return { ok: false, problem: { code: "quote-changed", message: "Your shipping rate needs a refresh. Check the new rate, then place your order." } };
  }
  return { ok: true, feeCents: cart.shippingFeeCents, carrier: cart.shippingCarrier ?? "", service: cart.shippingService ?? "", days: cart.shippingDays, handlingDays: handlingDays as number };
}

/** Placement charges the courier fee the shopper last saw and the hold was sized on; it never asks the couriers again. */
function shownCourier(
  cart: { courierFeeCents: number | null; courierProvider: string | null; deliveryLine1: string | null },
  leaveAtDoor: boolean,
): CourierQuoteInput {
  if (cart.courierFeeCents == null || !cart.courierProvider || !cart.deliveryLine1) {
    return { ok: false, problem: { code: "ineligible", message: "Confirm your delivery address to see the courier fee." } };
  }
  return { ok: true, feeCents: cart.courierFeeCents, provider: cart.courierProvider as "Uber Direct" | "DoorDash Drive", leaveAtDoor };
}

export { COURIER_NOT_OFFERED, computeQuote, type StoreDeliveryQuote } from "./quote";
export { checkoutTestHooks } from "./test-hooks";
export { SavedCardUnavailableError } from "./saved-card-payment";
export { LiveModeBlockedError } from "./live-mode";
export { StoreNotTakingOrdersError } from "../order/store-queue";
export { SlotUnavailableError } from "./slots";

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
  /** The checkout's WhatsApp updates tick (#560); kept only when the store has a registered number. */
  whatsappUpdates?: boolean;
  acquisitionSource?: AcquisitionSource | null;
  /** The calculation the hold was sized on (#65); placeOrder always passes it. */
  tax?: CheckoutTax;
}

const UNTAXED: CheckoutTax = { calculationId: null, taxCents: 0, lines: [], liableParty: "platform", key: "" };

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
      // Under the same lock, so two orders cannot both take a slot's last place (#565).
      await assertSlotOffered(tx, storeId, lockedStore, input.fulfillment, input.pickupSlot, now, input.cartId);

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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
        perishable: line.variant.listing.perishable,
        hot: line.variant.listing.prepared === "hot",
        minQty: line.variant.listing.cateringMinQty,
      }));
      if (!sameBasket(current, input.lines)) throw new BasketChangedError();
      const shipping = input.fulfillment === "ship"
        ? shownShipping(
            cart,
            currentLines.map((line) => ({ ships: lineShips(line.variant.listing, line.variant), weightG: line.variant.weightG, qty: line.qty })),
            lockedStore.shippingHandlingDays,
            await readShippingStates(tx),
            now,
          )
        : null;
      const point = cart.deliveryLat != null && cart.deliveryLng != null
        ? { lat: cart.deliveryLat, lng: cart.deliveryLng }
        : null;
      const delivery = input.fulfillment === "store-delivery"
        ? deliveryQuoteInput(lockedStore, point, cart.leaveAtDoor || input.leaveAtDoor === true)
        : null;
      const courier = input.fulfillment === "courier"
        ? shownCourier(cart, cart.leaveAtDoor || input.leaveAtDoor === true)
        : null;
      const serviceFee = await readServiceFeeSettings(tx);
      // Under the store lock, so two orders cannot both take a coupon's last use (#557).
      const couponUserId = input.actorUserId !== undefined ? input.actorUserId : cart.userId;
      const coupon = cart.couponCode
        ? await readCartCoupon(tx, storeId, cart.couponCode, { email: input.contact.email, userId: couponUserId, now })
        : null;
      const refused = customerRefusal(coupon);
      if (refused) throw new CouponRefusedError(refused);
      const untaxedQuote = computeQuote(
        input.minimumOrderCents ?? 0,
        current,
        input.contact,
        input.fulfillment,
        serviceFee,
        delivery,
        courier,
        coupon,
        0,
        shipping,
      );
      const tax = input.tax ?? UNTAXED;
      if (input.tax) {
        const pinned = await pinnedCheckoutTax(tx, storeId, input.cartId, current, untaxedQuote.discountCents, input.fulfillment);
        if (pinned?.key !== input.tax.key) throw new BasketChangedError();
      }
      const currentQuote = withTax(untaxedQuote, tax.taxCents);
      const couponId = appliedCouponId(coupon, currentQuote);
      if (
        currentQuote.problems.length > 0
        || currentQuote.holdCents !== (input.paymentAmount ?? input.quote.holdCents)
      ) {
        throw new BasketChangedError();
      }
      const delivering = (input.fulfillment === "store-delivery" || input.fulfillment === "courier") && point != null;
      const shipped = input.fulfillment === "ship" ? currentQuote.shipping ?? null : null;
      const addressed = delivering || shipped != null;
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
      const whatsappOptIn = input.whatsappUpdates === true && await storeHasWhatsAppNumber(storeId, tx);
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
          // A courier order keeps the courier fee here; courierFeeCents() reads it back (#495). A shipped order keeps its postage (#567).
          deliveryFeeCents: currentQuote.deliveryFeeCents + currentQuote.courierFeeCents + (shipped?.feeCents ?? 0),
          shippingRateId: shipped ? cart.shippingRateId : null,
          shippingCarrier: shipped?.carrier ?? null,
          shippingService: shipped?.service ?? null,
          shippingDays: shipped?.days ?? null,
          totalCents: currentQuote.totalCents,
          paymentIntentId: input.paymentIntentId,
          sourceCartId: input.cartId,
          couponId,
          discountCents: currentQuote.discountCents,
          couponCustomerKey: couponId ? couponCustomerKey(couponUserId, input.contact.email) : null,
          acquisitionSource: input.acquisitionSource ?? null,
          serviceFeeCents: currentQuote.serviceFeeCents,
          taxCents: tax.taxCents,
          taxLines: tax.lines as unknown as Prisma.InputJsonValue,
          taxLiableParty: tax.liableParty,
          taxCalculationId: tax.calculationId,
          serviceFeeBps: serviceFee.rateBps,
          serviceFeeMinCents: serviceFee.minCents,
          serviceFeeMaxCents: serviceFee.maxCents,
          platformFeeCents: captureSplit({
            capturedCents: currentQuote.totalCents,
            serviceFeeCents: currentQuote.serviceFeeCents,
            courierFeeCents: currentQuote.courierFeeCents,
          }).platformFeeCents,
          notes: input.notes || null,
          deliveryLine1: addressed ? cart.deliveryLine1 : null,
          deliveryLine2: addressed ? cart.deliveryLine2 : null,
          deliveryCity: addressed ? cart.deliveryCity : null,
          deliveryState: addressed ? cart.deliveryState : null,
          deliveryZip: addressed ? cart.deliveryZip : null,
          deliveryLat: delivering ? cart.deliveryLat : null,
          deliveryLng: delivering ? cart.deliveryLng : null,
          deliveryDistanceMi: distanceMi,
          leaveAtDoor: delivering ? cart.leaveAtDoor : false,
          trackingToken: newTrackingToken(),
          acceptanceClockStartsAt: availability.clockStartsAt,
          whatsappOptInAt: whatsappOptIn ? now : null,
        },
      });
      const orderLines = await tx.orderLine.createManyAndReturn({
        data: input.lines.map((line) => {
          // #570: prepared food is the exact item only, whatever the cart line said.
          const exact = ownedById.get(line.variantId)?.listing.prepared != null;
          return {
            storeId,
            orderId: order.id,
            listingVariantId: line.variantId,
            substituteVariantId: exact ? null : line.substituteVariantId,
            qtyOrdered: line.qty,
            unitPriceCents: line.price,
            swapRule: exact ? "exact_only" : line.swapRule,
          };
        }),
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
      // The assistant's pickup time was for this order; the next basket starts fresh (#247).
      await tx.aiConversation.updateMany({ where: { cartId: input.cartId }, data: { checkoutDraft: Prisma.DbNull } });
      await tx.cart.update({
        where: { id: input.cartId },
        data: {
          paymentIntentId: null,
          paymentAttemptToken: null,
          purchaseEpoch: { increment: 1 },
          couponCode: null,
          taxCents: null,
          taxLines: Prisma.DbNull,
          taxLiableParty: null,
          taxCalculationId: null,
          taxQuoteKey: null,
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
  perishable: boolean;
  ships: boolean;
  weightG: number;
  hot: boolean;
  minQty: number | null;
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
    perishable: l.variant.listing.perishable,
    ships: l.variant.ships,
    weightG: l.variant.weightG,
    hot: l.variant.listing.prepared === "hot",
    minQty: l.variant.listing.cateringMinQty,
  }));
}

function stripeIntentMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "resource_missing";
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
 * that commits first makes a later place refuse. With `cartUpdatedAt`, a cart
 * written since that read is left alone.
 */
export async function releaseLosingHold(
  storeId: string,
  cartId: string,
  paymentIntentId: string,
  cancellationReason?: "abandoned",
  cartUpdatedAt?: Date,
): Promise<void> {
  const reserved = await storeScopedTransaction(storeId, async (tx) => {
    await lockStoreRow(tx, storeId);
    await lockCart(tx, cartId);
    if (await orderExistsForPaymentIntent(tx, paymentIntentId)) return false;
    const cart = await tx.cart.findUnique({
      where: { id: cartId },
      select: { paymentIntentId: true, updatedAt: true },
    });
    if (cartUpdatedAt && cart && cart.updatedAt.getTime() !== cartUpdatedAt.getTime()) return false;
    await tx.paymentIntentRelease.upsert({
      where: { paymentIntentId },
      create: { paymentIntentId, storeId },
      update: {},
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
    if (stripeAlreadyCanceled(error) || stripeIntentMissing(error)) return;
    console.error(JSON.stringify({
      event: "losing_hold_release_failed",
      paymentIntentId,
      message: "Platform alerted. The authorization expires on its own.",
    }));
  }
}

/** A cart whose intent never got a card is cancelled once untouched this long. */
const DEAD_CART_MS = 24 * 60 * 60_000;
const UNPAID_PAYMENT = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);
/** No hold left to release; the cart's intent is cleared so it leaves the sweep. */
const FINISHED_PAYMENT = new Set(["canceled", "succeeded"]);

/**
 * Releases card holds that never became an order: the intent is still
 * `requires_capture` and was authorized more than the grace ago. Also cancels
 * intents that never got a card within a day, and clears intents that are
 * finished or that Stripe no longer has, so they leave the sweep; a returning
 * shopper gets a fresh intent. A cart that fails its check is still moved to the
 * back. releaseLosingHold re-checks for an order and a cart write since the find
 * under the store and cart locks and writes the tombstone, so a placeOrder that
 * wins the race keeps its hold and a later one is refused.
 */
export async function releaseOrphanHolds(
  carts: ReadonlyArray<{ storeId: string; cartId: string; paymentIntentId: string; updatedAt: Date }>,
): Promise<void> {
  for (const cart of carts) {
    const release = () => releaseLosingHold(cart.storeId, cart.cartId, cart.paymentIntentId, "abandoned", cart.updatedAt);
    try {
      let pi: NormalizedPaymentIntent;
      try {
        pi = await retrieveCheckoutIntent(cart.paymentIntentId);
      } catch (error) {
        if (!stripeIntentMissing(error)) throw error;
        await release();
        continue;
      }
      if (pi.status === "requires_capture" && pi.authorized_at != null) {
        if (Date.now() - pi.authorized_at < ORPHAN_HOLD_GRACE_MS) continue;
        await release();
        continue;
      }
      if (FINISHED_PAYMENT.has(pi.status)
        || (UNPAID_PAYMENT.has(pi.status) && Date.now() - cart.updatedAt.getTime() > DEAD_CART_MS)) {
        await release();
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
      await markOrphanHoldChecked(cart.storeId, cart.cartId, cart.paymentIntentId).catch(() => {});
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
    orderServiceFeeSettings(order),
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
  whatsappUpdates = false,
  acquisitionSource: AcquisitionSource | null = null,
): Promise<PlacedOrder> {
  assertLiveModeAllowed();
  const store = await getStripeStore(storeId);

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
    perishable: l.perishable,
    hot: l.hot,
    minQty: l.minQty,
  }));
  const [storeRow, serviceFee, coupon] = await Promise.all([
    platform.store.findUnique({ where: { id: storeId } }),
    readServiceFeeSettings(),
    cartCoupon(storeId, cartId, contact.email, actorUserId),
  ]);
  if (!storeRow) throw new Error("Store not found");
  const point = cart.delivery.lat != null && cart.delivery.lng != null
    ? { lat: cart.delivery.lat, lng: cart.delivery.lng }
    : null;
  const delivery = fulfillment === "store-delivery"
    ? deliveryQuoteInput(storeRow, point, cart.delivery.leaveAtDoor || leaveAtDoor)
    : null;
  const courier = fulfillment === "courier"
    ? shownCourier(
        await storeScoped(storeId).cart.findUniqueOrThrow({
          where: { id: cartId },
          select: { courierFeeCents: true, courierProvider: true, deliveryLine1: true },
        }),
        cart.delivery.leaveAtDoor || leaveAtDoor,
      )
    : null;
  const shipping = fulfillment === "ship"
    ? shownShipping(
        await storeScoped(storeId).cart.findUniqueOrThrow({ where: { id: cartId } }),
        orderLineData,
        storeRow.shippingHandlingDays,
        await readShippingStates(),
        new Date(),
      )
    : null;
  const untaxed = computeQuote(minimumOrderCents, serverLines, contact, fulfillment, serviceFee, delivery, courier, coupon, 0, shipping);
  let quote = untaxed;
  let tax: CheckoutTax;
  try {
    // The quote pinned this calculation; Stripe is called again only when the basket changed since.
    const taxedLines = orderLineData.map((line) => ({ variantId: line.variantId, qty: line.qty, price: line.price }));
    tax = await quoteCheckoutTax(storeId, cartId, taxedLines, untaxed.discountCents, fulfillment);
    quote = withTax(untaxed, tax.taxCents);
  } catch (error) {
    if (error instanceof TaxLocationError || error instanceof TaxUnavailableError) {
      await releaseLosingHold(storeId, cartId, paymentIntentId);
    }
    throw error;
  }

  const contactOnly = quote.problems.length > 0
    && quote.problems.every((problem) => problem.code === "invalid-contact");
  if (contactOnly) {
    throw new Error(quote.problems.map((problem) => problem.message).join(" "));
  }
  const refused = customerRefusal(coupon);
  if (refused) {
    await dropRefusedCoupon(storeId, cartId, paymentIntentId);
    throw new CouponRefusedError(refused);
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
      whatsappUpdates,
      acquisitionSource,
      tax,
      lines: orderLineData.map((line) => ({
        variantId: line.variantId,
        qty: line.qty,
        price: line.price,
        swapRule: line.swapRule,
        substituteVariantId: line.substituteVariantId,
      })),
    });
  } catch (error) {
    if (error instanceof CouponRefusedError) {
      await dropRefusedCoupon(storeId, cartId, paymentIntentId);
      throw error;
    }
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
    if (
      error instanceof BasketChangedError
      || error instanceof StoreNotTakingOrdersError
      || error instanceof SlotUnavailableError
    ) {
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

/**
 * A guest learns of a per-customer or first-order refusal only here, after paying (#557): the hold is
 * released and the code taken off the cart, so the next quote shows the full price.
 */
async function dropRefusedCoupon(storeId: string, cartId: string, paymentIntentId: string): Promise<void> {
  await releaseLosingHold(storeId, cartId, paymentIntentId);
  await removeCartCoupon(storeId, cartId);
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
  const [cart, serviceFee] = await Promise.all([getCartWithLines(storeId, cartId), readServiceFeeSettings()]);
  const serverLines = cart
    ? cart.lines.map((line) => ({
        price: line.variant.price,
        qty: line.qty,
        maxPerOrder: line.variant.listing.maxPerOrder,
      }))
    : [];
  return computeQuote(minimumOrderCents, serverLines, contact, fulfillment, serviceFee);
}
