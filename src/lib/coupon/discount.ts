/** Store coupon money (#557). Pure and in integer cents; the store funds every discount. */

export type CouponTerms = { kind: "percent" | "fixed"; percentOff: number | null; amountOffCents: number | null };

/** A stored coupon's terms. An unknown kind throws rather than becoming a fixed discount. */
export function couponTerms(row: { kind: string; percentOff: number | null; amountOffCents: number | null }): CouponTerms {
  if (row.kind !== "percent" && row.kind !== "fixed") throw new Error(`Unknown coupon kind: ${row.kind}`);
  return { kind: row.kind, percentOff: row.percentOff, amountOffCents: row.amountOffCents };
}

/** The discount on goods only: a percent rounds half up, a fixed amount is capped at the goods. */
export function goodsDiscountCents(goodsCents: number, terms: CouponTerms): number {
  const goods = Math.max(0, goodsCents);
  if (terms.kind === "percent") return Math.round((goods * (terms.percentOff ?? 0)) / 100);
  return Math.min(goods, Math.max(0, terms.amountOffCents ?? 0));
}

/** Splits `discountCents` over lines in proportion to their charge, by largest remainder, so the shares sum to it. */
export function allocateLineDiscounts(lineChargesCents: number[], discountCents: number): number[] {
  const goods = lineChargesCents.reduce((sum, cents) => sum + cents, 0);
  if (goods <= 0 || discountCents <= 0) return lineChargesCents.map(() => 0);
  const exact = lineChargesCents.map((cents) => (cents * discountCents) / goods);
  const shares = exact.map(Math.floor);
  let left = discountCents - shares.reduce((sum, cents) => sum + cents, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - shares[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    shares[index] += 1;
    left -= 1;
  }
  return shares;
}

/** The part of a line's discount that goes with `goodsRefundedCents` of that line's goods. */
export function lineDiscountShareCents(line: { discountCents: number; chargeCents: number }, goodsRefundedCents: number): number {
  if (line.discountCents <= 0 || line.chargeCents <= 0) return 0;
  return Math.min(line.discountCents, Math.round((line.discountCents * goodsRefundedCents) / line.chargeCents));
}
