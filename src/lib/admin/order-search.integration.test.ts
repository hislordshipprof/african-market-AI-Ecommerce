import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { parseOrderSearch, type OrderSearchFilters } from "./order-search";
import { searchOrders } from "./order-search-query";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t537s-${Date.now()}`;

let prisma: PrismaClient;
const storeIds: string[] = [];

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  }, { timeout: 60_000 });
}

function filters(input: Record<string, string>): OrderSearchFilters {
  const parsed = parseOrderSearch(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.filters;
}

beforeAll(() => {
  if (hasDb) prisma = testPrismaClient();
});

afterAll(async () => {
  if (!hasDb) return;
  await asPlatformAdmin(async (tx) => {
    await tx.order.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.customer.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.store.deleteMany({ where: { id: { in: storeIds } } });
  });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("order search across stores (lane DB)", () => {
  const chicago = crypto.randomUUID();
  const newYork = crypto.randomUUID();
  storeIds.push(chicago, newYork);
  const email = `${RUN}@example.com`;
  const phone = `+1 555 ${RUN.slice(-7)}`;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES (${chicago}, ${`Chicago ${RUN}`}, ${`${RUN}-chi`}, 'active', 'America/Chicago', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, timezone, updated_at) VALUES (${newYork}, ${`New York ${RUN}`}, ${`${RUN}-ny`}, 'active', 'America/New_York', now())`;
      const chiShopper = await tx.customer.create({ data: { storeId: chicago, name: "Ada", email, phone } });
      const nyShopper = await tx.customer.create({ data: { storeId: newYork, name: "Ada", email, phone } });
      const chiOther = await tx.customer.create({ data: { storeId: chicago, name: "Bola", email: `other-${email}`, phone: `${phone}9` } });
      const order = async (key: string, data: Prisma.OrderUncheckedCreateInput) => {
        ids[key] = (await tx.order.create({ data })).id;
      };
      const base = { subtotalCents: 1000, bufferCents: 100, totalAuthorizedCents: 1100 };
      // 03:30 UTC on 10 March is still 9 March in Chicago (UTC-6).
      await order("chiLateNight", { ...base, storeId: chicago, customerId: chiShopper.id, number: 1001, status: "COMPLETED", fulfillment: "pickup", createdAt: new Date("2026-03-10T03:30:00Z") });
      await order("chiCourier", { ...base, storeId: chicago, customerId: chiShopper.id, number: 1002, status: "REFUND_FAILED", fulfillment: "courier", createdAt: new Date("2026-03-10T18:00:00Z") });
      await order("chiOther", { ...base, storeId: chicago, customerId: chiOther.id, number: 1003, status: "COMPLETED", fulfillment: "pickup", createdAt: new Date("2026-03-10T19:00:00Z") });
      // Same number at another store.
      await order("nyPickup", { ...base, storeId: newYork, customerId: nyShopper.id, number: 1001, status: "COMPLETED", fulfillment: "pickup", createdAt: new Date("2026-03-10T05:30:00Z") });
    });
  });

  it("finds one order by store plus number, never the same number at another store", async () => {
    const { rows } = await searchOrders(filters({ storeId: chicago, number: "1001" }));
    expect(rows.map((row) => row.id)).toEqual([ids.chiLateNight]);
    expect(rows[0]).toMatchObject({ storeName: `Chicago ${RUN}`, storeTimezone: "America/Chicago", number: 1001 });
  });

  it("finds a customer's orders at every store by exact email, newest first", async () => {
    const { rows } = await searchOrders(filters({ email: email.toUpperCase() }));
    expect(rows.map((row) => row.id)).toEqual([ids.chiCourier, ids.nyPickup, ids.chiLateNight]);
  });

  it("matches email and phone exactly, never as a pattern", async () => {
    // "_" is a one-character LIKE wildcard and valid in an email address.
    expect((await searchOrders(filters({ email: `_${email.slice(1)}` }))).rows).toEqual([]);
    expect((await searchOrders(filters({ email: `x${email}` }))).rows).toEqual([]);
    expect((await searchOrders(filters({ phone: phone.slice(0, -1) }))).rows).toEqual([]);
    const byPhone = await searchOrders(filters({ phone }));
    expect(byPhone.rows.map((row) => row.id).sort()).toEqual([ids.chiCourier, ids.chiLateNight, ids.nyPickup].sort());
  });

  it("keeps a store filter to that store", async () => {
    const { rows } = await searchOrders(filters({ storeId: newYork }));
    expect(rows.map((row) => row.id)).toEqual([ids.nyPickup]);
  });

  it("filters by status and fulfillment", async () => {
    const { rows } = await searchOrders(filters({ storeId: chicago, status: "REFUND_FAILED", fulfillment: "courier" }));
    expect(rows.map((row) => row.id)).toEqual([ids.chiCourier]);
    expect((await searchOrders(filters({ storeId: chicago, status: "COMPLETED", fulfillment: "courier" }))).rows).toEqual([]);
  });

  it("reads the date range as days in each order's own store time zone", async () => {
    const tenth = await searchOrders(filters({ email, from: "2026-03-10", to: "2026-03-10" }));
    expect(tenth.rows.map((row) => row.id)).toEqual([ids.chiCourier, ids.nyPickup]);
    const ninth = await searchOrders(filters({ email, from: "2026-03-09", to: "2026-03-09" }));
    expect(ninth.rows.map((row) => row.id)).toEqual([ids.chiLateNight]);
    const openEnded = await searchOrders(filters({ storeId: chicago, from: "2026-03-10" }));
    expect(openEnded.rows.map((row) => row.id)).toEqual([ids.chiOther, ids.chiCourier]);
  });

  it("pages with a keyset cursor: no order twice, none skipped, even at the same instant", async () => {
    const store = crypto.randomUUID();
    storeIds.push(store);
    const sameInstant = new Date("2026-04-01T12:00:00Z");
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${store}, ${`Paging ${RUN}`}, ${`${RUN}-pg`}, 'active', now())`;
      const customer = await tx.customer.create({ data: { storeId: store, name: "Pager" } });
      await tx.order.createMany({
        data: Array.from({ length: 7 }, (_, i) => ({
          storeId: store,
          customerId: customer.id,
          number: i + 1,
          subtotalCents: 500,
          bufferCents: 0,
          totalAuthorizedCents: 500,
          createdAt: i < 4 ? sameInstant : new Date(sameInstant.getTime() + i * 1000),
        })),
      });
    });

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await searchOrders(filters({ storeId: store, ...(cursor ? { cursor } : {}) }), { pageSize: 3 });
      expect(page.rows.length).toBeLessThanOrEqual(3);
      seen.push(...page.rows.map((row) => row.number));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen.slice(0, 3)).toEqual([7, 6, 5]);
    expect(seen.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
