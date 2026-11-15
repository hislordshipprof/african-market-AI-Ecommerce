import { createHash, randomBytes } from "node:crypto";
import { storeScoped } from "../db";

/** A WhatsApp checkout link opens the store's checkout once, within this long (#559). */
export const CHECKOUT_LINK_TTL_MS = 60 * 60 * 1000;

/** 32 random bytes, base64url: exactly 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function checkoutLinkPath(token: string): string {
  return `/checkout/link/${token}`;
}

/** A new single-use link bound to this store's cart. Only the token's hash is stored. */
export async function createCheckoutLink(storeId: string, cartId: string, now: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await storeScoped(storeId).whatsAppCheckoutLink.create({
    data: {
      storeId,
      cartId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + CHECKOUT_LINK_TTL_MS),
    },
  });
  return token;
}

/**
 * The cart a link opens, at the store whose host it was opened on. The first
 * open claims the link in one conditional update. Later opens are refused,
 * except from the browser that already holds that cart (a reload), and only
 * before the link expires.
 */
export async function redeemCheckoutLink(
  storeId: string,
  token: string,
  cookieCartId: string | null,
  now: Date,
): Promise<{ ok: true; cartId: string } | { ok: false }> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false };
  const tokenHash = hashToken(token);
  const scoped = storeScoped(storeId);
  const claimed = await scoped.whatsAppCheckoutLink.updateMany({
    where: { storeId, tokenHash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  const row = await scoped.whatsAppCheckoutLink.findUnique({ where: { tokenHash }, select: { cartId: true, expiresAt: true } });
  if (!row) return { ok: false };
  if (claimed.count === 1) return { ok: true, cartId: row.cartId };
  if (cookieCartId === row.cartId && row.expiresAt > now) return { ok: true, cartId: row.cartId };
  return { ok: false };
}
