import { storeScoped } from "../db";

const orderInclude = {
  customer: true,
  coupon: { select: { code: true, kind: true, percentOff: true, amountOffCents: true } },
  lines: {
    include: {
      listingVariant: { include: { listing: { include: { masterProduct: { select: { name: true } } } } } },
      // The receipt names a swap's replacement (#762).
      substitutedVariant: { include: { listing: { include: { masterProduct: { select: { name: true } } } } } },
    },
  },
  // The order page gives the answer deadline of a short item (#762).
  substitutionRequests: { where: { status: "pending" }, select: { expiresAt: true }, orderBy: { expiresAt: "asc" }, take: 1 },
  issueReports: { select: { state: true, amountCents: true } },
  // The tracking page names what was refunded (#736).
  refundRequests: { select: { amountCents: true, providerStatus: true } },
  // The live courier delivery; failover leaves the replaced one cancelled.
  deliveries: {
    where: { status: { not: "cancelled" } },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { provider: true, status: true, courierJson: true, trackingUrl: true, pin: true },
  },
} as const;

/** The tracking token only: no order-id fallback. For the private delivery photo. */
export async function findOrderByTrackingToken(storeId: string, token: string) {
  return storeScoped(storeId).order.findUnique({
    where: { trackingToken: token },
    select: { id: true, deliveryProofKey: true },
  });
}

/** The tracking token only: an issue report is never opened by order id. */
export async function findOrderForIssueReport(storeId: string, token: string) {
  return storeScoped(storeId).order.findUnique({
    where: { trackingToken: token },
    include: orderInclude,
  });
}

/** Tracking token first. The order id opens only an order made before tokens, so an id never exposes a tokened order. */
export async function findOrderForTracking(storeId: string, token: string) {
  const scoped = storeScoped(storeId);
  const byToken = await scoped.order.findUnique({
    where: { trackingToken: token },
    include: orderInclude,
  });
  if (byToken) return byToken;
  return scoped.order.findFirst({
    where: { id: token, trackingToken: null },
    include: orderInclude,
  });
}

/**
 * The token for the delivery photo, or null. The photo shows only when the page was opened
 * with the tracking token itself: an order id opens the page but never the photo.
 */
export function deliveryProofTokenFor(
  order: { deliveredAt: Date | null; deliveryProofKey: string | null; trackingToken: string | null },
  urlToken: string,
): string | null {
  // deliveredAt, not status: an issue refund moves a delivered order on to Refunded (#462).
  if (!order.deliveredAt || !order.deliveryProofKey || !order.trackingToken) return null;
  return order.trackingToken === urlToken ? order.trackingToken : null;
}
