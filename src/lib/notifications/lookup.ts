import { storeScoped } from "../db";

const orderInclude = {
  customer: true,
  lines: {
    include: {
      listingVariant: { include: { listing: true } },
    },
  },
} as const;

/** The tracking token only: no order-id fallback. For the private delivery photo. */
export async function findOrderByTrackingToken(storeId: string, token: string) {
  return storeScoped(storeId).order.findUnique({
    where: { trackingToken: token },
    select: { id: true, deliveryProofKey: true },
  });
}

/** Tracking token first, then the order id, so checkout and account links keep working. */
export async function findOrderForTracking(storeId: string, token: string) {
  const scoped = storeScoped(storeId);
  const byToken = await scoped.order.findUnique({
    where: { trackingToken: token },
    include: orderInclude,
  });
  if (byToken) return byToken;
  return scoped.order.findUnique({
    where: { id: token },
    include: orderInclude,
  });
}

/**
 * The token for the delivery photo, or null. The photo shows only when the page was opened
 * with the tracking token itself: an order id opens the page but never the photo.
 */
export function deliveryProofTokenFor(
  order: { status: string; deliveryProofKey: string | null; trackingToken: string | null },
  urlToken: string,
): string | null {
  if (order.status !== "DELIVERED" || !order.deliveryProofKey || !order.trackingToken) return null;
  return order.trackingToken === urlToken ? order.trackingToken : null;
}

/** The id that goes in a customer's order link: the tracking token, or the id for an order made before tokens. */
export async function trackingTokenFor(storeId: string, orderId: string): Promise<string> {
  const order = await storeScoped(storeId).order.findUnique({
    where: { id: orderId },
    select: { trackingToken: true },
  });
  return order?.trackingToken ?? orderId;
}
