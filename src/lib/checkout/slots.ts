import type { PrismaClient } from "@prisma/client";
import type { Fulfillment } from "../customer-flow/contracts";
import { ASAP_SLOT, type PickupSlot } from "../order/pickup-slots";
import { pickupSlotsFor, readSlotSchedule, scheduledSlots, type SlotStore } from "../order/slot-schedule";
import { orderPrepMinutes } from "../listing/prepared";

export interface SlotStoreRow extends SlotStore {
  storeDeliverySlotSettings: unknown;
}

/** `required`: ASAP is not offered, the order must take one of `slots`. */
export interface SlotOptions {
  required: boolean;
  slots: PickupSlot[];
  /** Pickup: the basket's prep minutes, the store's plus its longest prepared item (#570). */
  prepMinutes?: number;
}

type SlotClient = Pick<PrismaClient, "order" | "cartLine">;

/** The store's prep plus the cart's longest prepared item, so no pickup time comes before the food is ready (#570). */
async function cartPrepMinutes(client: SlotClient, cartId: string | null, storePrepMinutes: number): Promise<number> {
  if (!cartId) return storePrepMinutes;
  const lines = await client.cartLine.findMany({
    where: { cartId, variant: { listing: { prepared: { not: null } } } },
    select: { variant: { select: { listing: { select: { prepared: true, prepMinutes: true } } } } },
  });
  return orderPrepMinutes(storePrepMinutes, lines.map((line) => line.variant.listing));
}

export class SlotUnavailableError extends Error {
  readonly code = "slot_unavailable" as const;
  constructor(readonly options: SlotOptions) {
    super("That time is no longer available. Choose another time.");
    this.name = "SlotUnavailableError";
  }
}

/** A slot is released when its order is cancelled. */
async function bookedCounts(
  client: Pick<PrismaClient, "order">,
  storeId: string,
  fulfillment: Fulfillment,
): Promise<Map<string, number>> {
  const rows = await client.order.findMany({
    where: { storeId, fulfillment, pickupSlot: { gt: new Date().toISOString() }, status: { not: "CANCELLED" } },
    select: { pickupSlot: true },
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.pickupSlot) counts.set(row.pickupSlot, (counts.get(row.pickupSlot) ?? 0) + 1);
  }
  return counts;
}

/**
 * The times checkout offers for a fulfillment (#565). Pickup keeps ASAP; store
 * delivery with a schedule must take a slot, and without one stays on demand.
 * Courier stays on demand.
 */
export async function slotOptions(
  client: SlotClient,
  storeId: string,
  store: SlotStoreRow,
  fulfillment: Fulfillment,
  now: Date,
  cartId: string | null,
): Promise<SlotOptions> {
  if (fulfillment === "pickup") {
    const prepMinutes = await cartPrepMinutes(client, cartId, store.prepTimeMinutes);
    const slots = pickupSlotsFor({ ...store, prepTimeMinutes: prepMinutes }, now, await bookedCounts(client, storeId, fulfillment))
      .filter((slot) => slot.id !== ASAP_SLOT.id);
    // Without a schedule the times are today's and carry no date.
    const today = !readSlotSchedule(store.pickupSlotSettings);
    return { required: false, slots: today ? slots.map((slot) => ({ ...slot, label: `Today ${slot.label}` })) : slots, prepMinutes };
  }
  const schedule = fulfillment === "store-delivery" ? readSlotSchedule(store.storeDeliverySlotSettings) : null;
  if (!schedule) return { required: false, slots: [] };
  const booked = await bookedCounts(client, storeId, fulfillment);
  return { required: true, slots: scheduledSlots(schedule, store.timezone, now, booked) };
}

/** Refuses a slot that is not offered now, or ASAP where a slot is required. Run under the store lock to reserve. */
export async function assertSlotOffered(
  client: SlotClient,
  storeId: string,
  store: SlotStoreRow,
  fulfillment: Fulfillment,
  slot: string | null,
  now: Date,
  cartId: string | null,
): Promise<void> {
  const options = await slotOptions(client, storeId, store, fulfillment, now, cartId);
  const asap = slot === null || slot === ASAP_SLOT.id;
  if (asap ? options.required : !options.slots.some((offered) => offered.id === slot)) {
    throw new SlotUnavailableError(options);
  }
}
