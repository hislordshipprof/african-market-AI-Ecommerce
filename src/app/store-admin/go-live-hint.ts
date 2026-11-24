import { money } from "@/lib/format";

/** The test order a new store should place after going live. It must reach the store's minimum order (#784). */
export function testOrderHint(minimumOrderCents: number): string {
  const order = minimumOrderCents > 0
    ? `an order of at least ${money(minimumOrderCents)}, your minimum order,`
    : "one order";
  return `To see what shoppers see, place ${order} yourself, then cancel it in Orders before you mark it ready, so your card is not charged.`;
}
