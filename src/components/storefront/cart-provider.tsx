"use client";
import { ProductImage } from "./product-image";
import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
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
import { stepCartQuantity } from "@/lib/storefront/cart-quantity";
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
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { toast } from "sonner";
import { money } from "@/lib/format";
import styles from "./cart.module.css";

const OFFLINE = "Couldn't update your cart. Check your connection and try again.";
const STALE_PAGE = "This page is out of date. Reload the market and try again.";

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

function isStaleAction(error: unknown) {
  if (unstable_isUnrecognizedActionError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  // Next 16 throws UnrecognizedActionError: 'Server Action "…" was not found on the server'
  // and links to /docs/messages/failed-to-find-server-action. The older wording is kept.
  return (
    /was not found on the server/i.test(message) ||
    /failed-to-find-server-action/i.test(message) ||
    /Failed to find Server Action/i.test(message)
  );
}

interface CartContextValue {
  lines: readonly CartLine[];
  count: number;
  subtotal: number;
  store: CartStore;
  openCart: () => void;
  loading: boolean;
  syncing: boolean;
  attention: boolean;
  refreshCart: () => Promise<void>;
}
const Context = createContext<CartContextValue | null>(null);
export function useCart() {
  const value = useContext(Context);
  if (!value) throw new Error("Cart controls require CartProvider");
  return value;
}

type Confirmed = { lineId?: string; qty: number };
type PullMode = "keep-intent" | "server-wins";
type Stamp = { revs: Map<string, number>; identity: Map<string, number> };

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
  const [syncing, setSyncing] = useState(false);
  const [attention, setAttention] = useState(false);
  const mounted = useRef(true);
  const linesRef = useRef<CartLine[]>([]);
  const revs = useRef(new Map<string, number>());
  const identity = useRef(new Map<string, number>());
  const confirmed = useRef(new Map<string, Confirmed>());
  const pendingDelete = useRef(new Map<string, string>());
  const paused = useRef(new Set<string>());
  const addAccepted = useRef(new Set<string>());
  const dropAfterAdd = useRef(new Set<string>());
  const clock = useRef(0);
  const jobs = useRef(0);
  const readFailures = useRef(0);
  const staleDeployment = useRef(false);
  const migratedRef = useRef(false);
  const chain = useRef(Promise.resolve());

  function publish(next: CartLine[]) {
    linesRef.current = next;
    if (mounted.current) setLines(next);
  }
  function intentQty(key: string) {
    return linesRef.current.find((line) => cartItemKey(line) === key)?.quantity ?? 0;
  }
  function bump(key: string, identityChange: boolean) {
    clock.current += 1;
    revs.current.set(key, clock.current);
    if (identityChange) identity.current.set(key, clock.current);
  }
  function takeStamp(): Stamp {
    return { revs: new Map(revs.current), identity: new Map(identity.current) };
  }
  function showQty(key: string, qty: number) {
    if (qty <= 0) {
      publish(linesRef.current.filter((line) => cartItemKey(line) !== key));
      return;
    }
    publish(
      linesRef.current.map((line) =>
        cartItemKey(line) === key ? { ...line, quantity: qty } : line,
      ),
    );
  }
  function put(item: CartItem, qty: number) {
    const key = cartItemKey(item);
    const previous = linesRef.current.find((line) => cartItemKey(line) === key);
    if (qty <= 0) {
      const id = previous?.serverLineId ?? confirmed.current.get(key)?.lineId;
      if (id) pendingDelete.current.set(key, id);
      else dropAfterAdd.current.add(key);
      publish(linesRef.current.filter((line) => cartItemKey(line) !== key));
      return;
    }
    const line: CartLine = {
      listingId: item.listingId,
      variantId: item.variantId,
      name: item.name,
      price: item.price,
      imageUrl: item.imageUrl,
      packLabel: item.packLabel,
      quantity: qty,
      serverLineId: previous?.serverLineId,
      swapRule: previous?.swapRule,
      substituteVariantId: previous?.substituteVariantId,
    };
    if (!previous) {
      dropAfterAdd.current.delete(key);
      publish([
        ...linesRef.current,
        { ...line, serverLineId: undefined, swapRule: undefined, substituteVariantId: undefined },
      ]);
      return;
    }
    publish(linesRef.current.map((entry) => (cartItemKey(entry) === key ? line : entry)));
  }
  function merge(serverLines: CartLine[], stamp: Stamp, mode: PullMode) {
    const next: CartLine[] = [];
    const seen = new Set<string>();
    for (const server of serverLines) {
      const key = cartItemKey(server);
      seen.add(key);
      const local = linesRef.current.find((line) => cartItemKey(line) === key);
      const moved = (revs.current.get(key) ?? 0) > (stamp.revs.get(key) ?? 0);
      const identityMoved = (identity.current.get(key) ?? 0) > (stamp.identity.get(key) ?? 0);
      const acked = confirmed.current.get(key)?.qty ?? 0;
      // A click that landed before this read was stamped is still outstanding.
      // Decreases count: a higher server quantity must not erase them.
      const outstanding = !!local && local.quantity !== acked;
      confirmed.current.set(key, { lineId: server.serverLineId, qty: server.quantity });
      if (!local) {
        if (moved || pendingDelete.current.has(key) || dropAfterAdd.current.has(key)) {
          if (server.serverLineId) pendingDelete.current.set(key, server.serverLineId);
          dropAfterAdd.current.delete(key);
          continue;
        }
        next.push(server);
        continue;
      }
      const keepQty =
        moved ||
        (mode === "keep-intent" && (outstanding || local.quantity > server.quantity));
      next.push({
        ...server,
        quantity: keepQty ? local.quantity : server.quantity,
        swapRule: identityMoved ? local.swapRule : server.swapRule,
        substituteVariantId: identityMoved ? local.substituteVariantId : server.substituteVariantId,
      });
    }
    for (const local of linesRef.current) {
      const key = cartItemKey(local);
      if (seen.has(key)) continue;
      const moved = (revs.current.get(key) ?? 0) > (stamp.revs.get(key) ?? 0);
      const known = confirmed.current.get(key);
      const outstanding = local.quantity !== (known?.qty ?? 0);
      const optimistic = !known?.lineId && local.quantity > 0;
      if (moved || outstanding || (mode === "keep-intent" && optimistic)) {
        next.push(local);
        continue;
      }
      confirmed.current.set(key, { qty: 0 });
      pendingDelete.current.delete(key);
    }
    publish(next);
  }
  async function pullServer(mode: PullMode): Promise<"ok" | "empty" | "failed"> {
    if (!mounted.current || staleDeployment.current) return "failed";
    const stamp = takeStamp();
    try {
      const cart = await getServerCart();
      if (!mounted.current) return "failed";
      if (!cart) return "empty";
      merge(cart.lines.map(serverLineToClient), stamp, mode);
      return "ok";
    } catch (error) {
      if (isStaleAction(error) && mounted.current) {
        staleDeployment.current = true;
        toast.error(STALE_PAGE);
        setAttention(true);
      }
      return "failed";
    }
  }
  function isDirty(key: string) {
    if (paused.current.has(key) || staleDeployment.current) return false;
    if (pendingDelete.current.has(key)) return true;
    const intent = intentQty(key);
    const known = confirmed.current.get(key);
    if ((known?.qty ?? 0) !== intent) return true;
    return intent > 0 && !known?.lineId;
  }
  function dirtyKeys() {
    const keys = new Set<string>();
    for (const line of linesRef.current) keys.add(cartItemKey(line));
    for (const key of confirmed.current.keys()) keys.add(key);
    for (const key of pendingDelete.current.keys()) keys.add(key);
    return [...keys].filter(isDirty);
  }
  async function onThrown(error: unknown, key: string, uncertainAdd: boolean) {
    const revAtFailure = revs.current.get(key) ?? 0;
    paused.current.add(key);
    if (isStaleAction(error)) {
      staleDeployment.current = true;
      if (mounted.current) {
        toast.error(STALE_PAGE);
        setAttention(true);
      }
      return;
    }
    if (mounted.current) {
      toast.error(OFFLINE);
      setAttention(true);
    }
    if (uncertainAdd) addAccepted.current.add(key);
    let pulled = await pullServer("keep-intent");
    if (pulled === "failed" && !staleDeployment.current && readFailures.current < 1) {
      readFailures.current = 1;
      pulled = await pullServer("keep-intent");
    }
    if (!mounted.current) return;
    const newer = (revs.current.get(key) ?? 0) > revAtFailure;
    if (newer) {
      paused.current.delete(key);
      return;
    }
    if (pulled === "failed") {
      readFailures.current = 2;
      showQty(key, confirmed.current.get(key)?.qty ?? 0);
      return;
    }
    readFailures.current = 0;
    const known = confirmed.current.get(key);
    if (pulled === "empty" || (uncertainAdd && !known?.lineId)) {
      if (uncertainAdd && !known?.lineId) {
        showQty(key, 0);
        confirmed.current.set(key, { qty: 0 });
      } else {
        showQty(key, known?.qty ?? 0);
      }
      return;
    }
    paused.current.delete(key);
  }
  async function confirmPull(key: string) {
    const pulled = await pullServer("keep-intent");
    if (!mounted.current) return;
    if (pulled === "failed") {
      if (!staleDeployment.current) {
        toast.error(OFFLINE);
        setAttention(true);
      }
      paused.current.add(key);
      return;
    }
    setAttention(false);
  }
  async function stepServer(key: string) {
    if (!mounted.current || staleDeployment.current || paused.current.has(key)) return;
    const doomed = pendingDelete.current.get(key);
    if (doomed) {
      try {
        const result = await removeCartLine(doomed);
        if (!result.ok && result.code !== "CART_NOT_FOUND") {
          if (mounted.current) {
            toast.error(result.error);
            setAttention(true);
          }
          await pullServer("server-wins");
          return;
        }
      } catch (error) {
        await onThrown(error, key, false);
        return;
      }
      pendingDelete.current.delete(key);
      confirmed.current.set(key, { qty: 0 });
      if (mounted.current) setAttention(false);
      return;
    }
    const target = intentQty(key);
    let known = confirmed.current.get(key) ?? { qty: 0 };
    if (target === 0) {
      if (known.lineId) pendingDelete.current.set(key, known.lineId);
      else confirmed.current.set(key, { qty: 0 });
      return;
    }
    let item = linesRef.current.find((line) => cartItemKey(line) === key);
    if (!known.lineId && addAccepted.current.has(key)) {
      const pulled = await pullServer("keep-intent");
      const recovered = confirmed.current.get(key);
      if (recovered?.lineId) {
        addAccepted.current.delete(key);
        paused.current.delete(key);
        known = recovered;
      } else if (pulled === "failed") {
        if (mounted.current && !staleDeployment.current) {
          toast.error(OFFLINE);
          setAttention(true);
        }
        paused.current.add(key);
        return;
      } else {
        addAccepted.current.delete(key);
      }
    }
    if (!known.lineId) {
      item = linesRef.current.find((line) => cartItemKey(line) === key);
      if (!item?.variantId) {
        paused.current.add(key);
        return;
      }
      let added: { ok: true } | { ok: false; error: string; code: string };
      try {
        added = await addToCart(item.variantId, 1);
      } catch (error) {
        await onThrown(error, key, true);
        return;
      }
      if (!added.ok) {
        if (mounted.current) {
          toast.error(added.error);
          setAttention(true);
        }
        if (added.code === "MAX_PER_ORDER") {
          showQty(key, 0);
          confirmed.current.set(key, { qty: 0 });
        } else {
          await pullServer("server-wins");
        }
        paused.current.add(key);
        return;
      }
      const pulled = await pullServer("keep-intent");
      const landed = confirmed.current.get(key)?.lineId;
      if (landed && dropAfterAdd.current.has(key)) {
        pendingDelete.current.set(key, landed);
        dropAfterAdd.current.delete(key);
        showQty(key, 0);
        return;
      }
      if (!landed) {
        if (pulled === "failed") {
          addAccepted.current.add(key);
          if (mounted.current && !staleDeployment.current) toast.error(OFFLINE);
        } else {
          showQty(key, 0);
          confirmed.current.set(key, { qty: 0 });
        }
        if (mounted.current) setAttention(true);
        paused.current.add(key);
        return;
      }
      addAccepted.current.delete(key);
      if (mounted.current) setAttention(false);
      return;
    }
    const lineId = known.lineId;
    const liveTarget = intentQty(key);
    if (liveTarget === known.qty) return;
    if (liveTarget > known.qty) {
      let result: { ok: true } | { ok: false; error: string; code: string };
      try {
        result = await serverSetLineQty(lineId, known.qty + 1);
      } catch (error) {
        await onThrown(error, key, false);
        return;
      }
      if (!result.ok) {
        if (mounted.current) {
          toast.error(result.error);
          setAttention(true);
        }
        if (result.code === "MAX_PER_ORDER") {
          if (intentQty(key) > known.qty) showQty(key, known.qty);
          return;
        }
        await pullServer("server-wins");
        return;
      }
      confirmed.current.set(key, { lineId, qty: known.qty + 1 });
      return;
    }
    let result: { ok: true } | { ok: false; error: string; code: string };
    try {
      result = await serverSetLineQty(lineId, liveTarget);
    } catch (error) {
      await onThrown(error, key, false);
      return;
    }
    if (!result.ok) {
      if (mounted.current) {
        toast.error(result.error);
        setAttention(true);
      }
      await pullServer("server-wins");
      return;
    }
    confirmed.current.set(key, { lineId, qty: liveTarget });
  }
  async function drain() {
    for (let i = 0; i < 200; i += 1) {
      if (!mounted.current || staleDeployment.current) return;
      const key = dirtyKeys()[0];
      if (!key) return;
      await stepServer(key);
      if (!mounted.current || staleDeployment.current) return;
      if (!isDirty(key) && !paused.current.has(key) && intentQty(key) > 0) {
        await confirmPull(key);
      }
    }
  }
  function enqueue(job: () => Promise<void>, user: boolean) {
    if (user) {
      jobs.current += 1;
      if (mounted.current) setSyncing(true);
    }
    const run = chain.current.then(async () => {
      try {
        if (mounted.current) await job();
      } catch (error) {
        if (!mounted.current) return;
        if (isStaleAction(error)) {
          staleDeployment.current = true;
          toast.error(STALE_PAGE);
        } else {
          toast.error(OFFLINE);
        }
        setAttention(true);
      } finally {
        if (!user) return;
        jobs.current = Math.max(0, jobs.current - 1);
        if (jobs.current === 0 && mounted.current) setSyncing(false);
      }
    });
    chain.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  function noteGesture(key: string) {
    paused.current.delete(key);
    readFailures.current = 0;
  }
  function rejectStale() {
    if (!staleDeployment.current) return false;
    toast.error(STALE_PAGE);
    if (mounted.current) setAttention(true);
    return true;
  }
  async function initialLoad() {
    const pulled = await pullServer("server-wins");
    if (!mounted.current) return;
    if (pulled === "failed") {
      if (!staleDeployment.current) {
        toast.error(OFFLINE);
        setAttention(true);
      }
      return;
    }
    if (linesRef.current.length > 0 || [...revs.current.values()].some((rev) => rev > 0)) return;
    if (migratedRef.current) return;
    migratedRef.current = true;
    const storageKey = `storefront-cart:${storeId}`;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const localLines = JSON.parse(raw) as Array<{ variantId?: string; quantity: number }>;
      if (!Array.isArray(localLines) || localLines.length === 0) return;
      const migrationLines = localLines
        .filter((line) => line.variantId && line.quantity > 0)
        .map((line) => ({ variantId: line.variantId!, qty: line.quantity }));
      if (migrationLines.length === 0) return;
      if ([...revs.current.values()].some((rev) => rev > 0)) return;
      const result = await migrateLocalCart(migrationLines);
      if (!result.ok || !mounted.current) return;
      window.localStorage.removeItem(storageKey);
      await pullServer("server-wins");
    } catch {
      /* Storage or the one-time migration can fail without blocking the shelf. */
    }
  }

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    void enqueue(() => initialLoad(), false).finally(() => {
      if (alive && mounted.current) setLoading(false);
    });
    return () => {
      alive = false;
      mounted.current = false;
    };
    // The queue and the loader close over refs. Re-running them every render would reload the cart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  const store: CartStore = {
    snapshot: () => linesRef.current,
    subscribe: () => () => {},
    adjust(item, delta, max) {
      const key = cartItemKey(item);
      const next = stepCartQuantity(intentQty(key), delta, max);
      if (next === null || rejectStale()) return;
      noteGesture(key);
      bump(key, (intentQty(key) === 0) !== (next === 0));
      put(item, next);
      void enqueue(drain, true);
    },
    setQuantity(item, quantity) {
      if (!Number.isFinite(quantity)) return;
      const next = Math.min(99, Math.max(0, Math.floor(quantity)));
      const key = cartItemKey(item);
      if (next === intentQty(key) || rejectStale()) return;
      noteGesture(key);
      bump(key, (intentQty(key) === 0) !== (next === 0));
      put(item, next);
      void enqueue(drain, true);
    },
    remove(key) {
      const current = linesRef.current.find((line) => cartItemKey(line) === key);
      if (!current && !pendingDelete.current.has(key)) return;
      if (rejectStale()) return;
      noteGesture(key);
      bump(key, true);
      const id = current?.serverLineId ?? confirmed.current.get(key)?.lineId;
      if (id) pendingDelete.current.set(key, id);
      else dropAfterAdd.current.add(key);
      publish(linesRef.current.filter((line) => cartItemKey(line) !== key));
      void enqueue(drain, true);
    },
  };
  const refreshCart = () =>
    enqueue(async () => {
      const pulled = await pullServer("server-wins");
      if (pulled === "failed" && mounted.current && !staleDeployment.current) {
        toast.error(OFFLINE);
        setAttention(true);
      }
    }, true);

  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.price, 0);
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
        attention,
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
  const { count, openCart, syncing, attention } = useCart();
  const reduced = useReducedMotion();
  return (
    <button
      type="button"
      className={`${styles.cartTrigger} ${className ?? ""}`}
      onClick={openCart}
      aria-label="Shopping cart"
      data-cart-pending={syncing || undefined}
      data-cart-attention={attention || undefined}
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
