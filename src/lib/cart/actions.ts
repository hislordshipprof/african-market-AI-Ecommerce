"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { assistantFakeAllowed } from "../assistant/contract";
import { auth } from "../auth";
import { getStore } from "../get-store";
import { readBrowserId } from "./browser";
import { getCartIdFromCookie, setCartIdCookie } from "./cookies";
import { parseInput } from "../security/parse-input";
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

const lineIdSchema = z.string().min(1).max(200);
const qtySchema = z.number().int().min(0).max(1_000_000);

function invalidItem(): { ok: false; error: string; code: string } {
  return { ok: false, error: "Invalid item", code: "INVALID_INPUT" };
}

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
  const reqHeaders = await headers();
  const [store, cookieCartId, userId] = await Promise.all([
    getStore(),
    getCartIdFromCookie(),
    sessionUserId(),
  ]);
  const cartId = await getOrCreateCart(
    store.id,
    cookieCartId,
    userId,
    readBrowserId(reqHeaders.get("x-shop-browser"), reqHeaders.get("cookie")),
  );
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
  const variant = parseInput(lineIdSchema, variantId);
  const quantity = parseInput(qtySchema, qty);
  if (!variant.ok || !quantity.ok || quantity.data < 1) return invalidItem();
  try {
    const { storeId, cartId, userId } = await ensureCartId();
    await addLine(storeId, cartId, variant.data, quantity.data, userId);
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
  const line = parseInput(lineIdSchema, lineId);
  const quantity = parseInput(qtySchema, qty);
  if (!line.ok || !quantity.ok) return invalidItem();
  try {
    const { storeId, cartId, userId } = await ensureCartId();
    await updateLineQty(storeId, cartId, line.data, quantity.data, userId);
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
  const parsed = parseInput(z.strictObject({
    lineId: lineIdSchema,
    swapRule: z.enum(["exact_only", "store_suggests", "named_substitute"]),
    substituteVariantId: z.string().max(200).nullable(),
  }), { lineId, swapRule, substituteVariantId });
  if (!parsed.ok) return invalidItem();
  try {
    const { storeId, cartId, userId } = await ensureCartId();
    await updateLineSwapRule(
      storeId,
      cartId,
      parsed.data.lineId,
      parsed.data.swapRule,
      parsed.data.substituteVariantId,
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
  const parsed = parseInput(z.strictObject({
    lineId: lineIdSchema,
    added: z.number().int().min(0).max(1_000_000),
    additionId: lineIdSchema,
  }), input);
  if (!parsed.ok) return invalidItem();
  if (assistantFakeAllowed()) {
    const cookie = (await headers()).get("cookie") ?? "";
    if (cookie.includes("e2e_undo=reject")) return { ok: false, error: "Could not undo that", code: "CART_NOT_FOUND" };
    if (cookie.includes("e2e_undo=throw")) throw new Error("undo failed");
    if (cookie.includes("e2e_undo=stale")) throw new Error('Server Action "undo" was not found on the server');
  }
  try {
    const { storeId, cartId, userId } = await ensureCartId();
    const result = await undoAssistantAddition(storeId, cartId, parsed.data.lineId, parsed.data.added, parsed.data.additionId, userId);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof CartError) return { ok: false, error: e.message, code: e.code };
    throw e;
  }
}

export async function removeCartLine(
  lineId: string,
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  const line = parseInput(lineIdSchema, lineId);
  if (!line.ok) return invalidItem();
  try {
    const { storeId, cartId, userId } = await ensureCartId();
    await removeLine(storeId, cartId, line.data, userId);
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
  const parsed = parseInput(z.array(z.strictObject({
    variantId: lineIdSchema,
    qty: qtySchema,
    swapRule: z.enum(["exact_only", "store_suggests", "named_substitute"]).optional(),
    substituteVariantId: z.string().max(200).nullable().optional(),
  })).max(200), localLines);
  if (!parsed.ok) return { ok: false, error: "Invalid item" };
  try {
    const { storeId, cartId, userId } = await ensureCartId();
    const existingCart = await getCartWithLines(storeId, cartId);
    if (existingCart && existingCart.lines.length > 0) {
      return { ok: true, cartId };
    }
    for (const line of parsed.data) {
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
