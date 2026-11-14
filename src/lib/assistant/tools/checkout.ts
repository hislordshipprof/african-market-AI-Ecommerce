import { storeScoped } from "../../db";
import { computeQuote } from "../../checkout/quote";
import { readServiceFeeSettings } from "../../order/service-fee-settings";
import { pickupSlotsToday } from "../../order/pickup-slots";
import { readConversationDraft, readPickupStore, writeCheckoutDraft } from "../checkout-draft";
import { mayBeUnavailable } from "./availability";
import { listingName, recordRead, type AssistantContext, type ToolResult } from "./execute";
import { getFulfillmentOptionsInput, parseToolInput, prepareCheckoutInput, setFulfillmentInput } from "./schemas";

/** Where the Review card's button goes: the normal checkout, where money moves only on its Pay button. */
export const CHECKOUT_PATH = "/checkout";

const MESSAGES: Record<string, string> = {
  store_not_found: "This store is not available.",
  pickup_unavailable: "This store does not offer pickup right now. Delivery, if the store offers it, is chosen on the checkout page.",
  slot_not_offered: "That pickup time is not offered. Call get_fulfillment_options for today's times.",
  cart_empty: "The cart is empty.",
};

function fail(code: string): ToolResult {
  return { ok: false, code, message: MESSAGES[code] ?? "That did not work." };
}

export async function getFulfillmentOptions(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(getFulfillmentOptionsInput, input);
  const store = await readPickupStore(ctx.storeId);
  if (!store) return recordRead(ctx, "get_fulfillment_options", parsed, fail("store_not_found"));
  const slots = pickupSlotsToday(store, new Date());
  return recordRead(ctx, "get_fulfillment_options", parsed, {
    ok: true,
    pickup: {
      offered: store.pickupEnabled,
      slots: slots.map((slot) => ({ slotId: slot.id, label: slot.label })),
      ...(store.pickupEnabled && slots.length === 0 ? { message: "No pickup times are left today." } : {}),
      ...(!store.pickupEnabled ? { message: MESSAGES.pickup_unavailable } : {}),
    },
    delivery: "Delivery and its address are chosen on the checkout page.",
  });
}

export async function setFulfillment(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(setFulfillmentInput, input);
  const store = await readPickupStore(ctx.storeId);
  if (!store) return recordRead(ctx, "set_fulfillment", parsed, fail("store_not_found"));
  if (!store.pickupEnabled) return recordRead(ctx, "set_fulfillment", parsed, fail("pickup_unavailable"));
  const slot = pickupSlotsToday(store, new Date()).find((offered) => offered.id === parsed.slot_id);
  if (!slot) return recordRead(ctx, "set_fulfillment", parsed, fail("slot_not_offered"));
  await writeCheckoutDraft(ctx.storeId, ctx.conversationId, { fulfillment: "pickup", slot: slot.id });
  return recordRead(ctx, "set_fulfillment", parsed, {
    ok: true,
    fulfillment: "pickup",
    slotId: slot.id,
    slotLabel: slot.label,
  });
}

/**
 * Draws the Review card from the live cart and the normal checkout quote. It
 * places nothing and holds nothing: the card is information, not consent.
 */
export async function prepareCheckout(ctx: AssistantContext, input: unknown): Promise<ToolResult> {
  const parsed = parseToolInput(prepareCheckoutInput, input);
  const [store, cart, serviceFee, draft] = await Promise.all([
    readPickupStore(ctx.storeId),
    storeScoped(ctx.storeId).cart.findUnique({
      where: { id: ctx.cartId },
      include: {
        lines: {
          orderBy: { createdAt: "asc" },
          include: { variant: { include: { listing: { include: { masterProduct: true } } } } },
        },
      },
    }),
    readServiceFeeSettings(),
    readConversationDraft(ctx.storeId, ctx.conversationId),
  ]);
  if (!store) return recordRead(ctx, "prepare_checkout", parsed, fail("store_not_found"));
  const cartLines = cart?.lines ?? [];
  if (cartLines.length === 0) return recordRead(ctx, "prepare_checkout", parsed, fail("cart_empty"));
  const quote = computeQuote(
    store.minimumOrderCents,
    cartLines.map((line) => ({
      price: line.variant.price,
      qty: line.qty,
      maxPerOrder: line.variant.listing.maxPerOrder,
      frozen: line.variant.listing.frozen,
    })),
    { name: "", email: "", phone: "" },
    "pickup",
    serviceFee,
  );
  const slot = draft ? pickupSlotsToday(store, new Date()).find((offered) => offered.id === draft.slot) : undefined;
  // Contact is entered on the checkout page, so its problem is not the card's.
  const problems = [...new Set(quote.problems.filter((problem) => problem.code !== "invalid-contact").map((problem) => problem.message))];
  for (const line of cartLines) {
    if (!line.variant.listing.active) problems.push(`${listingName(line.variant.listing)} is unavailable.`);
  }
  return recordRead(ctx, "prepare_checkout", parsed, {
    ok: true,
    lines: cartLines.map((line) => ({
      lineId: line.id,
      name: listingName(line.variant.listing),
      packLabel: line.variant.label,
      qty: line.qty,
      unitPriceCents: line.variant.price,
      lineTotalCents: line.variant.price * line.qty,
      mayBeUnavailable: mayBeUnavailable(line.variant.listing),
    })),
    fulfillment: slot ? { kind: "pickup", slotId: slot.id, slotLabel: slot.label } : null,
    subtotalCents: quote.subtotalCents,
    serviceFeeCents: quote.serviceFeeCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    bufferCents: quote.bufferCents,
    holdCents: quote.holdCents,
    problems,
    checkoutPath: CHECKOUT_PATH,
    note: "The customer enters contact and card and pays on the checkout page. Nothing is ordered or charged until they tap Pay there.",
  });
}
