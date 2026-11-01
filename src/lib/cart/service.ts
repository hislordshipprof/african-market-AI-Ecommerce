import { storeScoped, storeScopedTransaction, lockCartLineByVariant } from "../db";
import { catalogFor } from "../storefront/catalog";
import type { SwapRuleValue } from "../storefront/cart-store";

export type { SwapRuleValue };
const VALID_SWAP_RULES: readonly SwapRuleValue[] = [
  "exact_only",
  "store_suggests",
  "named_substitute",
];

export interface CartWithLines {
  id: string;
  storeId: string;
  lines: CartLineView[];
  subtotalCents: number;
}

export interface CartLineView {
  id: string;
  variantId: string;
  qty: number;
  swapRule: SwapRuleValue;
  substituteVariantId: string | null;
  imageUrl: string | undefined;
  variant: {
    id: string;
    label: string;
    price: number;
    weightG: number;
    listing: {
      id: string;
      customName: string | null;
      maxPerOrder: number | null;
      masterProduct: { name: string; categoryId: string | null } | null;
    };
  };
}

export interface MinimumOrderResult {
  allowed: boolean;
  minimumCents: number;
  currentCents: number;
}

export class CartError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "MAX_PER_ORDER"
      | "VARIANT_STORE_MISMATCH"
      | "INVALID_SWAP_RULE"
      | "INVALID_SUBSTITUTE"
      | "CART_NOT_FOUND",
  ) {
    super(message);
    this.name = "CartError";
  }
}

export async function getOrCreateCart(
  storeId: string,
  cartId: string | null,
  userId: string | null,
): Promise<string> {
  const scoped = storeScoped(storeId);

  if (cartId) {
    const existing = await scoped.cart.findUnique({ where: { id: cartId } });
    if (existing) return existing.id;
  }

  const cart = await scoped.cart.create({
    data: {
      storeId,
      userId,
      source: "manual",
    },
  });
  return cart.id;
}

export async function addLine(
  storeId: string,
  cartId: string,
  variantId: string,
  qty: number,
): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    const variant = await tx.listingVariant.findUnique({
      where: { id: variantId },
      include: { listing: true },
    });
    if (!variant || variant.listing.storeId !== storeId) {
      throw new CartError(
        "Variant does not belong to this store",
        "VARIANT_STORE_MISMATCH",
      );
    }

    const maxPerOrder = variant.listing.maxPerOrder ?? 99;

    const existing = await lockCartLineByVariant(tx, cartId, variantId);
    const totalQty = (existing?.qty ?? 0) + qty;

    if (totalQty > maxPerOrder) {
      throw new CartError(
        `Maximum ${maxPerOrder} per order for this item`,
        "MAX_PER_ORDER",
      );
    }

    if (existing) {
      await tx.cartLine.update({
        where: { id: existing.id },
        data: { qty: totalQty },
      });
    } else {
      await tx.cartLine.create({
        data: {
          storeId,
          cartId,
          variantId,
          qty: Math.min(qty, maxPerOrder),
          swapRule: "exact_only",
        },
      });
    }
  });
}

export async function updateLineQty(
  storeId: string,
  cartId: string,
  lineId: string,
  qty: number,
): Promise<void> {
  if (qty <= 0) {
    await removeLine(storeId, cartId, lineId);
    return;
  }

  await storeScopedTransaction(storeId, async (tx) => {
    const line = await tx.cartLine.findUnique({
      where: { id: lineId },
      include: { variant: { include: { listing: true } } },
    });
    if (!line || line.cartId !== cartId) {
      throw new CartError("Cart line not found", "CART_NOT_FOUND");
    }

    const maxPerOrder = line.variant.listing.maxPerOrder ?? 99;
    if (qty > maxPerOrder) {
      throw new CartError(
        `Maximum ${maxPerOrder} per order for this item`,
        "MAX_PER_ORDER",
      );
    }

    await tx.cartLine.update({
      where: { id: lineId },
      data: { qty },
    });
  });
}

export async function updateLineSwapRule(
  storeId: string,
  cartId: string,
  lineId: string,
  swapRule: SwapRuleValue,
  substituteVariantId: string | null,
): Promise<void> {
  if (!VALID_SWAP_RULES.includes(swapRule)) {
    throw new CartError("Invalid swap rule", "INVALID_SWAP_RULE");
  }

  if (swapRule === "named_substitute") {
    if (!substituteVariantId) {
      throw new CartError(
        "named_substitute requires a substituteVariantId",
        "INVALID_SUBSTITUTE",
      );
    }
    await storeScopedTransaction(storeId, async (tx) => {
      const line = await tx.cartLine.findUnique({ where: { id: lineId } });
      if (!line || line.cartId !== cartId) {
        throw new CartError("Cart line not found", "CART_NOT_FOUND");
      }
      const substitute = await tx.listingVariant.findUnique({
        where: { id: substituteVariantId },
        include: { listing: true },
      });
      if (!substitute || substitute.listing.storeId !== storeId) {
        throw new CartError(
          "Substitute variant does not belong to this store",
          "INVALID_SUBSTITUTE",
        );
      }
      await tx.cartLine.update({
        where: { id: lineId },
        data: { swapRule, substituteVariantId },
      });
    });
  } else {
    const scoped = storeScoped(storeId);
    const line = await scoped.cartLine.findUnique({ where: { id: lineId } });
    if (!line || line.cartId !== cartId) {
      throw new CartError("Cart line not found", "CART_NOT_FOUND");
    }
    await scoped.cartLine.update({
      where: { id: lineId },
      data: { swapRule, substituteVariantId: null },
    });
  }
}

export async function removeLine(
  storeId: string,
  cartId: string,
  lineId: string,
): Promise<void> {
  const scoped = storeScoped(storeId);
  await scoped.cartLine.deleteMany({ where: { id: lineId, cartId } });
}

export async function clearAllLines(
  storeId: string,
  cartId: string,
): Promise<void> {
  const scoped = storeScoped(storeId);
  await scoped.cartLine.deleteMany({ where: { cartId } });
}

export async function getCartWithLines(
  storeId: string,
  cartId: string,
): Promise<CartWithLines | null> {
  const scoped = storeScoped(storeId);
  const cart = await scoped.cart.findUnique({
    where: { id: cartId },
    include: {
      lines: {
        include: {
          variant: {
            include: {
              listing: {
                include: { masterProduct: true },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!cart) return null;

  const lines: CartLineView[] = cart.lines.map((line) => {
    const photo = catalogFor(
      line.variant.listing.customName,
      line.variant.listing.masterProduct?.name,
    );
    return {
      id: line.id,
      variantId: line.variantId,
      qty: line.qty,
      swapRule: line.swapRule as SwapRuleValue,
      substituteVariantId: line.substituteVariantId,
      imageUrl: photo?.imageUrl || undefined,
      variant: {
        id: line.variant.id,
        label: line.variant.label,
        price: line.variant.price,
        weightG: line.variant.weightG,
        listing: {
          id: line.variant.listing.id,
          customName: line.variant.listing.customName,
          maxPerOrder: line.variant.listing.maxPerOrder,
          masterProduct: line.variant.listing.masterProduct
            ? {
                name: line.variant.listing.masterProduct.name,
                categoryId: line.variant.listing.masterProduct.categoryId,
              }
            : null,
        },
      },
    };
  });

  const subtotalCents = lines.reduce(
    (sum, l) => sum + l.variant.price * l.qty,
    0,
  );

  return { id: cart.id, storeId: cart.storeId, lines, subtotalCents };
}

export async function checkMinimumOrder(
  storeId: string,
  cartId: string,
): Promise<MinimumOrderResult> {
  const scoped = storeScoped(storeId);
  const [cart, store] = await Promise.all([
    scoped.cart.findUnique({
      where: { id: cartId },
      include: {
        lines: { include: { variant: true } },
      },
    }),
    (await import("../db")).platform.store.findUnique({
      where: { id: storeId },
    }),
  ]);

  const minimumCents = store?.minimumOrderCents ?? 0;
  const currentCents = cart
    ? cart.lines.reduce((sum, l) => sum + l.variant.price * l.qty, 0)
    : 0;

  return {
    allowed: currentCents >= minimumCents,
    minimumCents,
    currentCents,
  };
}
