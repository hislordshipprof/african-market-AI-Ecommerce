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
  /** A catering minimum (#808): the first plus adds this many and minus at it removes the line, as the server does. */
  min = 1,
): number | null {
  if (!Number.isFinite(current) || (delta !== 1 && delta !== -1)) return null;
  const qty = Math.trunc(current);
  if (delta < 0) {
    if (qty <= 0) return null;
    return qty <= min ? 0 : qty - 1;
  }
  const next = Math.max(qty + 1, min);
  if (next > cartQuantityCeiling(max)) return null;
  return next;
}

/** The stepper's max: the per-order max, or the counted stock left when that is lower (#808). */
export function lineMax(max: number | undefined, stockLeft: number | undefined): number | undefined {
  return stockLeft === undefined ? max : Math.min(max ?? CART_QTY_HARD_CAP, stockLeft);
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
  /** Units left on a counted listing; caps the stepper when lower than the max (#808). */
  stockLeft?: number;
  /** A catering minimum: the first add needs room for this many. */
  minQty?: number;
  available: boolean | undefined;
  variantId: string | undefined;
}): StepperLimit {
  if (!input.variantId) return { canAdd: false, canIncrease: false, reason: "Not sold online yet" };
  const ceiling = cartQuantityCeiling(lineMax(input.max, input.stockLeft));
  if (input.available === false || ceiling < 1) return { canAdd: false, canIncrease: false, reason: "No longer available" };
  if (input.qty >= ceiling || (input.qty === 0 && (input.minQty ?? 1) > ceiling)) {
    const reason = input.stockLeft === ceiling ? `Only ${ceiling} left` : `Limit ${ceiling} per order`;
    return { canAdd: false, canIncrease: false, reason };
  }
  return { canAdd: true, canIncrease: true };
}
