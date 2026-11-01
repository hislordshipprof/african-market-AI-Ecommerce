"use client";
import { ProductImage } from "./product-image";
import Link from "next/link";
import { getSwapRule } from "@/lib/customer-flow/rules";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ShoppingBag, Trash2 } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  cartItemKey,
  createCartStore,
  EMPTY_CART,
  type CartLine,
  type CartStore,
} from "@/lib/storefront/cart-store";
import { QuickAddStepper } from "./quick-add-stepper";
import { Sheet } from "./sheet";
import styles from "./cart.module.css";
interface CartContextValue {
  lines: readonly CartLine[];
  count: number;
  subtotal: number;
  store: CartStore;
  openCart: () => void;
}
const Context = createContext<CartContextValue | null>(null);
export function useCart() {
  const value = useContext(Context);
  if (!value) throw new Error("Cart controls require CartProvider");
  return value;
}
const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value / 100,
  );
export function CartProvider({
  storeId,
  storeName,
  minimumOrderCents,
  children,
}: {
  storeId: string;
  storeName: string;
  minimumOrderCents: number;
  children: ReactNode;
}) {
  const store = useMemo(() => createCartStore(storeId), [storeId]);
  const lines = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    () => EMPTY_CART,
  );
  const [open, setOpen] = useState(false);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = lines.reduce(
    (sum, line) => sum + line.quantity * line.price,
    0,
  );
  const minimum = Math.max(0, minimumOrderCents);
  return (
    <Context.Provider
      value={{ store, lines, count, subtotal, openCart: () => setOpen(true) }}
    >
      {children}
      <Sheet open={open} onClose={() => setOpen(false)} title="Your cart">
        <p className={styles.muted}>{storeName}</p>
        {!lines.length ? (
          <div className={styles.empty}>
            <ShoppingBag size={44} />
            <h3>Your next good meal starts here</h3>
            <p>Add something from the shelves to start your cart.</p>
            <button
              className={styles.primaryButton}
              onClick={() => setOpen(false)}
            >
              Start shopping
            </button>
          </div>
        ) : (
          <>
            <ul className={styles.lines}>
              {lines.map((line) => (
                <li className={styles.line} key={cartItemKey(line)}>
                  <div className={`${styles.photo} sf-cart-photo`}>
                    <ProductImage
                      src={line.imageUrl}
                      name={line.name}
                      sizes="76px"
                    />
                  </div>
                  <div className={styles.lineDetails}>
                    <h3>{line.name}</h3>
                    <p>
                      {money(line.price)}
                      {line.packLabel && ` / ${line.packLabel}`}
                    </p>
                    <Link
                      className={styles.swap}
                      href="/cart"
                      onClick={() => setOpen(false)}
                    >
                      {(() => {
                        const rule = getSwapRule(storeId, cartItemKey(line));
                        return rule.kind === "chosen"
                          ? `Replace with ${rule.item.name}`
                          : rule.kind === "suggest"
                            ? "Store suggests a swap"
                            : "Exact item only";
                      })()}
                    </Link>
                    <div className={styles.lineActions}>
                      <QuickAddStepper item={line} />
                      <button
                        className={styles.iconButton}
                        aria-label={`Remove ${line.name} from cart`}
                        onClick={() => store.remove(cartItemKey(line))}
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className={styles.summary}>
              <div className={styles.total}>
                <span>Subtotal</span>
                <strong>{money(subtotal)}</strong>
              </div>
              {minimum > 0 && (
                <>
                  <progress
                    className={styles.progress}
                    max={minimum}
                    value={Math.min(minimum, subtotal)}
                    aria-label="Minimum order progress"
                  />
                  <p className={styles.muted}>
                    {subtotal >= minimum
                      ? "Minimum order reached"
                      : `${money(minimum - subtotal)} to reach the ${money(minimum)} minimum order`}
                  </p>
                </>
              )}
              <Link
                className={styles.primaryButton}
                href="/cart"
                onClick={() => setOpen(false)}
              >
                Review basket & checkout
              </Link>
              {subtotal >= minimum && (
                <Link
                  className="sf-text-link"
                  href="/checkout"
                  onClick={() => setOpen(false)}
                >
                  Continue to checkout
                </Link>
              )}
            </div>
          </>
        )}
      </Sheet>
    </Context.Provider>
  );
}
export function CartTrigger({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const { count, openCart } = useCart();
  const reduced = useReducedMotion();
  return (
    <button
      type="button"
      className={`${styles.cartTrigger} ${className ?? ""}`}
      onClick={openCart}
      aria-label="Shopping cart"
    >
      <ShoppingBag size={21} />
      {children}
      <motion.span
        key={count}
        data-testid="cart-count"
        aria-hidden="true"
        initial={reduced ? false : { scale: 1.2 }}
        animate={{ scale: 1 }}
        transition={
          reduced
            ? { duration: 0 }
            : { type: "spring", stiffness: 400, damping: 20 }
        }
      >
        {count}
      </motion.span>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {count} {count === 1 ? "item" : "items"} in cart
      </span>
    </button>
  );
}
