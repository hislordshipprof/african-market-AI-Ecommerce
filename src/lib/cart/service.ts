import type { PrismaClient } from "@prisma/client";
import { findOrCreateCustomer } from "../customer-auth";
import {
  authPrisma,
  storeScoped,
  storeScopedTransaction,
  lockCart,
  lockCartLineByVariant,
} from "../db";
import { catalogFor } from "../storefront/catalog";
import type { SwapRuleValue } from "../storefront/cart-store";
import { shareFirstCart } from "./bootstrap";
import {
  decideAddQty,
  decideLineQty,
  decideNamedSubstitute,
  isCartSwapRule,
  substituteIdForSwap,
  UNSET_MAX_PER_ORDER,
} from "./limits";

export type { SwapRuleValue };

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
      | "CART_NOT_FOUND"
      | "USER_NOT_FOUND",
  ) {
    super(message);
    this.name = "CartError";
  }
}

async function claimGuestCart(storeId: string, browserId: string): Promise<string> {
  const scoped = storeScoped(storeId);
  const claim = await scoped.guestBrowserCart.findUnique({
    where: { storeId_browserId: { storeId, browserId } },
  });
  if (claim) {
    const cart = await scoped.cart.findUnique({ where: { id: claim.cartId } });
    if (cart && cart.userId === null) return cart.id;
  }
  const cart = await scoped.cart.create({
    data: { storeId, userId: null, customerId: null, source: "manual" },
  });
  try {
    if (claim) {
      await scoped.guestBrowserCart.update({
        where: { storeId_browserId: { storeId, browserId } },
        data: { cartId: cart.id },
      });
    } else {
      await scoped.guestBrowserCart.create({
        data: { storeId, browserId, cartId: cart.id },
      });
    }
  } catch {
    const winner = await scoped.guestBrowserCart.findUnique({
      where: { storeId_browserId: { storeId, browserId } },
    });
    if (winner) {
      const won = await scoped.cart.findUnique({ where: { id: winner.cartId } });
      if (won && won.userId === null) return won.id;
    }
  }
  return cart.id;
}

export async function getOrCreateCart(
  storeId: string,
  cartId: string | null,
  userId: string | null,
  browserId: string | null = null,
): Promise<string> {
  const scoped = storeScoped(storeId);

  // A signed-out request must not keep writing an account cart that the
  // cookie still names. Reuse only a cart that no account owns.
  if (!userId) {
    if (cartId) {
      const existing = await scoped.cart.findUnique({ where: { id: cartId } });
      if (existing && existing.userId === null) return existing.id;
    }
    if (!browserId) {
      const cart = await scoped.cart.create({
        data: { storeId, userId: null, customerId: null, source: "manual" },
      });
      return cart.id;
    }
    return shareFirstCart(`guest:${storeId}:${browserId}`, () => claimGuestCart(storeId, browserId));
  }

  const customerId = await customerIdForCartUser(storeId, userId);

  // Claim under the same cart-row lock as line mutations. A guest clear that
  // already holds the lock finishes first; a claim that already committed is
  // visible when that clear rechecks ownership.
  if (cartId) {
    const claimed = await storeScopedTransaction(storeId, async (tx) => {
      await lockCart(tx, cartId);
      const existing = await tx.cart.findUnique({ where: { id: cartId } });
      if (!existing || (existing.userId !== null && existing.userId !== userId)) {
        return false;
      }
      await tx.cart.update({
        where: { id: existing.id },
        data: { userId, customerId },
      });
      await tx.guestBrowserCart.deleteMany({ where: { storeId, cartId } });
      return true;
    });
    if (claimed) return cartId;
  }

  return shareFirstCart(`user:${storeId}:${userId}`, async () => {
    const cart = await scoped.cart.create({
      data: { storeId, userId, customerId, source: "manual" },
    });
    return cart.id;
  });
}

async function requireCartActor(
  tx: Pick<PrismaClient, "cart" | "$queryRaw">,
  cartId: string,
  actorUserId: string | null,
): Promise<void> {
  await lockCart(tx, cartId);
  const cart = await tx.cart.findUnique({ where: { id: cartId } });
  if (!cart || cart.userId !== actorUserId) {
    throw new CartError("Cart not found", "CART_NOT_FOUND");
  }
}

async function customerIdForCartUser(storeId: string, userId: string): Promise<string> {
  const user = await authPrisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new CartError("Signed-in account was not found", "USER_NOT_FOUND");
  }
  const customer = await findOrCreateCustomer(storeId, user);
  return customer.id;
}

/** Integer cents: live variant price × quantity. Shared by the cart page, summary, and cart tools. */
export function cartLineSubtotalCents(lines: ReadonlyArray<{ priceCents: number; qty: number }>): number {
  let sum = 0;
  for (const line of lines) sum += line.priceCents * line.qty;
  return sum;
}

export interface AddLineOptions {
  source?: "manual" | "ai";
  /** Add up to the max and report the clamp. Storefront callers omit this and still throw. */
  clampToMax?: boolean;
  requireActive?: boolean;
}

export type CartWriteTx = Parameters<Parameters<typeof storeScopedTransaction>[1]>[0];

export interface AppliedAddLine {
  ok: true;
  lineId: string;
  qty: number;
  added: number;
  created: boolean;
  swapRule: SwapRuleValue;
  limitedTo?: number;
  listing: {
    id: string;
    active: boolean;
    confidence: number;
    stockMode: string;
    qty: number | null;
    status: string | null;
    customName: string | null;
    maxPerOrder: number | null;
    masterProduct: { name: string; imageUrl: string | null } | null;
  };
  variant: { id: string; label: string; price: number };
}

export type ApplyAddLineResult =
  | AppliedAddLine
  | { ok: false; code: "variant_not_found" | "unavailable" | "max_per_order"; maxPerOrder?: number };

/** Lock the cart, then run the write. Callers that need one audit row share this transaction. */
export async function runCartMutation<T>(
  storeId: string,
  cartId: string,
  actorUserId: string | null,
  fn: (tx: CartWriteTx) => Promise<T>,
): Promise<T> {
  return storeScopedTransaction(storeId, async (tx) => {
    await requireCartActor(tx, cartId, actorUserId);
    return fn(tx);
  });
}

export async function applyAddLine(
  tx: CartWriteTx,
  storeId: string,
  cartId: string,
  variantId: string,
  qty: number,
  options?: AddLineOptions,
): Promise<ApplyAddLineResult> {
  const variant = await tx.listingVariant.findUnique({
    where: { id: variantId },
    include: {
      listing: {
        include: { masterProduct: { select: { name: true, imageUrl: true } } },
      },
    },
  });
  if (!variant || variant.listing.storeId !== storeId) {
    return { ok: false, code: "variant_not_found" };
  }
  if (options?.requireActive && !variant.listing.active) {
    return { ok: false, code: "unavailable" };
  }

  // The cart row is already locked. FOR UPDATE cannot lock a missing line, so
  // concurrent first-adds serialize on that cart lock.
  const existing = await lockCartLineByVariant(tx, cartId, variantId);
  const decision = decideAddQty({
    existingQty: existing?.qty ?? 0,
    addQty: qty,
    maxPerOrder: variant.listing.maxPerOrder,
    clampToMax: options?.clampToMax === true,
  });
  if (!decision.ok) {
    return { ok: false, code: "max_per_order", maxPerOrder: decision.maxPerOrder };
  }
  const { nextQty, added, limitedTo } = decision;

  const listing = {
    id: variant.listing.id,
    active: variant.listing.active,
    confidence: variant.listing.confidence,
    stockMode: variant.listing.stockMode,
    qty: variant.listing.qty,
    status: variant.listing.status,
    customName: variant.listing.customName,
    maxPerOrder: variant.listing.maxPerOrder,
    masterProduct: variant.listing.masterProduct
      ? { name: variant.listing.masterProduct.name, imageUrl: variant.listing.masterProduct.imageUrl }
      : null,
  };
  const variantView = { id: variant.id, label: variant.label, price: variant.price };

  if (existing) {
    const current = await tx.cartLine.findUnique({ where: { id: existing.id } });
    await tx.cartLine.update({
      where: { id: existing.id },
      data: { qty: nextQty },
    });
    return {
      ok: true,
      lineId: existing.id,
      qty: nextQty,
      added,
      created: false,
      swapRule: (current?.swapRule ?? "exact_only") as SwapRuleValue,
      limitedTo,
      listing,
      variant: variantView,
    };
  }

  const created = await tx.cartLine.create({
    data: {
      storeId,
      cartId,
      variantId,
      qty: nextQty,
      source: options?.source ?? "manual",
      swapRule: "exact_only",
    },
  });
  return {
    ok: true,
    lineId: created.id,
    qty: nextQty,
    added,
    created: true,
    swapRule: "exact_only",
    limitedTo,
    listing,
    variant: variantView,
  };
}

export async function addLine(
  storeId: string,
  cartId: string,
  variantId: string,
  qty: number,
  actorUserId: string | null = null,
  options?: AddLineOptions,
): Promise<void> {
  await runCartMutation(storeId, cartId, actorUserId, async (tx) => {
    const result = await applyAddLine(tx, storeId, cartId, variantId, qty, {
      source: options?.source ?? "manual",
      clampToMax: options?.clampToMax ?? false,
      requireActive: options?.requireActive ?? false,
    });
    if (!result.ok && result.code === "variant_not_found") {
      throw new CartError("Variant does not belong to this store", "VARIANT_STORE_MISMATCH");
    }
    if (!result.ok && result.code === "unavailable") {
      throw new CartError("Listing is unavailable", "VARIANT_STORE_MISMATCH");
    }
    if (!result.ok) {
      throw new CartError(
        `Maximum ${result.maxPerOrder ?? UNSET_MAX_PER_ORDER} per order for this item`,
        "MAX_PER_ORDER",
      );
    }
  });
}

export async function updateLineQty(
  storeId: string,
  cartId: string,
  lineId: string,
  qty: number,
  actorUserId: string | null = null,
): Promise<void> {
  if (qty <= 0) {
    await removeLine(storeId, cartId, lineId, actorUserId);
    return;
  }

  await storeScopedTransaction(storeId, async (tx) => {
    await requireCartActor(tx, cartId, actorUserId);
    const line = await tx.cartLine.findUnique({
      where: { id: lineId },
      include: { variant: { include: { listing: true } } },
    });
    if (!line || line.cartId !== cartId) {
      throw new CartError("Cart line not found", "CART_NOT_FOUND");
    }

    const decision = decideLineQty(qty, line.variant.listing.maxPerOrder);
    if (!decision.ok) {
      throw new CartError(
        `Maximum ${decision.maxPerOrder} per order for this item`,
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
  actorUserId: string | null = null,
): Promise<void> {
  if (!isCartSwapRule(swapRule)) {
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
      await requireCartActor(tx, cartId, actorUserId);
      const line = await tx.cartLine.findUnique({ where: { id: lineId } });
      if (!line || line.cartId !== cartId) {
        throw new CartError("Cart line not found", "CART_NOT_FOUND");
      }
      const substitute = await tx.listingVariant.findUnique({
        where: { id: substituteVariantId },
        include: { listing: true },
      });
      const decision = decideNamedSubstitute(
        substitute
          ? {
              id: substitute.id,
              storeId: substitute.listing.storeId,
              active: substitute.listing.active,
            }
          : null,
        storeId,
      );
      if (!decision.ok) {
        throw new CartError(
          "Substitute variant does not belong to this store",
          "INVALID_SUBSTITUTE",
        );
      }
      await tx.cartLine.update({
        where: { id: lineId },
        data: { swapRule, substituteVariantId: decision.substituteVariantId },
      });
    });
  } else {
    await storeScopedTransaction(storeId, async (tx) => {
      await requireCartActor(tx, cartId, actorUserId);
      const line = await tx.cartLine.findUnique({ where: { id: lineId } });
      if (!line || line.cartId !== cartId) {
        throw new CartError("Cart line not found", "CART_NOT_FOUND");
      }
      await tx.cartLine.update({
        where: { id: lineId },
        data: { swapRule, substituteVariantId: substituteIdForSwap(swapRule, null) },
      });
    });
  }
}

export async function removeLine(
  storeId: string,
  cartId: string,
  lineId: string,
  actorUserId: string | null = null,
): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await requireCartActor(tx, cartId, actorUserId);
    await tx.cartLine.deleteMany({ where: { id: lineId, cartId } });
  });
}

export type UndoAdditionResult =
  | { status: "confirmed"; qty: number; removed: boolean }
  | { status: "already_consumed"; subtracted: number }
  | { status: "already_removed" };

/**
 * Subtract one assistant addition under the cart lock. The receipt is the
 * retry token: a second call for the same addition does not subtract again,
 * and a line id that no longer exists does not touch a later line for the
 * same variant.
 */
export async function undoAssistantAddition(
  storeId: string,
  cartId: string,
  lineId: string,
  added: number,
  additionId: string,
  actorUserId: string | null = null,
): Promise<UndoAdditionResult> {
  if (!Number.isInteger(added) || added < 1 || added > 99) {
    throw new CartError("Invalid quantity", "MAX_PER_ORDER");
  }
  if (!/^[A-Za-z0-9_:-]{1,120}$/.test(additionId)) {
    throw new CartError("Cart line not found", "CART_NOT_FOUND");
  }
  return runCartMutation(storeId, cartId, actorUserId, async (tx) => {
    const prior = await tx.assistantUndoReceipt.findUnique({
      where: { storeId_cartId_additionId: { storeId, cartId, additionId } },
    });
    if (prior) return { status: "already_consumed", subtracted: prior.subtracted };
    const line = await tx.cartLine.findUnique({ where: { id: lineId } });
    if (line && (line.cartId !== cartId || line.storeId !== storeId)) {
      throw new CartError("Cart line not found", "CART_NOT_FOUND");
    }
    if (!line) {
      await tx.assistantUndoReceipt.create({
        data: { storeId, cartId, lineId, additionId, subtracted: 0 },
      });
      return { status: "already_removed" };
    }
    const next = line.qty - added;
    if (next <= 0) await tx.cartLine.delete({ where: { id: line.id } });
    else await tx.cartLine.update({ where: { id: line.id }, data: { qty: next } });
    await tx.assistantUndoReceipt.create({
      data: { storeId, cartId, lineId: line.id, additionId, subtracted: added },
    });
    return { status: "confirmed", qty: Math.max(0, next), removed: next <= 0 };
  });
}

export async function clearAllLines(
  storeId: string,
  cartId: string,
  actorUserId: string | null = null,
): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await requireCartActor(tx, cartId, actorUserId);
    await tx.cartLine.deleteMany({ where: { cartId } });
  });
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

  const subtotalCents = cartLineSubtotalCents(
    lines.map((line) => ({ priceCents: line.variant.price, qty: line.qty })),
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
