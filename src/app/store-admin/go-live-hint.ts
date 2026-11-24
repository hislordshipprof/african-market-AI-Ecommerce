import { money } from "@/lib/format";

/** The test order a new store should place after going live. It must reach the store's minimum order (#784). */
export function testOrderHint(minimumOrderCents: number): string {
  const order = minimumOrderCents > 0
    ? `an order of at least ${money(minimumOrderCents)}, your minimum order,`
    : "one order";
  return `To see what shoppers see, place ${order} yourself, then cancel it in Orders before you mark it ready, so your card is not charged.`;
}

/**
 * What going live does to the directory listing (#786). The directory hides a store with no map point
 * (DIRECTORY_STORE_WHERE), so such a store is told it appears once its address is confirmed, as the Directory page says.
 */
export function directoryNote(located: boolean): string {
  return located
    ? "Your store is listed in the Store directory."
    : "Your store appears in the Store directory once the platform team confirms its address.";
}
