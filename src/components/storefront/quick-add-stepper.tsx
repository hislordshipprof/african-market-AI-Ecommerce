"use client";
import { m, useReducedMotion } from "motion/react";
import { Plus, Minus } from "lucide-react";
import { cartItemKey, type CartItem } from "@/lib/storefront/cart-store";
import { useCart } from "./cart-provider";
import { flyToCart } from "./cart-flight";
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
  const reduced = useReducedMotion();
  const press = reduced ? undefined : { scale: 0.95 };
  return (
    <m.div
      className={styles.stepper}
      initial={false}
      style={{ width: qty ? 132 : 44 }}
      transition={
        reduced
          ? { duration: 0 }
          : { type: "spring", stiffness: 400, damping: 25 }
      }
      data-testid={qty ? "quick-add-stepper" : undefined}
    >
      {qty ? (
        <>
          <m.button
            type="button"
            whileTap={press}
            data-testid="stepper-minus"
            disabled={disabled}
            onClick={() => store.setQuantity(item, qty - 1)}
            aria-label={`Remove one ${item.name}`}
          >
            <Minus size={18} />
          </m.button>
          <span data-testid="stepper-qty" aria-live="polite" aria-atomic="true">
            {qty}
          </span>
          <m.button
            type="button"
            whileTap={press}
            data-testid="stepper-plus"
            disabled={disabled || qty >= Math.min(99, maxQuantity)}
            onClick={e => { store.setQuantity(item, qty + 1); flyToCart(e.currentTarget); }}
            aria-label={`Add another ${item.name}`}
          >
            <Plus size={18} />
          </m.button>
        </>
      ) : (
        <m.button
          type="button"
          whileTap={press}
          data-testid="quick-add-btn"
          disabled={disabled || maxQuantity < 1}
          onClick={e => { store.setQuantity(item, 1); flyToCart(e.currentTarget); }}
          aria-label={`Add ${item.name} to cart`}
        >
          <Plus size={20} />
        </m.button>
      )}
    </m.div>
  );
}
