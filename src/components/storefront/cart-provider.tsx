"use client";
import { ProductImage } from "./product-image";
import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { ShoppingBag, Trash2 } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import {
  cartItemKey,
  EMPTY_CART,
  type CartItem,
  type CartLine,
  type CartStore,
} from "@/lib/storefront/cart-store";
import {
  getServerCart,
  addToCart,
  setLineQty as serverSetLineQty,
  removeCartLine,
  migrateLocalCart,
} from "@/lib/cart/actions";
import type { CartLineView } from "@/lib/cart/service";
import { QuickAddStepper } from "./quick-add-stepper";
import { Sheet } from "./sheet";
import { toast } from "sonner";
import styles from "./cart.module.css";

function serverLineToClient(sl: CartLineView): CartLine {
  const displayName =
    sl.variant.listing.customName ??
    sl.variant.listing.masterProduct?.name ??
    sl.variant.label;
  return {
    listingId: sl.variant.listing.id,
    variantId: sl.variantId,
    name: displayName,
    price: sl.variant.price,
    imageUrl: sl.imageUrl,
    packLabel: sl.variant.label,
    quantity: sl.qty,
    serverLineId: sl.id,
    swapRule: sl.swapRule,
    substituteVariantId: sl.substituteVariantId,
  };
}

interface CartContextValue {
  lines: readonly CartLine[];
  count: number;
  subtotal: number;
  store: CartStore;
  openCart: () => void;
  loading: boolean;
  syncing: boolean;
  refreshCart: () => Promise<void>;
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
  const [lines, setLines] = useState<readonly CartLine[]>(EMPTY_CART);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, startTransition] = useTransition();
  const linesRef = useRef(lines);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  const migratedRef = useRef(false);
  const inflightAdds = useRef(new Set<string>());
  const pendingQty = useRef(new Map<string, number>());

  const refreshCart = useCallback(async () => {
    const cart = await getServerCart();
    if (cart) {
      setLines(cart.lines.map(serverLineToClient));
    } else {
      setLines(EMPTY_CART);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const cart = await getServerCart();
        if (!active) return;

        if (cart && cart.lines.length > 0) {
          setLines(cart.lines.map(serverLineToClient));
          setLoading(false);
          return;
        }

        if (!migratedRef.current) {
          migratedRef.current = true;
          const storageKey = `storefront-cart:${storeId}`;
          try {
            const raw = window.localStorage.getItem(storageKey);
            if (raw) {
              const localLines = JSON.parse(raw) as Array<{
                listingId: string;
                variantId?: string;
                quantity: number;
              }>;
              if (Array.isArray(localLines) && localLines.length > 0) {
                const migrationLines = localLines
                  .filter((l) => l.variantId && l.quantity > 0)
                  .map((l) => ({
                    variantId: l.variantId!,
                    qty: l.quantity,
                  }));
                if (migrationLines.length > 0) {
                  const result = await migrateLocalCart(migrationLines);
                  if (result.ok) {
                    window.localStorage.removeItem(storageKey);
                    const freshCart = await getServerCart();
                    if (active && freshCart) {
                      setLines(freshCart.lines.map(serverLineToClient));
                    }
                  }
                }
              }
            }
          } catch {
            // localStorage unavailable or migration failed
          }
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [storeId, refreshCart]);

  const store: CartStore = {
    snapshot: () => linesRef.current,
    subscribe: () => () => {},
    setQuantity(item: CartItem, quantity: number) {
      const key = cartItemKey(item);
      const prev = linesRef.current;
      const existing = prev.find((l) => cartItemKey(l) === key);

      if (quantity <= 0) {
        setLines(prev.filter((l) => cartItemKey(l) !== key));
        if (existing?.serverLineId) {
          startTransition(async () => {
            const result = await removeCartLine(existing.serverLineId!);
            if (!result.ok) {
              setLines(prev);
              toast.error(result.error);
            }
          });
        } else if (inflightAdds.current.has(key)) {
          pendingQty.current.set(key, 0);
        }
        return;
      }

      if (existing) {
        setLines(
          prev.map((l) =>
            cartItemKey(l) === key ? { ...l, quantity } : l,
          ),
        );
        if (existing.serverLineId) {
          startTransition(async () => {
            const result = await serverSetLineQty(
              existing.serverLineId!,
              quantity,
            );
            if (!result.ok) {
              setLines(prev);
              toast.error(result.error);
            }
          });
        } else {
          pendingQty.current.set(key, quantity);
        }
      } else {
        setLines([
          ...prev,
          { ...item, quantity, serverLineId: undefined },
        ]);
        if (item.variantId) {
          if (inflightAdds.current.has(key)) {
            pendingQty.current.set(key, quantity);
            return;
          }
          inflightAdds.current.add(key);
          startTransition(async () => {
            const result = await addToCart(item.variantId!, quantity);
            if (!result.ok) {
              inflightAdds.current.delete(key);
              pendingQty.current.delete(key);
              setLines(prev);
              toast.error(result.error);
              return;
            }

            const cart = await getServerCart();
            inflightAdds.current.delete(key);

            if (!cart) {
              pendingQty.current.delete(key);
              return;
            }

            const serverLines = cart.lines.map(serverLineToClient);
            const desired = pendingQty.current.get(key);
            pendingQty.current.delete(key);

            if (desired !== undefined) {
              const serverLine = serverLines.find(
                (l) => cartItemKey(l) === key,
              );
              if (serverLine?.serverLineId) {
                if (desired <= 0) {
                  setLines(
                    serverLines.filter(
                      (l) => cartItemKey(l) !== key,
                    ),
                  );
                  await removeCartLine(serverLine.serverLineId);
                } else {
                  setLines(
                    serverLines.map((l) =>
                      cartItemKey(l) === key
                        ? { ...l, quantity: desired }
                        : l,
                    ),
                  );
                  const qtyResult = await serverSetLineQty(
                    serverLine.serverLineId,
                    desired,
                  );
                  if (!qtyResult.ok) {
                    toast.error(qtyResult.error);
                    await refreshCart();
                  }
                }
              } else {
                setLines(serverLines);
              }
            } else {
              setLines(serverLines);
            }
          });
        }
      }
    },
    remove(key: string) {
      const prev = linesRef.current;
      const line = prev.find((l) => cartItemKey(l) === key);
      setLines(prev.filter((l) => cartItemKey(l) !== key));
      if (line?.serverLineId) {
        startTransition(async () => {
          const result = await removeCartLine(line.serverLineId!);
          if (!result.ok) {
            setLines(prev);
            toast.error(result.error);
          }
        });
      } else if (inflightAdds.current.has(key)) {
        pendingQty.current.set(key, 0);
      }
    },
  };

  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = lines.reduce(
    (sum, line) => sum + line.quantity * line.price,
    0,
  );
  const minimum = Math.max(0, minimumOrderCents);

  return (
    <Context.Provider
      value={{
        store,
        lines,
        count,
        subtotal,
        openCart: () => setOpen(true),
        loading,
        syncing,
        refreshCart,
      }}
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
                        const rule = line.swapRule ?? "exact_only";
                        return rule === "named_substitute"
                          ? "Named substitute chosen"
                          : rule === "store_suggests"
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
  const { count, openCart, syncing } = useCart();
  const reduced = useReducedMotion();
  return (
    <button
      type="button"
      className={`${styles.cartTrigger} ${className ?? ""}`}
      onClick={openCart}
      aria-label="Shopping cart"
      data-cart-pending={syncing || undefined}
    >
      <ShoppingBag size={21} />
      {children}
      <m.span
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
      </m.span>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {count} {count === 1 ? "item" : "items"} in cart
      </span>
    </button>
  );
}
