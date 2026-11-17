"use client";
import { CircleAlert, ShoppingBag } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./cart.module.css";

/** The cart button's accessible name: matches the visible badge, no doubled digit (#705). */
export function basketLabel(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"} in basket`;
}

/** A save the closed basket is still waiting on, or one that failed; a failure outranks a pending save (#708 P1). */
function syncStatus(syncing?: boolean, attention?: boolean): { state: "failed" | "pending"; label: string } | null {
  if (attention) return { state: "failed", label: "Changes not saved" };
  if (syncing) return { state: "pending", label: "Saving changes" };
  return null;
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
  const status = loading ? null : syncStatus(syncing, attention);
  return (
    <button
      type="button"
      className={`${styles.cartTrigger} ${className ?? ""}`}
      onClick={onOpen}
      // The label IS the accessible name; the visible digit stays aria-hidden so the
      // count is never read twice (#705).
      // A sync status leads the name and keeps its "in basket" ending; no live region, as two triggers are mounted.
      aria-label={loading ? "Basket" : status ? `${status.label}. ${basketLabel(count)}` : basketLabel(count)}
      data-cart-pending={syncing || undefined}
      data-cart-attention={attention || undefined}
    >
      <ShoppingBag size={21} />
      {status && (
        // Stays on the closed button until the basket saves, so a failure is never only a passing toast.
        <span className={styles.syncStatus} data-testid="cart-sync-status" data-state={status.state} aria-hidden="true">
          {status.state === "failed" && <CircleAlert size={14} strokeWidth={2.5} />}
        </span>
      )}
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
