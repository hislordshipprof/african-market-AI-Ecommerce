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

export type LineQtyDecision =
  | { ok: true }
  | { ok: false; code: "max_per_order"; maxPerOrder: number };

/** Absolute quantity. Callers treat zero and below as removal before this runs. */
export function decideLineQty(
  qty: number,
  maxPerOrder: number | null | undefined,
): LineQtyDecision {
  const max = effectiveMaxPerOrder(maxPerOrder);
  if (qty > max) return { ok: false, code: "max_per_order", maxPerOrder: max };
  return { ok: true };
}

export type AddQtyDecision =
  | { ok: true; nextQty: number; added: number; limitedTo?: number }
  | { ok: false; code: "max_per_order"; maxPerOrder: number };

export function decideAddQty(input: {
  existingQty: number;
  addQty: number;
  maxPerOrder: number | null | undefined;
  clampToMax: boolean;
}): AddQtyDecision {
  const max = effectiveMaxPerOrder(input.maxPerOrder);
  const total = input.existingQty + input.addQty;
  if (total <= max) return { ok: true, nextQty: total, added: input.addQty };
  if (!input.clampToMax) return { ok: false, code: "max_per_order", maxPerOrder: max };
  const room = max - input.existingQty;
  if (room <= 0) return { ok: false, code: "max_per_order", maxPerOrder: max };
  return { ok: true, nextQty: max, added: room, limitedTo: max };
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
