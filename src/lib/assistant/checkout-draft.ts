import { platform, storeScoped } from "../db";
import { slotOptions } from "../checkout/slots";
import { ASAP_SLOT, type PickupSlot } from "../order/pickup-slots";
import { describeQueue, storeAvailability } from "../order/store-queue";

/**
 * The assistant's checkout draft (#247): the pickup slot chosen in chat. The
 * normal checkout page reads it for the same cart. Contact and card are never
 * stored here; they are entered on that page.
 */
export interface CheckoutDraft {
  fulfillment: "pickup";
  slot: string;
}

export function parseCheckoutDraft(value: unknown): CheckoutDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.fulfillment !== "pickup" || typeof row.slot !== "string") return null;
  return { fulfillment: "pickup", slot: row.slot };
}

export async function readPickupStore(storeId: string) {
  return platform.store.findUnique({
    where: { id: storeId },
    select: { hours: true, timezone: true, prepTimeMinutes: true, pickupEnabled: true, minimumOrderCents: true, pickupSlotSettings: true, storeDeliverySlotSettings: true, deliveryPausedUntil: true },
  });
}

type PickupStoreRow = NonNullable<Awaited<ReturnType<typeof readPickupStore>>>;

/**
 * The pickup times the checkout page offers this cart (#764): ASAP, or "when the store opens" while it is
 * closed, unless a time is required; then the same times as the page's Schedule pickup. None when the store
 * takes no orders now or pickup is off.
 */
export async function offeredPickupSlots(storeId: string, store: PickupStoreRow, cartId: string, now: Date): Promise<PickupSlot[]> {
  const availability = storeAvailability(store.hours, store.timezone, now);
  if (!store.pickupEnabled || availability.kind === "unavailable") return [];
  const options = await slotOptions(storeScoped(storeId), storeId, store, "pickup", now, cartId);
  if (options.required) return options.slots;
  const prepMinutes = options.prepMinutes ?? store.prepTimeMinutes;
  const queue = availability.kind === "queued" ? describeQueue(availability.clockStartsAt, prepMinutes, store.timezone) : null;
  const asap = queue ? { id: ASAP_SLOT.id, label: `When the store opens: ${queue.opensAt}, ready about ${queue.readyAt}` } : ASAP_SLOT;
  return [asap, ...options.slots];
}

export async function writeCheckoutDraft(storeId: string, conversationId: string, draft: CheckoutDraft): Promise<void> {
  await storeScoped(storeId).aiConversation.update({
    where: { id: conversationId },
    data: { checkoutDraft: { fulfillment: draft.fulfillment, slot: draft.slot } },
  });
}

export async function readConversationDraft(storeId: string, conversationId: string): Promise<CheckoutDraft | null> {
  const row = await storeScoped(storeId).aiConversation.findUnique({
    where: { id: conversationId },
    select: { checkoutDraft: true },
  });
  return parseCheckoutDraft(row?.checkoutDraft);
}

/**
 * The draft for this cart's conversation, with its slot re-checked against
 * the offered slots. A slot no longer offered is dropped, so checkout
 * never pre-selects a time the store cannot meet.
 */
export async function loadCheckoutDraft(
  storeId: string,
  cartId: string,
  now: Date = new Date(),
): Promise<{ fulfillment: "pickup"; slot: PickupSlot } | null> {
  const row = await storeScoped(storeId).aiConversation.findUnique({
    where: { storeId_cartId: { storeId, cartId } },
    select: { checkoutDraft: true },
  });
  const draft = parseCheckoutDraft(row?.checkoutDraft);
  if (!draft) return null;
  const store = await readPickupStore(storeId);
  const slot = store ? (await offeredPickupSlots(storeId, store, cartId, now)).find((offered) => offered.id === draft.slot) : undefined;
  return slot ? { fulfillment: "pickup", slot } : null;
}
