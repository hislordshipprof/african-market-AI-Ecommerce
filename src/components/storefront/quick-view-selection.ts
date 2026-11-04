import type { CartItem } from "@/lib/storefront/cart-store";
import { orderPacks } from "@/lib/storefront/pack-order";
import type { StockBadge } from "@/lib/storefront/stock-badge";

export type QuickViewPack = {
  id: string;
  label: string;
  price: number;
  weightG?: number;
};

export type QuickViewDetailState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "loaded";
      packs: readonly QuickViewPack[];
      basePrice: number;
      badge: StockBadge;
    };

export type QuickViewSelectionInput = {
  listingId: string;
  name: string;
  imageUrl?: string;
  listPacks: readonly QuickViewPack[];
  listBasePrice: number;
  /** Cheapest pack, or the pack the category `?pack=` filter already chose. */
  defaultVariantId?: string;
  /**
   * Set when the Customer presses a chip, including a press on the pack that
   * was already the default. Absent means they have not chosen.
   */
  chosenVariantId?: string;
  detail: QuickViewDetailState;
};

export type QuickViewSelection = {
  options: QuickViewPack[];
  selectedId?: string;
  price: number;
  weightG?: number;
  statusMessage?: string;
  addDisabled: boolean;
  /**
   * True only for a listing that had no packs on the shelf and still has none
   * after details load. The add control then builds an in-memory line with no
   * variant id. The cart provider does not call the server for that line.
   */
  eachOnly: boolean;
  heading: "Loading pack sizes…" | "Details unavailable" | "Add to your basket";
  cartItem: CartItem;
};

function cartItem(
  input: QuickViewSelectionInput,
  pack: QuickViewPack | undefined,
  price: number,
  packLabel: string,
): CartItem {
  return {
    listingId: input.listingId,
    variantId: pack?.id,
    name: input.name,
    price,
    imageUrl: input.imageUrl,
    packLabel,
  };
}

function fromPack(pack: QuickViewPack | undefined, fallbackPrice: number) {
  return {
    price: pack ? pack.price : fallbackPrice,
    weightG: pack?.weightG,
    label: pack?.label ?? "Each",
  };
}

export function selectQuickViewPack(input: QuickViewSelectionInput): QuickViewSelection {
  const listPacks = orderPacks(input.listPacks);
  const explicit = input.chosenVariantId !== undefined;
  const chosenId = input.chosenVariantId;

  const listSelected = explicit
    ? listPacks.find((pack) => pack.id === chosenId)
    : listPacks.find((pack) => pack.id === input.defaultVariantId) ?? listPacks[0];

  if (input.detail.status === "loading" || input.detail.status === "error") {
    const shown = fromPack(listSelected, input.listBasePrice);
    return {
      options: listPacks,
      selectedId: listSelected?.id,
      price: shown.price,
      weightG: shown.weightG,
      statusMessage:
        input.detail.status === "error"
          ? "Pack details could not load. Open the product page to try again."
          : undefined,
      addDisabled: true,
      eachOnly: false,
      heading: input.detail.status === "error" ? "Details unavailable" : "Loading pack sizes…",
      cartItem: cartItem(input, listSelected, shown.price, shown.label),
    };
  }

  const detailPacks = orderPacks(input.detail.packs);
  const askStore = input.detail.badge === "ask-store";
  const basePrice = input.detail.basePrice;

  if (listPacks.length === 0 && detailPacks.length === 0) {
    return {
      options: [],
      selectedId: undefined,
      price: basePrice,
      weightG: undefined,
      addDisabled: askStore,
      eachOnly: true,
      heading: "Add to your basket",
      cartItem: cartItem(input, undefined, basePrice, "Each"),
    };
  }

  if (detailPacks.length === 0) {
    return {
      options: [],
      selectedId: undefined,
      price: basePrice,
      weightG: undefined,
      statusMessage: "Pack sizes have changed. Open the product page to choose.",
      addDisabled: true,
      eachOnly: false,
      heading: "Add to your basket",
      cartItem: cartItem(input, undefined, basePrice, "Unavailable"),
    };
  }

  if (explicit) {
    const match = detailPacks.find((pack) => pack.id === chosenId);
    if (!match) {
      const label = listPacks.find((pack) => pack.id === chosenId)?.label ?? "selected";
      return {
        options: detailPacks,
        selectedId: undefined,
        price: basePrice,
        weightG: undefined,
        statusMessage: `The ${label} pack is no longer available. Choose another pack size.`,
        addDisabled: true,
        eachOnly: false,
        heading: "Add to your basket",
        cartItem: cartItem(input, undefined, basePrice, label),
      };
    }
    return {
      options: detailPacks,
      selectedId: match.id,
      price: match.price,
      weightG: match.weightG,
      addDisabled: askStore,
      eachOnly: false,
      heading: "Add to your basket",
      cartItem: cartItem(input, match, match.price, match.label),
    };
  }

  const fallback =
    detailPacks.find((pack) => pack.id === input.defaultVariantId) ?? detailPacks[0];
  return {
    options: detailPacks,
    selectedId: fallback.id,
    price: fallback.price,
    weightG: fallback.weightG,
    addDisabled: askStore,
    eachOnly: false,
    heading: "Add to your basket",
    cartItem: cartItem(input, fallback, fallback.price, fallback.label),
  };
}
