import { describe, expect, it } from "vitest";
import { addPendingUndo, livePendingUndo, removedLine, restoreSteps, undoMessage } from "./cart-undo";
import type { CartLine } from "./cart-store";

const garri: CartLine = {
  listingId: "l1",
  variantId: "v1",
  name: "Yellow Garri",
  price: 699,
  packLabel: "1 lb",
  quantity: 4,
  serverLineId: "line-1",
  swapRule: "store_suggests",
  substituteVariantId: null,
};

describe("cart undo", () => {
  it("restores the removed quantity and the swap choice", () => {
    const removed = removedLine(garri)!;
    expect(restoreSteps(removed, undefined)).toEqual({
      quantity: 4,
      swap: { swapRule: "store_suggests", substituteVariantId: null },
    });
  });

  it("keeps a named substitute with its variant", () => {
    const removed = removedLine({ ...garri, swapRule: "named_substitute", substituteVariantId: "v9" })!;
    expect(restoreSteps(removed, undefined).swap).toEqual({
      swapRule: "named_substitute",
      substituteVariantId: "v9",
    });
  });

  it("needs no swap change for the default exact-item rule", () => {
    expect(restoreSteps(removedLine({ ...garri, swapRule: "exact_only" })!, undefined).swap).toBeNull();
    expect(restoreSteps(removedLine({ ...garri, swapRule: undefined })!, undefined).swap).toBeNull();
  });

  it("does not lower a line the shopper added back before tapping Undo", () => {
    const removed = removedLine(garri)!;
    expect(restoreSteps(removed, { ...garri, quantity: 1, swapRule: undefined }).quantity).toBe(4);
    expect(restoreSteps(removed, { ...garri, quantity: 6, swapRule: undefined }).quantity).toBe(6);
  });

  it("skips the swap call when the line already carries that choice", () => {
    const removed = removedLine(garri)!;
    expect(restoreSteps(removed, { ...garri, quantity: 4 }).swap).toBeNull();
  });

  it("has nothing to undo for an empty line", () => {
    expect(removedLine({ ...garri, quantity: 0 })).toBeNull();
  });
});

describe("pending undo", () => {
  const okra = removedLine({ ...garri, listingId: "l2", variantId: "v2", name: "Okra" })!;
  const garriRemoved = removedLine(garri)!;

  it("keeps the first removal undoable when a second line is removed", () => {
    const pending = addPendingUndo(addPendingUndo([], garriRemoved, 0), okra, 2000);
    const live = livePendingUndo(pending, 3000);
    expect(live.entries.map((entry) => entry.removed.item.name)).toEqual(["Yellow Garri", "Okra"]);
    expect(undoMessage(live.entries)).toBe("Removed 2 items.");
  });

  it("hands the time left to the toast when the drawer closes", () => {
    const pending = addPendingUndo(addPendingUndo([], garriRemoved, 0), okra, 2000);
    expect(livePendingUndo(pending, 3000).remainingMs).toBe(5000);
    expect(undoMessage(livePendingUndo(pending, 3000).entries.slice(0, 1))).toBe("Removed Yellow Garri.");
  });

  it("drops a removal once its 6 seconds are up", () => {
    const pending = addPendingUndo(addPendingUndo([], garriRemoved, 0), okra, 2000);
    const live = livePendingUndo(pending, 6500);
    expect(live.entries.map((entry) => entry.removed.item.name)).toEqual(["Okra"]);
    expect(livePendingUndo(pending, 8000).entries).toEqual([]);
  });

  it("keeps only the latest removal of the same line", () => {
    const again = { ...garriRemoved, quantity: 1 };
    const pending = addPendingUndo(addPendingUndo([], garriRemoved, 0), again, 1000);
    expect(livePendingUndo(pending, 1500).entries.map((entry) => entry.removed.quantity)).toEqual([1]);
  });
});
