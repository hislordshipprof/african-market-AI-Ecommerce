import { storeScoped } from "../db";
import { computeQuote, recordAuthorizedOrder } from "../checkout/service";
import { setAuthorizedAmount } from "../stripe/fake";
import type { Contact } from "../customer-flow/contracts";
import { ADR_0021_SERVICE_FEE } from "./platform-fee";

const CONTACT: Contact = { name: "Ledger Buyer", phone: "+15551234567", email: "ledger@t141.test" };
const PRICE = 1000;

export async function countedListing(storeId: string, qty: number | null, name = "Counted") {
  const scoped = storeScoped(storeId);
  const listing = await scoped.listing.create({
    data: { storeId, customName: name, price: PRICE, stockMode: "counted", qty, frozen: false, perishable: false },
  });
  const variant = await scoped.listingVariant.create({
    data: { listingId: listing.id, label: "1 unit", price: PRICE, weightG: 100 },
  });
  return { listingId: listing.id, variantId: variant.id };
}

/** Places a real order through the checkout writer, as a customer's confirmed payment does. */
export async function placeOrder(
  storeId: string,
  lines: Array<{ variantId: string; qty: number; substituteVariantId?: string }>,
) {
  const fulfillment = "pickup" as const;
  const scoped = storeScoped(storeId);
  const paymentIntentId = `pi_ledger_${crypto.randomUUID()}`;
  const cart = await scoped.cart.create({ data: { storeId, paymentIntentId } });
  for (const line of lines) {
    await scoped.cartLine.create({
      data: {
        storeId,
        cartId: cart.id,
        variantId: line.variantId,
        qty: line.qty,
        swapRule: line.substituteVariantId ? "named_substitute" : "exact_only",
        substituteVariantId: line.substituteVariantId ?? null,
      },
    });
  }
  const orderLines = lines.map((line) => ({
    variantId: line.variantId,
    qty: line.qty,
    price: PRICE,
    swapRule: line.substituteVariantId ? "named_substitute" : "exact_only",
    substituteVariantId: line.substituteVariantId ?? null,
  }));
  const input = {
    cartId: cart.id,
    contact: CONTACT,
    fulfillment,
    pickupSlot: null,
    notes: null,
    paymentIntentId,
    quote: computeQuote(0, orderLines.map((line) => ({ ...line, maxPerOrder: null })), CONTACT, fulfillment, ADR_0021_SERVICE_FEE),
    lines: orderLines,
  };
  const { orderId } = await recordAuthorizedOrder(storeId, input);
  setAuthorizedAmount(paymentIntentId, input.quote.holdCents);
  const stored = await scoped.orderLine.findMany({ where: { orderId }, orderBy: { id: "asc" } });
  return { orderId, paymentIntentId, input, lineIds: stored.map((line) => line.id) };
}

/** A listing's qty and its order-driven events, oldest first, read under store scope. */
export async function stockOf(storeId: string, listingId: string) {
  const scoped = storeScoped(storeId);
  const listing = await scoped.listing.findUniqueOrThrow({ where: { id: listingId } });
  const events = await scoped.stockEvent.findMany({
    where: { listingId, idempotencyKey: { not: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return { qty: listing.qty, events: events.map((event) => [event.type, event.delta]) };
}
