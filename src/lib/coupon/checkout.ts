import type { Prisma } from "@prisma/client";
import { lockCart, storeScopedTransaction } from "../db";
import { takeRateLimit } from "../rate-limit/app-limiter";
import type { QuoteCouponInput } from "../checkout/quote";
import { RELEASED_STATUSES } from "./service";
import { couponTerms } from "./discount";

/** One answer for unknown, other-store, inactive and out-of-window codes, so it never says a code exists elsewhere. */
export const COUPON_INVALID = "That code isn't valid at this store.";
export const COUPON_TOO_MANY_TRIES = "Too many codes tried. Please wait an hour and try again.";
export const COUPON_USED_UP = "This code has reached its limit.";
export const COUPON_ALREADY_USED = "You have already used this code.";
export const COUPON_FIRST_ORDER = "This code is for a first order at this store.";

/** Placement refused the cart's code for this customer (per-customer or first-order rule); the hold is released. */
export class CouponRefusedError extends Error {
  readonly code = "coupon_refused" as const;
  constructor(refusal: string) {
    super(`${refusal} We took the code off and your card was not charged.`);
    this.name = "CouponRefusedError";
  }
}

/** The refusals only placement gives a guest, because they depend on who the customer is. */
export function customerRefusal(input: QuoteCouponInput | null): string | null {
  if (!input || !("refusal" in input)) return null;
  return input.refusal === COUPON_ALREADY_USED || input.refusal === COUPON_FIRST_ORDER ? input.refusal : null;
}

const CODE_RE = /^[A-Z0-9-]{3,20}$/;
const WRONG_PER_CART = 10;
const WRONG_PER_IP = 30;
const HOUR_MS = 60 * 60_000;

type CouponDb = Pick<Prisma.TransactionClient, "storeCoupon" | "order">;

/** Who a use counts against: the account when signed in, otherwise the guest email. */
export function couponCustomerKey(userId: string | null, email: string): string | null {
  if (userId) return `user:${userId}`;
  const normalized = email.trim().toLowerCase();
  return normalized ? `email:${normalized}` : null;
}

/** The code as stored: trimmed and upper-case. Null when it cannot be a code at all. */
export function normalizeCouponCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

/**
 * The cart's code checked against this store's coupon now: window, active, total uses, and the
 * per-customer and first-order rules. Quote and apply pass `email: null`, so a guest's typed email
 * never answers whether that person ordered here; a signed-in account is checked by its own account
 * only. Placement passes the contact email and calls it under the store lock, where it is the authority.
 */
export async function readCartCoupon(
  db: CouponDb,
  storeId: string,
  code: string,
  who: { email: string | null; userId: string | null; now: Date },
): Promise<QuoteCouponInput> {
  const refuse = (refusal: string): QuoteCouponInput => ({ code, refusal });
  const coupon = await db.storeCoupon.findUnique({ where: { storeId_code: { storeId, code } } });
  if (!coupon || coupon.storeId !== storeId || !coupon.active) return refuse(COUPON_INVALID);
  if (coupon.startsAt > who.now || (coupon.endsAt && coupon.endsAt <= who.now)) return refuse(COUPON_INVALID);

  const live = { storeId, status: { notIn: RELEASED_STATUSES } };
  if (coupon.totalUses != null && (await db.order.count({ where: { ...live, couponId: coupon.id } })) >= coupon.totalUses) {
    return refuse(COUPON_USED_UP);
  }
  const key = couponCustomerKey(who.userId, who.email ?? "");
  if (key && coupon.usesPerCustomer != null
    && (await db.order.count({ where: { ...live, couponId: coupon.id, couponCustomerKey: key } })) >= coupon.usesPerCustomer) {
    return refuse(COUPON_ALREADY_USED);
  }
  if (coupon.firstOrderOnly && key) {
    const email = (who.email ?? "").trim().toLowerCase();
    const earlier = await db.order.count({
      where: {
        ...live,
        OR: [
          { couponCustomerKey: key },
          ...(email ? [{ customer: { email } }] : []),
          ...(who.userId ? [{ customer: { userId: who.userId } }, { customer: { claimedBy: { userId: who.userId } } }] : []),
        ],
      },
    });
    if (earlier > 0) return refuse(COUPON_FIRST_ORDER);
  }
  return {
    code,
    coupon: { id: coupon.id, ...couponTerms(coupon), minGoodsCents: coupon.minGoodsCents },
  };
}

export type ApplyCouponResult = { ok: true } | { ok: false; error: string };

/**
 * Puts one code on the cart, replacing any other. Every try, right or wrong, first takes a slot from
 * the cart (10 an hour) and the IP (30 an hour), atomically, so a burst cannot check more codes than
 * that; once either is spent every code is refused until the hour is up.
 */
export async function applyCartCoupon(
  storeId: string,
  cartId: string,
  input: string,
  who: { ip: string; userId: string | null; now?: Date },
): Promise<ApplyCouponResult> {
  const now = who.now ?? new Date();
  const [byCart, byIp] = await Promise.all([
    takeRateLimit(`coupon-wrong:cart:${cartId}`, WRONG_PER_CART, HOUR_MS, now.getTime()),
    takeRateLimit(`coupon-wrong:ip:${who.ip}`, WRONG_PER_IP, HOUR_MS, now.getTime()),
  ]);
  if (!byCart.ok || !byIp.ok) return { ok: false, error: COUPON_TOO_MANY_TRIES };

  const code = normalizeCouponCode(input);
  return storeScopedTransaction(storeId, async (tx) => {
    await lockCart(tx, cartId);
    const cart = await tx.cart.findUnique({ where: { id: cartId }, select: { id: true } });
    if (!cart) return { ok: false as const, error: COUPON_INVALID };
    if (!code) return { ok: false as const, error: COUPON_INVALID };
    const checked = await readCartCoupon(tx, storeId, code, { email: null, userId: who.userId, now });
    if ("refusal" in checked) return { ok: false as const, error: checked.refusal };
    await tx.cart.update({ where: { id: cartId }, data: { couponCode: code } });
    return { ok: true as const };
  });
}

/** Takes the code off the cart. */
export async function removeCartCoupon(storeId: string, cartId: string): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    await lockCart(tx, cartId);
    await tx.cart.updateMany({ where: { id: cartId }, data: { couponCode: null } });
  });
}
