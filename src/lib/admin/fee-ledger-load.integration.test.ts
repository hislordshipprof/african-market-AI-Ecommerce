import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { ledgerMonth } from "./fee-ledger";
import { captureFactsSql, platformFeeLedger, refundFactsSql } from "./fee-ledger-query";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t546load${Date.now()}`;
const STORES = 20;
const MONTH = "2031-05";

let prisma: PrismaClient;
const storeIds = Array.from({ length: STORES }, () => crypto.randomUUID());

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  }, { timeout: 120_000 });
}

/** `count` captured orders, one a minute from `from`, spread over the stores; a third are courier orders. */
const seedOrders = (tx: Prisma.TransactionClient, customerIds: string[], first: number, count: number, from: string) => tx.$executeRaw`
  INSERT INTO orders (id, store_id, number, customer_id, status, fulfillment, subtotal_cents, buffer_cents, total_authorized_cents,
                      captured_amount_cents, service_fee_cents, delivery_fee_cents, platform_fee_cents, ready_at, updated_at)
  SELECT ${RUN} || '-' || g, s.store_id, g, s.customer_id, 'COMPLETED',
         CASE WHEN g % 3 = 0 THEN 'courier' ELSE 'pickup' END, 5000, 500, 7000,
         CASE WHEN g % 3 = 0 THEN 6049 ELSE 5150 END, 150, CASE WHEN g % 3 = 0 THEN 899 ELSE 0 END, 325,
         ${from}::timestamp + (g - ${first}) * interval '2 minutes', now()
  FROM generate_series(${first}::int, ${first + count - 1}::int) g
  JOIN unnest(${storeIds}::text[], ${customerIds}::text[]) WITH ORDINALITY AS s(store_id, customer_id, n) ON s.n = 1 + g % ${STORES}`;

beforeAll(async () => {
  if (!hasDb) return;
  prisma = testPrismaClient();
  await asPlatformAdmin(async (tx) => {
    for (const [i, id] of storeIds.entries()) {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${id}, ${`Load Market ${i} ${RUN}`}, ${`${RUN}-${i}`}, 'active', now())`;
    }
    const customerIds: string[] = [];
    for (const storeId of storeIds) customerIds.push((await tx.customer.create({ data: { storeId, name: "Load Customer" } })).id);
    // The month before and after hold as many orders again, so the month is read through the index.
    await seedOrders(tx, customerIds, 1, 20_000, "2031-04-03");
    await seedOrders(tx, customerIds, 100_001, 20_000, "2031-05-01");
    await seedOrders(tx, customerIds, 200_001, 20_000, "2031-06-01");
    await tx.$executeRaw`
      INSERT INTO refund_requests (id, store_id, order_id, payment_intent_id, key, amount_cents, refund_application_fee, state,
                                   provider_status, created_at, succeeded_at)
      SELECT ${RUN} || '-r' || o.number, o.store_id, o.id, 'pi_' || o.number, ${RUN} || '-r' || o.number, 1000, true, 'CREATED',
             'succeeded', o.ready_at + interval '1 day', o.ready_at + interval '1 day'
      FROM orders o WHERE o.id LIKE ${`${RUN}-%`} AND o.number % 50 = 1`;
  });
  await prisma.$executeRaw`ANALYZE orders`;
  await prisma.$executeRaw`ANALYZE refund_requests`;
}, 180_000);

afterAll(async () => {
  if (!hasDb) return;
  await asPlatformAdmin(async (tx) => {
    await tx.refundRequest.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.order.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.customer.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.store.deleteMany({ where: { id: { in: storeIds } } });
  });
  await prisma.$disconnect();
}, 180_000);

describe.skipIf(!hasDb)("platform fee ledger at 20,000 orders a month (lane DB)", () => {
  it("loads the month in under 2 s", async () => {
    const started = performance.now();
    const ledger = await platformFeeLedger(MONTH);
    const elapsed = performance.now() - started;
    if (process.env.LEDGER_PLAN) console.log(`ledger for ${MONTH}: ${ledger.rows.length} rows in ${Math.round(elapsed)} ms`);
    expect(ledger.total.orders).toBe(20_000);
    expect(ledger.stores).toHaveLength(STORES);
    expect(elapsed).toBeLessThan(2_000);
  }, 30_000);

  it("reads both queries through the month indexes", async () => {
    const month = ledgerMonth(MONTH);
    const plan = async (sql: Prisma.Sql) => {
      const rows = await asPlatformAdmin((tx) => tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
      const text = rows.map((row) => row["QUERY PLAN"]).join("\n");
      if (process.env.LEDGER_PLAN) console.log(text);
      return text;
    };
    expect(await plan(captureFactsSql(month))).toMatch(/orders_capture_confirmed_at_idx/);
    expect(await plan(refundFactsSql(month))).toMatch(/refund_requests_succeeded_at_idx/);
  }, 30_000);
});
