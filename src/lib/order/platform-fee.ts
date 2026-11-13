/**
 * Platform money per order (ADR-0021, platform-spec §10). All amounts are integer cents.
 *
 * Rounding rule, the only one: a percentage of cents rounds half up to the nearest cent
 * (Math.round on a non-negative value).
 *
 * - Service fee: the customer pays `rateBps` of the goods, held between `minCents` and
 *   `maxCents`. The store pays 0% commission.
 * - Card fee: Stripe's 2.9% + 30¢, which destination charges debit from the platform.
 *   The store bears it on the part it keeps (goods, tax, tip, store delivery) and the fixed
 *   30¢ goes with that part. The platform bears 2.9% on the service fee and on the courier
 *   fee, each part rounded on its own.
 */
export const CARD_FEE_BPS = 290;
export const CARD_FEE_FIXED_CENTS = 30;

export type ServiceFeeSettings = { rateBps: number; minCents: number; maxCents: number };

/** Orders placed before the fee existed carry this snapshot, so they keep a $0 fee. */
export const NO_SERVICE_FEE: ServiceFeeSettings = { rateBps: 0, minCents: 0, maxCents: 0 };

function percentOf(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10_000);
}

export function serviceFeeCents(goodsCents: number, settings: ServiceFeeSettings): number {
  if (goodsCents <= 0 || settings.rateBps <= 0) return 0;
  return Math.min(Math.max(percentOf(goodsCents, settings.rateBps), settings.minCents), settings.maxCents);
}

/** The most goods whose total with the service fee fits `budgetCents`. The fee never falls as goods rise. */
export function maxGoodsWithin(budgetCents: number, settings: ServiceFeeSettings): number {
  let low = 0;
  let high = Math.max(0, budgetCents);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (mid + serviceFeeCents(mid, settings) <= budgetCents) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** An issue refund returns the service fee in proportion to the goods it refunds. */
export function serviceFeeRefundCents(
  goodsRefundedCents: number,
  order: { serviceFeeCents: number; capturedAmountCents: number | null; tipCents: number; deliveryFeeCents: number },
): number {
  const goodsCharged = (order.capturedAmountCents ?? 0) - order.serviceFeeCents - order.tipCents - order.deliveryFeeCents;
  if (order.serviceFeeCents <= 0 || goodsCharged <= 0) return 0;
  return Math.min(order.serviceFeeCents, Math.round((order.serviceFeeCents * goodsRefundedCents) / goodsCharged));
}

type FeeRefundOrder = Parameters<typeof serviceFeeRefundCents>[1];

/** The service fee part of an issue refund of `refundCents` (goods plus their fee share): the share of the most goods it covers. */
export function serviceFeeShareOfRefund(refundCents: number, order: FeeRefundOrder): number {
  let low = 0;
  let high = Math.max(0, refundCents);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (mid + serviceFeeRefundCents(mid, order) <= refundCents) low = mid;
    else high = mid - 1;
  }
  return serviceFeeRefundCents(low, order);
}

export type CaptureSplit = {
  /** Sent as Stripe `application_fee_amount`. */
  applicationFeeCents: number;
  /** Stored on the order: service fee + the store's card fee, without courier recovery. */
  platformFeeCents: number;
  storeCardFeeCents: number;
  platformCardFeeCents: number;
  storeReceivesCents: number;
  platformKeepsCents: number;
};

export function captureSplit(input: {
  capturedCents: number;
  serviceFeeCents: number;
  courierFeeCents: number;
}): CaptureSplit {
  const captured = Math.max(0, input.capturedCents);
  const serviceFee = Math.max(0, input.serviceFeeCents);
  const courierFee = Math.max(0, input.courierFeeCents);
  const storePart = Math.max(0, captured - serviceFee - courierFee);
  const storeCardFeeCents = storePart > 0 ? percentOf(storePart, CARD_FEE_BPS) + CARD_FEE_FIXED_CENTS : 0;
  const platformCardFeeCents = percentOf(serviceFee, CARD_FEE_BPS) + percentOf(courierFee, CARD_FEE_BPS);
  const applicationFeeCents = Math.min(serviceFee + courierFee + storeCardFeeCents, captured);
  return {
    applicationFeeCents,
    platformFeeCents: Math.min(serviceFee + storeCardFeeCents, captured),
    storeCardFeeCents,
    platformCardFeeCents,
    storeReceivesCents: captured - applicationFeeCents,
    platformKeepsCents: serviceFee - platformCardFeeCents,
  };
}

/** The courier fee the platform passes to the courier. Store delivery keeps its fee. */
export function courierFeeCents(order: { fulfillment: string; deliveryFeeCents: number }): number {
  return order.fulfillment === "courier" ? Math.max(0, order.deliveryFeeCents) : 0;
}

/** The settings snapshot an order was quoted with. */
export function orderServiceFeeSettings(order: {
  serviceFeeBps: number;
  serviceFeeMinCents: number;
  serviceFeeMaxCents: number;
}): ServiceFeeSettings {
  return { rateBps: order.serviceFeeBps, minCents: order.serviceFeeMinCents, maxCents: order.serviceFeeMaxCents };
}
