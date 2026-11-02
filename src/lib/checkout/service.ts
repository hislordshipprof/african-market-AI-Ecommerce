import Stripe from "stripe";
import { platform, storeScopedTransaction, lockStoreRow } from "../db";
import type {
  CheckoutInput,
  CheckoutQuote,
  FlowProblem,
} from "../customer-flow/contracts";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key);
}

const PHONE_RE = /^\+?[\d\s().-]{10,20}$/;
function validPhone(phone: string): boolean {
  return PHONE_RE.test(phone) && phone.replace(/\D/g, "").length >= 10;
}

export async function quoteCheckout(
  storeId: string,
  minimumOrderCents: number,
  input: CheckoutInput,
): Promise<CheckoutQuote> {
  const problems: FlowProblem[] = [];
  let subtotalCents = 0;

  for (const line of input.lines) {
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      !Number.isSafeInteger(line.price) ||
      line.price < 0
    ) {
      problems.push({
        code: "max-quantity",
        message: "Check item quantity.",
      });
      continue;
    }
    subtotalCents += line.price * line.quantity;
  }

  if (!input.lines.length || subtotalCents < minimumOrderCents) {
    problems.push({
      code: "minimum-order",
      message: `Minimum order is $${(minimumOrderCents / 100).toFixed(2)}.`,
    });
  }

  if (
    !input.contact.name.trim() ||
    !input.contact.email.trim() ||
    !validPhone(input.contact.phone)
  ) {
    problems.push({
      code: "invalid-contact",
      message: "Name, email, and a valid phone number are required.",
    });
  }

  const tipCents = Math.max(
    0,
    Number.isSafeInteger(input.tipCents) ? input.tipCents : 0,
  );
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

export async function createPaymentIntent(
  storeId: string,
  holdCents: number,
): Promise<{ clientSecret: string; paymentIntentId: string }> {
  const store = await platform.store.findUnique({ where: { id: storeId } });
  if (!store?.stripeAccountId) {
    throw new Error("Store is not connected to Stripe");
  }

  const stripe = getStripe();
  const pi = await stripe.paymentIntents.create({
    amount: holdCents,
    currency: "usd",
    capture_method: "manual",
    on_behalf_of: store.stripeAccountId,
    transfer_data: { destination: store.stripeAccountId },
  });

  if (!pi.client_secret) {
    throw new Error("Stripe did not return a client secret");
  }

  return { clientSecret: pi.client_secret, paymentIntentId: pi.id };
}

export async function placeOrder(
  storeId: string,
  input: CheckoutInput,
  quote: CheckoutQuote,
  paymentIntentId: string,
): Promise<{ token: string }> {
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (pi.status !== "requires_capture") {
    throw new Error(
      `PaymentIntent is in status "${pi.status}", expected "requires_capture"`,
    );
  }

  const orderId = await storeScopedTransaction(storeId, async (tx) => {
    const customer = await tx.customer.create({
      data: {
        storeId,
        name: input.contact.name.trim(),
        email: input.contact.email.trim().toLowerCase(),
        phone: input.contact.phone.trim(),
      },
    });

    await lockStoreRow(tx, storeId);
    const maxRows = await tx.$queryRaw<Array<{ max_num: number | null }>>`
      SELECT MAX(number) AS max_num FROM orders WHERE store_id = ${storeId}
    `;
    const nextNumber = (maxRows[0]?.max_num ?? 0) + 1;

    const order = await tx.order.create({
      data: {
        storeId,
        number: nextNumber,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: input.fulfillment,
        pickupSlot: input.slot !== "asap" ? input.slot : null,
        subtotalCents: quote.subtotalCents,
        bufferCents: quote.bufferCents,
        totalAuthorizedCents: quote.holdCents,
        paymentIntentId,
        notes: input.notes || null,
      },
    });

    for (const line of input.lines) {
      const variantId = line.variantId ?? line.listingId;
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: order.id,
          listingVariantId: variantId,
          qtyOrdered: line.quantity,
          unitPriceCents: line.price,
          swapRule: line.swapRule ?? "exact_only",
        },
      });
    }

    return order.id;
  });

  return { token: orderId };
}
