import { randomUUID } from "node:crypto";
import { storeScoped } from "../db";
import { DeliveryProviderError, type CreatedDelivery, type DeliveryProvider, type DeliveryProviderName, type DeliveryQuote, type DeliveryRequest } from "./provider";

/** Spec §9, §11.2: no courier assigned this long after the delivery was created → switch provider. */
export const COURIER_ASSIGNMENT_TIMEOUT_MS = 600_000;

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

export type CourierEvent =
  | { name: typeof COURIER_DELIVERY_CREATED; data: { storeId: string; deliveryId: string } }
  | { name: typeof COURIER_FAILOVER_TRIGGERED; data: { storeId: string; orderId: string; fromProvider: DeliveryProviderName; reason: "create_failed" | "assignment_timeout" } }
  | { name: typeof COURIER_BOTH_FAILED; data: { storeId: string; orderId: string; orderNumber: number; options: Array<"store-delivery" | "pickup" | "cancel"> } };

export interface DispatchDeps {
  providers: DeliveryProvider[];
  emit: (event: CourierEvent) => Promise<void>;
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
function externalDeliveryId(orderId: string, provider: DeliveryProviderName): string {
  return `${orderId}-${provider}-${randomUUID().slice(0, 8)}`;
}

/**
 * Quotes every provider at once and books the cheapest live quote. A provider that cannot quote (missing keys,
 * HTTP error) or quotes an expired price is unavailable. A create error moves straight to the next cheapest.
 */
export async function selectAndDispatch(input: DispatchInput, deps: DispatchDeps): Promise<DispatchResult> {
  const now = deps.now ?? (() => new Date());
  const quoteWith = async (provider: DeliveryProvider) => {
    const req: DeliveryRequest = {
      ...input.request,
      pickup: { ...input.request.pickup, ...input.registrations?.[provider.name] },
      externalDeliveryId: externalDeliveryId(input.orderId, provider.name),
    };
    return { provider, req, quote: await provider.quote(req) };
  };

  const settled = await Promise.all(
    deps.providers.map(async (provider) => {
      try {
        return await quoteWith(provider);
      } catch (err) {
        logUnavailable(input.orderId, provider.name, "quote", err);
        return null;
      }
    }),
  );
  const candidates = settled
    .filter((c): c is { provider: DeliveryProvider; req: DeliveryRequest; quote: DeliveryQuote } => c !== null && c.quote.expiresAt > now())
    .sort((a, b) => a.quote.feeCents - b.quote.feeCents);

  for (const [i, candidate] of candidates.entries()) {
    const { provider } = candidate;
    let booked: { quote: DeliveryQuote; created: CreatedDelivery };
    try {
      const { req, quote } = candidate.quote.expiresAt > now() ? candidate : await quoteWith(provider);
      booked = { quote, created: await provider.create(quote.quoteId, req) };
    } catch (err) {
      logUnavailable(input.orderId, provider.name, "create", err);
      if (i < candidates.length - 1) {
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
  await emit({ name: COURIER_BOTH_FAILED, data: { storeId, orderId, orderNumber: order.number, options } });
}

function logUnavailable(orderId: string, provider: DeliveryProviderName, stage: "quote" | "create", err: unknown) {
  const message = err instanceof Error ? err.message : "unknown";
  console.warn(JSON.stringify({ event: "courier_provider_unavailable", orderId, provider, stage, message }));
}

/** The courier request for an order, from the store's address and the order's delivery snapshot. */
export async function courierRequest(storeId: string, orderId: string): Promise<Pick<DispatchInput, "request" | "registrations">> {
  const order = await storeScoped(storeId).order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      subtotalCents: true,
      tipCents: true,
      leaveAtDoor: true,
      deliveryLine1: true,
      deliveryLine2: true,
      deliveryCity: true,
      deliveryState: true,
      deliveryZip: true,
      customer: { select: { name: true, phone: true } },
      store: { select: { name: true, addressLine1: true, addressLine2: true, city: true, state: true, zip: true, doordashStoreId: true } },
    },
  });
  const { store, customer } = order;
  if (!store.addressLine1 || !store.city || !store.state || !store.zip) throw new Error("Store has no pickup address");
  if (!order.deliveryLine1 || !order.deliveryCity || !order.deliveryState || !order.deliveryZip) throw new Error("Order has no delivery address");
  if (!customer.phone) throw new Error("Customer has no phone");
  const [givenName, ...rest] = customer.name.trim().split(/\s+/);
  // DoorDash registers the store with our store id as both business and store id (doordash-registration.ts).
  // Uber's organization id is not an external_store_id, so Uber gets none.
  const registrations = store.doordashStoreId ? { doordash: { providerBusinessId: storeId, providerStoreId: store.doordashStoreId } } : {};
  const request = {
    pickup: {
      businessName: store.name,
      address: { line1: store.addressLine1, line2: store.addressLine2, city: store.city, state: store.state, zip: store.zip },
    },
    dropoff: {
      address: { line1: order.deliveryLine1, line2: order.deliveryLine2, city: order.deliveryCity, state: order.deliveryState, zip: order.deliveryZip },
      phone: customer.phone,
      givenName,
      familyName: rest.join(" ") || undefined,
      contactless: order.leaveAtDoor,
    },
    orderValueCents: order.subtotalCents,
    tipCents: order.tipCents,
  };
  return { request, registrations };
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
  const deadlineIso = (await step.run("courier-timer-plan", async () => {
    const delivery = await storeScoped(storeId).delivery.findUnique({ where: { id: deliveryId }, select: { createdAt: true } });
    return delivery ? new Date(delivery.createdAt.getTime() + COURIER_ASSIGNMENT_TIMEOUT_MS).toISOString() : null;
  })) as string | null;
  if (!deadlineIso) return;
  await step.sleepUntil("courier-assignment-timeout", new Date(deadlineIso));

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
    const used = await storeScoped(storeId).delivery.findMany({ where: { orderId: delivery.orderId }, select: { id: true, provider: true, status: true } });
    // A replay of this step after it booked the alternate must not book again or report a failure. It sends the
    // timer event again (the event id drops a repeat), in case that send is what failed.
    const live = used.find((u) => u.status !== "cancelled");
    if (live) {
      await deps.emit({ name: COURIER_DELIVERY_CREATED, data: { storeId, deliveryId: live.id } });
      return;
    }
    const alternates = deps.providers.filter((p) => !used.some((u) => u.provider === p.name));
    if (alternates.length > 0) {
      const fromProvider = delivery.provider as DeliveryProviderName;
      await deps.emit({ name: COURIER_FAILOVER_TRIGGERED, data: { storeId, orderId: delivery.orderId, fromProvider, reason: "assignment_timeout" } });
    }
    await selectAndDispatch({ storeId, orderId: delivery.orderId, ...(await courierRequest(storeId, delivery.orderId)) }, { ...deps, providers: alternates });
  });
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
