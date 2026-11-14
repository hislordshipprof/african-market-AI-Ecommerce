import type { PrismaClient } from "@prisma/client";
import type { Fulfillment } from "../customer-flow/contracts";
import { ASAP_SLOT, type PickupSlot } from "../order/pickup-slots";
import { pickupSlotsFor, readSlotSchedule, scheduledSlots, type SlotStore } from "../order/slot-schedule";

export interface SlotStoreRow extends SlotStore {
  storeDeliverySlotSettings: unknown;
}

/** `required`: ASAP is not offered, the order must take one of `slots`. */
export interface SlotOptions {
  required: boolean;
  slots: PickupSlot[];
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
  client: Pick<PrismaClient, "order">,
  storeId: string,
  store: SlotStoreRow,
  fulfillment: Fulfillment,
  now: Date,
): Promise<SlotOptions> {
  if (fulfillment === "pickup") {
    const slots = pickupSlotsFor(store, now, await bookedCounts(client, storeId, fulfillment));
    return { required: false, slots: slots.filter((slot) => slot.id !== ASAP_SLOT.id) };
  }
  const schedule = fulfillment === "store-delivery" ? readSlotSchedule(store.storeDeliverySlotSettings) : null;
  if (!schedule) return { required: false, slots: [] };
  const booked = await bookedCounts(client, storeId, fulfillment);
  return { required: true, slots: scheduledSlots(schedule, store.timezone, now, booked) };
}

/** Refuses a slot that is not offered now, or ASAP where a slot is required. Run under the store lock to reserve. */
export async function assertSlotOffered(
  client: Pick<PrismaClient, "order">,
  storeId: string,
  store: SlotStoreRow,
  fulfillment: Fulfillment,
  slot: string | null,
  now: Date,
): Promise<void> {
  const options = await slotOptions(client, storeId, store, fulfillment, now);
  const asap = slot === null || slot === ASAP_SLOT.id;
  if (asap ? options.required : !options.slots.some((offered) => offered.id === slot)) {
    throw new SlotUnavailableError(options);
  }
}
