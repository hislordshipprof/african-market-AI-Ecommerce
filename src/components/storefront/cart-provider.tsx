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
import { CircleAlert, ShoppingBag, Trash2 } from "lucide-react";
import {
  cartItemKey,
  EMPTY_CART,
  type CartItem,
  type CartLine,
  type CartStore,
} from "@/lib/storefront/cart-store";
import { stepCartQuantity } from "@/lib/storefront/cart-quantity";
import { effectiveMaxPerOrder } from "@/lib/cart/limits";
import {
  clearKeyIdentity,
  confirmedSnapshot,
  mergeServerLines,
  removalResultAction,
  type ReconcileScope,
} from "@/lib/storefront/cart-reconcile";
import {
  getServerCart,
  addToCart,
  setLineQty as serverSetLineQty,
  removeCartLine,
  migrateLocalCart,
  setSwapRule,
} from "@/lib/cart/actions";
import { minimumOrderGate } from "@/lib/storefront/minimum-order";
import {
  addPendingUndo,
  livePendingUndo,
  removedLine,
  restoreSteps,
  undoMessage,
  UNDO_MS,
  type PendingUndo,
  type RemovedLine,
} from "@/lib/storefront/cart-undo";
import type { CartLineView } from "@/lib/cart/service";
import { QuickAddStepper } from "./quick-add-stepper";
import { CartTriggerView } from "./cart-trigger";
import { Sheet } from "./sheet";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { money } from "@/lib/format";
import { bindCartRefresh } from "@/lib/assistant/ui/cart-bridge";
import { AssistantSlot } from "./assistant/assistant-slot";
import styles from "./cart.module.css";
import { TOASTER_WANTED } from "@/components/ui/sonner";

type Sonner = typeof import("sonner");
// Sonner loads on the first toast, not on the path to the first paint (#563); the event mounts the Toaster.
function loadSonner() {
  window.dispatchEvent(new Event(TOASTER_WANTED));
  return import("sonner");
}
const toast = Object.assign(
  (...args: Parameters<Sonner["toast"]>) => void loadSonner().then((mod) => mod.toast(...args)),
  { error: (...args: Parameters<Sonner["toast"]["error"]>) => void loadSonner().then((mod) => mod.toast.error(...args)) },
);

/** Wall clock for the Undo window; only read from event handlers and timers. */
const undoClock = () => Date.now();
const OFFLINE = "Couldn't update your basket. Check your connection and try again.";
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
    categorySlug: sl.categorySlug,
    packLabel: sl.variant.label,
    maxPerOrder: effectiveMaxPerOrder(sl.variant.listing.maxPerOrder),
    available: sl.variant.listing.available,
    alternatives: sl.alternatives?.map((alt) => ({
      listingId: alt.listingId,
      variantId: alt.variantId,
      name: alt.name,
      price: alt.price,
      imageUrl: alt.imageUrl,
      packLabel: alt.packLabel,
      maxPerOrder: alt.maxPerOrder,
    })),
    quantity: sl.qty,
    serverLineId: sl.id,
    swapRule: sl.swapRule,
    substituteVariantId: sl.substituteVariantId,
  };
}

function e2eRemovalOverride(): Promise<{ ok: false; error: string; code: string } | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const host = window.location.hostname;
  if (host !== "localhost" && !host.endsWith(".localhost")) return Promise.resolve(null);
  const hooked = (window as Window & {
    __e2eRemovalResult?:
      | { ok: false; error: string; code: string }
      | (() => Promise<{ ok: false; error: string; code: string }>);
  }).__e2eRemovalResult;
  if (!hooked) return Promise.resolve(null);
  if (typeof hooked === "function") return hooked();
  return Promise.resolve(hooked);
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
  /** The last read of the server cart failed, so an empty list is unknown, not empty (#708 P1). */
  loadFailed: boolean;
  /** Lines with a change still on its way to the server, for a per-line "Updating…" (#717 AC4). */
  pendingKeys: ReadonlySet<string>;
  /** The latest cart change, for the one polite status of the surface in front (#708 P1). */
  announcement: string;
  cartId: string | null;
  refreshCart: () => Promise<void>;
  reportCartFailure: (failure: { error?: string; thrown?: unknown }) => void;
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
  const openRef = useRef(false);
  // A write failure while the (modal) drawer is open, shown inside it instead of a page toast (#708 AC3).
  // Keyed by line, so it clears when that line saves again; keyless ones clear when nothing is failing.
  const [sheetNotice, setSheetNotice] = useState<{ message: string; retry?: () => void; key?: string } | null>(null);
  // One polite announcement per change, so no two cart triggers announce the same change (#708 AC3).
  const [announce, setAnnounce] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [syncing, setSyncing] = useState(false);
  const [attention, setAttention] = useState(false);
  const [cartId, setCartId] = useState<string | null>(null);
  // Removals Undo can still restore. Inside the open (modal) drawer they show in it; elsewhere as a toast.
  const [pendingUndo, setPendingUndo] = useState<PendingUndo[]>([]);
  const pendingUndoRef = useRef<PendingUndo[]>([]);
  const undoTimer = useRef<number | undefined>(undefined);
  function setPending(next: PendingUndo[]) {
    pendingUndoRef.current = next;
    setPendingUndo(next);
    window.clearTimeout(undoTimer.current);
    // Re-check when the soonest entry expires, so each removal leaves the bar after its own 6 s.
    const now = undoClock();
    const live = livePendingUndo(next, now).entries;
    if (live.length) undoTimer.current = window.setTimeout(() => setPending(livePendingUndo(pendingUndoRef.current, undoClock()).entries), Math.min(...live.map((entry) => entry.until - now)));
  }
  function undoToast(entries: PendingUndo[], duration: number) {
    toast(undoMessage(entries), {
      duration,
      action: { label: "Undo", onClick: () => livePendingUndo(entries, undoClock()).entries.forEach((entry) => restoreRemoved(entry.removed)) },
    });
  }
  function openCart() {
    openRef.current = true;
    setOpen(true);
  }
  function closeCart() {
    openRef.current = false;
    setOpen(false);
    setSheetNotice(null);
    // Whatever was still undoable in the drawer moves to a toast for the time it has left.
    const { entries, remainingMs } = livePendingUndo(pendingUndoRef.current, undoClock());
    if (entries.length) undoToast(entries, remainingMs);
    setPending([]);
  }
  /** Inside the open drawer the message shows in it; elsewhere it is a toast, with Retry when there is one. */
  function notify(message: string, retry?: () => void, key?: string) {
    if (!mounted.current) return;
    if (openRef.current) setSheetNotice({ message, retry, key });
    // One toast per line (or per message): a repeated failure replaces it instead of stacking.
    else toast.error(message, { id: `cart:${key ?? message}`, ...(retry ? { action: { label: "Retry", onClick: retry } } : {}) });
  }
  /** A line saved again: its notice is resolved, and a general one too once nothing is failing. */
  function resolveNotice(key?: string) {
    if (!mounted.current) return;
    const clean = failedKeys.current.size === 0;
    setSheetNotice((notice) => (!notice ? notice : notice.key ? (notice.key === key ? null : notice) : clean ? null : notice));
  }
  function markPending(key: string) {
    if (mounted.current) setPendingKeys((keys) => (keys.has(key) ? keys : new Set(keys).add(key)));
  }
  /** Retry puts the failed quantity back as the intent and sends it again. */
  function retryAt(item: CartItem, qty: number) {
    return () => {
      setSheetNotice(null);
      const key = cartItemKey(item);
      if (intentQty(key) !== qty) store.setQuantity(item, qty);
      else if (!rejectStale()) {
        noteGesture(key);
        void enqueue(drain, true);
      }
    };
  }
  const mounted = useRef(true);
  const linesRef = useRef<CartLine[]>([]);
  const revs = useRef(new Map<string, number>());
  const identity = useRef(new Map<string, number>());
  const confirmed = useRef(new Map<string, Confirmed>());
  const pendingDelete = useRef(new Map<string, string>());
  const paused = useRef(new Set<string>());
  const fallback = useRef(new Map<string, CartLine>());
  const failedKeys = useRef(new Set<string>());
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
  function rememberFallback(key: string, line: CartLine | undefined) {
    const prior = fallback.current.get(key);
    const lineId = line?.serverLineId ?? confirmed.current.get(key)?.lineId ?? prior?.serverLineId;
    if ((!line && !prior) || !lineId) return;
    const base = line ?? prior;
    if (!base) return;
    fallback.current.set(
      key,
      confirmedSnapshot(
        {
          ...base,
          serverLineId: lineId,
          swapRule: line?.swapRule ?? prior?.swapRule,
          substituteVariantId: line?.substituteVariantId ?? prior?.substituteVariantId,
        },
        confirmed.current.get(key)?.qty ?? prior?.quantity ?? 0,
      ),
    );
  }
  function restoreFallback(key: string) {
    const snap = fallback.current.get(key);
    pendingDelete.current.delete(key);
    if (!snap || snap.quantity <= 0) return;
    const without = linesRef.current.filter((line) => cartItemKey(line) !== key);
    publish([...without, snap]);
    confirmed.current.set(key, { lineId: snap.serverLineId, qty: snap.quantity });
  }
  function clearFailure(key: string) {
    failedKeys.current.delete(key);
    if (pendingDelete.current.has(key)) {
      const snap = fallback.current.get(key);
      const known = confirmed.current.get(key);
      if (snap && known?.lineId && known.qty > 0) {
        fallback.current.set(key, {
          ...snap,
          quantity: known.qty,
          serverLineId: known.lineId,
        });
      }
    } else {
      fallback.current.delete(key);
    }
    if (failedKeys.current.size === 0 && mounted.current) setAttention(false);
    resolveNotice(key);
  }
  function applyMerged(
    merged: {
      lines: CartLine[];
      confirmed: Map<string, { lineId?: string; qty: number }>;
      pendingDelete: Map<string, string>;
      dropAfterAdd: Set<string>;
    },
    scope?: ReconcileScope,
  ) {
    confirmed.current = merged.confirmed;
    pendingDelete.current = merged.pendingDelete;
    dropAfterAdd.current = merged.dropAfterAdd;
    if (scope && (revs.current.get(scope.key) ?? 0) <= scope.sinceRev) {
      fallback.current.delete(scope.key);
    } else if (!scope) {
      for (const line of merged.lines) {
        const key = cartItemKey(line);
        if (!fallback.current.has(key) || pendingDelete.current.has(key)) continue;
        const known = merged.confirmed.get(key);
        fallback.current.set(
          key,
          confirmedSnapshot(line, known?.qty ?? line.quantity),
        );
      }
    }
    publish(merged.lines);
  }
  function put(item: CartItem, qty: number) {
    const key = cartItemKey(item);
    const previous = linesRef.current.find((line) => cartItemKey(line) === key);
    if (qty <= 0) {
      rememberFallback(key, previous);
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
      categorySlug: item.categorySlug ?? previous?.categorySlug,
      packLabel: item.packLabel,
      // The server line's limit and availability are fresher than the page's copy of the listing.
      maxPerOrder: previous?.maxPerOrder ?? item.maxPerOrder,
      available: previous?.available ?? item.available,
      alternatives: previous?.alternatives,
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
  function merge(serverLines: CartLine[], stamp: Stamp, mode: PullMode, scope?: ReconcileScope) {
    const merged = mergeServerLines({
      lines: linesRef.current,
      confirmed: confirmed.current,
      pendingDelete: pendingDelete.current,
      dropAfterAdd: dropAfterAdd.current,
      revs: revs.current,
      identity: identity.current,
      serverLines,
      stamp,
      mode,
      scope,
    });
    applyMerged(merged, scope);
    for (const server of serverLines) {
      const key = cartItemKey(server);
      if (!pendingDelete.current.has(key)) continue;
      if (scope && scope.key === key && (revs.current.get(key) ?? 0) <= scope.sinceRev) continue;
      const known = confirmed.current.get(key);
      if (!known?.lineId || known.qty <= 0) continue;
      const prior = fallback.current.get(key);
      fallback.current.set(
        key,
        confirmedSnapshot(
          {
            ...server,
            serverLineId: known.lineId,
            swapRule: server.swapRule ?? prior?.swapRule,
            substituteVariantId: server.substituteVariantId ?? prior?.substituteVariantId,
          },
          known.qty,
        ),
      );
    }
  }
  async function pullServer(mode: PullMode, scope?: ReconcileScope): Promise<"ok" | "empty" | "failed"> {
    if (!mounted.current || staleDeployment.current) return "failed";
    const stamp = takeStamp();
    try {
      const cart = await getServerCart();
      if (!mounted.current) return "failed";
      if (!cart) {
        setCartId(null);
        setLoadFailed(false);
        if (scope) {
          const cleared = clearKeyIdentity(
            {
              lines: linesRef.current,
              confirmed: confirmed.current,
              pendingDelete: pendingDelete.current,
              dropAfterAdd: dropAfterAdd.current,
            },
            revs.current,
            scope.key,
            scope.sinceRev,
          );
          if (cleared) applyMerged(cleared, scope);
        }
        return "empty";
      }
      setCartId(cart.id);
      merge(cart.lines.map(serverLineToClient), stamp, mode, scope);
      setLoadFailed(false);
      return "ok";
    } catch (error) {
      if (isStaleAction(error) && mounted.current) {
        staleDeployment.current = true;
        notify(STALE_PAGE);
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
  /**
   * Shared by a thrown write and a rejected write: one keep-intent read, one
   * retry, then stop when the page is stale, unmounted, or a newer gesture won.
   */
  async function readCartForRecovery(
    key: string,
    sinceRev: number,
    scope?: ReconcileScope,
  ): Promise<"ok" | "empty" | "failed" | "stopped"> {
    let pulled = await pullServer("keep-intent", scope);
    if (pulled === "failed" && !staleDeployment.current && readFailures.current < 1) {
      readFailures.current = 1;
      pulled = await pullServer("keep-intent", scope);
    }
    if (!mounted.current || staleDeployment.current) return "stopped";
    if ((revs.current.get(key) ?? 0) > sinceRev) {
      paused.current.delete(key);
      return "stopped";
    }
    return pulled;
  }
  async function onThrown(error: unknown, key: string, uncertainAdd: boolean, revAtSend?: number) {
    const failedRev = revAtSend ?? revs.current.get(key) ?? 0;
    const removing = pendingDelete.current.has(key);
    paused.current.add(key);
    if (isStaleAction(error)) {
      staleDeployment.current = true;
      if (mounted.current) {
        notify(STALE_PAGE);
        setAttention(true);
      }
      return;
    }
    if (mounted.current) {
      const line = linesRef.current.find((entry) => cartItemKey(entry) === key);
      notify(
        line ? `Couldn\u2019t update ${line.name}. Check your connection and try again.` : OFFLINE,
        uncertainAdd && line ? retryAt(line, line.quantity) : undefined,
        key,
      );
      setAttention(true);
    }
    if (uncertainAdd) addAccepted.current.add(key);
    const scope = removing ? { key, sinceRev: failedRev } : undefined;
    const pulled = await readCartForRecovery(key, failedRev, scope);
    if (pulled === "stopped") return;
    if (removing) {
      if (pulled === "failed") {
        readFailures.current = 2;
        restoreFallback(key);
        failedKeys.current.add(key);
        return;
      }
      readFailures.current = 0;
      failedKeys.current.add(key);
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
    if ((known?.qty ?? 0) !== intentQty(key)) {
      showQty(key, known?.qty ?? 0);
      return;
    }
    paused.current.delete(key);
  }
  async function recoverRejected(key: string, sinceRev: number, kind: "remove" | "qty" | "add") {
    const pulled = await readCartForRecovery(key, sinceRev, { key, sinceRev });
    if (pulled === "stopped") return;
    if (pulled === "failed") {
      readFailures.current = 2;
      paused.current.add(key);
      failedKeys.current.add(key);
      if (mounted.current) setAttention(true);
      if (kind === "remove") restoreFallback(key);
      else showQty(key, confirmed.current.get(key)?.qty ?? 0);
      return;
    }
    readFailures.current = 0;
    if (kind === "remove") {
      failedKeys.current.add(key);
      if (mounted.current) setAttention(true);
      paused.current.delete(key);
      return;
    }
    if (kind === "add" && !confirmed.current.get(key)?.lineId) {
      showQty(key, 0);
      confirmed.current.set(key, { qty: 0 });
      addAccepted.current.delete(key);
      paused.current.add(key);
      return;
    }
    paused.current.delete(key);
  }
  async function confirmPull(key: string) {
    const pulled = await pullServer("keep-intent");
    if (!mounted.current) return;
    if (pulled === "failed") {
      if (!staleDeployment.current) {
        notify(OFFLINE, undefined, key);
        setAttention(true);
        failedKeys.current.add(key);
      }
      paused.current.add(key);
      return;
    }
    // A read is not a save: a rejection the read just reconciled still explains what happened.
    if (failedKeys.current.size === 0) setAttention(false);
  }
  async function stepServer(key: string) {
    if (!mounted.current || staleDeployment.current || paused.current.has(key)) return;
    const doomed = pendingDelete.current.get(key);
    if (doomed) {
      const revAtSend = revs.current.get(key) ?? 0;
      try {
        const override = await e2eRemovalOverride();
        const result = override ?? (await removeCartLine(doomed));
        if (!result.ok && removalResultAction(result.code) === "rejected") {
          if (mounted.current) {
            notify(result.error, undefined, key);
            setAttention(true);
          }
          await recoverRejected(key, revAtSend, "remove");
          return;
        }
      } catch (error) {
        await onThrown(error, key, false, revAtSend);
        return;
      }
      pendingDelete.current.delete(key);
      confirmed.current.set(key, { qty: 0 });
      clearFailure(key);
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
          notify(OFFLINE, undefined, key);
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
      const revAtSend = revs.current.get(key) ?? 0;
      try {
        added = await addToCart(item.variantId, 1);
      } catch (error) {
        await onThrown(error, key, true, revAtSend);
        return;
      }
      if (!added.ok) {
        if (mounted.current) {
          notify(`${item.name}: ${added.error}`, undefined, key);
          setAttention(true);
        }
        if (added.code === "MAX_PER_ORDER") {
          showQty(key, 0);
          confirmed.current.set(key, { qty: 0 });
          if ((revs.current.get(key) ?? 0) > revAtSend) paused.current.delete(key);
          else paused.current.add(key);
        } else {
          await recoverRejected(key, revAtSend, "add");
        }
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
          if (mounted.current && !staleDeployment.current) {
            notify(`Couldn\u2019t add ${item.name}. Check your connection and try again.`, retryAt(item, intentQty(key)), key);
          }
        } else {
          showQty(key, 0);
          confirmed.current.set(key, { qty: 0 });
        }
        if (mounted.current) setAttention(true);
        paused.current.add(key);
        return;
      }
      addAccepted.current.delete(key);
      clearFailure(key);
      return;
    }
    const lineId = known.lineId;
    const liveTarget = intentQty(key);
    if (liveTarget === known.qty) return;
    if (liveTarget > known.qty) {
      let result: { ok: true } | { ok: false; error: string; code: string };
      const revAtSend = revs.current.get(key) ?? 0;
      try {
        result = await serverSetLineQty(lineId, known.qty + 1);
      } catch (error) {
        await onThrown(error, key, false, revAtSend);
        return;
      }
      if (!result.ok) {
        if (mounted.current) {
          notify(result.error, undefined, key);
          setAttention(true);
        }
        if (result.code === "MAX_PER_ORDER") {
          if (intentQty(key) > known.qty) showQty(key, known.qty);
          return;
        }
        await recoverRejected(key, revAtSend, "qty");
        return;
      }
      confirmed.current.set(key, { lineId, qty: known.qty + 1 });
      clearFailure(key);
      return;
    }
    let result: { ok: true } | { ok: false; error: string; code: string };
    const revAtSend = revs.current.get(key) ?? 0;
    try {
      result = await serverSetLineQty(lineId, liveTarget);
    } catch (error) {
      await onThrown(error, key, false, revAtSend);
      return;
    }
    if (!result.ok) {
      if (mounted.current) {
        notify(result.error, undefined, key);
        setAttention(true);
      }
      await recoverRejected(key, revAtSend, "qty");
      return;
    }
    confirmed.current.set(key, { lineId, qty: liveTarget });
    clearFailure(key);
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
          notify(STALE_PAGE);
        } else {
          notify(OFFLINE);
        }
        setAttention(true);
      } finally {
        if (!user) return;
        jobs.current = Math.max(0, jobs.current - 1);
        if (jobs.current === 0 && mounted.current) {
          setSyncing(false);
          setPendingKeys((keys) => (keys.size ? new Set() : keys));
        }
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
    notify(STALE_PAGE);
    if (mounted.current) setAttention(true);
    return true;
  }
  async function initialLoad() {
    const pulled = await pullServer("server-wins");
    if (!mounted.current) return;
    if (pulled === "failed") {
      setLoadFailed(true);
      if (!staleDeployment.current) {
        notify(OFFLINE);
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
      const previous = intentQty(key);
      // Nothing the server could add is never shown as added (#708 P1).
      if (delta > 0 && !item.variantId) {
        notify(`${item.name} can\u2019t be added online yet.`);
        return;
      }
      const next = stepCartQuantity(previous, delta, max);
      if (next === null || rejectStale()) return;
      noteGesture(key);
      bump(key, (previous === 0) !== (next === 0));
      put(item, next);
      markPending(key);
      // Optimistic, contextual confirmation: announced once, from the provider, not per trigger.
      if (mounted.current) {
        const total = linesRef.current.reduce((sum, line) => sum + line.quantity, 0);
        setAnnounce(
          next > previous
            ? `${item.name} added. ${total} in basket.`
            : next === 0
              ? `${item.name} removed. ${total} in basket.`
              : `${item.name} down to ${next}. ${total} in basket.`,
        );
      }
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
      markPending(key);
      void enqueue(drain, true);
    },
    remove(key) {
      const current = linesRef.current.find((line) => cartItemKey(line) === key);
      if (!current && !pendingDelete.current.has(key)) return;
      if (rejectStale()) return;
      noteGesture(key);
      bump(key, true);
      rememberFallback(key, current);
      const id = current?.serverLineId ?? confirmed.current.get(key)?.lineId;
      if (id) pendingDelete.current.set(key, id);
      else dropAfterAdd.current.add(key);
      publish(linesRef.current.filter((line) => cartItemKey(line) !== key));
      void enqueue(drain, true);
      const removed = current && removedLine(current);
      if (!removed) return;
      const now = undoClock();
      if (open) {
        // The open drawer is modal, so a page toast could not be tapped; Undo shows inside it.
        setPending(addPendingUndo(pendingUndoRef.current, removed, now));
      } else {
        undoToast(addPendingUndo([], removed, now), UNDO_MS);
      }
    },
  };
  /** Undo puts the line back with its quantity, then re-applies its swap choice once it has a server id. */
  function restoreRemoved(removed: RemovedLine) {
    if (rejectStale()) return;
    const key = cartItemKey(removed.item);
    const { quantity, swap } = restoreSteps(
      removed,
      linesRef.current.find((line) => cartItemKey(line) === key),
    );
    store.setQuantity(removed.item, quantity);
    if (!swap) return;
    void enqueue(async () => {
      const lineId =
        linesRef.current.find((line) => cartItemKey(line) === key)?.serverLineId ??
        confirmed.current.get(key)?.lineId;
      if (!lineId) return;
      const result = await setSwapRule(lineId, swap.swapRule, swap.substituteVariantId);
      if (!result.ok && mounted.current) notify(result.error);
      await pullServer("server-wins");
    }, true);
  }
  const refreshCart = () =>
    enqueue(async () => {
      const pulled = await pullServer("server-wins");
      if (pulled === "failed" && mounted.current) setLoadFailed(true);
      if (pulled === "failed" && mounted.current && !staleDeployment.current) {
        notify(OFFLINE);
        setAttention(true);
      }
      if (pulled !== "failed" && failedKeys.current.size === 0 && mounted.current) {
        setAttention(false);
        resolveNotice();
      }
    }, true);

  const refreshBridge = useRef(refreshCart);
  useEffect(() => {
    refreshBridge.current = refreshCart;
  });
  useEffect(() => bindCartRefresh(storeId, () => refreshBridge.current()), [storeId]);

  function reportCartFailure(failure: { error?: string; thrown?: unknown }) {
    if (!mounted.current) return;
    if (failure.thrown !== undefined && isStaleAction(failure.thrown)) {
      staleDeployment.current = true;
      notify(STALE_PAGE);
    } else {
      notify(failure.error ?? OFFLINE);
    }
    setAttention(true);
  }

  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.price, 0);
  const minimum = Math.max(0, minimumOrderCents);
  const gate = minimumOrderGate(subtotal, minimum);
  const needsChange = lines.some(
    (line) => line.available === false || (line.maxPerOrder !== undefined && line.quantity > line.maxPerOrder),
  );
  // Why checkout is not open yet, beside the link that still lets the shopper review the basket.
  const blockReason = needsChange ? "Remove or change the items marked below to check out." : gate.met ? null : gate.message;

  return (
    <Context.Provider
      value={{
        store,
        lines,
        count,
        subtotal,
        openCart,
        loading,
        syncing,
        attention,
        loadFailed,
        pendingKeys,
        announcement: announce,
        cartId,
        refreshCart,
        reportCartFailure,
      }}
    >
      {children}
      {/* The open drawer is modal, so the page's live region would be inert: it moves inside. */}
      {!open && <CartAnnouncement testId="cart-announce" />}
      <Sheet
        open={open}
        onClose={closeCart}
        title="Your basket"
        footer={
          lines.length ? (
            <div className={styles.summary}>
              <div className={styles.total}>
                <span>Subtotal</span>
                <strong>{money(subtotal)}</strong>
              </div>
              {minimum > 0 && (
                <progress
                  className={styles.progress}
                  max={minimum}
                  value={Math.min(minimum, subtotal)}
                  aria-label="Minimum order progress"
                />
              )}
              {blockReason ? (
                // The reason sits outside the link, so the label stays stable (#708 AC3).
                <p className={styles.gateReason} id="cart-gate-reason">{blockReason}</p>
              ) : minimum > 0 ? (
                <p className={styles.muted}>Minimum order reached</p>
              ) : null}
              {/* Reviewing the basket is always allowed; the basket page holds checkout until it is ready. */}
              <Link
                className={styles.primaryButton}
                href="/cart"
                onClick={closeCart}
                aria-describedby={blockReason ? "cart-gate-reason" : undefined}
              >
                Review basket & checkout
              </Link>
            </div>
          ) : undefined
        }
      >
        {open && <CartAnnouncement testId="cart-announce" />}
        <p className={styles.muted}>{storeName}</p>
        {open && <AssistantSlot label="Shop with AI" />}
        {(sheetNotice || attention) && (
          // Shown in the open modal, where the root toast can't be tapped (#708 AC3).
          <div className={styles.sheetError} role="alert">
            {sheetNotice?.message ?? "Some changes couldn\u2019t be saved. Check your connection, then try again."}
            {sheetNotice?.retry && (
              <button type="button" onClick={sheetNotice.retry}>
                Retry
              </button>
            )}
          </div>
        )}
        {pendingUndo.length > 0 && (
          <div className={styles.undoBar} role="status">
            <span>{undoMessage(pendingUndo)}</span>
            <button
              type="button"
              onClick={() => {
                const { entries } = livePendingUndo(pendingUndoRef.current, undoClock());
                setPending([]);
                entries.forEach((entry) => restoreRemoved(entry.removed));
              }}
            >
              Undo
            </button>
          </div>
        )}
        {!lines.length && loading ? (
          // Still reading the server cart: never a false "empty" (#708 P1).
          <div className={styles.loadingLines} role="status" aria-label="Loading your basket">
            <span />
            <span />
          </div>
        ) : !lines.length && loadFailed ? (
          <div className={styles.empty}>
            <CircleAlert size={40} aria-hidden />
            <h3>We couldn&rsquo;t load your basket</h3>
            <p>Check your connection, then try again.</p>
            <button type="button" className={styles.primaryButton} onClick={() => void refreshCart()}>
              Retry
            </button>
          </div>
        ) : !lines.length ? (
          <div className={styles.empty}>
            <ShoppingBag size={44} aria-hidden />
            <h3>Your basket is empty</h3>
            <p>Add something from the shelves to get started.</p>
            <Link className={styles.primaryButton} href="/categories" onClick={closeCart}>
              Browse aisles
            </Link>
          </div>
        ) : (
          <ul className={styles.lines}>
            {lines.map((line) => {
              const key = cartItemKey(line);
              const unavailable = line.available === false;
              const overLimit = !unavailable && line.maxPerOrder !== undefined && line.quantity > line.maxPerOrder;
              const issueId = `cart-line-issue-${line.serverLineId ?? line.listingId}`;
              return (
              <li
                className={styles.line}
                key={key}
                data-unavailable={unavailable || undefined}
                aria-busy={pendingKeys.has(key) || undefined}
                aria-describedby={unavailable || overLimit ? issueId : undefined}
              >
                <div className={`${styles.photo} sf-cart-photo`}>
                  <ProductImage
                    src={line.imageUrl}
                    name={line.name}
                    category={line.categorySlug}
                    sizes="80px"
                  />
                </div>
                <div className={styles.lineDetails}>
                  <h3>{line.name}</h3>
                  <p>
                    {money(line.price)}
                    {line.packLabel && ` / ${line.packLabel}`}
                    {pendingKeys.has(key) && <span className={styles.updating}>Updating…</span>}
                  </p>
                  <Link
                    className={styles.swap}
                    href="/cart"
                    onClick={closeCart}
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
                  {(unavailable || overLimit) && (
                    <p className={styles.lineIssue} id={issueId}>
                      <CircleAlert size={16} aria-hidden />
                      {unavailable
                        ? "No longer available. Remove it to check out."
                        : `Limit ${line.maxPerOrder} per order. Reduce it to check out.`}
                    </p>
                  )}
                  <div className={styles.lineActions}>
                    {/* Kept on unavailable lines too: only the increase stops, so one can still be taken away (#708 P1). */}
                    <QuickAddStepper item={line} />
                    {unavailable ? (
                      <button
                        type="button"
                        className={styles.removeButton}
                        aria-label={`Remove ${line.name} from basket`}
                        onClick={() => store.remove(key)}
                      >
                        <Trash2 size={18} aria-hidden />
                        Remove
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.iconButton}
                        aria-label={`Remove ${line.name} from basket`}
                        onClick={() => store.remove(key)}
                      >
                        <Trash2 size={18} />
                      </button>
                    )}
                  </div>
                  {unavailable && !!line.alternatives?.length && (
                    <div className={styles.alternatives}>
                      <p>Try instead</p>
                      <ul aria-label={`Instead of ${line.name}`}>
                        {line.alternatives.map((alt) => (
                          <li key={cartItemKey(alt)}>
                            <div className={`${styles.altPhoto} sf-cart-photo`}>
                              <ProductImage src={alt.imageUrl} name={alt.name} sizes="48px" />
                            </div>
                            <span>
                              {alt.name}
                              <small>{money(alt.price)}{alt.packLabel && ` / ${alt.packLabel}`}</small>
                            </span>
                            <QuickAddStepper item={alt} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </Sheet>
    </Context.Provider>
  );
}
/**
 * The one polite status for cart changes. The provider renders it on the page and
 * inside the open drawer; a modal sheet that adjusts quantities (quick view) renders
 * its own, because the page's region is inert while a modal is open.
 */
export function CartAnnouncement({ testId }: { testId?: string }) {
  const { announcement } = useCart();
  return (
    // A polite live region without role=status, so it never competes with a surface's own status text.
    <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid={testId}>
      {announcement}
    </div>
  );
}

export function CartTrigger({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const { count, openCart, syncing, attention, loading } = useCart();
  return (
    <CartTriggerView
      count={count}
      loading={loading}
      syncing={syncing}
      attention={attention}
      onOpen={openCart}
      className={className}
    >
      {children}
    </CartTriggerView>
  );
}
