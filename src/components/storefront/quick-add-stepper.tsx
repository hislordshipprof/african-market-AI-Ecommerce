"use client";
import { Plus, Minus } from "lucide-react";
import { cartItemKey, type CartItem } from "@/lib/storefront/cart-store";
import { cartQuantityCeiling } from "@/lib/storefront/cart-quantity";
import { useCart } from "./cart-provider";
import styles from "./cart.module.css";
export function QuickAddStepper({
  item,
  disabled = false,
  maxQuantity = 99,
}: {
  item: CartItem;
  disabled?: boolean;
  maxQuantity?: number;
}) {
  const { lines, store } = useCart();
  const qty =
    lines.find((line) => cartItemKey(line) === cartItemKey(item))?.quantity ??
    0;
  const ceiling = cartQuantityCeiling(maxQuantity);
  return (
    <div
      className={styles.stepper}
      style={{ width: qty ? 132 : 44 }}
      data-testid={qty ? "quick-add-stepper" : undefined}
    >
      {qty ? (
        <>
          <button
            type="button"
            data-testid="stepper-minus"
            disabled={disabled}
            onClick={() => store.adjust(item, -1, maxQuantity)}
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
            onClick={() => store.adjust(item, 1, maxQuantity)}
            aria-label={`Add another ${item.name}`}
          >
            <Plus size={18} />
          </button>
        </>
      ) : (
        <button
          type="button"
          data-testid="quick-add-btn"
          disabled={disabled || ceiling < 1}
          onClick={() => store.adjust(item, 1, maxQuantity)}
          aria-label={`Add ${item.name} to cart`}
        >
          <Plus size={20} />
        </button>
      )}
    </div>
  );
}
