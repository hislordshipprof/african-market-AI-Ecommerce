import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformAdminTransaction, storeScopedTransaction } from "../db";
import { salesRows, salesView } from "../analytics/queries";
import { platformTotals } from "./platform-totals";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `pt831-${Date.now()}`;
const NOW = new Date("2026-11-25T12:00:00Z");

/**
 * 1999-03-02 to 1999-03-04, store days. A (Chicago): one pickup order at 9 pm on 1999-03-04 (already 03-05 in UTC), captured $23.00 with a $3.00 tip, so $20.00 goods.
 * B (New York): $15.00 goods, and a second order on 1999-03-05 in New York that is outside the range.
 * Orders 2, goods $35.00, stores with orders 2.
 * C (Chicago): its only order is from 1999-01-10, captured $50.00, with a succeeded $40.00 refund on 1999-03-03.
 */
describe.skipIf(!hasDb)("platform totals (#831)", () => {
  const storeA = crypto.randomUUID();
  const storeB = crypto.randomUUID();
  const storeC = crypto.randomUUID();

  async function order(storeId: string, number: number, capturedAmountCents: number, tipCents: number, createdAt: Date) {
    return storeScopedTransaction(storeId, async (tx) => {
      const customer = await tx.customer.create({ data: { storeId, name: "Ada" } });
      return tx.order.create({
        data: {
          storeId, number, customerId: customer.id, fulfillment: "pickup", status: "COMPLETED",
          subtotalCents: 0, bufferCents: 0, totalAuthorizedCents: 0, tipCents, capturedAmountCents, platformFeeCents: 0, createdAt,
        },
      });
    });
  }

  beforeAll(async () => {
    await platformAdminTransaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES (${storeA}, ${`A ${RUN}`}, ${`a-${RUN}`}, 'active', 'America/Chicago', now()), (${storeB}, ${`B ${RUN}`}, ${`b-${RUN}`}, 'suspended', 'America/New_York', now()), (${storeC}, ${`C ${RUN}`}, ${`c-${RUN}`}, 'active', 'America/Chicago', now())`;
    });
    await order(storeA, 1, 2300, 300, new Date("1999-03-05T03:00:00Z"));
    await order(storeB, 1, 1500, 0, new Date("1999-03-02T06:00:00Z"));
    await order(storeB, 2, 9900, 0, new Date("1999-03-05T06:00:00Z"));
    const old = await order(storeC, 1, 5000, 0, new Date("1999-01-10T18:00:00Z"));
    await storeScopedTransaction(storeC, (tx) => tx.refundRequest.create({
      data: {
        storeId: storeC, orderId: old.id, paymentIntentId: `pi_${RUN}`, key: `refund:${old.id}:1`, amountCents: 4000,
        refundApplicationFee: false, state: "SUCCEEDED", providerStatus: "succeeded", createdAt: new Date("1999-03-03T18:00:00Z"),
      },
    }));
  });

  afterAll(async () => {
    for (const storeId of [storeA, storeB, storeC]) {
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.refundRequest.deleteMany({ where: { storeId } });
        await tx.order.deleteMany({ where: { storeId } });
        await tx.customer.deleteMany({ where: { storeId } });
      });
    }
    await platformAdminTransaction((tx) => tx.store.deleteMany({ where: { id: { in: [storeA, storeB, storeC] } } }));
  });

  it("adds each store's analytics figures for its own store days", async () => {
    const totals = await platformTotals("1999-03-02", "1999-03-04", NOW);
    expect(totals).toMatchObject({ ok: true, from: "1999-03-02", to: "1999-03-04", orders: 2, goodsCents: 3500, storesWithOrders: 2 });
  });

  it("counts a refund in the range on an order placed before it, as the store's analytics page does", async () => {
    const range = { preset: "custom", from: "1999-03-02", to: "1999-03-04" } as const;
    const pages = await Promise.all([[storeA, "America/Chicago"], [storeB, "America/New_York"], [storeC, "America/Chicago"]]
      .map(async ([id, zone]) => salesView(await salesRows(id, range, zone), range).totals));
    const totals = await platformTotals("1999-03-02", "1999-03-04", NOW);
    expect(totals).toMatchObject({ ok: true, refundsCents: 4000, netCents: pages.reduce((sum, page) => sum + page.netCents, 0) });
  });

  it("splits the figures by store day and by store, for the admin Home and Stores pages (#859)", async () => {
    const totals = await platformTotals("1999-03-02", "1999-03-04", NOW);
    if (!totals.ok) throw new Error(totals.reason);
    expect(totals.days.map(({ day, orders, goodsCents }) => ({ day, orders, goodsCents }))).toEqual([
      { day: "1999-03-02", orders: 1, goodsCents: 1500 },
      { day: "1999-03-03", orders: 0, goodsCents: 0 },
      { day: "1999-03-04", orders: 1, goodsCents: 2000 },
    ]);
    const ours = totals.stores.filter((row) => [storeA, storeB, storeC].includes(row.storeId));
    expect(ours.sort((a, b) => a.storeId.localeCompare(b.storeId))).toEqual(
      [
        { storeId: storeA, orders: 1, goodsCents: 2000, today: { orders: 1, goodsCents: 2000 } },
        { storeId: storeB, orders: 1, goodsCents: 1500, today: { orders: 0, goodsCents: 0 } },
        { storeId: storeC, orders: 0, goodsCents: 0, today: { orders: 0, goodsCents: 0 } },
      ].sort((a, b) => a.storeId.localeCompare(b.storeId)),
    );
  });

  it("refuses a range it cannot read rather than guessing", async () => {
    expect(await platformTotals("1999-03-04", "1999-03-02", NOW)).toMatchObject({ ok: false });
    expect(await platformTotals("2027-01-01", "2027-01-02", NOW)).toMatchObject({ ok: false });
    expect(await platformTotals("1999-02-30", "1999-03-02", NOW)).toMatchObject({ ok: false });
  });
});
