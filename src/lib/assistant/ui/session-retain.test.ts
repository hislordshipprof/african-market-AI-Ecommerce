import { describe, expect, it } from "vitest";
import { retainAction } from "./session-retain";

const store = { storeId: "store-a", accountId: null, cartId: "cart-1" };

describe("assistant chat session", () => {
  it("keeps the transcript while the next page is still loading its cart", () => {
    expect(retainAction(store, { ...store, cartId: null, loading: true })).toBe("keep");
  });

  it("drops the transcript when the loaded cart is a different one", () => {
    expect(retainAction(store, { ...store, cartId: "cart-2", loading: false })).toBe("reset");
  });

  it("adopts the first cart id and a guest claim of that same cart", () => {
    expect(retainAction(
      { storeId: "store-a", accountId: null, cartId: null },
      { storeId: "store-a", accountId: null, cartId: "cart-1", loading: false },
    )).toBe("adopt");
    expect(retainAction(store, { ...store, accountId: "user-1", loading: false })).toBe("adopt");
  });
});