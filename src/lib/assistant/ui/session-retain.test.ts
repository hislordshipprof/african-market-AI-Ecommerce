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

  it("resets as soon as the account changes, including while the next cart is loading", () => {
    const signedIn = { storeId: "store-a", accountId: "user-a", cartId: "cart-1" };
    expect(retainAction(signedIn, { ...signedIn, accountId: "user-b", loading: false })).toBe("reset");
    expect(retainAction(signedIn, { ...signedIn, accountId: null, cartId: null, loading: true })).toBe("reset");
  });

  it("keeps a guest transcript only for a claim of that same cart", () => {
    expect(retainAction(store, { ...store, accountId: "user-1", cartId: null, loading: true })).toBe("keep");
    expect(retainAction(store, { ...store, accountId: "user-1", cartId: "cart-2", loading: false })).toBe("reset");
  });

  it("adopts the first cart id and a guest claim of that same cart", () => {
    expect(retainAction(
      { storeId: "store-a", accountId: null, cartId: null },
      { storeId: "store-a", accountId: null, cartId: "cart-1", loading: false },
    )).toBe("adopt");
    expect(retainAction(store, { ...store, accountId: "user-1", loading: false })).toBe("adopt");
  });
});