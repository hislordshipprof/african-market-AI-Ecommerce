import type { CartItem, CartLine, SwapRuleValue } from "./cart-store";

export interface RemovedLine {
  item: CartItem;
  quantity: number;
  swapRule: SwapRuleValue;
  substituteVariantId: string | null;
}

/** What "Removed. Undo" needs to put the line back; null when nothing was in the basket. */
export function removedLine(line: CartLine): RemovedLine | null {
  if (line.quantity <= 0) return null;
  return {
    item: {
      listingId: line.listingId,
      variantId: line.variantId,
      name: line.name,
      price: line.price,
      imageUrl: line.imageUrl,
      packLabel: line.packLabel,
    },
    quantity: line.quantity,
    swapRule: line.swapRule ?? "exact_only",
    substituteVariantId: line.substituteVariantId ?? null,
  };
}

/**
 * The quantity to set and the swap choice to re-apply. A line the shopper added back
 * meanwhile is never lowered, and a rule the line already has is not sent again.
 */
export function restoreSteps(
  removed: RemovedLine,
  current: CartLine | undefined,
): { quantity: number; swap: { swapRule: SwapRuleValue; substituteVariantId: string | null } | null } {
  const quantity = Math.max(removed.quantity, current?.quantity ?? 0);
  const currentRule = current?.swapRule ?? "exact_only";
  const currentSubstitute = current?.substituteVariantId ?? null;
  const same = currentRule === removed.swapRule && currentSubstitute === removed.substituteVariantId;
  return {
    quantity,
    swap: same ? null : { swapRule: removed.swapRule, substituteVariantId: removed.substituteVariantId },
  };
}
