import { platform, storeScoped } from "../db";
import { pickupSlotsToday, type PickupSlot } from "../order/pickup-slots";

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
    select: { hours: true, timezone: true, prepTimeMinutes: true, pickupEnabled: true, minimumOrderCents: true },
  });
}

/** Today's slots for the store; empty when the store is missing. */
export async function offeredPickupSlots(storeId: string, now: Date): Promise<PickupSlot[]> {
  const store = await readPickupStore(storeId);
  return store ? pickupSlotsToday(store, now) : [];
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
 * today's offered slots. A slot no longer offered is dropped, so checkout
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
  const slot = (await offeredPickupSlots(storeId, now)).find((offered) => offered.id === draft.slot);
  return slot ? { fulfillment: "pickup", slot } : null;
}
