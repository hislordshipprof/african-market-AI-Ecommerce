"use client";
import { ShoppingBag } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./cart.module.css";

/** The cart button's accessible name: matches the visible badge, no doubled digit (#705). */
export function basketLabel(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"} in basket`;
}

/**
 * Presentational cart button. Kept apart from the cart context so its accessible
 * name can be rendered and asserted without a provider (#705).
 */
export function CartTriggerView({
  count,
  loading,
  syncing,
  attention,
  onOpen,
  className,
  children,
}: {
  count: number;
  loading: boolean;
  syncing?: boolean;
  attention?: boolean;
  onOpen: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`${styles.cartTrigger} ${className ?? ""}`}
      onClick={onOpen}
      // The label IS the accessible name; the visible digit stays aria-hidden so the
      // count is never read twice (#705).
      aria-label={loading ? "Basket" : basketLabel(count)}
      data-cart-pending={syncing || undefined}
      data-cart-attention={attention || undefined}
    >
      <ShoppingBag size={21} />
      {children}
      {loading ? (
        // No number until the server cart is read, so the badge never flashes a false 0.
        <span
          data-testid="cart-count"
          data-loading="true"
          aria-hidden="true"
          className={styles.countLoading}
        />
      ) : (
        // Remounts on each change, so the bump replays (CSS; reduced motion turns it off).
        <span
          key={count}
          data-testid="cart-count"
          aria-hidden="true"
          className={styles.countBump}
        >
          {count}
        </span>
      )}
    </button>
  );
}
