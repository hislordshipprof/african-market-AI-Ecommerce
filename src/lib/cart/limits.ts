/**
 * Quantity and substitute decisions shared by the storefront cart and the
 * shopper tools. Each caller keeps its own error codes.
 *
 * A missing max is 99. A stored max is used as written, including a max
 * above 99. The stepper's click ceiling stays in cart-quantity.ts.
 *
 * An inactive named substitute is allowed on the storefront cart and refused
 * by the shopper tools (`requireActive`). Both ask this module, so the
 * store-ownership check cannot drift.
 */

export const UNSET_MAX_PER_ORDER = 99;

export const SWAP_RULES = ["exact_only", "store_suggests", "named_substitute"] as const;
export type CartSwapRule = (typeof SWAP_RULES)[number];

export function effectiveMaxPerOrder(maxPerOrder: number | null | undefined): number {
  return maxPerOrder ?? UNSET_MAX_PER_ORDER;
}

/**
 * Units a counted listing has left (#808), which caps a cart line. Undefined for other stock modes, and at
 * zero, which is the out-of-stock path instead: unavailable on the storefront, a flagged swap for the assistant.
 */
export function countedStockLeft(listing: { stockMode: string; qty: number | null }): number | undefined {
  return listing.stockMode === "counted" && listing.qty != null && listing.qty > 0 ? listing.qty : undefined;
}

/** `stockLeft` is set when the counted stock, not the per-order max, is what stops the line (#808). */
type OverCap = { ok: false; code: "max_per_order"; maxPerOrder: number; stockLeft?: number };

/** `otherPacksQty` is what the listing's other pack lines in the cart already take of `stockLeft`. */
function lineCap(maxPerOrder: number | null | undefined, stockLeft: number | undefined, otherPacksQty = 0) {
  const max = effectiveMaxPerOrder(maxPerOrder);
  const room = stockLeft === undefined ? undefined : Math.max(0, stockLeft - otherPacksQty);
  const over: OverCap = room !== undefined && room < max
    ? { ok: false, code: "max_per_order", maxPerOrder: room, stockLeft }
    : { ok: false, code: "max_per_order", maxPerOrder: max };
  return { cap: over.maxPerOrder, over };
}

export type LineQtyDecision = { ok: true } | OverCap;

/** Absolute quantity. Callers treat zero and below as removal before this runs. */
export function decideLineQty(
  qty: number,
  maxPerOrder: number | null | undefined,
  stockLeft?: number,
  otherPacksQty?: number,
): LineQtyDecision {
  const { cap, over } = lineCap(maxPerOrder, stockLeft, otherPacksQty);
  return qty > cap ? over : { ok: true };
}

export type AddQtyDecision =
  | { ok: true; nextQty: number; added: number; limitedTo?: number }
  | OverCap;

export function decideAddQty(input: {
  existingQty: number;
  addQty: number;
  maxPerOrder: number | null | undefined;
  stockLeft?: number;
  otherPacksQty?: number;
  clampToMax: boolean;
}): AddQtyDecision {
  const { cap, over } = lineCap(input.maxPerOrder, input.stockLeft, input.otherPacksQty);
  const total = input.existingQty + input.addQty;
  if (total <= cap) return { ok: true, nextQty: total, added: input.addQty };
  if (!input.clampToMax) return over;
  const room = cap - input.existingQty;
  if (room <= 0) return over;
  return { ok: true, nextQty: cap, added: room, limitedTo: cap };
}

/** The shopper-facing reason a line stops: the stock left, else the per-order max. */
export function overCapMessage(over: Pick<OverCap, "maxPerOrder" | "stockLeft">): string {
  return over.stockLeft !== undefined ? `Only ${over.stockLeft} left` : `Maximum ${over.maxPerOrder} per order for this item`;
}

export interface SubstituteListing {
  id: string;
  storeId: string;
  active: boolean;
}

export type NamedSubstituteDecision =
  | { ok: true; substituteVariantId: string }
  | { ok: false; reason: "missing" | "other_store" | "inactive" };

export function decideNamedSubstitute(
  substitute: SubstituteListing | null | undefined,
  storeId: string,
  options?: { requireActive?: boolean },
): NamedSubstituteDecision {
  if (!substitute) return { ok: false, reason: "missing" };
  if (substitute.storeId !== storeId) return { ok: false, reason: "other_store" };
  if (options?.requireActive && !substitute.active) return { ok: false, reason: "inactive" };
  return { ok: true, substituteVariantId: substitute.id };
}

export function isCartSwapRule(value: string): value is CartSwapRule {
  return (SWAP_RULES as readonly string[]).includes(value);
}

/** A rule other than named_substitute stores no substitute variant. */
export function substituteIdForSwap(
  rule: CartSwapRule,
  substituteVariantId: string | null,
): string | null {
  return rule === "named_substitute" ? substituteVariantId : null;
}

export function backupSwap(
  variantId: string,
  storeId: string,
  backup: SubstituteListing | null | undefined,
): { swapRule: CartSwapRule; substituteVariantId: string | null } {
  if (!backup || backup.id === variantId) {
    return { swapRule: "store_suggests", substituteVariantId: null };
  }
  const decision = decideNamedSubstitute(backup, storeId, { requireActive: true });
  if (!decision.ok) return { swapRule: "store_suggests", substituteVariantId: null };
  return { swapRule: "named_substitute", substituteVariantId: decision.substituteVariantId };
}
