import { storeScopedTransaction, lockStoreRow, getNextOrderNumber, storeScoped } from "../db";
import { getCartWithLines, type CartLineView } from "../cart/service";
import { getStripeClient } from "../stripe/provider";
import { sendOrderAuthorized } from "../inngest/send";
import type {
  CheckoutQuote,
  Contact,
  FlowProblem,
  Fulfillment,
} from "../customer-flow/contracts";

async function getStripeStore(storeId: string) {
  const store = await (await import("../db")).platform.store.findUnique({ where: { id: storeId } });
  if (!store?.stripeAccountId) {
    throw new Error("Store is not connected to Stripe");
  }
  return store as typeof store & { stripeAccountId: string };
}

const PHONE_RE = /^\+?[\d\s().-]{10,20}$/;
function validPhone(phone: string): boolean {
  return PHONE_RE.test(phone) && phone.replace(/\D/g, "").length >= 10;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function computeQuote(
  minimumOrderCents: number,
  cartLines: ReadonlyArray<{ price: number; qty: number; maxPerOrder: number | null }>,
  contact: Contact,
  fulfillment: Fulfillment,
): CheckoutQuote {
  const problems: FlowProblem[] = [];
  let subtotalCents = 0;

  for (const line of cartLines) {
    if (
      !Number.isInteger(line.qty) ||
      line.qty < 1
    ) {
      problems.push({ code: "max-quantity", message: "Check item quantity." });
      continue;
    }
    if (line.maxPerOrder !== null && line.qty > line.maxPerOrder) {
      problems.push({
        code: "max-quantity",
        message: `Maximum ${line.maxPerOrder} per order for this item.`,
      });
    }
    subtotalCents += line.price * line.qty;
  }

  if (!cartLines.length || subtotalCents < minimumOrderCents) {
    problems.push({
      code: "minimum-order",
      message: `Minimum order is $${(minimumOrderCents / 100).toFixed(2)}.`,
    });
  }

  if (
    !contact.name.trim() ||
    !validEmail(contact.email) ||
    !validPhone(contact.phone)
  ) {
    problems.push({
      code: "invalid-contact",
      message: "Name, email, and a valid phone number are required.",
    });
  }

  if (fulfillment !== "pickup") {
    problems.push({
      code: "ineligible",
      message: "Only pickup is available for this store.",
    });
  }

  const tipCents = 0;
  const totalCents = subtotalCents + tipCents;
  const bufferCents = Math.min(Math.round(subtotalCents * 0.1), 2000);
  const holdCents = totalCents + bufferCents;

  return {
    id: crypto.randomUUID(),
    subtotalCents,
    deliveryFeeCents: 0,
    courierFeeCents: 0,
    taxCents: 0,
    tipCents,
    discountCents: 0,
    totalCents,
    bufferCents,
    holdCents,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    problems,
  };
}

export async function quoteCheckout(
  storeId: string,
  minimumOrderCents: number,
  cartId: string,
  contact: Contact,
  fulfillment: Fulfillment,
): Promise<CheckoutQuote> {
  const cart = await getCartWithLines(storeId, cartId);
  if (!cart || !cart.lines.length) {
    return computeQuote(minimumOrderCents, [], contact, fulfillment);
  }
  const serverLines = cart.lines.map((l) => ({
    price: l.variant.price,
    qty: l.qty,
    maxPerOrder: l.variant.listing.maxPerOrder,
  }));
  return computeQuote(minimumOrderCents, serverLines, contact, fulfillment);
}

export async function createPaymentIntent(
  storeId: string,
  cartId: string,
  holdCents: number,
): Promise<{ clientSecret: string; paymentIntentId: string }> {
  const scoped = storeScoped(storeId);
  const store = await getStripeStore(storeId);

  const stripe = getStripeClient();

  const cart = await scoped.cart.findUnique({ where: { id: cartId } });
  if (!cart) throw new Error("Cart not found");

  if (cart.paymentIntentId) {
    const existing = await stripe.paymentIntents.retrieve(cart.paymentIntentId);
    if (existing.status === "requires_capture") {
      throw new Error("Payment already confirmed for this cart");
    }
    if (
      existing.status === "requires_payment_method" ||
      existing.status === "requires_confirmation" ||
      existing.status === "requires_action"
    ) {
      if (existing.amount !== holdCents) {
        await stripe.paymentIntents.update(cart.paymentIntentId, { amount: holdCents });
      }
      return { clientSecret: existing.client_secret!, paymentIntentId: existing.id };
    }
  }

  const pi = await stripe.paymentIntents.create({
    amount: holdCents,
    currency: "usd",
    capture_method: "manual",
    on_behalf_of: store.stripeAccountId,
    transfer_data: { destination: store.stripeAccountId },
    metadata: { store_id: storeId, cart_id: cartId },
  });

  await scoped.cart.update({
    where: { id: cartId },
    data: { paymentIntentId: pi.id },
  });

  if (!pi.client_secret) {
    throw new Error("Stripe did not return a client secret");
  }

  return { clientSecret: pi.client_secret, paymentIntentId: pi.id };
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
}> {
  return cart.lines.map((l) => ({
    variantId: l.variantId,
    listingId: l.variant.listing.id,
    qty: l.qty,
    price: l.variant.price,
    swapRule: l.swapRule,
    substituteVariantId: l.substituteVariantId,
    maxPerOrder: l.variant.listing.maxPerOrder,
  }));
}

export async function placeOrder(
  storeId: string,
  minimumOrderCents: number,
  cartId: string,
  contact: Contact,
  fulfillment: Fulfillment,
  notes: string | null,
  pickupSlot: string | null,
  paymentIntentId: string,
): Promise<{ token: string; quote: CheckoutQuote }> {
  const store = await getStripeStore(storeId);

  if (fulfillment !== "pickup") {
    throw new Error("Only pickup fulfillment is supported");
  }

  const stripe = getStripeClient();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

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

  const existingOrder = await storeScoped(storeId).order.findUnique({
    where: { paymentIntentId },
  });
  if (existingOrder) {
    const cart = await getCartWithLines(storeId, cartId);
    const serverLines = cart ? cart.lines.map((l) => ({
      price: l.variant.price,
      qty: l.qty,
      maxPerOrder: l.variant.listing.maxPerOrder,
    })) : [];
    const quote = computeQuote(minimumOrderCents, serverLines, contact, fulfillment);
    // Idempotent replay — don't re-send the Inngest event
    return { token: existingOrder.id, quote };
  }

  const cart = await getCartWithLines(storeId, cartId);
  if (!cart || !cart.lines.length) {
    throw new Error("Cart is empty");
  }

  const orderLineData = cartLinesToOrderLines(cart);
  const serverLines = orderLineData.map((l) => ({
    price: l.price,
    qty: l.qty,
    maxPerOrder: l.maxPerOrder,
  }));
  const quote = computeQuote(minimumOrderCents, serverLines, contact, fulfillment);

  if (quote.problems.length) {
    throw new Error(quote.problems.map((p) => p.message).join(" "));
  }

  if (pi.amount !== quote.holdCents) {
    throw new Error(
      `PaymentIntent amount (${pi.amount}) does not match quote hold (${quote.holdCents})`,
    );
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

  const orderId = await storeScopedTransaction(storeId, async (tx) => {
    const customer = await tx.customer.create({
      data: {
        storeId,
        name: contact.name.trim(),
        email: contact.email.trim().toLowerCase(),
        phone: contact.phone.trim(),
      },
    });

    await lockStoreRow(tx, storeId);
    const nextNumber = await getNextOrderNumber(tx, storeId);

    const order = await tx.order.create({
      data: {
        storeId,
        number: nextNumber,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment,
        pickupSlot: pickupSlot !== "asap" ? pickupSlot : null,
        subtotalCents: quote.subtotalCents,
        tipCents: quote.tipCents,
        bufferCents: quote.bufferCents,
        totalAuthorizedCents: quote.holdCents,
        paymentIntentId,
        notes: notes || null,
      },
    });

    await tx.orderLine.createMany({
      data: orderLineData.map((line) => ({
        storeId,
        orderId: order.id,
        listingVariantId: line.variantId,
        substituteVariantId: line.substituteVariantId,
        qtyOrdered: line.qty,
        unitPriceCents: line.price,
        swapRule: line.swapRule,
      })),
    });

    await tx.cartLine.deleteMany({ where: { cartId } });
    await tx.cart.update({
      where: { id: cartId },
      data: { paymentIntentId: null },
    });

    return order.id;
  });

  await sendOrderAuthorized(storeId, orderId).catch(() => {});

  return { token: orderId, quote };
}
