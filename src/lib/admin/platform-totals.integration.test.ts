import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformAdminTransaction, storeScopedTransaction } from "../db";
import { platformTotals } from "./platform-totals";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `pt831-${Date.now()}`;
const NOW = new Date("2026-11-25T12:00:00Z");

/**
 * 1999-03-02 to 1999-03-04, store days. A (Chicago): one pickup order at 9 pm on 1999-03-04 (already 03-05 in UTC), captured $23.00 with a $3.00 tip, so $20.00 goods.
 * B (New York): $15.00 goods, and a second order on 1999-03-05 in New York that is outside the range.
 * Orders 2, goods $35.00, stores with orders 2.
 */
describe.skipIf(!hasDb)("platform totals (#831)", () => {
  const storeA = crypto.randomUUID();
  const storeB = crypto.randomUUID();

  async function order(storeId: string, number: number, capturedAmountCents: number, tipCents: number, createdAt: Date) {
    await storeScopedTransaction(storeId, async (tx) => {
      const customer = await tx.customer.create({ data: { storeId, name: "Ada" } });
      await tx.order.create({
        data: {
          storeId, number, customerId: customer.id, fulfillment: "pickup", status: "COMPLETED",
          subtotalCents: 0, bufferCents: 0, totalAuthorizedCents: 0, tipCents, capturedAmountCents, platformFeeCents: 0, createdAt,
        },
      });
    });
  }

  beforeAll(async () => {
    await platformAdminTransaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES (${storeA}, ${`A ${RUN}`}, ${`a-${RUN}`}, 'active', 'America/Chicago', now()), (${storeB}, ${`B ${RUN}`}, ${`b-${RUN}`}, 'suspended', 'America/New_York', now())`;
    });
    await order(storeA, 1, 2300, 300, new Date("1999-03-05T03:00:00Z"));
    await order(storeB, 1, 1500, 0, new Date("1999-03-02T06:00:00Z"));
    await order(storeB, 2, 9900, 0, new Date("1999-03-05T06:00:00Z"));
  });

  afterAll(async () => {
    for (const storeId of [storeA, storeB]) {
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.deleteMany({ where: { storeId } });
        await tx.customer.deleteMany({ where: { storeId } });
      });
    }
    await platformAdminTransaction((tx) => tx.store.deleteMany({ where: { id: { in: [storeA, storeB] } } }));
  });

  it("adds each store's analytics figures for its own store days", async () => {
    const totals = await platformTotals("1999-03-02", "1999-03-04", NOW);
    expect(totals).toMatchObject({ ok: true, from: "1999-03-02", to: "1999-03-04", orders: 2, goodsCents: 3500, storesWithOrders: 2 });
  });

  it("refuses a range it cannot read rather than guessing", async () => {
    expect(await platformTotals("1999-03-04", "1999-03-02", NOW)).toMatchObject({ ok: false });
    expect(await platformTotals("2027-01-01", "2027-01-02", NOW)).toMatchObject({ ok: false });
    expect(await platformTotals("1999-02-30", "1999-03-02", NOW)).toMatchObject({ ok: false });
  });
});
