"use server";

import { getStore } from "../get-store";
import { getCartIdFromCookie, setCartIdCookie } from "./cookies";
import {
  getOrCreateCart,
  addLine,
  updateLineQty,
  updateLineSwapRule,
  removeLine,
  clearAllLines,
  getCartWithLines,
  checkMinimumOrder,
  CartError,
  type SwapRuleValue,
  type CartWithLines,
  type MinimumOrderResult,
} from "./service";

async function ensureCartId(): Promise<{ storeId: string; cartId: string }> {
  const store = await getStore();
  const cookieCartId = await getCartIdFromCookie();
  const cartId = await getOrCreateCart(store.id, cookieCartId, null);
  if (cartId !== cookieCartId) {
    await setCartIdCookie(cartId);
  }
  return { storeId: store.id, cartId };
}

export async function getServerCart(): Promise<CartWithLines | null> {
  const store = await getStore();
  const cartId = await getCartIdFromCookie();
  if (!cartId) return null;
  return getCartWithLines(store.id, cartId);
}

export async function addToCart(
  variantId: string,
  qty: number,
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  try {
    const { storeId, cartId } = await ensureCartId();
    await addLine(storeId, cartId, variantId, qty);
    return { ok: true };
  } catch (e) {
    if (e instanceof CartError) {
      return { ok: false, error: e.message, code: e.code };
    }
    throw e;
  }
}

export async function setLineQty(
  lineId: string,
  qty: number,
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  try {
    const store = await getStore();
    await updateLineQty(store.id, lineId, qty);
    return { ok: true };
  } catch (e) {
    if (e instanceof CartError) {
      return { ok: false, error: e.message, code: e.code };
    }
    throw e;
  }
}

export async function setSwapRule(
  lineId: string,
  swapRule: SwapRuleValue,
  substituteVariantId: string | null,
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  try {
    const store = await getStore();
    await updateLineSwapRule(store.id, lineId, swapRule, substituteVariantId);
    return { ok: true };
  } catch (e) {
    if (e instanceof CartError) {
      return { ok: false, error: e.message, code: e.code };
    }
    throw e;
  }
}

export async function removeCartLine(
  lineId: string,
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  try {
    const store = await getStore();
    await removeLine(store.id, lineId);
    return { ok: true };
  } catch (e) {
    if (e instanceof CartError) {
      return { ok: false, error: e.message, code: e.code };
    }
    throw e;
  }
}

export async function clearCart(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const store = await getStore();
    const cartId = await getCartIdFromCookie();
    if (!cartId) return { ok: true };
    await clearAllLines(store.id, cartId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function getMinimumOrder(): Promise<MinimumOrderResult> {
  const store = await getStore();
  const cartId = await getCartIdFromCookie();
  if (!cartId) {
    return {
      allowed: false,
      minimumCents: store.minimumOrderCents,
      currentCents: 0,
    };
  }
  return checkMinimumOrder(store.id, cartId);
}

export async function migrateLocalCart(
  localLines: Array<{
    variantId: string;
    qty: number;
    swapRule?: SwapRuleValue;
    substituteVariantId?: string | null;
  }>,
): Promise<{ ok: true; cartId: string } | { ok: false; error: string }> {
  try {
    const { storeId, cartId } = await ensureCartId();
    const existingCart = await getCartWithLines(storeId, cartId);
    if (existingCart && existingCart.lines.length > 0) {
      return { ok: true, cartId };
    }
    for (const line of localLines) {
      if (!line.variantId || line.qty <= 0) continue;
      try {
        await addLine(storeId, cartId, line.variantId, line.qty);
        if (line.swapRule && line.swapRule !== "exact_only") {
          const cart = await getCartWithLines(storeId, cartId);
          const serverLine = cart?.lines.find(
            (l) => l.variantId === line.variantId,
          );
          if (serverLine) {
            await updateLineSwapRule(
              storeId,
              serverLine.id,
              line.swapRule,
              line.substituteVariantId ?? null,
            );
          }
        }
      } catch {
        // Skip lines that fail (variant gone, max exceeded, etc.)
      }
    }
    return { ok: true, cartId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
