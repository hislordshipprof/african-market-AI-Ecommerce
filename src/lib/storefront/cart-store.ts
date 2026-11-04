import { stepCartQuantity } from "./cart-quantity";

export type SwapRuleValue = "exact_only" | "store_suggests" | "named_substitute";

export interface CartItem {
  listingId: string;
  variantId?: string;
  name: string;
  /** Unit price in cents. */
  price: number;
  imageUrl?: string;
  packLabel?: string;
}
export interface CartLine extends CartItem {
  quantity: number;
  serverLineId?: string;
  swapRule?: SwapRuleValue;
  substituteVariantId?: string | null;
}
export interface CartStore {
  snapshot: () => readonly CartLine[];
  subscribe: (listener: () => void) => () => void;
  setQuantity: (item: CartItem, quantity: number) => void;
  /** One stepper step from the latest quantity. No-op when the step changes nothing. */
  adjust: (item: CartItem, delta: 1 | -1, max?: number) => void;
  remove: (key: string) => void;
}
export const cartItemKey = (item: Pick<CartItem, "listingId" | "variantId">) =>
  JSON.stringify([item.listingId, item.variantId ?? null]);
export const EMPTY_CART: readonly CartLine[] = Object.freeze([]);
function validItem(value: unknown): value is CartItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.listingId === "string" &&
    item.listingId.length > 0 &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    Number.isSafeInteger(item.price) &&
    (item.price as number) >= 0 &&
    ["variantId", "packLabel"].every(
      (key) => item[key] === undefined || typeof item[key] === "string",
    )
  );
}
function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    /^\/images\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp|avif|gif)$/i.test(
      value,
    )
  )
    return value;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["images.unsplash.com", "upload.wikimedia.org"].includes(url.hostname)
    )
      return undefined;
    const path = decodeURIComponent(url.pathname);
    if (
      url.hostname === "images.unsplash.com" &&
      /^\/photo-[a-zA-Z0-9-]+$/.test(path)
    )
      return url.href;
    if (
      url.hostname === "upload.wikimedia.org" &&
      /\.(?:jpe?g|png|webp|avif|gif)$/i.test(path)
    )
      return url.href;
  } catch {
    /* Invalid saved images use the initial fallback. */
  }
  return undefined;
}
function sanitizeItem(item: CartItem): CartItem {
  return {
    listingId: item.listingId,
    variantId: item.variantId,
    name: item.name,
    price: item.price,
    packLabel: item.packLabel,
    imageUrl: safeImageUrl(item.imageUrl),
  };
}
function decode(raw: string | null): readonly CartLine[] {
  try {
    if (!raw) return EMPTY_CART;
    const data: unknown = JSON.parse(raw);
    if (
      !Array.isArray(data) ||
      data.length > 500 ||
      !data.every((line) => {
        const quantity = line?.quantity;
        return (
          validItem(line) &&
          Number.isInteger(quantity) &&
          quantity > 0 &&
          quantity <= 99
        );
      })
    )
      return EMPTY_CART;
    const keys = new Set(data.map(cartItemKey));
    return keys.size === data.length
      ? data.map((line) => ({ ...sanitizeItem(line), quantity: line.quantity }))
      : EMPTY_CART;
  } catch {
    return EMPTY_CART;
  }
}
export function createCartStore(storeId: string): CartStore {
  const storageKey = `storefront-cart:${storeId}`;
  const listeners = new Set<() => void>();
  const read = () => {
    try {
      return typeof window === "undefined"
        ? EMPTY_CART
        : decode(window.localStorage.getItem(storageKey));
    } catch {
      return EMPTY_CART;
    }
  };
  let lines = read();
  const notify = () => listeners.forEach((listener) => listener());
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    const next = event.key === null ? EMPTY_CART : decode(event.newValue);
    if (JSON.stringify(next) !== JSON.stringify(lines)) {
      lines = next;
      notify();
    }
  };
  const commit = (next: readonly CartLine[]) => {
    lines = next;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(lines));
    } catch {
      /* Memory-only carts work when storage is blocked. */
    }
    notify();
  };
  const store: CartStore = {
    snapshot: () => lines,
    subscribe(listener) {
      if (listeners.size === 0 && typeof window !== "undefined") {
        window.addEventListener("storage", onStorage);
        lines = read();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && typeof window !== "undefined")
          window.removeEventListener("storage", onStorage);
      };
    },
    setQuantity(item, quantity) {
      if (!validItem(item) || !Number.isFinite(quantity)) return;
      const qty = Math.min(99, Math.max(0, Math.floor(quantity)));
      const key = cartItemKey(item);
      const next = lines.filter((line) => cartItemKey(line) !== key);
      if (qty > 0) {
        const index = lines.findIndex((line) => cartItemKey(line) === key);
        next.splice(index < 0 ? next.length : index, 0, {
          ...sanitizeItem(item),
          quantity: qty,
        });
      }
      commit(next);
    },
    adjust(item, delta, max) {
      const current =
        lines.find((line) => cartItemKey(line) === cartItemKey(item))?.quantity ?? 0;
      const next = stepCartQuantity(current, delta, max);
      if (next === null) return;
      store.setQuantity(item, next);
    },
    remove(key) {
      commit(lines.filter((line) => cartItemKey(line) !== key));
    },
  };
  return store;
}
