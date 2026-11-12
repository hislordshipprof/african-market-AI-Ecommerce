/** Money rules for short lines (#13). Pure, so the hold check and the capture share one formula. */

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

/** The amount to capture at Ready. Nothing charged releases the whole hold, tip and fee included. */
export function captureAmountCents(
  lines: ChargeLine[],
  fees: { tipCents: number; deliveryFeeCents: number },
): number {
  const lineTotal = lines.reduce((sum, line) => sum + lineChargeCents(line), 0);
  return lineTotal === 0 ? 0 : lineTotal + fees.tipCents + fees.deliveryFeeCents;
}
