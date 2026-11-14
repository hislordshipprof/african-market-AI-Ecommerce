import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { Prisma, storeScopedRawQuery } from "../db";
import { storeAnalytics, type StoreAnalytics } from "./queries";
import { analyticsCsv } from "./csv";
import type { AnalyticsRange } from "./range";

const hasDb = !!process.env.DATABASE_URL;
const TZ = "America/Chicago";
const RANGE: AnalyticsRange = { preset: "custom", from: "2026-11-01", to: "2026-11-07" };
const at = (iso: string) => new Date(iso);
const minutes = (date: Date, n: number) => new Date(date.getTime() + n * 60_000);

/**
 * Hand-computed fixture (Chicago is UTC-6 after 1 Nov 2026). Card fee = round(2.9% of captured) + 30¢, as stored at capture.
 * O1 pickup   11-03  egusi 2×$10.00 picked; tip $3.00          captured 2300 fee 97  net 2203
 * O2 courier  11-03 11:30 pm (UTC 11-04)  palm oil 3×$15.00, 1 found, 2 swapped to egusi @ $11.00;
 *             courier fee $8.99                                captured 4599 fee 163 net 4599-163-899 = 3537
 *             refund $11.00, no fee back (courier issue), 11-05 → store bears 1100
 * O3 store delivery 11-05  palm oil 2×$15.00; egusi 1×$10.00 refunded at pick; tip $2.00, delivery $5.00
 *                                                              captured 3700 fee 137 net 3563
 *             refund $10.00 with fee back: round(137 × 1000 / 3700) = 37 → store bears 963; a pending refund is ignored
 * Goods 2000 + 3700 + 3000 = 8700, AOV 2900. Net 2203 + 3537 + 3563 − 1100 − 963 = 7240.
 */
describe.skipIf(!hasDb)("store analytics (lane DB)", () => {
  const run = `an498-${Date.now()}`;
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let data: StoreAnalytics;

  async function asStore<T>(storeId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
      return fn(tx);
    });
  }

  async function seedStoreA() {
    await asStore(storeA, async (tx) => {
      const egusi = await tx.listing.create({ data: { storeId: storeA, customName: "Egusi", price: 1000, stockMode: "always" } });
      const palm = await tx.listing.create({ data: { storeId: storeA, customName: "Palm oil", price: 1500, stockMode: "always" } });
      const vEgusi = await tx.listingVariant.create({ data: { listingId: egusi.id, label: "1 lb", price: 1000, weightG: 450 } });
      const vPalm = await tx.listingVariant.create({ data: { listingId: palm.id, label: "1 L", price: 1500, weightG: 900 } });
      const c1 = await tx.customer.create({ data: { storeId: storeA, name: "Ada" } });
      const c1guest = await tx.customer.create({ data: { storeId: storeA, name: "Ada guest", claimedByCustomerId: c1.id } });
      const c2 = await tx.customer.create({ data: { storeId: storeA, name: "Bisi" } });
      const c3 = await tx.customer.create({ data: { storeId: storeA, name: "Chidi" } });
      const cartO2 = await tx.cart.create({ data: { storeId: storeA } });
      const cartX = await tx.cart.create({ data: { storeId: storeA } });
      const cartY = await tx.cart.create({ data: { storeId: storeA } });

      let number = 0;
      const order = (o: Partial<Prisma.OrderUncheckedCreateInput> & { customerId: string; createdAt: Date }) =>
        tx.order.create({
          data: { storeId: storeA, number: ++number, subtotalCents: 0, bufferCents: 0, totalAuthorizedCents: 0, ...o },
        });

      const o1At = at("2026-11-03T15:00:00Z");
      const o1 = await order({ customerId: c1.id, fulfillment: "pickup", status: "COMPLETED", tipCents: 300, capturedAmountCents: 2300, platformFeeCents: 97, createdAt: o1At, readyAt: minutes(o1At, 20) });
      await tx.orderLine.create({ data: { storeId: storeA, orderId: o1.id, listingVariantId: vEgusi.id, qtyOrdered: 2, qtyPicked: 2, unitPriceCents: 1000, status: "picked" } });

      const o2At = at("2026-11-04T05:30:00Z");
      const o2 = await order({ customerId: c2.id, fulfillment: "courier", status: "OUT_FOR_DELIVERY", deliveryFeeCents: 899, capturedAmountCents: 4599, platformFeeCents: 163, sourceCartId: cartO2.id, createdAt: o2At, readyAt: minutes(o2At, 40) });
      const l2 = await tx.orderLine.create({ data: { storeId: storeA, orderId: o2.id, listingVariantId: vPalm.id, qtyOrdered: 3, qtyPicked: 1, unitPriceCents: 1500, status: "substituted", substitutedVariantId: vEgusi.id, substitutedUnitPriceCents: 1100 } });
      await tx.substitutionRequest.create({ data: { storeId: storeA, orderId: o2.id, orderLineId: l2.id, qty: 2, status: "approved", expiresAt: minutes(o2At, 10), createdAt: minutes(o2At, 5) } });
      await tx.refundRequest.create({ data: { storeId: storeA, orderId: o2.id, paymentIntentId: `pi_${run}_2`, key: `${run}-r2`, amountCents: 1100, refundApplicationFee: false, state: "CREATED", providerStatus: "succeeded", createdAt: at("2026-11-05T18:00:00Z") } });
      await tx.delivery.create({ data: { storeId: storeA, orderId: o2.id, provider: "doordash", externalId: `${run}-d2`, status: "requested", quoteFeeCents: 899, createdAt: minutes(o2At, 41) } });

      const o3At = at("2026-11-05T20:00:00Z");
      const o3 = await order({ customerId: c1guest.id, fulfillment: "store_delivery", status: "DELIVERED", tipCents: 200, deliveryFeeCents: 500, capturedAmountCents: 3700, platformFeeCents: 137, createdAt: o3At, readyAt: minutes(o3At, 90) });
      await tx.orderLine.create({ data: { storeId: storeA, orderId: o3.id, listingVariantId: vPalm.id, qtyOrdered: 2, qtyPicked: 2, unitPriceCents: 1500, status: "picked" } });
      const l4 = await tx.orderLine.create({ data: { storeId: storeA, orderId: o3.id, listingVariantId: vEgusi.id, qtyOrdered: 1, qtyPicked: 0, unitPriceCents: 1000, status: "refunded" } });
      await tx.substitutionRequest.create({ data: { storeId: storeA, orderId: o3.id, orderLineId: l4.id, qty: 1, status: "timed_out", expiresAt: minutes(o3At, 15), createdAt: minutes(o3At, 5) } });
      await tx.refundRequest.create({ data: { storeId: storeA, orderId: o3.id, paymentIntentId: `pi_${run}_3`, key: `${run}-r3`, amountCents: 1000, refundApplicationFee: true, state: "CREATED", providerStatus: "succeeded", createdAt: at("2026-11-06T02:00:00Z") } });
      await tx.refundRequest.create({ data: { storeId: storeA, orderId: o3.id, paymentIntentId: `pi_${run}_3`, key: `${run}-r3b`, amountCents: 500, refundApplicationFee: true, state: "CREATED", providerStatus: "pending", createdAt: at("2026-11-06T03:00:00Z") } });

      const o4 = await order({ customerId: c3.id, status: "CANCELLED", createdAt: at("2026-11-06T16:00:00Z"), cancelledAt: at("2026-11-06T17:00:00Z") });
      const o5 = await order({ customerId: c3.id, status: "CANCELLED", createdAt: at("2026-11-06T17:00:00Z"), cancelledAt: at("2026-11-06T17:30:00Z") });
      const system = await raw.user.upsert({ where: { email: "system@platform.internal" }, update: {}, create: { id: "system_00000000000000000000000", email: "system@platform.internal", name: "System" } });
      await tx.auditLog.create({ data: { storeId: storeA, actorId: system.id, actorEmail: system.email, action: "store_cancel", entityType: "order", entityId: o4.id, after: { reason: "out_of_stock", note: null } } });
      await tx.auditLog.create({ data: { storeId: storeA, actorId: system.id, actorEmail: system.email, action: "auto_cancel", entityType: "order", entityId: o5.id } });

      // Before the range: makes Bisi a returning, repeat shopper. Just after it (00:30 on 11-08): excluded.
      await order({ customerId: c2.id, status: "COMPLETED", capturedAmountCents: 1000, platformFeeCents: 59, createdAt: at("2026-10-20T15:00:00Z") });
      await order({ customerId: c2.id, status: "COMPLETED", capturedAmountCents: 5000, platformFeeCents: 175, createdAt: at("2026-11-08T06:30:00Z") });

      const convO2 = await tx.aiConversation.create({ data: { storeId: storeA, cartId: cartO2.id, model: "test", createdAt: minutes(o2At, -30) } });
      const convX = await tx.aiConversation.create({ data: { storeId: storeA, cartId: cartX.id, model: "test", createdAt: at("2026-11-04T15:00:00Z") } });
      const convY = await tx.aiConversation.create({ data: { storeId: storeA, cartId: cartY.id, model: "test", createdAt: at("2026-11-05T15:00:00Z") } });
      const action = (conversationId: string, tool: string, input: object, output: object, createdAt: Date, ok = true) =>
        tx.aiAction.create({ data: { storeId: storeA, conversationId, tool, input, output, ok, createdAt } });
      await action(convO2.id, "add_to_cart", { items: [] }, { ok: true }, minutes(o2At, -20));
      await action(convX.id, "add_to_cart", { items: [] }, { ok: true }, at("2026-11-04T15:05:00Z"));
      await action(convY.id, "add_to_cart", { items: [] }, { ok: false }, at("2026-11-05T15:05:00Z"), false);
      await action(convY.id, "search_catalog", { query: " Ogiri" }, { ok: true, items: [] }, at("2026-11-05T15:01:00Z"));
      await action(convY.id, "search_catalog", { query: "OGIRI" }, { ok: true, items: [] }, at("2026-11-05T15:02:00Z"));
      await action(convY.id, "search_catalog", { query: "kpomo" }, { ok: true, items: [] }, at("2026-11-05T15:03:00Z"));
      await action(convY.id, "search_catalog", { query: "egusi" }, { ok: true, items: [{ listingId: egusi.id }] }, at("2026-11-05T15:04:00Z"));
      await action(convY.id, "search_catalog", { query: "uziza" }, { ok: true, items: [] }, at("2026-10-25T15:04:00Z"));
    });
  }

  async function seedStoreB() {
    await asStore(storeB, async (tx) => {
      const listing = await tx.listing.create({ data: { storeId: storeB, customName: "Store B yam", price: 999, stockMode: "always" } });
      const variant = await tx.listingVariant.create({ data: { listingId: listing.id, label: "Each", price: 999, weightG: 1000 } });
      const customer = await tx.customer.create({ data: { storeId: storeB, name: "B shopper" } });
      const cart = await tx.cart.create({ data: { storeId: storeB } });
      const order = await tx.order.create({ data: { storeId: storeB, number: 1, customerId: customer.id, subtotalCents: 0, bufferCents: 0, totalAuthorizedCents: 0, status: "COMPLETED", capturedAmountCents: 99_900, platformFeeCents: 2927, createdAt: at("2026-11-03T15:00:00Z"), readyAt: at("2026-11-03T15:05:00Z"), sourceCartId: cart.id } });
      await tx.orderLine.create({ data: { storeId: storeB, orderId: order.id, listingVariantId: variant.id, qtyOrdered: 100, qtyPicked: 100, unitPriceCents: 999, status: "picked" } });
      const conv = await tx.aiConversation.create({ data: { storeId: storeB, cartId: cart.id, model: "test", createdAt: at("2026-11-03T14:00:00Z") } });
      await tx.aiAction.create({ data: { storeId: storeB, conversationId: conv.id, tool: "search_catalog", input: { query: "store b only" }, output: { ok: true, items: [] }, ok: true, createdAt: at("2026-11-03T14:01:00Z") } });
      await tx.aiAction.create({ data: { storeId: storeB, conversationId: conv.id, tool: "add_to_cart", input: {}, output: { ok: true }, ok: true, createdAt: at("2026-11-03T14:02:00Z") } });
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    storeA = (await raw.store.create({ data: { slug: `an-a-${run}`, name: "Analytics A", timezone: TZ } })).id;
    storeB = (await raw.store.create({ data: { slug: `an-b-${run}`, name: "Analytics B", timezone: TZ } })).id;
    await seedStoreA();
    await seedStoreB();
    data = await storeAnalytics(storeA, TZ, RANGE);
  });

  afterAll(async () => {
    await raw?.$disconnect();
  });

  it("sales match the hand-computed fixture to the cent, by day and by fulfilment", () => {
    expect(data.sales.totals).toEqual({
      orders: 3, goodsCents: 8700, averageOrderCents: 2900, refundsCents: 2100, cardFeeCents: 397, courierFeeCents: 899, netCents: 7240,
    });
    const byDay = Object.fromEntries(data.sales.days.map((d) => [d.day, d]));
    expect(data.sales.days).toHaveLength(7);
    // O2 at 11:30 pm store time (05:30 UTC on 11-04) counts on 11-03; the 00:30 order on 11-08 is outside the range.
    expect(byDay["2026-11-03"]).toMatchObject({ orders: 2, goodsCents: 5700, cardFeeCents: 260, courierFeeCents: 899, netCents: 5740, refundsCents: 0 });
    expect(byDay["2026-11-04"]).toMatchObject({ orders: 0, netCents: 0 });
    expect(byDay["2026-11-05"]).toMatchObject({ orders: 1, goodsCents: 3000, refundsCents: 2100, netCents: 1500 });
    const split = Object.fromEntries(data.sales.byFulfillment.map((f) => [f.fulfillment, f]));
    expect(split.pickup).toMatchObject({ orders: 1, goodsCents: 2000, netCents: 2203 });
    expect(split.courier).toMatchObject({ orders: 1, goodsCents: 3700, refundsCents: 1100, netCents: 2437 });
    expect(split.store_delivery).toMatchObject({ orders: 1, goodsCents: 3000, refundsCents: 1000, netCents: 2600 });
  });

  it("products, customers, operations and assistant match the fixture", () => {
    expect(data.products.sellers.map(({ name, units, revenueCents }) => ({ name, units, revenueCents }))).toEqual([
      { name: "Egusi", units: 4, revenueCents: 4200 },
      { name: "Palm oil", units: 3, revenueCents: 4500 },
    ]);
    expect(data.products.shortOrSwapped.map(({ name, shortLines, swappedLines }) => ({ name, shortLines, swappedLines }))).toEqual([
      { name: "Egusi", shortLines: 1, swappedLines: 0 },
      { name: "Palm oil", shortLines: 0, swappedLines: 1 },
    ]);
    expect(data.products.missedSearches).toEqual([
      { query: "ogiri", searches: 2 },
      { query: "kpomo", searches: 1 },
    ]);
    expect(data.customers).toEqual({
      shoppers: 2, newShoppers: 1, returningShoppers: 1, repeatShoppers: 2, repeatRatePct: 100,
      orders: 3, assistantOrders: 1, browsingOrders: 2,
    });
    expect(data.operations).toEqual({
      readyOrders: 3, medianReadyMinutes: 40, averageReadyMinutes: 50,
      swapsAnswered: 1, swapsTimedOut: 1, swapsPending: 0,
      cancellations: [{ reason: "auto_cancel", orders: 1 }, { reason: "out_of_stock", orders: 1 }],
      courier: { deliveries: 1, delivered: 0 },
    });
    expect(data.assistant).toEqual({ chatsInRange: 3, ledToCart: 2, ledToOrder: 1 });
  });

  it("store B's data never appears for store A, and RLS refuses a cross-store read", async () => {
    const text = JSON.stringify(data);
    expect(text).not.toContain("Store B yam");
    expect(text).not.toContain("store b only");
    const leaked = await storeScopedRawQuery<{ n: number }>(storeA, Prisma.sql`SELECT COUNT(*)::int AS n FROM orders WHERE store_id = ${storeB}`);
    expect(leaked[0].n).toBe(0);
    const b = await storeAnalytics(storeB, TZ, RANGE);
    expect(b.sales.totals).toMatchObject({ orders: 1, goodsCents: 99_900 });
    expect(b.operations.courier).toBeNull();
  });

  it("each CSV matches the on-screen numbers", () => {
    const sales = analyticsCsv("sales", data).split("\r\n");
    expect(sales).toContain("2026-11-03,2,57.00,28.50,0.00,2.60,8.99,57.40");
    expect(sales).toContain("Courier,1,37.00,37.00,11.00,1.63,8.99,24.37");
    expect(sales).toContain("Total 2026-11-01 to 2026-11-07,3,87.00,29.00,21.00,3.97,8.99,72.40");
    expect(analyticsCsv("products", data)).toContain("Top seller,Egusi,4,42.00,,,\r\n");
    expect(analyticsCsv("customers", data)).toContain("Repeat rate %,100\r\n");
    expect(analyticsCsv("operations", data)).toContain("Cancelled: Out of stock,1\r\n");
    expect(analyticsCsv("assistant", data)).toContain("Chats that led to an order,1\r\n");
  });
});
