"use client";
import { useId } from "react";
import { Plus, Minus } from "lucide-react";
import { cartItemKey, type CartItem } from "@/lib/storefront/cart-store";
import { cartQuantityCeiling } from "@/lib/storefront/cart-quantity";
import { useCart } from "./cart-provider";
import styles from "./cart.module.css";
export function QuickAddStepper({
  item,
  disabled = false,
  maxQuantity,
}: {
  item: CartItem;
  disabled?: boolean;
  maxQuantity?: number;
}) {
  const { lines, store } = useCart();
  const qty =
    lines.find((line) => cartItemKey(line) === cartItemKey(item))?.quantity ??
    0;
  const max = maxQuantity ?? item.maxPerOrder;
  const ceiling = cartQuantityCeiling(max);
  const reasonId = useId();
  const atLimit = max !== undefined && ceiling > 0 && qty >= ceiling;
  return (
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
            onClick={() => store.adjust(item, -1, max)}
            aria-label={`Remove one ${item.name}`}
          >
            <Minus size={18} />
          </button>
          <span data-testid="stepper-qty" aria-live="polite" aria-atomic="true">
            {qty}
          </span>
          <button
            type="button"
            data-testid="stepper-plus"
            disabled={disabled || qty >= ceiling}
            aria-describedby={atLimit ? reasonId : undefined}
            onClick={() => store.adjust(item, 1, max)}
            aria-label={`Add another ${item.name}`}
          >
            <Plus size={18} />
          </button>
          {atLimit && (
            <span id={reasonId} className="sr-only">
              Limit {ceiling} per order
            </span>
          )}
        </>
      ) : (
        <button
          type="button"
          data-testid="quick-add-btn"
          disabled={disabled || ceiling < 1}
          onClick={() => store.adjust(item, 1, max)}
          aria-label={`Add ${item.name} to cart`}
        >
          <Plus size={20} />
        </button>
      )}
    </div>
  );
}
