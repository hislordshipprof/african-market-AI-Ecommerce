"use client";
import { useId } from "react";
import { Plus, Minus } from "lucide-react";
import { cartItemKey, otherPacksQuantity, type CartItem } from "@/lib/storefront/cart-store";
import { lineMax, stepperLimit, stockRoom, type StepperLimit } from "@/lib/storefront/cart-quantity";
import { useCart } from "./cart-provider";
import styles from "./cart.module.css";

/**
 * The stepper's markup, apart from the cart context so its limits can be rendered
 * and asserted (#708 P1). Only plus stops at a limit; minus always works above zero.
 * The quantity is not a live region: the cart's one status announces changes.
 */
export function QuickAddStepperView({
  item,
  qty,
  limit,
  disabled,
  reasonId,
  onStep,
}: {
  item: CartItem;
  qty: number;
  limit: StepperLimit;
  disabled: boolean;
  reasonId: string;
  onStep: (delta: 1 | -1) => void;
}) {
  const blocked = qty ? !limit.canIncrease : !limit.canAdd;
  const reason = blocked && !disabled ? limit.reason : undefined;
  return (
    <>
      <div
        className={styles.stepper}
        data-active={qty ? "true" : undefined}
        data-testid={qty ? "quick-add-stepper" : undefined}
      >
        {qty ? (
          <>
            <button
              type="button"
              data-testid="stepper-minus"
              disabled={disabled}
              onClick={() => onStep(-1)}
              aria-label={`Remove one ${item.name}`}
            >
              <Minus size={18} />
            </button>
            <span data-testid="stepper-qty">{qty}</span>
            <button
              type="button"
              data-testid="stepper-plus"
              disabled={disabled || !limit.canIncrease}
              aria-describedby={reason ? reasonId : undefined}
              onClick={() => onStep(1)}
              aria-label={`Add another ${item.name}`}
            >
              <Plus size={18} />
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="quick-add-btn"
            disabled={disabled || !limit.canAdd}
            aria-describedby={reason ? reasonId : undefined}
            onClick={() => onStep(1)}
            aria-label={`Add ${item.name} to basket`}
          >
            <Plus size={20} />
          </button>
        )}
      </div>
      {reason && (
        <span id={reasonId} className={styles.stepperNote} data-testid="stepper-limit">
          {reason}
        </span>
      )}
    </>
  );
}

export function QuickAddStepper({
  item,
  disabled = false,
  maxQuantity,
  blockedReason,
}: {
  item: CartItem;
  /** Turns the whole stepper off (both directions), e.g. while a pack is loading. */
  disabled?: boolean;
  maxQuantity?: number;
  /** Stops adding but keeps minus, with this reason shown beside it (e.g. ask the store). */
  blockedReason?: string;
}) {
  const { lines, store } = useCart();
  const reasonId = useId();
  const line = lines.find((entry) => cartItemKey(entry) === cartItemKey(item));
  const qty = line?.quantity ?? 0;
  // The cart line carries the server's fresh limit and availability; the page's copy can be stale.
  const max = line?.maxPerOrder ?? maxQuantity ?? item.maxPerOrder;
  const stockLeft = line ? line.stockLeft : item.stockLeft;
  const otherPacksQty = otherPacksQuantity(lines, item);
  const limit: StepperLimit = blockedReason
    ? { canAdd: false, canIncrease: false, reason: blockedReason }
    : stepperLimit({ qty, max, stockLeft, otherPacksQty, minQty: line?.cateringMinQty ?? item.cateringMinQty, available: line?.available ?? item.available, variantId: item.variantId });
  return (
    <QuickAddStepperView
      item={item}
      qty={qty}
      limit={limit}
      disabled={disabled}
      reasonId={reasonId}
      onStep={(delta) => store.adjust(item, delta, lineMax(max, stockRoom(stockLeft, otherPacksQty)))}
    />
  );
}
