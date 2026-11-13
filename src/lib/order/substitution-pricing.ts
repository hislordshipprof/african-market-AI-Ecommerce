/** Money rules for short lines (#13). Pure, so the hold check and the capture share one formula. */
import { serviceFeeCents, type ServiceFeeSettings } from "./platform-fee";

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

export type OrderFees = { tipCents: number; deliveryFeeCents: number; serviceFee: ServiceFeeSettings };

/**
 * The amount to capture at Ready and its service fee, which is charged on the goods actually
 * picked (ADR-0021). Nothing charged releases the whole hold, tip and fees included.
 */
export function captureCharge(lines: ChargeLine[], fees: OrderFees): { amountCents: number; serviceFeeCents: number } {
  const goods = lines.reduce((sum, line) => sum + lineChargeCents(line), 0);
  if (goods === 0) return { amountCents: 0, serviceFeeCents: 0 };
  const fee = serviceFeeCents(goods, fees.serviceFee);
  return { amountCents: goods + fee + fees.tipCents + fees.deliveryFeeCents, serviceFeeCents: fee };
}
