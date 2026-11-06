import { afterEach, describe, expect, it, vi } from "vitest";
import { cartItemKey, createCartStore } from "./cart-store";

const item = { listingId: "rice", name: "Rice", price: 1299 };
afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return values;
}
describe("storefront cart", () => {
  it("persists and restores stable snapshots", () => {
    storage();
    const cart = createCartStore("a");
    cart.setQuantity(item, 2);
    expect(cart.snapshot()).toBe(cart.snapshot());
    expect(createCartStore("a").snapshot()).toEqual([{ ...item, quantity: 2 }]);
  });
  it("rejects malformed persisted data", () => {
    const values = storage();
    values.set(
      "storefront-cart:a",
      JSON.stringify([{ ...item, quantity: "2" }]),
    );
    expect(createCartStore("a").snapshot()).toEqual([]);
    values.set("storefront-cart:a", "invalid json");
    expect(createCartStore("a").snapshot()).toEqual([]);
  });
  it("separates stores and variants", () => {
    storage();
    const cart = createCartStore("a");
    cart.setQuantity(item, 1);
    cart.setQuantity({ ...item, variantId: "large" }, 2);
    expect(cart.snapshot()).toHaveLength(2);
    expect(createCartStore("b").snapshot()).toEqual([]);
  });
  it("steps one from the latest quantity and stops at the ceiling", () => {
    storage();
    const cart = createCartStore("a");
    cart.adjust(item, 1);
    cart.adjust(item, 1);
    expect(cart.snapshot()[0]?.quantity).toBe(2);
    cart.adjust(item, 1, 2);
    expect(cart.snapshot()[0]?.quantity).toBe(2);
    cart.adjust(item, -1, 0);
    expect(cart.snapshot()[0]?.quantity).toBe(1);
    cart.adjust(item, -1, 0);
    cart.adjust(item, -1, 0);
    expect(cart.snapshot()).toEqual([]);
  });
  it("caps quantities and removes zero, negative and explicit removals", () => {
    storage();
    const cart = createCartStore("a");
    cart.setQuantity(item, 200);
    expect(cart.snapshot()[0].quantity).toBe(99);
    cart.setQuantity(item, 0);
    expect(cart.snapshot()).toEqual([]);
    cart.setQuantity(item, 2);
    cart.setQuantity(item, -1);
    expect(cart.snapshot()).toEqual([]);
    cart.setQuantity(item, 2);
    cart.remove(cartItemKey(item));
    expect(cart.snapshot()).toEqual([]);
  });
  it("keeps working when storage is unavailable", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("blocked");
      },
    });
    const cart = createCartStore("a");
    cart.setQuantity(item, 2);
    expect(cart.snapshot()[0].quantity).toBe(2);
  });
  it("rejects unsafe prices and duplicate saved lines", () => {
    const values = storage();
    values.set(
      "storefront-cart:a",
      JSON.stringify([{ ...item, price: -1, quantity: 1 }]),
    );
    expect(createCartStore("a").snapshot()).toEqual([]);
    values.set(
      "storefront-cart:a",
      JSON.stringify([
        { ...item, quantity: 1 },
        { ...item, quantity: 2 },
      ]),
    );
    expect(createCartStore("a").snapshot()).toEqual([]);
  });
  it("drops an unsafe saved image while restoring the cart", () => {
    const imageUrl = "/images/../secret.jpg";
    const values = storage();
    values.set(
      "storefront-cart:a",
      JSON.stringify([{ ...item, imageUrl, quantity: 2 }]),
    );
    const restored = createCartStore("a").snapshot();
    expect(restored).toHaveLength(1);
    expect(restored[0].quantity).toBe(2);
    expect(restored[0].imageUrl).toBeUndefined();
  });
  it("retains a permitted local photo", () => {
    const imageUrl = "/images/products/rice.webp";
    storage();
    const cart = createCartStore("a");
    cart.setQuantity({ ...item, imageUrl }, 1);
    expect(createCartStore("a").snapshot()[0].imageUrl).toBe(imageUrl);
  });
});
