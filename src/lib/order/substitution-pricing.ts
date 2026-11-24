/** Money rules for short lines (#13). Pure, so the hold check and the capture share one formula. */
import { serviceFeeCents, type ServiceFeeSettings } from "./platform-fee";
import { allocateLineDiscounts, goodsDiscountCents, type CouponTerms } from "../coupon/discount";

export type ChargeLine = {
  status: string;
  qtyOrdered: number;
  qtyPicked: number;
  unitPriceCents: number;
  substitutedUnitPriceCents: number | null;
};

/** A swap is offered only while the order's new total stays within the card hold. */
export function canOfferSwap(holdCents: number, currentTotalCents: number, swapDeltaCents: number): boolean {
  return currentTotalCents + swapDeltaCents <= holdCents;
}

/**
 * What the timer does with an unanswered prompt (decision 2026-11-23-11): the offered swap only when it
 * costs no more than the line it replaces; a pricier swap needs the customer's yes, so the units are refunded.
 */
export function timeoutDecision(proposedUnitPriceCents: number | null, unitPriceCents: number): "swap" | "refund" {
  return proposedUnitPriceCents != null && proposedUnitPriceCents <= unitPriceCents ? "swap" : "refund";
}

/**
 * What one line charges. Found units at the ordered price; on a swap, the units found short
 * at the substitute's price. A refunded line charges only what was found. Unresolved lines
 * count as ordered, which is the estimate the hold was sized for.
 */
export function lineChargeCents(line: ChargeLine): number {
  switch (line.status) {
    case "picked":
    case "refunded":
      return line.qtyPicked * line.unitPriceCents;
    case "substituted":
      return line.qtyPicked * line.unitPriceCents
        + (line.qtyOrdered - line.qtyPicked) * (line.substitutedUnitPriceCents ?? 0);
    default:
      return line.qtyOrdered * line.unitPriceCents;
  }
}

export type OrderFees = { tipCents: number; deliveryFeeCents: number; serviceFee: ServiceFeeSettings; coupon?: CouponTerms | null };

export type CaptureChargeResult = {
  amountCents: number;
  serviceFeeCents: number;
  discountCents: number;
  /** Each line's share of the discount, in the order of `lines`. */
  lineDiscountsCents: number[];
};

/**
 * The amount to capture at Ready and its service fee, which is charged on the goods actually
 * picked after the coupon discount (ADR-0021, #557). The discount is recomputed on the goods
 * picked and never touches tip or fees; a short never removes it. Nothing charged releases the
 * whole hold, tip and fees included.
 */
export function captureCharge(lines: ChargeLine[], fees: OrderFees): CaptureChargeResult {
  const charges = lines.map(lineChargeCents);
  const goods = charges.reduce((sum, cents) => sum + cents, 0);
  if (goods === 0) return { amountCents: 0, serviceFeeCents: 0, discountCents: 0, lineDiscountsCents: charges.map(() => 0) };
  const discountCents = fees.coupon ? goodsDiscountCents(goods, fees.coupon) : 0;
  const fee = serviceFeeCents(goods - discountCents, fees.serviceFee);
  return {
    amountCents: goods - discountCents + fee + fees.tipCents + fees.deliveryFeeCents,
    serviceFeeCents: fee,
    discountCents,
    lineDiscountsCents: allocateLineDiscounts(charges, discountCents),
  };
}
