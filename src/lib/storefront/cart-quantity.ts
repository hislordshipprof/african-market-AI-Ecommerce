import { UNSET_MAX_PER_ORDER } from "../cart/limits";

/** Hard cap used when a listing has no max, matching the cart service. */
export const CART_QTY_HARD_CAP = UNSET_MAX_PER_ORDER;

/**
 * Ceiling for a plus click. Unavailable lines pass max 0.
 * A max above the hard cap is the hard cap.
 */
export function cartQuantityCeiling(max?: number): number {
  if (max === undefined || !Number.isFinite(max)) return CART_QTY_HARD_CAP;
  return Math.min(CART_QTY_HARD_CAP, Math.max(0, Math.trunc(max)));
}

/**
 * One stepper step from the latest intended quantity.
 * Plus is a no-op at or above the ceiling. Minus moves one toward zero
 * even when the current quantity is above that ceiling, and is a no-op at zero.
 * Returns null when the click changes nothing.
 */
export function stepCartQuantity(
  current: number,
  delta: number,
  max?: number,
): number | null {
  if (!Number.isFinite(current) || (delta !== 1 && delta !== -1)) return null;
  const qty = Math.trunc(current);
  if (delta < 0) {
    if (qty <= 0) return null;
    return qty - 1;
  }
  if (qty >= cartQuantityCeiling(max)) return null;
  return qty + 1;
}
