import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { orderSearchSql } from "../db";
import { parseOrderSearch } from "./order-search";
import { searchOrders } from "./order-search-query";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t537p${Date.now()}`;
const ORDERS = 10_000;
const CUSTOMERS = 2_000;
/** Other stores' orders, so the table looks like a platform with many stores and not one. */
const NEIGHBOUR_ORDERS = 30_000;

let prisma: PrismaClient;
const storeId = crypto.randomUUID();
const neighbourId = crypto.randomUUID();

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  }, { timeout: 120_000 });
}

const CASES: Array<[string, Record<string, string>]> = [
  ["store, newest page", { storeId }],
  ["store plus order number", { storeId, number: "7345" }],
  ["email across stores", { email: `${RUN}-77@example.com` }],
  ["phone across stores", { phone: `+1 555 ${RUN} 77` }],
  ["status across stores", { status: "REFUND_FAILED" }],
  ["fulfillment and date range across stores", { fulfillment: "courier", from: "2026-01-20", to: "2026-01-21" }],
];

beforeAll(async () => {
  if (!hasDb) return;
  prisma = testPrismaClient();
  await asPlatformAdmin(async (tx) => {
    await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES (${storeId}, ${`Perf ${RUN}`}, ${RUN}, 'active', 'America/Chicago', now())`;
    await tx.$executeRaw`
      INSERT INTO customers (id, store_id, name, email, phone, updated_at)
      SELECT ${RUN} || '-c' || g, ${storeId}, 'Perf ' || g, ${RUN} || '-' || g || '@example.com', '+1 555 ' || ${RUN} || ' ' || g, now()
      FROM generate_series(1, ${CUSTOMERS}) g`;
    await tx.$executeRaw`
      INSERT INTO orders (id, store_id, number, customer_id, status, fulfillment, subtotal_cents, buffer_cents, total_authorized_cents, created_at)
      SELECT ${RUN} || '-o' || g, ${storeId}, g, ${RUN} || '-c' || (1 + g % ${CUSTOMERS}),
             (ARRAY['COMPLETED', 'CANCELLED', 'AWAITING_PICKUP', 'REFUND_FAILED', 'DELIVERED'])[1 + g % 5],
             (ARRAY['pickup', 'store-delivery', 'courier'])[1 + g % 3],
             1000, 100, 1100, timestamp '2026-01-01' + g * interval '7 minutes'
      FROM generate_series(1, ${ORDERS}) g`;
  });
  await asPlatformAdmin(async (tx) => {
    await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${neighbourId}, ${`Neighbour ${RUN}`}, ${`${RUN}-n`}, 'active', now())`;
    await tx.$executeRaw`INSERT INTO customers (id, store_id, name, updated_at) VALUES (${`${RUN}-nc`}, ${neighbourId}, 'Neighbour', now())`;
    await tx.$executeRaw`
      INSERT INTO orders (id, store_id, number, customer_id, status, subtotal_cents, buffer_cents, total_authorized_cents, created_at)
      SELECT ${RUN} || '-n' || g, ${neighbourId}, g, ${`${RUN}-nc`}, 'COMPLETED', 1000, 100, 1100, timestamp '2025-06-01' + g * interval '5 minutes'
      FROM generate_series(1, ${NEIGHBOUR_ORDERS}) g`;
  });
  await prisma.$executeRaw`ANALYZE orders`;
  await prisma.$executeRaw`ANALYZE customers`;
}, 120_000);

afterAll(async () => {
  if (!hasDb) return;
  await asPlatformAdmin(async (tx) => {
    await tx.order.deleteMany({ where: { storeId: { in: [storeId, neighbourId] } } });
    await tx.customer.deleteMany({ where: { storeId: { in: [storeId, neighbourId] } } });
    await tx.store.deleteMany({ where: { id: { in: [storeId, neighbourId] } } });
  });
  await prisma.$disconnect();
});

function filtersOf(input: Record<string, string>) {
  const parsed = parseOrderSearch(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.filters;
}

describe.skipIf(!hasDb)(`order search on a store with ${ORDERS} orders (lane DB)`, () => {
  it.each(CASES)("%s returns in under 1 s", async (_name, input) => {
    const started = performance.now();
    const { rows } = await searchOrders(filtersOf(input));
    const elapsed = performance.now() - started;
    expect(rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });

  it.each(CASES)("%s reads orders and customers through an index", async (_name, input) => {
    const plan = await asPlatformAdmin((tx) =>
      tx.$queryRaw<Array<{ "QUERY PLAN": string }>>(Prisma.sql`EXPLAIN ${orderSearchSql(filtersOf(input), 51)}`),
    );
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).not.toMatch(/Seq Scan on (orders|customers)/);
  });
});
