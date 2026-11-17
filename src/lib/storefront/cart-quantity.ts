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

export interface StepperLimit {
  /** The first add is allowed. */
  canAdd: boolean;
  /** Plus is allowed; minus is always allowed above zero. */
  canIncrease: boolean;
  /** Shown beside the stepper and named by aria-describedby when plus is off. */
  reason?: string;
}

/**
 * What a stepper allows and why (#708 P1, #717 AC1). Only the increase stops:
 * a shopper can always take one away. Server checks stay authoritative.
 */
export function stepperLimit(input: {
  qty: number;
  max: number | undefined;
  available: boolean | undefined;
  variantId: string | undefined;
}): StepperLimit {
  if (!input.variantId) return { canAdd: false, canIncrease: false, reason: "Not sold online yet" };
  const ceiling = cartQuantityCeiling(input.max);
  if (input.available === false || ceiling < 1) return { canAdd: false, canIncrease: false, reason: "No longer available" };
  if (input.qty >= ceiling) return { canAdd: false, canIncrease: false, reason: `Limit ${ceiling} per order` };
  return { canAdd: true, canIncrease: true };
}
