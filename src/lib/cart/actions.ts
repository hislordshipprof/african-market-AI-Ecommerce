"use server";

import { headers } from "next/headers";
import { assistantFakeAllowed } from "../assistant/contract";
import { auth } from "../auth";
import { getStore } from "../get-store";
import { getCartIdFromCookie, setCartIdCookie } from "./cookies";
import {
  getOrCreateCart,
  addLine,
  undoAssistantAddition,
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

async function sessionUserId(): Promise<string | null> {
  const reqHeaders = await headers();
  const session = await auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });
  return session?.user.id ?? null;
}

async function ensureCartId(): Promise<{
  storeId: string;
  cartId: string;
  userId: string | null;
}> {
  const [store, cookieCartId, userId] = await Promise.all([
    getStore(),
    getCartIdFromCookie(),
    sessionUserId(),
  ]);
  const cartId = await getOrCreateCart(store.id, cookieCartId, userId);
  if (cartId !== cookieCartId) {
    await setCartIdCookie(cartId);
  }
  return { storeId: store.id, cartId, userId };
}

/**
 * The cart this browser may read or change. No cookie means no cart.
 * A cookie that names an account cart the current session does not own is
 * replaced, so a signed-out shopper neither sees nor clears that basket.
 */
export async function resolveShopperCart(): Promise<{
  storeId: string;
  cartId: string;
  userId: string | null;
} | null> {
  const cookieCartId = await getCartIdFromCookie();
  if (!cookieCartId) return null;
  return ensureCartId();
}

export async function getServerCart(): Promise<CartWithLines | null> {
  if (assistantFakeAllowed()) {
    const cookie = (await headers()).get("cookie") ?? "";
    if (cookie.includes("e2e_fail_cart_read=1")) throw new Error("cart read failed");
  }
  const resolved = await resolveShopperCart();
  if (!resolved) return null;
  return getCartWithLines(resolved.storeId, resolved.cartId);
}

export async function addToCart(
  variantId: string,
  qty: number,
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  try {
    const { storeId, cartId, userId } = await ensureCartId();
    await addLine(storeId, cartId, variantId, qty, userId);
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
    const { storeId, cartId, userId } = await ensureCartId();
    await updateLineQty(storeId, cartId, lineId, qty, userId);
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
    const { storeId, cartId, userId } = await ensureCartId();
    await updateLineSwapRule(
      storeId,
      cartId,
      lineId,
      swapRule,
      substituteVariantId,
      userId,
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof CartError) {
      return { ok: false, error: e.message, code: e.code };
    }
    throw e;
  }
}

export async function undoAssistantAdditionAction(input: {
  lineId: string;
  added: number;
  additionId: string;
}): Promise<
  | { ok: true; result: Awaited<ReturnType<typeof undoAssistantAddition>> }
  | { ok: false; error: string; code: string }
> {
  if (assistantFakeAllowed()) {
    const cookie = (await headers()).get("cookie") ?? "";
    if (cookie.includes("e2e_undo=reject")) return { ok: false, error: "Could not undo that", code: "CART_NOT_FOUND" };
    if (cookie.includes("e2e_undo=throw")) throw new Error("undo failed");
    if (cookie.includes("e2e_undo=stale")) throw new Error('Server Action "undo" was not found on the server');
  }
  try {
    const { storeId, cartId, userId } = await ensureCartId();
    const result = await undoAssistantAddition(storeId, cartId, input.lineId, input.added, input.additionId, userId);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof CartError) return { ok: false, error: e.message, code: e.code };
    throw e;
  }
}

export async function removeCartLine(
  lineId: string,
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  try {
    const { storeId, cartId, userId } = await ensureCartId();
    await removeLine(storeId, cartId, lineId, userId);
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
    const resolved = await resolveShopperCart();
    if (!resolved) return { ok: true };
    await clearAllLines(resolved.storeId, resolved.cartId, resolved.userId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function getMinimumOrder(): Promise<MinimumOrderResult> {
  const store = await getStore();
  const resolved = await resolveShopperCart();
  if (!resolved) {
    return {
      allowed: false,
      minimumCents: store.minimumOrderCents,
      currentCents: 0,
    };
  }
  return checkMinimumOrder(resolved.storeId, resolved.cartId);
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
    const { storeId, cartId, userId } = await ensureCartId();
    const existingCart = await getCartWithLines(storeId, cartId);
    if (existingCart && existingCart.lines.length > 0) {
      return { ok: true, cartId };
    }
    for (const line of localLines) {
      if (!line.variantId || line.qty <= 0) continue;
      try {
        await addLine(storeId, cartId, line.variantId, line.qty, userId);
        if (line.swapRule && line.swapRule !== "exact_only") {
          const cart = await getCartWithLines(storeId, cartId);
          const serverLine = cart?.lines.find(
            (l) => l.variantId === line.variantId,
          );
          if (serverLine) {
            await updateLineSwapRule(
              storeId,
              cartId,
              serverLine.id,
              line.swapRule,
              line.substituteVariantId ?? null,
              userId,
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
