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
import { goodsDiscountCents, type CouponTerms } from "../coupon/discount";

export const CARD_FEE_BPS = 290;
export const CARD_FEE_FIXED_CENTS = 30;

export type ServiceFeeSettings = { rateBps: number; minCents: number; maxCents: number };

/** Orders placed before the fee existed carry this snapshot, so they keep a $0 fee. */
export const NO_SERVICE_FEE: ServiceFeeSettings = { rateBps: 0, minCents: 0, maxCents: 0 };

/** The ADR-0021 defaults: 3% of goods, at least $0.99, at most $2.99. The migration seeds the same row. */
export const ADR_0021_SERVICE_FEE: ServiceFeeSettings = { rateBps: 300, minCents: 99, maxCents: 299 };

function percentOf(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10_000);
}

export function serviceFeeCents(goodsCents: number, settings: ServiceFeeSettings): number {
  if (goodsCents <= 0 || settings.rateBps <= 0) return 0;
  return Math.min(Math.max(percentOf(goodsCents, settings.rateBps), settings.minCents), settings.maxCents);
}

/** Goods less the coupon discount: what the service fee is charged on (#557). */
export function discountedGoodsCents(goodsCents: number, coupon?: CouponTerms | null): number {
  return coupon ? goodsCents - goodsDiscountCents(goodsCents, coupon) : goodsCents;
}

/**
 * The most goods whose total with the service fee, and the tax reserved on them (#65), fits
 * `budgetCents`, after the coupon discount when there is one (#557). None of these falls as goods rise.
 */
export function maxGoodsWithin(
  budgetCents: number,
  settings: ServiceFeeSettings,
  coupon?: CouponTerms | null,
  taxReserveCents: (netGoodsCents: number) => number = () => 0,
): number {
  const charged = (goods: number) => {
    const net = discountedGoodsCents(goods, coupon);
    return net + serviceFeeCents(net, settings) + taxReserveCents(net);
  };
  let low = 0;
  // A discount lets goods above the budget fit; a 90% coupon at most multiplies them by ten.
  let high = Math.max(0, budgetCents) * (coupon ? 10 : 1) + (coupon?.amountOffCents ?? 0);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (charged(mid) <= budgetCents) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** What a refund needs from its order: the captured amount and its non-goods parts (#65: tax is not goods). */
export type RefundOrder = { serviceFeeCents: number; capturedAmountCents: number | null; tipCents: number; deliveryFeeCents: number; taxCents: number };

/** The goods the order charged for, after the coupon: the capture less fee, tip, delivery and tax. */
function goodsChargedCents(order: RefundOrder): number {
  return (order.capturedAmountCents ?? 0) - order.serviceFeeCents - order.tipCents - order.deliveryFeeCents - order.taxCents;
}

/** A refund of goods returns the service fee in proportion to them. */
export function serviceFeeRefundCents(goodsRefundedCents: number, order: RefundOrder): number {
  const goodsCharged = goodsChargedCents(order);
  if (order.serviceFeeCents <= 0 || goodsCharged <= 0) return 0;
  return Math.min(order.serviceFeeCents, Math.round((order.serviceFeeCents * goodsRefundedCents) / goodsCharged));
}

/**
 * The goods a refund tied to order lines returns and the exact tax of those lines (#671), from the per-line tax
 * stored at capture. A refund with no lines, or of an order captured before lines kept their tax, has none.
 */
export type LineTax = { goodsCents: number; taxCents: number };

/**
 * A refund of goods returns the tax paid on them: with `lineTax`, those lines' exact tax (#671), scaled when the
 * refund covers less of their goods; otherwise the order's tax in proportion to the goods (decision 2026-11-15-06).
 * Never more than what earlier refunds left of the tax.
 */
export function taxRefundCents(goodsRefundedCents: number, order: RefundOrder, taxRefundedBeforeCents = 0, lineTax: LineTax | null = null): number {
  const left = order.taxCents - taxRefundedBeforeCents;
  const [tax, goods] = lineTax ? [lineTax.taxCents, lineTax.goodsCents] : [order.taxCents, goodsChargedCents(order)];
  if (left <= 0 || goods <= 0) return 0;
  return Math.max(0, Math.min(left, Math.round((tax * goodsRefundedCents) / goods)));
}

/** What the customer gets back for `goodsCents` of goods: the goods, their service fee share and their tax. */
export function refundOfGoodsCents(goodsCents: number, order: RefundOrder, taxRefundedBeforeCents = 0, lineTax: LineTax | null = null): number {
  return goodsCents + serviceFeeRefundCents(goodsCents, order) + taxRefundCents(goodsCents, order, taxRefundedBeforeCents, lineTax);
}

export type RefundShares = { goodsCents: number; serviceFeeCents: number; taxCents: number };

/** A refund of `refundCents` split into the most goods it covers, their service fee share and their tax share. */
export function refundShares(refundCents: number, order: RefundOrder, taxRefundedBeforeCents = 0, lineTax: LineTax | null = null): RefundShares {
  let low = 0;
  let high = Math.max(0, refundCents);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (refundOfGoodsCents(mid, order, taxRefundedBeforeCents, lineTax) <= refundCents) low = mid;
    else high = mid - 1;
  }
  return {
    goodsCents: low,
    serviceFeeCents: serviceFeeRefundCents(low, order),
    taxCents: taxRefundCents(low, order, taxRefundedBeforeCents, lineTax),
  };
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
  /** Sales tax the platform collects as marketplace facilitator (ADR-0008, #65); it never reaches the store. */
  platformTaxCents?: number;
}): CaptureSplit {
  const captured = Math.max(0, input.capturedCents);
  const serviceFee = Math.max(0, input.serviceFeeCents);
  const courierFee = Math.max(0, input.courierFeeCents);
  const platformTax = Math.max(0, input.platformTaxCents ?? 0);
  const storePart = Math.max(0, captured - serviceFee - courierFee - platformTax);
  const storeCardFeeCents = storePart > 0 ? percentOf(storePart, CARD_FEE_BPS) + CARD_FEE_FIXED_CENTS : 0;
  const platformCardFeeCents = percentOf(serviceFee, CARD_FEE_BPS) + percentOf(courierFee, CARD_FEE_BPS) + percentOf(platformTax, CARD_FEE_BPS);
  const applicationFeeCents = Math.min(serviceFee + courierFee + platformTax + storeCardFeeCents, captured);
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

/**
 * The store's card fee and payout on a captured order, from the platform fee stored at capture
 * (service fee + the store's card fee under every formula), so older orders show what Stripe paid.
 */
export function capturedPayout(order: {
  capturedAmountCents: number;
  platformFeeCents: number | null;
  serviceFeeCents: number;
  fulfillment: string;
  deliveryFeeCents: number;
  taxCents: number;
  taxLiableParty: string;
}): { storeCardFeeCents: number; storeReceivesCents: number } {
  const captured = Math.max(0, order.capturedAmountCents);
  const courierFee = courierFeeCents(order);
  const platformTax = platformTaxCents(order);
  if (order.platformFeeCents == null) {
    const split = captureSplit({ capturedCents: captured, serviceFeeCents: order.serviceFeeCents, courierFeeCents: courierFee, platformTaxCents: platformTax });
    return { storeCardFeeCents: split.storeCardFeeCents, storeReceivesCents: split.storeReceivesCents };
  }
  return {
    storeCardFeeCents: Math.max(0, order.platformFeeCents - order.serviceFeeCents),
    storeReceivesCents: captured - Math.min(order.platformFeeCents + courierFee + platformTax, captured),
  };
}

/** The order's tax that the platform keeps to remit; 0 when the store is the liable party. */
export function platformTaxCents(order: { taxCents: number; taxLiableParty: string }): number {
  return order.taxLiableParty === "store" ? 0 : Math.max(0, order.taxCents);
}

/** The `application_fee_amount` Stripe took at capture; null before capture. */
export function capturedApplicationFee(order: {
  capturedAmountCents: number | null;
  platformFeeCents: number | null;
  serviceFeeCents: number;
  fulfillment: string;
  deliveryFeeCents: number;
  taxCents: number;
  taxLiableParty: string;
}): number | null {
  if (order.capturedAmountCents === null) return null;
  const captured = Math.max(0, order.capturedAmountCents);
  return captured - capturedPayout({ ...order, capturedAmountCents: captured }).storeReceivesCents;
}

/** The card fee rate as the store sees it, e.g. "2.9% + 30¢". */
export const CARD_FEE_LABEL = `${CARD_FEE_BPS / 100}% + ${CARD_FEE_FIXED_CENTS}¢`;

/** The settings snapshot an order was quoted with. */
export function orderServiceFeeSettings(order: {
  serviceFeeBps: number;
  serviceFeeMinCents: number;
  serviceFeeMaxCents: number;
}): ServiceFeeSettings {
  return { rateBps: order.serviceFeeBps, minCents: order.serviceFeeMinCents, maxCents: order.serviceFeeMaxCents };
}
