import { randomInt, randomUUID } from "node:crypto";
import { storeMayUse } from "../billing/plan";
import { storeScoped } from "../db";
import { anyCourierEnabled, enabledProviders, preferredProvider, type CourierSelectionMode, type CourierSettings } from "./courier-settings";
import { DoorDashDriveProvider } from "./doordash";
import { UberDirectProvider } from "./uber-direct";
import { orderReadyEstimate, READY_PUSH_MINUTES } from "./ready-estimate";
import { DeliveryProviderError, type CreatedDelivery, type DeliveryAddress, type DeliveryProvider, type DeliveryProviderName, type DeliveryQuote, type DeliveryRequest } from "./provider";

/** Spec §11.3: above this goods value (the subtotal, before fees, tip and tax), or with any frozen item, the courier checks a PIN at drop-off. */
const PIN_ABOVE_GOODS_CENTS = 15_000;

/** The one rule for the drop-off PIN, used by the checkout quote and by dispatch: frozen goods, or goods strictly above $150. */
export function pinRequired(goodsCents: number, hasFrozenLine: boolean): boolean {
  return hasFrozenLine || goodsCents > PIN_ABOVE_GOODS_CENTS;
}

/** A courier order reached Ready: book its courier, or move the order on to the courier it already has. */
export const COURIER_ORDER_READY = "courier/order.ready";
/** A courier order started packing (#562): book its courier for the estimated ready time. */
export const COURIER_ORDER_PACKING = "courier/order.packing";
/** A courier order was cancelled before capture: cancel its courier. */
export const COURIER_ORDER_CANCELLED = "courier/order.cancelled";
/** A delivered webhook carried a proof photo: copy it into the private bucket. */
export const COURIER_PROOF_RECEIVED = "courier/proof.received";
/** Starts the assignment timer for one delivery. */
export const COURIER_DELIVERY_CREATED = "courier/delivery.created";
/** Domain events for the notification system (#12). */
export const COURIER_FAILOVER_TRIGGERED = "courier.failover_triggered";
export const COURIER_BOTH_FAILED = "courier.both_failed";

/** The brand the customer sees (ADR-0006), as `CheckoutQuote.courierProvider` types it. */
export type CourierBrand = "Uber Direct" | "DoorDash Drive";
const BRANDS: Record<DeliveryProviderName, CourierBrand> = { uber: "Uber Direct", doordash: "DoorDash Drive" };

export function courierBrand(name: DeliveryProviderName): CourierBrand {
  return BRANDS[name];
}

/** Both adapters read their keys per call, so a provider without keys fails its quote and is skipped. */
export function courierProviders(): DeliveryProvider[] {
  return [new DoorDashDriveProvider(), new UberDirectProvider()];
}

export type CourierEvent =
  | { name: typeof COURIER_ORDER_READY; data: { storeId: string; orderId: string } }
  | { name: typeof COURIER_ORDER_PACKING; data: { storeId: string; orderId: string } }
  | { name: typeof COURIER_ORDER_CANCELLED; data: { storeId: string; orderId: string } }
  | { name: typeof COURIER_PROOF_RECEIVED; data: { storeId: string; deliveryId: string } }
  | { name: typeof COURIER_DELIVERY_CREATED; data: { storeId: string; deliveryId: string } }
  | { name: typeof COURIER_FAILOVER_TRIGGERED; data: { storeId: string; orderId: string; fromProvider: DeliveryProviderName; reason: "create_failed" | "assignment_timeout" } }
  | { name: typeof COURIER_BOTH_FAILED; data: { storeId: string; orderId: string; orderNumber: number; options: Array<"store-delivery" | "pickup" | "cancel"> } };

export interface DispatchDeps {
  /** Every adapter. The settings decide which may be quoted; a live delivery is cancelled with its own adapter. */
  providers: DeliveryProvider[];
  emit: (event: CourierEvent) => Promise<void>;
  /** The courier settings (#535), read each time dispatch or failover runs. */
  settings: () => Promise<CourierSettings>;
  now?: () => Date;
}

export interface DispatchInput {
  storeId: string;
  orderId: string;
  request: Omit<DeliveryRequest, "externalDeliveryId">;
  /** The store's registration with each provider. One provider's ids never go to the other. */
  registrations?: Partial<Record<DeliveryProviderName, Pick<DeliveryRequest["pickup"], "providerBusinessId" | "providerStoreId">>>;
}

export type DispatchResult =
  | { ok: true; deliveryId: string; provider: DeliveryProviderName; courierProvider: CourierBrand; quoteFeeCents: number }
  | { ok: false; reason: "both_failed" };

/** A new id for every quote: DoorDash refuses a delivery id it has quoted before (409). */
function externalDeliveryId(referenceId: string, provider: DeliveryProviderName): string {
  return `${referenceId}-${provider}-${randomUUID().slice(0, 8)}`;
}

type QuoteInput = { referenceId: string } & Pick<DispatchInput, "request" | "registrations">;
type Candidate = { provider: DeliveryProvider; req: DeliveryRequest; quote: DeliveryQuote };

function quoteWith(input: QuoteInput, provider: DeliveryProvider): Promise<Candidate> {
  const req: DeliveryRequest = {
    ...input.request,
    pickup: { ...input.request.pickup, ...input.registrations?.[provider.name] },
    externalDeliveryId: externalDeliveryId(input.referenceId, provider.name),
  };
  return provider.quote(req).then((quote) => ({ provider, req, quote }));
}

/**
 * Quotes every provider at once; live quotes come back cheapest first, or with the mode's provider first. A provider
 * that cannot quote (missing keys, HTTP error) or quotes an expired price is unavailable.
 */
async function liveQuotes(input: QuoteInput, providers: DeliveryProvider[], mode: CourierSelectionMode, now: () => Date): Promise<Candidate[]> {
  const settled = await Promise.all(
    providers.map(async (provider) => {
      try {
        return await quoteWith(input, provider);
      } catch (err) {
        logUnavailable(input.referenceId, provider.name, "quote", err);
        return null;
      }
    }),
  );
  const first = preferredProvider(mode);
  const rank = (c: Candidate) => (c.provider.name === first ? 0 : 1);
  return settled
    .filter((c): c is Candidate => c !== null && c.quote.expiresAt > now())
    .sort((a, b) => rank(a) - rank(b) || a.quote.feeCents - b.quote.feeCents);
}

export type CheckoutCourierQuote = { provider: DeliveryProviderName; courierProvider: CourierBrand; feeCents: number; expiresAt: Date };

/** The fee checkout shows (#527): the same selection dispatch books from (#535), with nothing booked. */
export async function quoteCourier(input: QuoteInput, providers: DeliveryProvider[], settings: CourierSettings, now: () => Date = () => new Date()): Promise<CheckoutCourierQuote | null> {
  if (!anyCourierEnabled(settings, input.referenceId)) return null;
  const [chosen] = await liveQuotes(input, enabledProviders(providers, settings), settings.selectionMode, now);
  if (!chosen) return null;
  return { provider: chosen.provider.name, courierProvider: courierBrand(chosen.provider.name), feeCents: chosen.quote.feeCents, expiresAt: chosen.quote.expiresAt };
}

/** Books the first live quote in the settings' order. A create error moves straight to the next one. */
export async function selectAndDispatch(input: DispatchInput, deps: DispatchDeps): Promise<DispatchResult> {
  const now = deps.now ?? (() => new Date());
  const settings = await deps.settings();
  const quoteInput = { ...input, referenceId: input.orderId };
  const candidates = anyCourierEnabled(settings, input.orderId)
    ? await liveQuotes(quoteInput, enabledProviders(deps.providers, settings), settings.selectionMode, now)
    : [];

  for (const [i, candidate] of candidates.entries()) {
    const { provider } = candidate;
    let booked: { quote: DeliveryQuote; created: CreatedDelivery };
    try {
      const { req, quote } = candidate.quote.expiresAt > now() ? candidate : await quoteWith(quoteInput, provider);
      booked = { quote, created: await provider.create(quote.quoteId, req) };
    } catch (err) {
      logUnavailable(input.orderId, provider.name, "create", err);
      if (i < candidates.length - 1) {
        await recordCourierEvent(input.storeId, input.orderId, null, "failover_triggered", { fromProvider: provider.name, reason: "create_failed" });
        await deps.emit({
          name: COURIER_FAILOVER_TRIGGERED,
          data: { storeId: input.storeId, orderId: input.orderId, fromProvider: provider.name, reason: "create_failed" },
        });
      }
      continue;
    }
    const delivery = await recordDelivery(input, provider, booked);
    await deps.emit({ name: COURIER_DELIVERY_CREATED, data: { storeId: input.storeId, deliveryId: delivery.id } });
    return { ok: true, deliveryId: delivery.id, provider: provider.name, courierProvider: courierBrand(provider.name), quoteFeeCents: booked.quote.feeCents };
  }
  await emitBothFailed(input.storeId, input.orderId, deps.emit);
  return { ok: false, reason: "both_failed" };
}

/** A booked courier whose row cannot be written is cancelled with the same provider; no other provider is tried. */
async function recordDelivery(input: DispatchInput, provider: DeliveryProvider, booked: { quote: DeliveryQuote; created: CreatedDelivery }) {
  try {
    return await storeScoped(input.storeId).delivery.create({
      data: {
        storeId: input.storeId,
        orderId: input.orderId,
        provider: provider.name,
        externalId: booked.created.externalId,
        status: "requested",
        quoteFeeCents: booked.quote.feeCents,
        trackingUrl: booked.created.trackingUrl,
        pin: booked.created.pin ?? null,
        pickupReadyAt: input.request.pickupReadyAt ?? null,
      },
    });
  } catch (err) {
    try {
      await provider.cancel(booked.created.externalId);
    } catch (cancelErr) {
      console.error(JSON.stringify({ event: "courier_unrecorded_cancel_failed", orderId: input.orderId, provider: provider.name, externalId: booked.created.externalId, message: cancelErr instanceof Error ? cancelErr.message : "unknown" }));
    }
    throw err;
  }
}

/** Asks the store to deliver itself or convert to pickup, and offers the customer what this store can do. */
async function emitBothFailed(storeId: string, orderId: string, emit: DispatchDeps["emit"]): Promise<void> {
  const order = await storeScoped(storeId).order.findUniqueOrThrow({
    where: { id: orderId },
    select: { number: true, store: { select: { storeDeliveryEnabled: true, pickupEnabled: true } } },
  });
  const options: Array<"store-delivery" | "pickup" | "cancel"> = [];
  if (order.store.storeDeliveryEnabled) options.push("store-delivery");
  if (order.store.pickupEnabled) options.push("pickup");
  options.push("cancel");
  await recordCourierEvent(storeId, orderId, null, "both_failed", { options });
  await emit({ name: COURIER_BOTH_FAILED, data: { storeId, orderId, orderNumber: order.number, options } });
}

/**
 * Failover and both-fail also land on the order's delivery events, so the courier incident log reads them from the
 * database (#536). Keyed like their Inngest event ids: on the replaced delivery for a timeout, else on the order (and
 * the refusing courier for a create error), so a replayed step writes each once.
 */
async function recordCourierEvent(
  storeId: string,
  orderId: string,
  deliveryId: string | null,
  type: "failover_triggered" | "both_failed",
  payload: Record<string, unknown>,
): Promise<void> {
  await storeScoped(storeId).deliveryEvent.createMany({
    data: [{ storeId, orderId, deliveryId, externalEventId: deliveryId || type === "both_failed" ? type : `${type}:${payload.fromProvider}`, type, payload: payload as object }],
    skipDuplicates: true,
  });
}

function logUnavailable(referenceId: string, provider: DeliveryProviderName, stage: "quote" | "create", err: unknown) {
  const message = err instanceof Error ? err.message : "unknown";
  console.warn(JSON.stringify({ event: "courier_provider_unavailable", referenceId, provider, stage, message }));
}

/** The courier request for an order, from the store's address and the order's delivery snapshot. */
export async function courierRequest(storeId: string, orderId: string, pickupReadyAt: Date | null = null): Promise<Pick<DispatchInput, "request" | "registrations">> {
  const order = await storeScoped(storeId).order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      subtotalCents: true,
      tipCents: true,
      leaveAtDoor: true,
      lines: {
        where: { OR: [{ listingVariant: { listing: { frozen: true } } }, { substitutedVariant: { listing: { frozen: true } } }] },
        select: { id: true },
        take: 1,
      },
      deliveryLine1: true,
      deliveryLine2: true,
      deliveryCity: true,
      deliveryState: true,
      deliveryZip: true,
      customer: { select: { name: true, phone: true } },
      store: { select: { name: true, addressLine1: true, addressLine2: true, city: true, state: true, zip: true, phone: true, doordashStoreId: true } },
    },
  });
  const { store, customer } = order;
  if (!order.deliveryLine1 || !order.deliveryCity || !order.deliveryState || !order.deliveryZip) throw new Error("Order has no delivery address");
  if (!customer.phone) throw new Error("Customer has no phone");
  return buildCourierRequest(storeId, store, {
    address: { line1: order.deliveryLine1, line2: order.deliveryLine2, city: order.deliveryCity, state: order.deliveryState, zip: order.deliveryZip },
    phone: customer.phone,
    name: customer.name,
    contactless: order.leaveAtDoor,
  }, {
    orderValueCents: order.subtotalCents,
    tipCents: order.tipCents,
    hasFrozenLine: order.lines.length > 0,
    pickupReadyAt,
  });
}

type CourierStore = {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  doordashStoreId: string | null;
};

/** Both couriers take E.164; checkout accepts any 10-digit US format. */
function e164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone.trim();
}

/** The courier request from the store's address and the customer's drop-off. Checkout quotes and dispatch books the same request. */
export function buildCourierRequest(
  storeId: string,
  store: CourierStore,
  dropoff: { address: DeliveryAddress; phone: string; name: string; contactless: boolean },
  value: { orderValueCents: number; tipCents: number; hasFrozenLine: boolean; pickupReadyAt?: Date | null },
): Pick<DispatchInput, "request" | "registrations"> {
  if (!store.addressLine1 || !store.city || !store.state || !store.zip) throw new Error("Store has no pickup address");
  const [givenName, ...rest] = dropoff.name.trim().split(/\s+/);
  // DoorDash registers the store with our store id as both business and store id (doordash-registration.ts).
  // Uber's organization id is not an external_store_id, so Uber gets none.
  const registrations = store.doordashStoreId ? { doordash: { providerBusinessId: storeId, providerStoreId: store.doordashStoreId } } : {};
  const request = {
    pickup: {
      businessName: store.name,
      address: { line1: store.addressLine1, line2: store.addressLine2, city: store.city, state: store.state, zip: store.zip },
      phone: store.phone ? e164(store.phone) : undefined,
    },
    dropoff: {
      address: dropoff.address,
      phone: e164(dropoff.phone),
      givenName,
      familyName: rest.join(" ") || undefined,
      contactless: dropoff.contactless,
    },
    orderValueCents: value.orderValueCents,
    tipCents: value.tipCents,
    dropoffPin: pinRequired(value.orderValueCents, value.hasFrozenLine) ? String(randomInt(0, 10_000)).padStart(4, "0") : null,
    pickupReadyAt: value.pickupReadyAt ?? null,
  };
  return { request, registrations };
}

export type ReadyDispatchResult = DispatchResult | { ok: false; reason: "not_ready" | "plan" } | { ok: true; deliveryId: string; existing: true };

/** Where a Ready order goes when its courier, booked at packing start, has already moved on. */
const ORDER_STATUS_FOR_DELIVERY: Record<string, "COURIER_REQUESTED" | "COURIER_ASSIGNED" | "PICKED_UP"> = {
  requested: "COURIER_REQUESTED",
  courier_assigned: "COURIER_ASSIGNED",
  picked_up: "PICKED_UP",
};

/** Packing has started and nothing is captured yet: the statuses a courier is booked or pushed in (#562). */
const PACKING_STATUSES = ["PICKING", "SUBSTITUTION_PENDING"];
/** A delivery the provider may still send a courier for. */
const CANCELLABLE_DELIVERY = ["requested", "courier_assigned"];

async function liveDelivery(storeId: string, orderId: string) {
  return storeScoped(storeId).delivery.findFirst({
    where: { orderId, status: { not: "cancelled" } },
    select: { id: true, status: true, provider: true, externalId: true },
  });
}

/** The plan gate (#494): courier delivery is Pro only. Checked before any quote; failover does not re-check. */
async function planAllowsCourier(storeId: string, orderId: string): Promise<boolean> {
  if (await storeMayUse(storeId, "courier-delivery")) return true;
  console.error(JSON.stringify({ event: "courier_plan_blocked", storeId, orderId }));
  return false;
}

/**
 * Books the courier for an order that reached Ready. Safe to run again: an order with a live delivery only re-sends
 * its timer event and moves on to that delivery's step, so a retried step or a packing-time booking (#562) never
 * books a second courier.
 */
export async function dispatchReadyOrder(storeId: string, orderId: string, deps: DispatchDeps): Promise<ReadyDispatchResult> {
  const scoped = storeScoped(storeId);
  const order = await scoped.order.findUnique({ where: { id: orderId }, select: { status: true, fulfillment: true } });
  if (order?.fulfillment !== "courier" || !["READY", "COURIER_REQUESTED"].includes(order.status)) return { ok: false, reason: "not_ready" };
  const markRequested = (status: "COURIER_REQUESTED" | "COURIER_ASSIGNED" | "PICKED_UP" = "COURIER_REQUESTED") =>
    scoped.order.updateMany({ where: { id: orderId, status: { in: ["READY", "COURIER_REQUESTED"] } }, data: { status } });

  const live = await liveDelivery(storeId, orderId);
  if (live) {
    await deps.emit({ name: COURIER_DELIVERY_CREATED, data: { storeId, deliveryId: live.id } });
    await markRequested(ORDER_STATUS_FOR_DELIVERY[live.status] ?? "COURIER_REQUESTED");
    return { ok: true, deliveryId: live.id, existing: true };
  }
  if (!(await planAllowsCourier(storeId, orderId))) return { ok: false, reason: "plan" };
  const result = await selectAndDispatch({ storeId, orderId, ...(await courierRequest(storeId, orderId)) }, deps);
  if (result.ok) await markRequested();
  return result;
}

export type PackingDispatchResult = DispatchResult | { ok: false; reason: "not_packing" | "plan" } | { ok: true; deliveryId: string; existing: true };

/**
 * Books the courier when packing starts (#562), for the order's estimated ready time, so the courier arrives as the
 * bag is packed. The order stays where it is; Ready moves it on (dispatchReadyOrder). An order already at Ready is
 * left to the ready booking, and a failed booking here is tried again at Ready.
 */
export async function dispatchPackingOrder(storeId: string, orderId: string, deps: DispatchDeps): Promise<PackingDispatchResult> {
  const now = deps.now ?? (() => new Date());
  const order = await storeScoped(storeId).order.findUnique({ where: { id: orderId }, select: { status: true, fulfillment: true } });
  if (order?.fulfillment !== "courier" || !PACKING_STATUSES.includes(order.status)) return { ok: false, reason: "not_packing" };
  const live = await liveDelivery(storeId, orderId);
  if (live) {
    await deps.emit({ name: COURIER_DELIVERY_CREATED, data: { storeId, deliveryId: live.id } });
    return { ok: true, deliveryId: live.id, existing: true };
  }
  if (!(await planAllowsCourier(storeId, orderId))) return { ok: false, reason: "plan" };
  const pickupReadyAt = await orderReadyEstimate(storeId, orderId, now());
  return selectAndDispatch({ storeId, orderId, ...(await courierRequest(storeId, orderId, pickupReadyAt)) }, deps);
}

export const READY_ALREADY_PUSHED = "The ready time was already pushed once";
export const READY_NOT_PUSHABLE = "This order has no ready time to push";

export type PushReadyResult =
  | { ok: true; readyEstimateAt: Date; courier: "moved" | "rebooked" | "kept" | "none" }
  | { ok: false; error: string };

/**
 * The store's one "5 more minutes" (#562). The ready time moves first, then the courier: the provider moves the
 * booked delivery, or, while no courier is assigned, it is cancelled and booked again through the failover
 * selection. An assigned courier the provider will not move keeps its time. A crash between the cancel and the new
 * booking leaves no live courier, and Ready books one.
 */
export async function pushReadyTime(storeId: string, orderId: string, deps: DispatchDeps): Promise<PushReadyResult> {
  const now = (deps.now ?? (() => new Date()))();
  const scoped = storeScoped(storeId);
  const order = await scoped.order.findUnique({
    where: { id: orderId },
    select: { status: true, fulfillment: true, readyEstimateAt: true, readyPushedAt: true },
  });
  if (!order || order.fulfillment !== "courier") return { ok: false, error: "Order not found" };
  if (!PACKING_STATUSES.includes(order.status) || !order.readyEstimateAt) return { ok: false, error: READY_NOT_PUSHABLE };
  if (order.readyPushedAt) return { ok: false, error: READY_ALREADY_PUSHED };
  const readyEstimateAt = new Date(Math.max(order.readyEstimateAt.getTime(), now.getTime()) + READY_PUSH_MINUTES * 60_000);
  const { count } = await scoped.order.updateMany({
    where: { id: orderId, status: { in: PACKING_STATUSES }, readyPushedAt: null, readyEstimateAt: order.readyEstimateAt },
    data: { readyEstimateAt, readyPushedAt: now },
  });
  if (count === 0) return { ok: false, error: READY_ALREADY_PUSHED };

  const delivery = await liveDelivery(storeId, orderId);
  if (!delivery || !CANCELLABLE_DELIVERY.includes(delivery.status)) return { ok: true, readyEstimateAt, courier: "none" };
  const provider = deps.providers.find((p) => p.name === delivery.provider);
  try {
    if (!provider) throw new Error(`No adapter for ${delivery.provider}`);
    await provider.reschedule(delivery.externalId, readyEstimateAt);
    await scoped.delivery.update({ where: { id: delivery.id }, data: { pickupReadyAt: readyEstimateAt } });
    return { ok: true, readyEstimateAt, courier: "moved" };
  } catch (err) {
    console.warn(JSON.stringify({ event: "courier_reschedule_failed", storeId, orderId, provider: delivery.provider, message: err instanceof Error ? err.message : "unknown" }));
  }
  if (delivery.status !== "requested") return { ok: true, readyEstimateAt, courier: "kept" };
  // The same claim the assignment timer makes, so only one of them replaces this delivery.
  const claimed = await scoped.delivery.updateMany({ where: { id: delivery.id, status: "requested" }, data: { status: "cancelled" } });
  if (claimed.count === 0) return { ok: true, readyEstimateAt, courier: "kept" };
  try {
    if (!provider) throw new Error(`No adapter for ${delivery.provider}`);
    await provider.cancel(delivery.externalId);
  } catch (err) {
    console.error(JSON.stringify({ event: "courier_reschedule_cancel_failed", storeId, orderId, provider: delivery.provider, message: err instanceof Error ? err.message : "unknown" }));
    await scoped.delivery.updateMany({ where: { id: delivery.id, status: "cancelled" }, data: { status: "requested" } });
    return { ok: true, readyEstimateAt, courier: "kept" };
  }
  // The platform's own cancel, so the incident log does not read the provider's echo of it as a courier cancel (#536).
  await scoped.deliveryEvent.createMany({
    data: [{ storeId, orderId, deliveryId: delivery.id, externalEventId: "platform_cancelled", type: "cancelled", payload: { by: "platform", reason: "ready_time_pushed" } }],
    skipDuplicates: true,
  });
  const result = await selectAndDispatch({ storeId, orderId, ...(await courierRequest(storeId, orderId, readyEstimateAt)) }, deps);
  return { ok: true, readyEstimateAt, courier: result.ok ? "rebooked" : "none" };
}

export type CancelCourierResult = { cancelled: number; refused: number } | { skipped: "order_not_cancelled" };

/**
 * A cancelled order (store cancel, auto-cancel, or an order emptied at Ready) cancels its courier (#562). Each
 * delivery is claimed before the provider call. A transient error restores it and throws, so the job retries; a
 * provider that refuses (a courier is already committed) keeps its delivery and is logged for the platform, since a
 * cancel fee may apply.
 */
export async function cancelOrderCouriers(storeId: string, orderId: string, deps: Pick<DispatchDeps, "providers">): Promise<CancelCourierResult> {
  const scoped = storeScoped(storeId);
  const order = await scoped.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (order?.status !== "CANCELLED") return { skipped: "order_not_cancelled" };
  const deliveries = await scoped.delivery.findMany({
    where: { orderId, status: { in: CANCELLABLE_DELIVERY } },
    select: { id: true, status: true, provider: true, externalId: true },
  });
  let cancelled = 0;
  let refused = 0;
  for (const delivery of deliveries) {
    const claimed = await scoped.delivery.updateMany({ where: { id: delivery.id, status: delivery.status }, data: { status: "cancelled" } });
    if (claimed.count === 0) continue;
    const provider = deps.providers.find((p) => p.name === delivery.provider);
    try {
      if (!provider) throw new Error(`No adapter for ${delivery.provider}`);
      await provider.cancel(delivery.externalId);
      cancelled++;
    } catch (err) {
      await scoped.delivery.updateMany({ where: { id: delivery.id, status: "cancelled" }, data: { status: delivery.status } });
      if (!refusedCancel(err)) throw err;
      refused++;
      console.error(JSON.stringify({ event: "courier_cancel_refused", storeId, orderId, deliveryId: delivery.id, provider: delivery.provider, message: err instanceof Error ? err.message : "unknown" }));
    }
  }
  return { cancelled, refused };
}

type FailoverStep = {
  run<T>(id: string, fn: () => Promise<T>): Promise<unknown>;
  sleepUntil(id: string, time: Date): Promise<unknown>;
};

/**
 * The assignment timer for one delivery. At the deadline it claims the delivery (requested → cancelled) in one
 * conditional update, so a courier_assigned webhook that lands first wins and the timer does nothing. Then it cancels with the provider and
 * books a provider this order has not used; with none left, the both-fail path runs.
 */
export async function runCourierFailover(
  step: FailoverStep,
  target: { storeId: string; deliveryId: string },
  deps: DispatchDeps,
): Promise<void> {
  const { storeId, deliveryId } = target;
  // The timeout is read once, when the timer starts; a later settings change does not move this delivery's deadline.
  const plan = (await step.run("courier-timer-plan", async () => {
    const { assignmentTimeoutSeconds } = await deps.settings();
    const timeoutMs = assignmentTimeoutSeconds * 1000;
    return { timeoutMs, deadlineIso: await assignmentDeadline(storeId, deliveryId, timeoutMs) };
  })) as { timeoutMs: number; deadlineIso: string | null };
  const deadlineIso = plan.deadlineIso;
  if (!deadlineIso) return;
  await step.sleepUntil("courier-assignment-timeout", new Date(deadlineIso));
  // The store's one push (#562) can move the ready time, and so the deadline, while the timer sleeps.
  const pushedIso = (await step.run("courier-timer-replan", () => assignmentDeadline(storeId, deliveryId, plan.timeoutMs))) as string | null;
  if (pushedIso && pushedIso > deadlineIso) await step.sleepUntil("courier-assignment-timeout-pushed", new Date(pushedIso));

  const claimed = (await step.run("courier-claim", async () => {
    const { count } = await storeScoped(storeId).delivery.updateMany({
      where: { id: deliveryId, status: "requested" },
      data: { status: "cancelled" },
    });
    return count === 1;
  })) as boolean;
  if (!claimed) return;

  const delivery = await storeScoped(storeId).delivery.findUniqueOrThrow({
    where: { id: deliveryId },
    select: { orderId: true, provider: true, externalId: true },
  });
  const current = deps.providers.find((p) => p.name === delivery.provider);
  const cancelled = (await step.run("courier-cancel", async () => {
    try {
      if (!current) throw new Error(`No adapter for ${delivery.provider}`);
      await current.cancel(delivery.externalId);
      return true;
    } catch (err) {
      // Anything but a definite refusal (5xx, timeout, auth, no adapter) throws, so Inngest retries the step.
      if (!refusedCancel(err)) throw err;
      // A provider that cancelled the delivery itself refuses a second cancel: its webhook already recorded it.
      const providerCancelled = await storeScoped(storeId).deliveryEvent.count({ where: { deliveryId, type: "cancelled" } });
      if (providerCancelled > 0) return true;
      // Otherwise a courier may already be on the way: keep this delivery, book no other.
      console.error(JSON.stringify({ event: "courier_failover_cancel_failed", deliveryId, provider: delivery.provider, message: err instanceof Error ? err.message : "unknown" }));
      await storeScoped(storeId).delivery.updateMany({ where: { id: deliveryId, status: "cancelled" }, data: { status: "requested" } });
      return false;
    }
  })) as boolean;
  if (!cancelled) return;

  await step.run("courier-redispatch", async () => {
    // A cancelled order needs no other courier: the claim above already cancelled this one.
    const order = await storeScoped(storeId).order.findUnique({ where: { id: delivery.orderId }, select: { status: true } });
    if (order?.status === "CANCELLED") return;
    const used = await storeScoped(storeId).delivery.findMany({ where: { orderId: delivery.orderId }, select: { id: true, provider: true, status: true } });
    // A replay of this step after it booked the alternate must not book again or report a failure. It sends the
    // timer event again (the event id drops a repeat), in case that send is what failed.
    const live = used.find((u) => u.status !== "cancelled");
    if (live) {
      await deps.emit({ name: COURIER_DELIVERY_CREATED, data: { storeId, deliveryId: live.id } });
      return;
    }
    const settings = await deps.settings();
    const alternates = enabledProviders(deps.providers.filter((p) => !used.some((u) => u.provider === p.name)), settings);
    if (alternates.length > 0) {
      const fromProvider = delivery.provider as DeliveryProviderName;
      await recordCourierEvent(storeId, delivery.orderId, deliveryId, "failover_triggered", { fromProvider, reason: "assignment_timeout" });
      await deps.emit({ name: COURIER_FAILOVER_TRIGGERED, data: { storeId, orderId: delivery.orderId, fromProvider, reason: "assignment_timeout" } });
    }
    const ready = await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: delivery.orderId }, select: { status: true, readyEstimateAt: true } });
    // Still packing: the replacement keeps the order's ready time. Once Ready, it comes as soon as possible.
    const pickupReadyAt = PACKING_STATUSES.includes(ready.status) && ready.readyEstimateAt && ready.readyEstimateAt > (deps.now ?? (() => new Date()))() ? ready.readyEstimateAt : null;
    await selectAndDispatch({ storeId, orderId: delivery.orderId, ...(await courierRequest(storeId, delivery.orderId, pickupReadyAt)) }, { ...deps, providers: alternates, settings: async () => settings });
  });
}

/**
 * No courier assigned this long after booking switches provider. A courier booked for a ready time (#562) is not
 * expected before then, so its deadline is the later of the two.
 */
async function assignmentDeadline(storeId: string, deliveryId: string, timeoutMs: number): Promise<string | null> {
  const delivery = await storeScoped(storeId).delivery.findUnique({ where: { id: deliveryId }, select: { createdAt: true, pickupReadyAt: true } });
  if (!delivery) return null;
  const deadline = Math.max(delivery.createdAt.getTime() + timeoutMs, delivery.pickupReadyAt?.getTime() ?? 0);
  return new Date(deadline).toISOString();
}

/** A 4xx that says the provider will not cancel this delivery. Auth, timeout and rate-limit errors can pass on a retry. */
function refusedCancel(err: unknown): boolean {
  return err instanceof DeliveryProviderError && err.status >= 400 && err.status < 500 && ![401, 403, 408, 429].includes(err.status);
}

/** Inngest's onFailure for the timer: once retries run out, an order left with no live courier goes to the both-fail path. */
export async function courierFailoverFailed(target: { storeId: string; deliveryId: string }, deps: DispatchDeps): Promise<void> {
  const { storeId, deliveryId } = target;
  console.error(JSON.stringify({ event: "courier_failover_failed", storeId, deliveryId }));
  const delivery = await storeScoped(storeId).delivery.findUnique({ where: { id: deliveryId }, select: { orderId: true } });
  if (!delivery) return;
  const live = await storeScoped(storeId).delivery.count({ where: { orderId: delivery.orderId, status: { not: "cancelled" } } });
  if (live === 0) await emitBothFailed(storeId, delivery.orderId, deps.emit);
}
