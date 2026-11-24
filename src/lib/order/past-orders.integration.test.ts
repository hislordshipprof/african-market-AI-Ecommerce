import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, storeScopedTransaction } from "../db";
import { PAST_ORDERS_PAGE_SIZE, pastStoreOrders } from "./past-orders";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDb)("past orders (#785)", () => {
  let raw: PrismaClient;
  let storeA: string;
  let storeB: string;
  let ada: string;
  let kofi: string;
  let number = 5000;

  async function order(storeId: string, customerId: string, status: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
    return storeScopedTransaction(storeId, (tx) =>
      tx.order.create({
        data: {
          storeId,
          number: ++number,
          customerId,
          status,
          fulfillment: "pickup",
          subtotalCents: 2000,
          bufferCents: 200,
          totalAuthorizedCents: 2200,
          totalCents: 2000,
          createdAt: new Date(Date.now() - minutesAgo * 60_000),
          ...extra,
        },
      }),
    );
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: `past-a-${suffix}`, name: "Past A", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: `past-b-${suffix}`, name: "Past B", themePreset: "palm-and-shea" } })).id;
    ada = (await storeScoped(storeA).customer.create({ data: { storeId: storeA, name: "Ada Obi", email: `ada-${suffix}@example.com` } })).id;
    kofi = (await storeScoped(storeA).customer.create({ data: { storeId: storeA, name: "Kofi Mensah" } })).id;
    const other = (await storeScoped(storeB).customer.create({ data: { storeId: storeB, name: "Ada Elsewhere" } })).id;
    await order(storeB, other, "COMPLETED", 1);
  });

  afterAll(async () => {
    for (const storeId of [storeA, storeB]) {
      await storeScoped(storeId).order.deleteMany({});
      await storeScoped(storeId).customer.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    await raw.$disconnect();
  });

  it("lists completed, delivered, cancelled and refunded orders newest first with total and payout, and no active order", async () => {
    // $20 captured on a pickup with no fees: the store gets the capture less its card fee.
    const completed = await order(storeA, ada, "COMPLETED", 50, { capturedAmountCents: 2000, captureCents: 2000, platformFeeCents: 88 });
    const delivered = await order(storeA, kofi, "DELIVERED", 40, { capturedAmountCents: 2000, captureCents: 2000, platformFeeCents: 88 });
    const cancelled = await order(storeA, kofi, "CANCELLED", 30);
    const refunded = await order(storeA, ada, "REFUNDED", 20, { capturedAmountCents: 2000, captureCents: 2000, platformFeeCents: 88 });
    await order(storeA, ada, "AUTHORIZED", 10);
    await order(storeA, ada, "READY", 5);

    const { rows, nextCursor } = await pastStoreOrders(storeA, {});

    expect(rows.map((row) => row.id)).toEqual([refunded.id, cancelled.id, delivered.id, completed.id]);
    expect(nextCursor).toBeNull();
    const first = rows.find((row) => row.id === completed.id)!;
    expect(first).toMatchObject({ number: completed.number, customerName: "Ada Obi", status: "COMPLETED", totalCents: 2000, payoutCents: 1912 });
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.id === cancelled.id)).toMatchObject({ totalCents: 2000, payoutCents: null });
    expect(JSON.stringify(rows)).not.toContain("Elsewhere");
  });

  it("finds an order by its number, with or without #, and by customer name or email", async () => {
    const all = await pastStoreOrders(storeA, {});
    const target = all.rows.find((row) => row.customerName === "Kofi Mensah")!;

    expect((await pastStoreOrders(storeA, { q: String(target.number) })).rows.map((row) => row.id)).toEqual([target.id]);
    expect((await pastStoreOrders(storeA, { q: `#${target.number}` })).rows.map((row) => row.id)).toEqual([target.id]);
    const byName = await pastStoreOrders(storeA, { q: "kofi" });
    expect(byName.rows.length).toBe(2);
    expect(byName.rows.every((row) => row.customerName === "Kofi Mensah")).toBe(true);
    const byEmail = await pastStoreOrders(storeA, { q: `ADA-${suffix}` });
    expect(byEmail.rows.length).toBe(2);
    expect((await pastStoreOrders(storeA, { q: "nobody-like-this" })).rows).toEqual([]);
  });

  it("pages older orders with a cursor and rejects a forged one", async () => {
    const extra = PAST_ORDERS_PAGE_SIZE + 2;
    for (let i = 0; i < extra; i++) await order(storeA, kofi, "COMPLETED", 1000 + i);

    const page1 = await pastStoreOrders(storeA, {});
    expect(page1.rows.length).toBe(PAST_ORDERS_PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await pastStoreOrders(storeA, { cursor: page1.nextCursor! });
    expect(page2.rows.length).toBe(extra + 4 - PAST_ORDERS_PAGE_SIZE);
    expect(page2.rows.some((row) => page1.rows.some((seen) => seen.id === row.id))).toBe(false);
    expect(page2.rows[0].createdAt.getTime()).toBeLessThanOrEqual(page1.rows.at(-1)!.createdAt.getTime());
    expect(page2.nextCursor).toBeNull();

    expect((await pastStoreOrders(storeA, { cursor: "not-a-cursor" })).rows.length).toBe(PAST_ORDERS_PAGE_SIZE);
  });
});
