import { storeScoped } from "../db";
import type { DeliveryProvider, DeliveryProviderName, DeliveryQuote, DeliveryRequest } from "./provider";

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
}

export type DispatchResult =
  | { ok: true; deliveryId: string; provider: DeliveryProviderName; courierProvider: CourierBrand; quoteFeeCents: number }
  | { ok: false; reason: "both_failed" };

/** One id per order and provider: failover never returns to a provider the order already used. */
function externalDeliveryId(orderId: string, provider: DeliveryProviderName): string {
  return `${orderId}-${provider}`;
}

/**
 * Quotes every provider at once and books the cheapest live quote. A provider that cannot quote (missing keys,
 * HTTP error) or quotes an expired price is unavailable. A create error moves straight to the next cheapest.
 */
export async function selectAndDispatch(input: DispatchInput, deps: DispatchDeps): Promise<DispatchResult> {
  const now = deps.now ?? (() => new Date());
  const requestFor = (provider: DeliveryProvider): DeliveryRequest => ({
    ...input.request,
    externalDeliveryId: externalDeliveryId(input.orderId, provider.name),
  });

  const settled = await Promise.all(
    deps.providers.map(async (provider) => {
      try {
        return { provider, quote: await provider.quote(requestFor(provider)) };
      } catch (err) {
        logUnavailable(input.orderId, provider.name, "quote", err);
        return null;
      }
    }),
  );
  const candidates = settled
    .filter((c): c is { provider: DeliveryProvider; quote: DeliveryQuote } => c !== null && c.quote.expiresAt > now())
    .sort((a, b) => a.quote.feeCents - b.quote.feeCents);

  for (const { provider, quote } of candidates) {
    const req = requestFor(provider);
    try {
      const fresh = quote.expiresAt > now() ? quote : await provider.quote(req);
      const created = await provider.create(fresh.quoteId, req);
      const delivery = await storeScoped(input.storeId).delivery.create({
        data: {
          storeId: input.storeId,
          orderId: input.orderId,
          provider: provider.name,
          externalId: created.externalId,
          status: "requested",
          quoteFeeCents: fresh.feeCents,
          trackingUrl: created.trackingUrl,
        },
      });
      await deps.emit({ name: COURIER_DELIVERY_CREATED, data: { storeId: input.storeId, deliveryId: delivery.id } });
      return { ok: true, deliveryId: delivery.id, provider: provider.name, courierProvider: courierBrand(provider.name), quoteFeeCents: fresh.feeCents };
    } catch (err) {
      logUnavailable(input.orderId, provider.name, "create", err);
      await deps.emit({
        name: COURIER_FAILOVER_TRIGGERED,
        data: { storeId: input.storeId, orderId: input.orderId, fromProvider: provider.name, reason: "create_failed" },
      });
    }
  }
  await emitBothFailed(input.storeId, input.orderId, deps.emit);
  return { ok: false, reason: "both_failed" };
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

export async function runCourierFailover(): Promise<void> {
  throw new Error("not implemented");
}
