import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { computeQuote, recordAuthorizedOrder, BasketChangedError, type RecordAuthorizedOrderInput } from "../checkout/service";
import type { Contact } from "../customer-flow/contracts";
import { ADR_0021_SERVICE_FEE } from "../order/platform-fee";
import { applyCartCoupon, COUPON_INVALID, COUPON_TOO_MANY_TRIES, readCartCoupon } from "./checkout";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t557-${Date.now().toString(36)}`;
const PRICE = 2500;
const NOW = new Date("2026-11-20T15:00:00Z");

it("runs against a database in CI", () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; this test must not skip");
});

describe.skipIf(!hasDb)("store coupons at checkout (lane DB, app_runtime)", () => {
  let raw: PrismaClient;
  let userId = "";
  const storeIds: string[] = [];

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    const user = await raw.user.create({
      data: { id: crypto.randomUUID(), email: `${RUN}@example.com`, name: "Coupon Owner", emailVerified: true },
    });
    userId = user.id;
  }, 30_000);

  afterAll(async () => {
    if (raw && storeIds.length > 0) {
      await raw.$transaction([
        raw.$executeRaw`SET LOCAL ROLE app_user`,
        raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        raw.cartLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.cart.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.stockEvent.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.orderLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.notificationLog.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.order.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.customer.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.storeCoupon.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.listingVariant.deleteMany({ where: { listing: { storeId: { in: storeIds } } } }),
        raw.listing.deleteMany({ where: { storeId: { in: storeIds } } }),
      ]);
      await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    }
    if (userId) await raw.user.deleteMany({ where: { id: userId } });
    await raw?.$disconnect();
  }, 30_000);

  async function makeStore(label: string): Promise<string> {
    const store = await raw.store.create({
      data: {
        slug: `${RUN}-${label}-${crypto.randomUUID().slice(0, 6)}`,
        name: `Coupon ${label}`,
        themePreset: "palm-and-shea",
        stripeAccountId: `acct_t557_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeIds.push(store.id);
    return store.id;
  }

  async function makeCoupon(storeId: string, code: string, extra: Record<string, unknown> = {}) {
    return storeScoped(storeId).storeCoupon.create({
      data: {
        storeId, code, kind: "percent", percentOff: 20, startsAt: new Date("2026-11-01T00:00:00Z"),
        createdById: userId, ...extra,
      },
    });
  }

  async function makeCart(storeId: string, couponCode: string | null = null) {
    const scoped = storeScoped(storeId);
    const listing = await scoped.listing.create({
      data: { storeId, customName: `Yam ${crypto.randomUUID().slice(0, 4)}`, price: PRICE, stockMode: "unlimited", frozen: false, perishable: false },
    });
    const variant = await scoped.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: PRICE, weightG: 500 } });
    const cart = await scoped.cart.create({ data: { storeId, couponCode, paymentIntentId: `pi_t557_${crypto.randomUUID()}` } });
    await scoped.cartLine.create({ data: { storeId, cartId: cart.id, variantId: variant.id, qty: 2, swapRule: "exact_only" } });
    return { cart, variantId: variant.id };
  }

  /** What placement records when the shopper was quoted with the discount the cart's code gives now. */
  async function placeWithCode(storeId: string, email: string, actorUserId?: string | null): Promise<RecordAuthorizedOrderInput> {
    const { cart, variantId } = await makeCart(storeId, null);
    const contact: Contact = { name: "Ada Buyer", phone: "+15551234567", email };
    const coupon = await readCartCoupon(storeScoped(storeId), storeId, "SAVE20", { email, userId: actorUserId ?? null, now: NOW });
    await storeScoped(storeId).cart.update({ where: { id: cart.id }, data: { couponCode: "SAVE20", ...(actorUserId ? { userId: actorUserId } : {}) } });
    const quote = computeQuote(0, [{ price: PRICE, qty: 2, maxPerOrder: null }], contact, "pickup", ADR_0021_SERVICE_FEE, null, null, coupon);
    return {
      cartId: cart.id, contact, fulfillment: "pickup", pickupSlot: null, notes: null,
      paymentIntentId: cart.paymentIntentId!, quote, minimumOrderCents: 0,
      ...(actorUserId !== undefined ? { actorUserId } : {}),
      lines: [{ variantId, qty: 2, price: PRICE, swapRule: "exact_only", substituteVariantId: null }],
    };
  }

  it("records the coupon, the discount and who used it on the order, and clears the code off the cart", async () => {
    const storeId = await makeStore("record");
    const coupon = await makeCoupon(storeId, "SAVE20");
    const input = await placeWithCode(storeId, "Ada@Example.com");
    // $50.00 goods, 20% off = $10.00; fee 3% of $40.00 = $1.20; hold 4120 + 400.
    expect(input.quote.holdCents).toBe(4520);
    const placed = await recordAuthorizedOrder(storeId, input);
    const order = await storeScoped(storeId).order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order).toMatchObject({
      couponId: coupon.id, discountCents: 1000, serviceFeeCents: 120, totalCents: 4120,
      totalAuthorizedCents: 4520, couponCustomerKey: "email:ada@example.com",
    });
    const cart = await storeScoped(storeId).cart.findUniqueOrThrow({ where: { id: input.cartId } });
    expect(cart.couponCode).toBeNull();
  });

  it("two orders racing for a code's last use: one gets it, the other is refused and records nothing", async () => {
    const storeId = await makeStore("race");
    await makeCoupon(storeId, "SAVE20", { totalUses: 1 });
    const first = await placeWithCode(storeId, "one@example.com");
    const second = await placeWithCode(storeId, "two@example.com");
    const results = await Promise.allSettled([
      recordAuthorizedOrder(storeId, first),
      recordAuthorizedOrder(storeId, second),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(BasketChangedError);
    expect(await storeScoped(storeId).order.count({ where: { couponId: { not: null } } })).toBe(1);
  });

  it("limits uses per customer by guest email, and by account whatever email is typed", async () => {
    const storeId = await makeStore("per-customer");
    await makeCoupon(storeId, "SAVE20", { usesPerCustomer: 1 });
    await recordAuthorizedOrder(storeId, await placeWithCode(storeId, "guest@example.com"));
    const again = await readCartCoupon(storeScoped(storeId), storeId, "SAVE20", { email: "GUEST@example.com", userId: null, now: NOW });
    expect(again).toEqual({ code: "SAVE20", refusal: "You have already used this code." });

    await recordAuthorizedOrder(storeId, await placeWithCode(storeId, "first@example.com", userId));
    const otherEmail = await readCartCoupon(storeScoped(storeId), storeId, "SAVE20", { email: "second@example.com", userId, now: NOW });
    expect(otherEmail).toEqual({ code: "SAVE20", refusal: "You have already used this code." });
  });

  it("a cancelled order gives its use back", async () => {
    const storeId = await makeStore("cancel");
    await makeCoupon(storeId, "SAVE20", { totalUses: 1 });
    const placed = await recordAuthorizedOrder(storeId, await placeWithCode(storeId, "c1@example.com"));
    expect(await readCartCoupon(storeScoped(storeId), storeId, "SAVE20", { email: "c2@example.com", userId: null, now: NOW }))
      .toEqual({ code: "SAVE20", refusal: "This code has reached its limit." });
    await storeScoped(storeId).order.update({ where: { id: placed.orderId }, data: { status: "CANCELLED" } });
    const after = await readCartCoupon(storeScoped(storeId), storeId, "SAVE20", { email: "c2@example.com", userId: null, now: NOW });
    expect(after && "coupon" in after).toBe(true);
  });

  it("refuses a code outside its window or once deactivated, with the same words as an unknown code", async () => {
    const storeId = await makeStore("window");
    await makeCoupon(storeId, "LATER", { startsAt: new Date("2026-12-01T00:00:00Z") });
    await makeCoupon(storeId, "OVER", { endsAt: new Date("2026-11-10T00:00:00Z") });
    await makeCoupon(storeId, "OFF", { active: false });
    for (const code of ["LATER", "OVER", "OFF", "NOPE"]) {
      expect(await readCartCoupon(storeScoped(storeId), storeId, code, { email: "w@example.com", userId: null, now: NOW }))
        .toEqual({ code, refusal: COUPON_INVALID });
    }
  });

  it("another store's code is refused with the same words as a made-up one, and never lands on the cart", async () => {
    const storeA = await makeStore("iso-a");
    const storeB = await makeStore("iso-b");
    await makeCoupon(storeA, "ASTORE");
    const { cart } = await makeCart(storeB);
    const theirs = await applyCartCoupon(storeB, cart.id, "astore", { ip: "203.0.113.7", userId: null, now: NOW });
    const madeUp = await applyCartCoupon(storeB, cart.id, "ZZZZZ", { ip: "203.0.113.7", userId: null, now: NOW });
    expect(theirs).toEqual({ ok: false, error: COUPON_INVALID });
    expect(madeUp).toEqual(theirs);
    expect((await storeScoped(storeB).cart.findUniqueOrThrow({ where: { id: cart.id } })).couponCode).toBeNull();
  });

  it("applies a valid code exactly as typed, upper-cased, and a later code replaces it", async () => {
    const storeId = await makeStore("apply");
    await makeCoupon(storeId, "SAVE20");
    await makeCoupon(storeId, "TEN-OFF", { kind: "fixed", percentOff: null, amountOffCents: 1000 });
    const { cart } = await makeCart(storeId);
    expect(await applyCartCoupon(storeId, cart.id, " save20 ", { ip: "203.0.113.8", userId: null, now: NOW })).toEqual({ ok: true });
    expect(await applyCartCoupon(storeId, cart.id, "ten-off", { ip: "203.0.113.8", userId: null, now: NOW })).toEqual({ ok: true });
    expect((await storeScoped(storeId).cart.findUniqueOrThrow({ where: { id: cart.id } })).couponCode).toBe("TEN-OFF");
    // A pattern is not a code.
    expect(await applyCartCoupon(storeId, cart.id, "SAVE%", { ip: "203.0.113.8", userId: null, now: NOW })).toEqual({ ok: false, error: COUPON_INVALID });
  });

  it("limits wrong codes to 10 an hour per cart and 30 an hour per IP, and a right code is refused once limited", async () => {
    // The limiter drops windows by the real clock, so this test counts from now, not from NOW.
    const t0 = new Date();
    const storeId = await makeStore("limit");
    await makeCoupon(storeId, "SAVE20");
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}-${RUN}`;
    const { cart } = await makeCart(storeId);
    for (let i = 0; i < 10; i++) {
      expect(await applyCartCoupon(storeId, cart.id, `WRONG${i}`, { ip, userId: null, now: t0 })).toEqual({ ok: false, error: COUPON_INVALID });
    }
    expect(await applyCartCoupon(storeId, cart.id, "SAVE20", { ip, userId: null, now: t0 })).toEqual({ ok: false, error: COUPON_TOO_MANY_TRIES });
    // An hour later the cart may try again.
    const later = new Date(t0.getTime() + 60 * 60_000 + 1);
    expect(await applyCartCoupon(storeId, cart.id, "SAVE20", { ip, userId: null, now: later })).toEqual({ ok: true });

    // The IP limit spans carts: 20 more wrong tries from two fresh carts reach 30.
    for (let c = 0; c < 2; c++) {
      const fresh = await makeCart(storeId);
      for (let i = 0; i < 10; i++) await applyCartCoupon(storeId, fresh.cart.id, `NOPE${i}`, { ip, userId: null, now: t0 });
    }
    const third = await makeCart(storeId);
    expect(await applyCartCoupon(storeId, third.cart.id, "SAVE20", { ip, userId: null, now: t0 })).toEqual({ ok: false, error: COUPON_TOO_MANY_TRIES });
  });
});
