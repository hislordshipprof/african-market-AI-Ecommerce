import { Prisma } from "@prisma/client";
import { storeScopedTransaction, lockStoreRow, lockCart, getNextOrderNumber, storeScoped } from "../db";
import { getCartWithLines, type CartLineView } from "../cart/service";
import { getStripeClient } from "../stripe/provider";
import { sendOrderAuthorized } from "../inngest/send";
import { platformFeeCentsForCapture } from "../order/platform-fee";
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

/**
 * Test-only pause after placeOrder's pre-transaction order lookup misses.
 * Production leaves this null. NODE_ENV=test is required before it runs,
 * so a leaked hook cannot stall a live checkout.
 */
export const checkoutTestHooks: {
  afterMissedOrderLookup: (() => Promise<void>) | null;
} = { afterMissedOrderLookup: null };

export interface AuthorizedOrderLine {
  variantId: string;
  qty: number;
  price: number;
  swapRule: string;
  substituteVariantId: string | null;
}

export interface RecordAuthorizedOrderInput {
  cartId: string;
  contact: Contact;
  fulfillment: Fulfillment;
  pickupSlot: string | null;
  notes: string | null;
  paymentIntentId: string;
  quote: CheckoutQuote;
  lines: AuthorizedOrderLine[];
  /** When set, including null for a guest, the locked cart must still belong to this actor. */
  actorUserId?: string | null;
}

function paymentIntentTaken(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  const target = err.meta?.target;
  const text = `${err.message} ${JSON.stringify(target ?? "")}`;
  return text.includes("payment_intent") || text.includes("paymentIntentId");
}

/**
 * Trusted persistence for an already-verified PaymentIntent. Does not call
 * Stripe and does not look up another store's order. The caller has checked
 * the PaymentIntent's status, destination, on_behalf_of, store metadata and
 * amount. A cart or variant this store cannot see is rejected before any write.
 */
export async function recordAuthorizedOrder(
  storeId: string,
  input: RecordAuthorizedOrderInput,
): Promise<{ orderId: string; created: boolean }> {
  try {
    return await storeScopedTransaction(storeId, async (tx) => {
      await lockStoreRow(tx, storeId);

      const existing = await tx.order.findUnique({
        where: { paymentIntentId: input.paymentIntentId },
      });
      if (existing) {
        return { orderId: existing.id, created: false };
      }

      if (input.lines.length === 0) {
        throw new Error("Order lines are required");
      }

      await lockCart(tx, input.cartId);
      const cart = await tx.cart.findUnique({ where: { id: input.cartId } });
      if (!cart || cart.storeId !== storeId) {
        throw new Error("Cart not found");
      }
      if (input.actorUserId !== undefined && cart.userId !== input.actorUserId) {
        throw new Error("Cart not found");
      }

      const variantIds = [
        ...new Set(
          input.lines.flatMap((line) =>
            line.substituteVariantId
              ? [line.variantId, line.substituteVariantId]
              : [line.variantId],
          ),
        ),
      ];
      const owned = await tx.listingVariant.findMany({
        where: { id: { in: variantIds } },
        include: { listing: true },
      });
      const ownedById = new Map(owned.map((variant) => [variant.id, variant]));
      for (const line of input.lines) {
        const variant = ownedById.get(line.variantId);
        if (!variant || variant.listing.storeId !== storeId) {
          throw new Error(`Variant ${line.variantId} does not belong to this store`);
        }
        if (line.substituteVariantId) {
          const substitute = ownedById.get(line.substituteVariantId);
          if (!substitute || substitute.listing.storeId !== storeId) {
            throw new Error(
              `Substitute variant ${line.substituteVariantId} does not belong to this store`,
            );
          }
        }
      }

      const customer = await tx.customer.create({
        data: {
          storeId,
          name: input.contact.name.trim(),
          email: input.contact.email.trim().toLowerCase(),
          phone: input.contact.phone.trim(),
        },
      });
      const nextNumber = await getNextOrderNumber(tx, storeId);
      const order = await tx.order.create({
        data: {
          storeId,
          number: nextNumber,
          customerId: customer.id,
          status: "AUTHORIZED",
          fulfillment: input.fulfillment,
          pickupSlot: input.pickupSlot !== "asap" ? input.pickupSlot : null,
          subtotalCents: input.quote.subtotalCents,
          tipCents: input.quote.tipCents,
          bufferCents: input.quote.bufferCents,
          totalAuthorizedCents: input.quote.holdCents,
          paymentIntentId: input.paymentIntentId,
          platformFeeCents: platformFeeCentsForCapture(input.quote.totalCents),
          notes: input.notes || null,
        },
      });
      await tx.orderLine.createMany({
        data: input.lines.map((line) => ({
          storeId,
          orderId: order.id,
          listingVariantId: line.variantId,
          substituteVariantId: line.substituteVariantId,
          qtyOrdered: line.qty,
          unitPriceCents: line.price,
          swapRule: line.swapRule,
        })),
      });
      await tx.cartLine.deleteMany({ where: { cartId: input.cartId } });
      await tx.cart.update({
        where: { id: input.cartId },
        data: { paymentIntentId: null },
      });
      return { orderId: order.id, created: true };
    }, { timeout: 40_000, maxWait: 8_000 });
  } catch (err) {
    if (paymentIntentTaken(err)) {
      throw new Error("PaymentIntent is already recorded");
    }
    throw err;
  }
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
  actorUserId: string | null = null,
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
    const quote = await quoteFromCart(storeId, minimumOrderCents, cartId, contact, fulfillment);
    // Idempotent replay — don't re-send the Inngest event or touch the cart.
    return { token: existingOrder.id, quote };
  }

  if (process.env.NODE_ENV === "test" && checkoutTestHooks.afterMissedOrderLookup) {
    await checkoutTestHooks.afterMissedOrderLookup();
  }

  const cart = await getCartWithLines(storeId, cartId);
  if (!cart || !cart.lines.length) {
    const raced = await storeScoped(storeId).order.findUnique({
      where: { paymentIntentId },
    });
    if (raced) {
      const quote = await quoteFromCart(storeId, minimumOrderCents, cartId, contact, fulfillment);
      return { token: raced.id, quote };
    }
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

  const recorded = await recordAuthorizedOrder(storeId, {
    cartId,
    contact,
    fulfillment,
    pickupSlot,
    notes,
    paymentIntentId,
    quote,
    actorUserId,
    lines: orderLineData.map((line) => ({
      variantId: line.variantId,
      qty: line.qty,
      price: line.price,
      swapRule: line.swapRule,
      substituteVariantId: line.substituteVariantId,
    })),
  });

  if (recorded.created) {
    await sendOrderAuthorized(storeId, recorded.orderId);
  }

  return { token: recorded.orderId, quote };
}

async function quoteFromCart(
  storeId: string,
  minimumOrderCents: number,
  cartId: string,
  contact: Contact,
  fulfillment: Fulfillment,
): Promise<CheckoutQuote> {
  const cart = await getCartWithLines(storeId, cartId);
  const serverLines = cart
    ? cart.lines.map((line) => ({
        price: line.variant.price,
        qty: line.qty,
        maxPerOrder: line.variant.listing.maxPerOrder,
      }))
    : [];
  return computeQuote(minimumOrderCents, serverLines, contact, fulfillment);
}
