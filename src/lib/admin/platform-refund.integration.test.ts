import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";

const requirePlatformAdmin = vi.fn();
vi.mock("./session", () => ({ requirePlatformAdmin: () => requirePlatformAdmin() }));
const scheduled = vi.hoisted(() => [] as Array<{ orderId: string; event: string }>);
vi.mock("../inngest/notify", async (original) => ({
  ...(await original<typeof import("../inngest/notify")>()),
  scheduleOrderNotification: (_storeId: string, orderId: string, event: string) => scheduled.push({ orderId, event }),
}));

const { platformRefundAction } = await import("./platform-refund-action");
const { storeScoped } = await import("../db");
const { setStripeProvider } = await import("../stripe");
const { fakeStripeProvider, refundRequests, reset, setAuthorizedAmount, storeFundedRefundCents } = await import("../stripe/fake");
const { captureSplit } = await import("../order/platform-fee");
const { getStoreOrders } = await import("../order/service");
const { countedListing } = await import("../order/stock-ledger-test-helpers");

const hasDb = !!process.env.DATABASE_URL;
const ADMIN = { id: crypto.randomUUID(), email: `ops-${Date.now()}@platform.test` };

describe.skipIf(!hasDb)("platform manual refund (#538)", () => {
  const run = `pr538-${Date.now()}`;
  let raw: PrismaClient;
  const stores: string[] = [];
  let variants: Record<string, string> = {};
  let number = 0;

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.user.create({ data: { ...ADMIN, name: "Platform ops", emailVerified: true, role: "platform_admin" } });
    for (const name of ["A", "B"]) {
      const created = await raw.store.create({ data: { slug: `${run}-${name.toLowerCase()}`, name: `Refund ${name}`, themePreset: "palm-and-shea" } });
      stores.push(created.id);
      variants = { ...variants, [created.id]: (await countedListing(created.id, 50)).variantId };
    }
    reset();
    setStripeProvider(fakeStripeProvider);
  });

  beforeEach(() => {
    scheduled.length = 0;
    requirePlatformAdmin.mockReset();
    requirePlatformAdmin.mockResolvedValue({ user: ADMIN });
  });

  afterAll(async () => {
    setStripeProvider(null);
    if (!raw) return;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      for (const id of stores) {
        await tx.auditLog.deleteMany({ where: { storeId: id } });
        await tx.notificationLog.deleteMany({ where: { storeId: id } });
        await tx.order.deleteMany({ where: { storeId: id } });
        await tx.customer.deleteMany({ where: { storeId: id } });
        await tx.stockEvent.deleteMany({ where: { storeId: id } });
        await tx.listingVariant.deleteMany({ where: { listing: { storeId: id } } });
        await tx.listing.deleteMany({ where: { storeId: id } });
        await tx.store.deleteMany({ where: { id } });
      }
    });
    await raw.user.deleteMany({ where: { id: ADMIN.id } });
    await raw.$disconnect();
  });

  /** A captured order: goods plus a service fee and sales tax, and a courier fee when the order went by courier. */
  async function capturedOrder(opts: {
    goods: number; serviceFee?: number; courierFee?: number; tax?: number; taxLiableParty?: "platform" | "store";
    status?: "COMPLETED" | "DELIVERED" | "READY"; storeId?: string;
  }) {
    number += 1;
    const storeId = opts.storeId ?? stores[0];
    const serviceFeeCents = opts.serviceFee ?? 0;
    const courierFeeCents = opts.courierFee ?? 0;
    const taxCents = opts.tax ?? 0;
    const taxLiableParty = opts.taxLiableParty ?? "platform";
    const customer = await storeScoped(storeId).customer.create({ data: { storeId, name: `Refund ${number}`, email: `c${number}@${run}.test` } });
    const captured = opts.goods + serviceFeeCents + courierFeeCents + taxCents;
    const pi = `pi_pr538_${number}_${run}`;
    setAuthorizedAmount(pi, captured);
    const platformTaxCents = taxLiableParty === "platform" ? taxCents : 0;
    const fee = courierFeeCents > 0 || platformTaxCents > 0
      ? captureSplit({ capturedCents: captured, serviceFeeCents, courierFeeCents, platformTaxCents }).applicationFeeCents
      : undefined;
    await fakeStripeProvider.capturePaymentIntent(pi, captured, `cap-pr538-${number}`, fee);
    const order = await storeScoped(storeId).order.create({
      data: {
        storeId,
        number,
        customerId: customer.id,
        status: opts.status ?? "COMPLETED",
        fulfillment: courierFeeCents > 0 ? "courier" : "pickup",
        deliveryFeeCents: courierFeeCents,
        subtotalCents: opts.goods,
        bufferCents: 0,
        totalAuthorizedCents: captured,
        totalCents: captured,
        capturedAmountCents: captured,
        serviceFeeCents,
        taxCents,
        taxLiableParty,
        paymentIntentId: pi,
        completedAt: new Date("2026-11-01T12:00:00Z"),
      },
    });
    await storeScoped(storeId).orderLine.create({
      data: { storeId, orderId: order.id, listingVariantId: variants[storeId], qtyOrdered: 1, qtyPicked: 1, unitPriceCents: opts.goods, status: "picked" },
    });
    return order;
  }

  function form(orderId: string, amountDollars: string, reason = "Courier left the bag at the wrong door", submissionId: string = crypto.randomUUID()) {
    const data = new FormData();
    data.set("orderId", orderId);
    data.set("amountDollars", amountDollars);
    data.set("reason", reason);
    data.set("submissionId", submissionId);
    return data;
  }

  async function written(storeId: string, orderId: string) {
    const scoped = storeScoped(storeId);
    return {
      order: await scoped.order.findUniqueOrThrow({ where: { id: orderId } }),
      requests: await scoped.refundRequest.findMany({ where: { orderId } }),
      audits: await scoped.auditLog.findMany({ where: { entityId: orderId, action: "platform_refund" } }),
      notices: await scoped.notificationLog.findMany({ where: { orderId, event: "refunded" } }),
    };
  }

  it("refunds part of a pickup order with the fee back in proportion, records who and why, and tells the customer once", async () => {
    // $50 goods + $1.50 service fee captured; $10.30 back.
    const order = await capturedOrder({ goods: 5000, serviceFee: 150 });
    const result = await platformRefundAction(null, form(order.id, "10.30"));
    expect(result).toEqual({ ok: true, amountCents: 1030, pending: false });
    const after = await written(stores[0], order.id);
    expect(after.order.status).toBe("PARTIALLY_REFUNDED");
    expect(after.requests).toHaveLength(1);
    expect(after.requests[0]).toMatchObject({ amountCents: 1030, refundApplicationFee: true, serviceFeeShareCents: 0, providerStatus: "succeeded" });
    expect(after.requests[0].key).toMatch(/:platform:/);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ actorId: ADMIN.id, actorEmail: ADMIN.email, entityType: "order" });
    expect(after.audits[0].after).toMatchObject({ amountCents: 1030, reason: "Courier left the bag at the wrong door", refundRequestId: after.requests[0].id });
    expect(after.notices.length).toBeGreaterThan(0);
    expect(new Set(after.notices.map((row) => row.channel)).size).toBe(after.notices.length);
    expect(scheduled.filter((row) => row.orderId === order.id && row.event === "refunded")).toHaveLength(1);
  });

  it("keeps the platform fee on a courier order and returns only the service fee share from it", async () => {
    const order = await capturedOrder({ goods: 2000, serviceFee: 99, courierFee: 899 });
    expect(await platformRefundAction(null, form(order.id, "10.50"))).toMatchObject({ ok: true, amountCents: 1050 });
    const [request] = (await written(stores[0], order.id)).requests;
    expect(request).toMatchObject({ amountCents: 1050, refundApplicationFee: false, serviceFeeShareCents: 50 });
    expect(request.feeRefundId).toMatch(/^fr_fake_/);
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(1000);
  });

  it("#65 B5: a courier refund of a platform-taxed order returns the tax from the platform fee, so the store funds the goods only", async () => {
    // $20 goods + 60¢ service fee + $1.65 tax the platform collects + $8.99 courier fee; all the goods back is $22.25.
    const order = await capturedOrder({ goods: 2000, serviceFee: 60, courierFee: 899, tax: 165 });
    expect(await platformRefundAction(null, form(order.id, "22.25"))).toMatchObject({ ok: true, amountCents: 2225 });
    const [request] = (await written(stores[0], order.id)).requests;
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(2000);
    expect(request).toMatchObject({ amountCents: 2225, refundApplicationFee: false, serviceFeeShareCents: 60, taxShareCents: 165, platformTaxShareCents: 165 });
  });

  it("#65 B5: a partial courier refund of a platform-taxed order takes no tax from the store", async () => {
    // Half the goods: $10 + 30¢ fee share + 82.5¢ → 83¢ tax share.
    const order = await capturedOrder({ goods: 2000, serviceFee: 60, courierFee: 899, tax: 165 });
    expect(await platformRefundAction(null, form(order.id, "11.13"))).toMatchObject({ ok: true, amountCents: 1113 });
    const [request] = (await written(stores[0], order.id)).requests;
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(1000);
    expect(request).toMatchObject({ serviceFeeShareCents: 30, taxShareCents: 83, platformTaxShareCents: 83 });
  });

  it("#65 B5: when the store collects the tax, a courier refund reverses the tax with the store's transfer", async () => {
    const order = await capturedOrder({ goods: 2000, serviceFee: 60, courierFee: 899, tax: 165, taxLiableParty: "store" });
    expect(await platformRefundAction(null, form(order.id, "22.25"))).toMatchObject({ ok: true, amountCents: 2225 });
    const [request] = (await written(stores[0], order.id)).requests;
    expect(request).toMatchObject({ serviceFeeShareCents: 60, taxShareCents: 165, platformTaxShareCents: 0 });
    expect(storeFundedRefundCents(order.paymentIntentId!)).toBe(2165);
  });

  it("#65: two courier refunds of half the goods each never return more tax than the order paid", async () => {
    // $20 goods + $1.65 platform tax: half is 82.5 → 83¢, so the second half carries only the 82¢ left.
    const order = await capturedOrder({ goods: 2000, courierFee: 899, tax: 165 });
    expect(await platformRefundAction(null, form(order.id, "10.83"))).toMatchObject({ ok: true, amountCents: 1083 });
    expect(await platformRefundAction(null, form(order.id, "10.83"))).toMatchObject({ ok: true, amountCents: 1083 });
    const requests = (await written(stores[0], order.id)).requests;
    expect(requests.map((row) => row.platformTaxShareCents).sort()).toEqual([82, 83]);
  });

  it("a double submit and a concurrent submit of one form refund once", async () => {
    const order = await capturedOrder({ goods: 3000 });
    const submissionId = crypto.randomUUID();
    const calls = refundRequests.length;
    const [first, second] = await Promise.all([
      platformRefundAction(null, form(order.id, "5.00", "Damaged", submissionId)),
      platformRefundAction(null, form(order.id, "5.00", "Damaged", submissionId)),
    ]);
    const third = await platformRefundAction(null, form(order.id, "5.00", "Damaged", submissionId));
    expect([first, second].some((result) => result.ok)).toBe(true);
    expect(third).toEqual({ ok: true, amountCents: 500, pending: false });
    expect(refundRequests.length - calls).toBe(1);
    const after = await written(stores[0], order.id);
    expect(after.requests).toHaveLength(1);
    expect(after.audits).toHaveLength(1);
    expect(after.order.status).toBe("PARTIALLY_REFUNDED");
    expect(scheduled.filter((row) => row.orderId === order.id && row.event === "refunded")).toHaveLength(1);
  });

  it("refuses an amount above what is left after earlier refunds before writing anything, and refunds the exact remainder", async () => {
    const order = await capturedOrder({ goods: 2000 });
    await fakeStripeProvider.refundPayment(order.paymentIntentId!, 1500, "dashboard-538");
    const calls = refundRequests.length;
    const over = await platformRefundAction(null, form(order.id, "5.01"));
    expect(over).toEqual({ ok: false, error: "That is more than is left to refund on this order ($5.00)." });
    expect(refundRequests.length).toBe(calls);
    const none = await written(stores[0], order.id);
    expect(none.requests).toHaveLength(0);
    expect(none.audits).toHaveLength(0);
    expect(await platformRefundAction(null, form(order.id, "5.00"))).toMatchObject({ ok: true, amountCents: 500 });
    expect((await written(stores[0], order.id)).order.status).toBe("REFUNDED");
    expect(await platformRefundAction(null, form(order.id, "0.01"))).toMatchObject({ ok: false });
  });

  it("refuses a missing or too long reason, a zero amount, and an order not yet delivered", async () => {
    const order = await capturedOrder({ goods: 2000 });
    expect(await platformRefundAction(null, form(order.id, "1.00", "   "))).toMatchObject({ ok: false });
    expect(await platformRefundAction(null, form(order.id, "1.00", "x".repeat(501)))).toMatchObject({ ok: false });
    expect(await platformRefundAction(null, form(order.id, "0.00"))).toMatchObject({ ok: false });
    const ready = await capturedOrder({ goods: 2000, status: "READY" });
    expect(await platformRefundAction(null, form(ready.id, "1.00"))).toMatchObject({ ok: false });
    expect((await written(stores[0], order.id)).requests).toHaveLength(0);
    expect((await written(stores[0], ready.id)).requests).toHaveLength(0);
  });

  it("anyone who is not a platform admin is refused before anything is read or written", async () => {
    const order = await capturedOrder({ goods: 2000 });
    requirePlatformAdmin.mockRejectedValue(new Error("NEXT_REDIRECT /admin/sign-in"));
    await expect(platformRefundAction(null, form(order.id, "1.00"))).rejects.toThrow("NEXT_REDIRECT");
    expect((await written(stores[0], order.id)).requests).toHaveLength(0);
  });

  it("the store that owns the order sees it as refunded by the platform team; another store never sees it", async () => {
    const order = await capturedOrder({ goods: 2000, storeId: stores[1] });
    expect(await platformRefundAction(null, form(order.id, "2.00"))).toMatchObject({ ok: true });
    const own = (await getStoreOrders(stores[1])).find((row) => row.id === order.id);
    expect(own).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedByPlatform: true });
    expect((await getStoreOrders(stores[0])).some((row) => row.id === order.id)).toBe(false);
  });
});
