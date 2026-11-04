import { describe, expect, it } from "vitest";
import {
  selectQuickViewPack,
  type QuickViewPack,
  type QuickViewSelectionInput,
} from "./quick-view-selection";

const oz: QuickViewPack = { id: "v-8oz", label: "8 oz", price: 1099, weightG: 227 };
const one: QuickViewPack = { id: "v-1lb", label: "1 lb", price: 1899, weightG: 454 };
const five: QuickViewPack = { id: "v-5lb", label: "5 lb bag", price: 7999, weightG: 2268 };
const listOrder = [one, five, oz];

function input(overrides: Partial<QuickViewSelectionInput> = {}): QuickViewSelectionInput {
  return {
    listingId: "mn_egusi",
    name: "Egusi",
    imageUrl: "/images/egusi.jpg",
    listPacks: listOrder,
    listBasePrice: 1099,
    defaultVariantId: "v-8oz",
    detail: { status: "loading" },
    ...overrides,
  };
}

describe("selectQuickViewPack", () => {
  it("a pack chosen before details load stays selected when they arrive in another order", () => {
    const before = selectQuickViewPack(input({ chosenVariantId: "v-5lb" }));
    expect(before.heading).toBe("Loading pack sizes…");
    expect(before.addDisabled).toBe(true);
    expect(before.options.map((pack) => pack.label)).toEqual(["8 oz", "1 lb", "5 lb bag"]);
    expect(before.selectedId).toBe("v-5lb");

    const after = selectQuickViewPack(
      input({
        chosenVariantId: "v-5lb",
        detail: {
          status: "loaded",
          packs: [five, oz, one],
          basePrice: 1099,
          badge: "in-stock",
        },
      }),
    );
    expect(after.options.map((pack) => pack.id)).toEqual(["v-8oz", "v-1lb", "v-5lb"]);
    expect(after.selectedId).toBe("v-5lb");
    expect(after.options.filter((pack) => pack.id === after.selectedId)).toHaveLength(1);
    expect(after.price).toBe(7999);
    expect(after.weightG).toBe(2268);
    expect(after.statusMessage).toBeUndefined();
    expect(after.addDisabled).toBe(false);
  });

  it("last click wins before details load", () => {
    const result = selectQuickViewPack(input({ chosenVariantId: "v-1lb" }));
    expect(result.selectedId).toBe("v-1lb");
    expect(result.options.filter((pack) => pack.id === result.selectedId)).toHaveLength(1);
    expect(result.addDisabled).toBe(true);
  });

  it("a chosen pack missing from details is reported and nothing is selected", () => {
    const result = selectQuickViewPack(
      input({
        chosenVariantId: "v-1lb",
        detail: { status: "loaded", packs: [oz, five], basePrice: 1099, badge: "in-stock" },
      }),
    );
    expect(result.selectedId).toBeUndefined();
    expect(result.options.every((pack) => pack.id !== result.selectedId)).toBe(true);
    expect(result.statusMessage).toBe(
      "The 1 lb pack is no longer available. Choose another pack size.",
    );
    expect(result.addDisabled).toBe(true);
    expect(result.cartItem.variantId).toBeUndefined();
    expect(result.cartItem.packLabel).not.toBe("Each");
    expect(result.options[0]?.id).toBe("v-8oz");
  });

  it("add is disabled until the Customer picks again, then uses the new pick", () => {
    const gone = selectQuickViewPack(
      input({
        chosenVariantId: "v-1lb",
        detail: { status: "loaded", packs: [oz, five], basePrice: 1099, badge: "in-stock" },
      }),
    );
    expect(gone.addDisabled).toBe(true);
    const again = selectQuickViewPack(
      input({
        chosenVariantId: "v-8oz",
        detail: { status: "loaded", packs: [oz, five], basePrice: 1099, badge: "in-stock" },
      }),
    );
    expect(again.addDisabled).toBe(false);
    expect(again.selectedId).toBe("v-8oz");
    expect(again.cartItem).toMatchObject({
      listingId: "mn_egusi",
      variantId: "v-8oz",
      price: 1099,
      packLabel: "8 oz",
    });
    expect(again.cartItem.variantId).not.toBe("v-1lb");
  });

  it("a missing default falls back to the first detail pack without a message", () => {
    const result = selectQuickViewPack(
      input({
        defaultVariantId: "gone",
        detail: { status: "loaded", packs: [five, oz, one], basePrice: 50, badge: "in-stock" },
      }),
    );
    expect(result.selectedId).toBe("v-8oz");
    expect(result.statusMessage).toBeUndefined();
    expect(result.addDisabled).toBe(false);
    expect(result.price).toBe(1099);
  });

  it("a filter-chosen default stays pressed after load", () => {
    const result = selectQuickViewPack(
      input({
        defaultVariantId: "v-5lb",
        detail: { status: "loaded", packs: [oz, one, five], basePrice: 1099, badge: "in-stock" },
      }),
    );
    expect(result.selectedId).toBe("v-5lb");
    expect(result.price).toBe(7999);
    expect(result.statusMessage).toBeUndefined();
  });

  it("the cart item uses the chosen id with the detail label and price", () => {
    const detailFive: QuickViewPack = { id: "v-5lb", label: "5 lb sack", price: 0, weightG: 2268 };
    const result = selectQuickViewPack(
      input({
        chosenVariantId: "v-5lb",
        detail: {
          status: "loaded",
          packs: [detailFive, { ...one, price: 100 }],
          basePrice: 1099,
          badge: "in-stock",
        },
      }),
    );
    expect(result.selectedId).toBe("v-5lb");
    expect(result.price).toBe(0);
    expect(result.cartItem).toMatchObject({
      variantId: "v-5lb",
      packLabel: "5 lb sack",
      price: 0,
    });
    expect(result.options.map((pack) => pack.id)).toEqual(["v-5lb", "v-1lb"]);
  });

  it("new packs, zero packs, one pack, no variants, twelve packs", () => {
    const added = selectQuickViewPack(
      input({
        chosenVariantId: "v-1lb",
        detail: {
          status: "loaded",
          packs: [five, { id: "v-new", label: "2 lb", price: 1500, weightG: 900 }, oz, one],
          basePrice: 1099,
          badge: "in-stock",
        },
      }),
    );
    expect(added.options.map((pack) => pack.id)).toEqual(["v-8oz", "v-new", "v-1lb", "v-5lb"]);
    expect(added.selectedId).toBe("v-1lb");

    const cleared = selectQuickViewPack(
      input({
        chosenVariantId: "v-1lb",
        detail: { status: "loaded", packs: [], basePrice: 1099, badge: "in-stock" },
      }),
    );
    expect(cleared.options).toEqual([]);
    expect(cleared.selectedId).toBeUndefined();
    expect(cleared.statusMessage).toBe("Pack sizes have changed. Open the product page to choose.");
    expect(cleared.addDisabled).toBe(true);
    expect(cleared.eachOnly).toBe(false);
    expect(cleared.cartItem.packLabel).not.toBe("Each");

    const only = selectQuickViewPack(
      input({
        listPacks: [oz],
        defaultVariantId: "v-8oz",
        detail: { status: "loaded", packs: [oz], basePrice: 1099, badge: "in-stock" },
      }),
    );
    expect(only.selectedId).toBe("v-8oz");
    expect(only.statusMessage).toBeUndefined();
    expect(only.options).toHaveLength(1);

    const each = selectQuickViewPack(
      input({
        listPacks: [],
        listBasePrice: 400,
        defaultVariantId: undefined,
        detail: { status: "loaded", packs: [], basePrice: 400, badge: "in-stock" },
      }),
    );
    expect(each.options).toEqual([]);
    expect(each.eachOnly).toBe(true);
    expect(each.addDisabled).toBe(false);
    expect(each.cartItem.variantId).toBeUndefined();
    expect(each.cartItem.packLabel).toBe("Each");
    expect(each.cartItem.price).toBe(400);
    expect(each.statusMessage).toBeUndefined();

    const many = Array.from({ length: 12 }, (_, index) => ({
      id: `p${String(11 - index).padStart(2, "0")}`,
      label: `Pack ${index}`,
      price: (index + 1) * 100,
      weightG: 10,
    }));
    const dozen = selectQuickViewPack(
      input({
        listPacks: many,
        defaultVariantId: "p00",
        chosenVariantId: "p05",
        detail: { status: "loaded", packs: [...many].reverse(), basePrice: 100, badge: "in-stock" },
      }),
    );
    expect(dozen.options.map((pack) => pack.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `p${String(11 - index).padStart(2, "0")}`),
    );
    expect(dozen.selectedId).toBe("p05");
    expect(dozen.options.filter((pack) => pack.id === dozen.selectedId)).toHaveLength(1);
  });

  it("a failed detail load disables add without reporting a vanished pack", () => {
    const result = selectQuickViewPack(input({ chosenVariantId: "v-5lb", detail: { status: "error" } }));
    expect(result.addDisabled).toBe(true);
    expect(result.statusMessage).toBe("Pack details could not load. Open the product page to try again.");
    expect(result.statusMessage).not.toContain("no longer available");
    expect(result.selectedId).toBe("v-5lb");
    expect(result.heading).toBe("Details unavailable");
  });

  it("empty detail distinguishes vanished pack sets from genuine Each", () => {
    const untouched = selectQuickViewPack(
      input({
        detail: { status: "loaded", packs: [], basePrice: 1099, badge: "in-stock" },
      }),
    );
    expect(untouched.statusMessage).toBe("Pack sizes have changed. Open the product page to choose.");
    expect(untouched.selectedId).toBeUndefined();
    expect(untouched.addDisabled).toBe(true);
    expect(untouched.eachOnly).toBe(false);

    const gained = selectQuickViewPack(
      input({
        listPacks: [],
        defaultVariantId: undefined,
        detail: { status: "loaded", packs: [five, oz], basePrice: 400, badge: "in-stock" },
      }),
    );
    expect(gained.selectedId).toBe("v-8oz");
    expect(gained.cartItem.variantId).toBe("v-8oz");
    expect(gained.eachOnly).toBe(false);
    expect(gained.statusMessage).toBeUndefined();
  });

  it("explicit default choice and same-label replacement are not silent fallbacks", () => {
    const clickedDefault = selectQuickViewPack(
      input({
        chosenVariantId: "v-8oz",
        detail: { status: "loaded", packs: [one, five], basePrice: 1099, badge: "in-stock" },
      }),
    );
    expect(clickedDefault.selectedId).toBeUndefined();
    expect(clickedDefault.statusMessage).toBe(
      "The 8 oz pack is no longer available. Choose another pack size.",
    );
    expect(clickedDefault.cartItem.variantId).toBeUndefined();

    const replaced = selectQuickViewPack(
      input({
        chosenVariantId: "v-1lb",
        detail: {
          status: "loaded",
          packs: [{ id: "v-1lb-new", label: "1 lb", price: 1899, weightG: 454 }, oz],
          basePrice: 1099,
          badge: "in-stock",
        },
      }),
    );
    expect(replaced.selectedId).toBeUndefined();
    expect(replaced.options.map((pack) => pack.id)).toEqual(["v-8oz", "v-1lb-new"]);
    expect(replaced.statusMessage).toBe(
      "The 1 lb pack is no longer available. Choose another pack size.",
    );
  });

  it("retained ID uses detail label price and weight after a price-rank change", () => {
    const result = selectQuickViewPack(
      input({
        chosenVariantId: "v-1lb",
        detail: {
          status: "loaded",
          packs: [
            { id: "v-1lb", label: "1 pound", price: 5000, weightG: 500 },
            oz,
            five,
          ],
          basePrice: 1099,
          badge: "limited",
        },
      }),
    );
    expect(result.selectedId).toBe("v-1lb");
    expect(result.options.map((pack) => pack.id)).toEqual(["v-8oz", "v-1lb", "v-5lb"]);
    expect(result.price).toBe(5000);
    expect(result.weightG).toBe(500);
    expect(result.cartItem).toMatchObject({ variantId: "v-1lb", packLabel: "1 pound", price: 5000 });
  });

  it("loading, failure and ask-store keep a valid choice but disable add", () => {
    const loading = selectQuickViewPack(input({ chosenVariantId: "v-5lb" }));
    expect(loading.addDisabled).toBe(true);
    expect(loading.cartItem.variantId).toBe("v-5lb");
    expect(loading.statusMessage).toBeUndefined();

    const ask = selectQuickViewPack(
      input({
        chosenVariantId: "v-5lb",
        detail: { status: "loaded", packs: [oz, one, five], basePrice: 1099, badge: "ask-store" },
      }),
    );
    expect(ask.selectedId).toBe("v-5lb");
    expect(ask.addDisabled).toBe(true);
    expect(ask.statusMessage).toBeUndefined();
    expect(ask.cartItem.variantId).toBe("v-5lb");
  });
});
